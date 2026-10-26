import fs from 'fs';
import path from 'path';
import { createParser } from '../parser/index.js';
import { GraphStore } from '../graph/store.js';
import { L2Index } from '../retrieval/index.js';
import { getSubprojectDir } from '../scanner/workspace.js';
import { acquireFileLock } from '../utils/file-lock.js';
import { markIngestState } from '../ingest/state.js';
import { runIngestPipeline } from '../ingest/pipeline.js';

const DEBOUNCE_MS = 500;
const LOCKED_RETRY_MS = 5000;

export class FileWatcher {
  constructor({ workspace, subproject }) {
    this.workspace = workspace;
    this.subproject = subproject;
    this.parser = createParser();
    this.watchers = [];
    this.pending = new Map();
    this.store = null;
    this.l2 = null;
    this.dir = null;
    this.debounceTimer = null;
    this.processing = false;
    this.stopped = false;
    this.onReindex = null;
  }

  async start() {
    const sp = this.subproject;
    this.dir = getSubprojectDir(this.workspace.id, sp.id);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });

    const dbPath = path.join(this.dir, 'entity_graph.sqlite');
    this.store = new GraphStore(dbPath);

    this.l2 = new L2Index(this.store, { indexPath: path.join(this.dir, 'ast_embed_index') });
    this.l2.load();

    const includeGlobs = sp.includeGlobs || sp.include_globs || ['**/*'];
    const excludeGlobs = sp.excludeGlobs || sp.exclude_globs || [];
    const watchDirs = collectWatchDirs(sp.root);

    for (const dir of watchDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(dir, filename);
          if (this._shouldIgnore(fullPath, includeGlobs, excludeGlobs)) return;

          const ext = path.extname(filename).toLowerCase();
          const supportedExts = new Set([
            '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.php',
            '.dart', '.vue', '.py', '.go', '.rs', '.java',
            '.graphql', '.gql', '.prisma', '.proto',
            '.yaml', '.yml', '.json', '.sql', '.md',
          ]);
          if (!supportedExts.has(ext)) return;

          this._scheduleReindex(fullPath, eventType);
        });
        watcher.on('error', (err) => {
          console.error(`[watch] watcher error on ${dir}: ${err.message}`);
          try { watcher.close(); } catch {}
          this.watchers = this.watchers.filter((w) => w !== watcher);
        });
        this.watchers.push(watcher);
      } catch (err) {
        console.error(`[watch] failed to watch ${dir}: ${err.message}`);
      }
    }

    return { watching: watchDirs.length, subproject: sp.id };
  }

  _shouldIgnore(filePath, includeGlobs, excludeGlobs) {
    const relativePath = path.relative(this.subproject.root, filePath).replace(/\\/g, '/');
    if (relativePath.startsWith('../') || path.isAbsolute(relativePath)) return true;
    const defaultExclude = [
      'node_modules', 'vendor', '.git', 'dist', 'build',
      'var', 'public/builder', 'public/assets', '__pycache__',
      '.next', '.nuxt', 'target', 'bin', 'obj',
    ];
    // Only segments inside the subproject count: a project living under e.g.
    // ~/build/ must not have every event ignored.
    const parts = relativePath.split('/');
    for (const part of parts) {
      if (defaultExclude.includes(part)) return true;
    }
    if (excludeGlobs.some(pattern => globMatches(relativePath, pattern))) return true;
    return !includeGlobs.some(pattern => globMatches(relativePath, pattern));
  }

  _scheduleReindex(filePath, eventType) {
    if (this.stopped) return;
    this.pending.set(filePath, eventType);
    if (this.processing) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._processPending(), DEBOUNCE_MS);
  }

  async _processPending() {
    if (this.processing || this.stopped) return;
    this.processing = true;
    const changed = new Map(this.pending);
    this.pending.clear();
    this.debounceTimer = null;

    if (changed.size === 0) {
      this.processing = false;
      return;
    }

    const changedFiles = [...changed.keys()];
    const relativePaths = changedFiles.map(f => path.relative(this.subproject.root, f));
    let retryDelay = DEBOUNCE_MS;

    try {
      const lock = acquireFileLock(path.join(this.dir, '.ingest.lock'));
      try {
        markIngestState(this.dir, 'building');
        const stats = await runIngestPipeline({
          subproject: this.subproject,
          dir: this.dir,
          store: this.store,
          parser: this.parser,
          changedPaths: relativePaths,
          l2: this.l2,
        });
        if (this.onReindex) {
          this.onReindex({
            files: relativePaths,
            nodesCreated: stats.graph.nodesCreated,
            edgesCreated: stats.graph.edgesCreated,
          });
        }
        markIngestState(this.dir, 'ready', { nodes: stats.totals.totalNodes, edges: stats.totals.totalEdges });
      } finally {
        lock.release();
      }
    } catch (err) {
      if (err.code === 'ORACLE_LOCKED') {
        // Another ingest is running: keep the events and retry later, quietly.
        for (const [filePath, eventType] of changed) this.pending.set(filePath, eventType);
        retryDelay = LOCKED_RETRY_MS;
        console.error(`[watch] ${this.subproject.id}: another ingest is running; retrying in ${LOCKED_RETRY_MS / 1000}s`);
      } else {
        markIngestState(this.dir, 'failed', { error: err.message });
        console.error(`[watch] reindex failed for ${this.subproject.id}: ${process.env.ORACLE_DEBUG === 'true' ? err.stack : err.message}`);
      }
    } finally {
      this.processing = false;
      if (this.stopped) this._closeStore();
      else if (this.pending.size > 0) this._scheduleReindexTimer(retryDelay);
    }
  }

  _scheduleReindexTimer(delay = DEBOUNCE_MS) {
    if (this.debounceTimer || this.processing || this.stopped) return;
    this.debounceTimer = setTimeout(() => this._processPending(), delay);
  }

  stop() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) {
      try { w.close(); } catch {}
    }
    this.watchers = [];
    this.stopped = true;
    // A reindex in flight still needs the store; it closes it when done.
    if (!this.processing) this._closeStore();
  }

  _closeStore() {
    if (this.store) {
      try { this.store.close(); } catch {}
      this.store = null;
    }
  }
}

function collectWatchDirs(root) {
  return [root];
}

function globMatches(value, glob) {
  let regex = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        regex += '(?:.*/)?';
        i += 2;
      } else {
        regex += '.*';
        i++;
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${regex}$`).test(value);
}
