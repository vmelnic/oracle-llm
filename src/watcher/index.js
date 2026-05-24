import fs from 'fs';
import path from 'path';
import { buildGraph } from '../graph/builder.js';
import { createParser } from '../parser/index.js';
import { GraphStore } from '../graph/store.js';
import { PatternCatalogue } from '../patterns/index.js';
import { L2Index } from '../retrieval/index.js';
import { createContractRegistry } from '../contracts/index.js';
import { getSubprojectDir } from '../scanner/workspace.js';

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
    this.onReindex = null;
  }

  async start() {
    const sp = this.subproject;
    this.dir = getSubprojectDir(this.workspace.id, sp.id);
    fs.mkdirSync(this.dir, { recursive: true });

    const dbPath = path.join(this.dir, 'entity_graph.sqlite');
    this.store = new GraphStore(dbPath);

    const cataloguePath = path.join(this.dir, 'pattern_catalog.json');
    this.patterns = new PatternCatalogue(this.store);
    if (fs.existsSync(cataloguePath)) this.patterns.load(cataloguePath);

    this.l2 = new L2Index(this.store, { indexPath: path.join(this.dir, 'ast_embed_index.json') });
    this.l2.load();

    const includeGlobs = sp.includeGlobs || sp.include_globs || ['**/*'];
    const excludeGlobs = sp.excludeGlobs || sp.exclude_globs || [];
    const watchDirs = collectWatchDirs(sp.root, includeGlobs, excludeGlobs);

    for (const dir of watchDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(dir, filename);
          if (this._shouldIgnore(fullPath, excludeGlobs)) return;

          const ext = path.extname(filename).toLowerCase();
          const supportedExts = new Set([
            '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.php',
            '.dart', '.vue', '.py', '.go', '.rs', '.java',
            '.graphql', '.gql', '.prisma', '.proto',
            '.yaml', '.yml', '.json', '.sql',
          ]);
          if (!supportedExts.has(ext)) return;

          this._scheduleReindex(fullPath, eventType);
        });
        this.watchers.push(watcher);
      } catch {}
    }

    return { watching: watchDirs.length, subproject: sp.id };
  }

  _shouldIgnore(filePath, excludeGlobs) {
    const defaultExclude = [
      'node_modules', 'vendor', '.git', 'dist', 'build',
      'var', 'public/builder', 'public/assets', '__pycache__',
      '.next', '.nuxt', 'target', 'bin', 'obj',
    ];
    const parts = filePath.split(path.sep);
    for (const part of parts) {
      if (defaultExclude.includes(part)) return true;
    }
    return false;
  }

  _scheduleReindex(filePath, eventType) {
    this.pending.set(filePath, eventType);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._processPending(), DEBOUNCE_MS);
  }

  async _processPending() {
    const changed = new Map(this.pending);
    this.pending.clear();
    this.debounceTimer = null;

    if (changed.size === 0) return;

    const changedFiles = [...changed.keys()];
    const relativePaths = changedFiles.map(f => path.relative(this.subproject.root, f));

    try {
      const changedGlobs = relativePaths.map(p => p.replace(/\\/g, '/'));
      const graphStats = await buildGraph(this.subproject, this.parser, this.store, { onlyFiles: changedGlobs });

      const contracts = createContractRegistry(this.store);
      await contracts.index(this.subproject);

      this.patterns.extract(this.subproject);
      this.patterns.rerank(relativePaths);
      const cataloguePath = path.join(this.dir, 'pattern_catalog.json');
      this.patterns.save(cataloguePath);

      this.l2.build(this.subproject.id);
      this.l2.save();

      if (this.onReindex) {
        this.onReindex({
          files: relativePaths,
          nodesCreated: graphStats.nodesCreated,
          edgesCreated: graphStats.edgesCreated,
        });
      }
    } catch {}
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

function collectWatchDirs(root, includeGlobs, excludeGlobs) {
  const dirs = new Set();
  const maxDepth = 3;

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
        if (entry.isDirectory()) {
          const fullPath = path.join(dir, entry.name);
          dirs.add(fullPath);
          walk(fullPath, depth + 1);
        }
      }
    } catch {}
  }

  dirs.add(root);
  walk(root, 0);
  return [...dirs];
}
