import fs from 'fs';
import path from 'path';
import { buildGraph } from '../graph/builder.js';
import { createParser } from '../parser/index.js';
import { GraphStore } from '../graph/store.js';
import { PatternCatalogue } from '../patterns/index.js';
import { L2Index } from '../retrieval/index.js';
import { createContractRegistry } from '../contracts/index.js';
import { ManifestDrafter } from '../manifest/index.js';
import { processMarkdownFiles } from '../markdown/index.js';
import { getSubprojectDir } from '../scanner/workspace.js';
import { acquireFileLock } from '../utils/file-lock.js';
import { markIngestState } from '../ingest/state.js';

const DEBOUNCE_MS = 500;

export class FileWatcher {
  constructor({ workspace, subproject }) {
    this.workspace = workspace;
    this.subproject = subproject;
    this.parser = createParser();
    this.watchers = [];
    this.pending = new Map();
    this.store = null;
    this.l2 = null;
    this.patterns = null;
    this.dir = null;
    this.debounceTimer = null;
    this.processing = false;
    this.onReindex = null;
  }

  async start() {
    const sp = this.subproject;
    this.dir = getSubprojectDir(this.workspace.id, sp.id);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });

    const dbPath = path.join(this.dir, 'entity_graph.sqlite');
    this.store = new GraphStore(dbPath);

    const cataloguePath = path.join(this.dir, 'pattern_catalog.json');
    this.patterns = new PatternCatalogue(this.store);
    if (fs.existsSync(cataloguePath)) this.patterns.load(cataloguePath);

    this.l2 = new L2Index(this.store, { indexPath: path.join(this.dir, 'ast_embed_index.json') });
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
    const parts = filePath.split(path.sep);
    for (const part of parts) {
      if (defaultExclude.includes(part)) return true;
    }
    if (excludeGlobs.some(pattern => globMatches(relativePath, pattern))) return true;
    return !includeGlobs.some(pattern => globMatches(relativePath, pattern));
  }

  _scheduleReindex(filePath, eventType) {
    this.pending.set(filePath, eventType);
    if (this.processing) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._processPending(), DEBOUNCE_MS);
  }

  async _processPending() {
    if (this.processing) return;
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

    try {
      const lock = acquireFileLock(path.join(this.dir, '.ingest.lock'));
      try {
        markIngestState(this.dir, 'building');

        // A changed definition can invalidate incoming edges from unchanged files,
        // so hash-scan the project and rebuild graph edges as one transaction.
        const graphStats = await buildGraph(this.subproject, this.parser, this.store);

        const contracts = createContractRegistry(this.store);
        const surfacesPath = path.join(this.dir, 'contract_surfaces.json');
        const previousSurfaces = contracts.loadSurfacesJson(surfacesPath);
        const contractStats = await contracts.index(this.subproject, { previousSurfaces });
        contracts.saveSurfacesJson(contractStats.surfaces, surfacesPath);

        processMarkdownFiles(this.subproject, this.store);

        this.patterns.extract(this.subproject);
        this.patterns.rerank(relativePaths);
        const cataloguePath = path.join(this.dir, 'pattern_catalog.json');
        this.patterns.save(cataloguePath);

        await this.l2.build(this.subproject.id);
        this.l2.save();

        const drafter = new ManifestDrafter();
        const manifestPath = path.join(this.dir, 'manifest.yaml');
        const existing = drafter.load(manifestPath);
        const drafted = await drafter.draft(this.subproject);
        await drafter.save(existing ? drafter.merge(existing, drafted) : drafted, manifestPath);

        const storeStats = this.store.stats(this.subproject.id);
        if (this.onReindex) {
          this.onReindex({
            files: relativePaths,
            nodesCreated: graphStats.nodesCreated,
            edgesCreated: graphStats.edgesCreated,
          });
        }
        markIngestState(this.dir, 'ready', { nodes: storeStats.totalNodes, edges: storeStats.totalEdges });
      } finally {
        lock.release();
      }
    } catch (err) {
      if (err.code === 'ORACLE_LOCKED') {
        for (const [filePath, eventType] of changed) this.pending.set(filePath, eventType);
      } else {
        markIngestState(this.dir, 'failed', { error: err.message });
      }
      console.error(`[watch] reindex failed for ${this.subproject.id}: ${err.stack || err.message}`);
    } finally {
      this.processing = false;
      if (this.pending.size > 0) this._scheduleReindexTimer();
    }
  }

  _scheduleReindexTimer() {
    if (this.debounceTimer || this.processing) return;
    this.debounceTimer = setTimeout(() => this._processPending(), DEBOUNCE_MS);
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
