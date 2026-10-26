import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, dirname, resolve, extname, isAbsolute, basename } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'child_process';
import { globFiles } from '../utils/glob.js';
import { positiveInt } from '../utils/env.js';
import { createCallResolver, mergeCallMetadata, TYPE_KINDS } from './calls.js';
import { createModuleResolver } from './modules.js';

const extractorCache = new Map();

// Bump whenever extractor output or edge resolution changes: a graph built
// with another version is re-extracted in full on the next build, since
// unchanged files would otherwise keep their old nodes and edges.
const EXTRACTOR_VERSION = 5;
const EXTRACTOR_VERSION_KEY = 'extractor_version';
const MAX_EDGE_LINES = 20;

const EXTRACTOR_ALIAS = {
  tsx: 'typescript',
  py: 'python',
  vue: 'javascript',
};

async function loadExtractor(language) {
  const extractorName = EXTRACTOR_ALIAS[language] || language;
  if (extractorCache.has(extractorName)) return extractorCache.get(extractorName);

  try {
    const mod = await import(`./extractors/${extractorName}.js`);
    extractorCache.set(extractorName, mod);
    return mod;
  } catch {
    extractorCache.set(extractorName, null);
    return null;
  }
}

function blobHash(content) {
  return createHash('sha1').update(content).digest('hex');
}

function debugLog(message) {
  if (process.env.ORACLE_DEBUG === 'true') console.error(`[graph] ${message}`);
}

/**
 * Incrementally builds the entity graph for a subproject.
 *
 * 1. Hash every candidate file (content is not kept in memory).
 * 2. Parse and extract stale files, plus the unchanged files whose edges
 *    depend on what is changing: files pointing at removed or deleted nodes,
 *    and files with unresolved references a new symbol might now satisfy.
 * 3. Write everything in one synchronous transaction, so the database write
 *    lock is never held across async I/O.
 */
export async function buildGraph(subproject, parserManager, store, { onlyFiles } = {}) {
  const { id: subprojectId, root } = subproject;
  const commitSha = readCommitSha(root);
  // Module resolution settings (tsconfig paths, workspace packages, pubspec
  // name) are part of the version: changing them re-resolves every import.
  const modules = await createModuleResolver(root);
  const versionKey = `${EXTRACTOR_VERSION_KEY}:${subprojectId}`;
  const version = `${EXTRACTOR_VERSION}:${modules.fingerprint}`;
  // A graph built by another version is re-extracted in full; a partial
  // build (onlyFiles) never stamps the version, so the next full one does.
  const outdated = store.getMeta(versionKey) !== version;
  if (outdated && store.getIndexedFiles(subprojectId).length > 0) {
    store.forgetFileHashes(subprojectId);
    onlyFiles = null;
  }
  const fullBuild = !onlyFiles?.length;
  const files = await listFiles(subproject, onlyFiles);

  const maxFiles = positiveInt(process.env.ORACLE_MAX_FILES, 100_000);
  if (files.length > maxFiles) throw new Error(`File limit exceeded: ${files.length} > ${maxFiles}`);

  const maxFileBytes = positiveInt(process.env.ORACLE_MAX_FILE_BYTES, 5 * 1024 * 1024);
  const current = new Map();
  let preSkipped = 0;
  for (const absPath of files) {
    const fileStat = await stat(absPath);
    if (fileStat.size > maxFileBytes) {
      preSkipped++;
      continue;
    }
    current.set(relative(root, absPath), { absPath, blobHash: blobHash(await readFile(absPath)) });
  }

  const deletionCandidates = onlyFiles?.length
    ? onlyFiles.filter(rel => !current.has(rel) && store.getFileHash(subprojectId, rel))
    : store.getIndexedFiles(subprojectId).filter(rel => !current.has(rel));

  const stalePaths = store.getStaleFiles(
    subprojectId,
    [...current].map(([path, file]) => ({ path, blobHash: file.blobHash }))
  );

  const extracted = new Map();
  for (const relPath of stalePaths) {
    const result = await extractFile(current.get(relPath).absPath, relPath, subprojectId, parserManager);
    if (result) extracted.set(relPath, result);
  }

  for (const relPath of [...collectDependents(store, subprojectId, extracted, deletionCandidates)].sort()) {
    if (extracted.has(relPath) || !current.has(relPath)) continue;
    const result = await extractFile(current.get(relPath).absPath, relPath, subprojectId, parserManager);
    if (result) extracted.set(relPath, result);
  }

  const unchanged = current.size - extracted.size;
  const write = () => {
    const result = writeGraph(store, subprojectId, commitSha, extracted, deletionCandidates, preSkipped + unchanged, modules);
    if (outdated && fullBuild) store.setMeta(versionKey, version);
    return result;
  };
  return typeof store.withTransaction === 'function' ? store.withTransaction(write) : write();
}

function readCommitSha(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function listFiles({ root, includeGlobs, excludeGlobs }, onlyFiles) {
  if (!onlyFiles || onlyFiles.length === 0) {
    // Sorted: fast-glob order varies between runs, and processing order must
    // not influence the resulting graph.
    return (await globFiles(includeGlobs, { cwd: root, ignore: excludeGlobs, absolute: true })).sort();
  }

  const realRoot = await realpath(root);
  const files = [];
  for (const rel of onlyFiles) {
    try {
      const canonical = await realpath(resolve(root, rel));
      const canonicalRelative = relative(realRoot, canonical);
      if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) continue;
      const fileStat = await stat(canonical);
      if (fileStat.isFile()) files.push(canonical);
    } catch {}
  }
  return files;
}

/**
 * Reads, parses and extracts one file. Returns null if the file vanished.
 * status: 'ok' | 'failed' (parse/extract threw; old nodes get dropped) |
 * 'unsupported' (no grammar or extractor; existing nodes are left alone).
 */
async function extractFile(absPath, relPath, subprojectId, parserManager) {
  let buffer;
  try {
    buffer = await readFile(absPath);
  } catch {
    return null;
  }
  const hash = blobHash(buffer);

  try {
    const extracted = await extractFromSource(buffer.toString('utf-8'), absPath, relPath, subprojectId, parserManager);
    if (!extracted) return { blobHash: hash, status: 'unsupported' };
    return { blobHash: hash, status: 'ok', ...extracted };
  } catch (err) {
    debugLog(`failed to extract ${relPath}: ${err.message}`);
    return { blobHash: hash, status: 'failed', lang: parserManager.languageFor(absPath), nodes: [], edges: [] };
  }
}

/**
 * Nodes and edges for source text, exactly as ingest would extract them.
 * Returns null when the language has no grammar or extractor; throws when
 * parsing or extraction fails. Also used by the emit gate on proposed code.
 */
export async function extractFromSource(content, absPath, relPath, subprojectId, parserManager) {
  const lang = parserManager.languageFor(absPath);
  const extractor = lang ? await loadExtractor(lang) : null;
  if (!extractor) return null;
  const tree = parserManager.parse(content, lang);
  const { nodes, edges } = extractor.extract(tree, relPath, subprojectId);
  const sqlNodes = extractSqlTables(content, relPath, subprojectId);
  if (sqlNodes.length > 0) nodes.push(...sqlNodes);
  return { lang, nodes, edges };
}

/**
 * Unchanged files that must be re-resolved because of this build's changes.
 * Over-approximates on purpose: reprocessing an extra file is harmless.
 */
function collectDependents(store, subprojectId, extracted, deletedPaths) {
  const dependents = new Set();
  const newKeys = new Set();

  // Keys whose set of candidate symbols changed: a call that was ambiguous or
  // bound by name may resolve differently now.
  const changedKeys = new Set();
  // Types and methods edited in this build: calls resolved through an
  // inheritance chain or a method's return type ('soft' refs keyed by that
  // type or method) are re-resolved.
  const touchedTypeKeys = new Set();
  const touches = (kind) => TYPE_KINDS.has(kind) || kind === 'method' || kind === 'function';

  for (const deletedPath of deletedPaths) {
    for (const p of store.getDependentPathsOfFile(subprojectId, deletedPath)) dependents.add(p);
    for (const n of store.getNodesByFile(subprojectId, deletedPath)) {
      changedKeys.add(symbolKey(n.symbol));
      if (touches(n.kind)) touchedTypeKeys.add(symbolKey(n.symbol));
    }
  }

  for (const [relPath, file] of extracted) {
    if (file.status === 'unsupported') continue;
    const existing = store.getNodesByFile(subprojectId, relPath);
    if (existing.length === 0) for (const key of fileKeys(relPath)) newKeys.add(key);

    const newCounts = new Map();
    for (const n of file.nodes) {
      const k = `${n.symbol}\x00${n.kind}`;
      newCounts.set(k, (newCounts.get(k) || 0) + 1);
    }
    const existingByKey = new Map();
    for (const row of existing) {
      const k = `${row.symbol}\x00${row.kind}`;
      if (!existingByKey.has(k)) existingByKey.set(k, []);
      existingByKey.get(k).push(row.id);
    }

    // replaceNodesByFile keeps ids for matching symbol+kind; any key that
    // shrinks may lose nodes, and their incoming edges cascade away.
    const maybeRemoved = [];
    for (const [k, ids] of existingByKey) {
      if (ids.length > (newCounts.get(k) || 0)) {
        maybeRemoved.push(...ids);
        changedKeys.add(symbolKey(k.split('\x00')[0]));
      }
    }
    for (const p of store.getDependentPathsOfNodes(maybeRemoved)) dependents.add(p);

    for (const n of file.nodes) {
      if (!existingByKey.has(`${n.symbol}\x00${n.kind}`)) newKeys.add(symbolKey(n.symbol));
      if (touches(n.kind)) touchedTypeKeys.add(symbolKey(n.symbol));
    }
    for (const row of existing) {
      if (touches(row.kind)) touchedTypeKeys.add(symbolKey(row.symbol));
    }
  }

  for (const key of changedKeys) newKeys.add(key);
  for (const p of store.findPathsByUnresolvedKeys(subprojectId, newKeys)) dependents.add(p);
  for (const p of store.findPathsByUnresolvedKeys(subprojectId, touchedTypeKeys, 'soft')) dependents.add(p);
  return dependents;
}

function writeGraph(store, subprojectId, commitSha, extracted, deletedPaths, skippedBefore, modules) {
  for (const deletedPath of deletedPaths) store.deleteFileData(subprojectId, deletedPath);

  let filesProcessed = 0;
  let nodesCreated = 0;
  let skipped = skippedBefore;
  const deferredEdges = [];
  const unresolvedByFile = new Map();
  const importMaps = new Map();
  // Distinct (source, target, kind): repeated calls collapse into one row.
  const writtenEdges = new Set();
  const countNewEdges = (edges) => {
    for (const e of edges) writtenEdges.add(`${e.sourceId}\x00${e.targetId}\x00${e.kind}`);
  };
  // Edges that carry a source line (calls, renders, references) collapse per
  // (source, target, kind) into one row listing every line.
  const lineEdges = new Map();
  // Resolved method calls, one row per (source, target) with their lines.
  const callEdges = new Map();
  const writeEdges = (edges) => {
    const plain = [];
    for (const e of edges) {
      if (!Number.isInteger(e.metadata?.line)) {
        plain.push(e);
        continue;
      }
      const key = `${e.sourceId}\x00${e.targetId}\x00${e.kind}`;
      const entry = lineEdges.get(key) || { edge: e, lines: new Set() };
      entry.lines.add(e.metadata.line);
      lineEdges.set(key, entry);
    }
    if (plain.length > 0) {
      store.upsertEdges(plain);
      countNewEdges(plain);
    }
  };
  // Symbol resolution cache: `${kind}\x00${symbol}` -> node id | null.
  // Positive entries can go stale when a later file in this build removes the
  // node, so resolveSymbolId re-checks them. Negative entries may flip once the
  // file defining the symbol gets processed, so they are dropped before the
  // deferred pass to allow exactly one retry.
  const symbolCache = new Map();

  for (const [relPath, file] of extracted) {
    if (file.status === 'unsupported') {
      store.setFileHash(subprojectId, relPath, file.blobHash);
      skipped++;
      continue;
    }

    const { nodes, edges, lang } = file;
    store.deleteEdgesByFile(subprojectId, relPath);
    const nodeIds = store.replaceNodesByFile(
      subprojectId,
      relPath,
      nodes.map(n => ({
        ...n,
        subprojectId,
        path: relPath,
        lang,
        fileBlobHash: file.blobHash,
        commitSha: n.commitSha ?? commitSha,
        metadata: addOracleSource(n.metadata, 'graph'),
      }))
    );
    unresolvedByFile.set(relPath, new Set());
    const importMap = importedNames(edges, relPath, modules);
    importMaps.set(relPath, importMap);

    if (nodes.length > 0 && edges.length > 0) {
      const localSymbolMap = new Map();
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        localSymbolMap.set(`${n.symbol}::${n.kind}`, nodeIds[i]);
        localSymbolMap.set(n.symbol, nodeIds[i]);
      }

      const resolvedEdges = edges.map(e => {
        let sourceId = typeof e.sourceIndex === 'number' ? nodeIds[e.sourceIndex] : e.sourceId;
        let targetId = typeof e.targetIndex === 'number' ? nodeIds[e.targetIndex] : e.targetId;

        // Global name lookups wait for the deferred pass: resolved now, an
        // ambiguous name would bind to whichever candidate is written first.
        if (sourceId == null && e.source_symbol) {
          sourceId = localSymbolMap.get(`${e.source_symbol}::${e.source_kind}`)
            || localSymbolMap.get(e.source_symbol);

          if (sourceId == null && e.source_kind === 'file' && e.source_symbol === relPath) {
            const fileNodes = inSourceOrder(store.getNodesByFile(subprojectId, relPath));
            const exported = fileNodes.find(n => n.exported);
            if (exported) sourceId = exported.id;
            else if (fileNodes.length > 0) sourceId = fileNodes[0].id;
          }
        }
        // Method calls are resolved once every node is written (below).
        if (targetId == null && e.target_symbol && !e.metadata?.call) {
          targetId = localSymbolMap.get(`${e.target_symbol}::${e.target_kind}`)
            || localSymbolMap.get(e.target_symbol)
            || resolveImportedName(store, subprojectId, relPath, importMap, e, modules);
          // An explicitly imported name whose module has no nodes yet (it may
          // be processed later in this build) waits for the deferred pass
          // instead of binding to an unrelated global match now.

          if (targetId == null && (e.kind === 'imports' || e.kind === 'depends_on')) {
            targetId = resolveModulePath(store, subprojectId, relPath, e.target_symbol, e.metadata, modules, { global: false });
          }
        }

        return { ...e, subprojectId, sourceId, targetId };
      });

      const validEdges = resolvedEdges.filter(e => e.sourceId != null && e.targetId != null && !e.metadata?.call && !isSelfReference(e));
      if (validEdges.length > 0) writeEdges(validEdges);

      const unresolvedEdges = resolvedEdges.filter(e => (e.sourceId == null || e.targetId == null || e.metadata?.call) && e.target_symbol);
      for (const e of unresolvedEdges) {
        deferredEdges.push({ ...e, _sourceFile: relPath });
      }
    }

    nodesCreated += nodeIds.length;
    store.setFileHash(subprojectId, relPath, file.blobHash);
    if (file.status === 'ok') filesProcessed++;
    else skipped++;
  }

  const refsOf = (relPath) => unresolvedByFile.get(relPath);
  const addRef = (relPath, key, kind = 'symbol') => refsOf(relPath).add(`${kind}\x00${key}`);

  if (deferredEdges.length > 0) {
    // All files are processed now — drop cached misses so each unresolved
    // symbol is retried exactly once against the complete graph.
    for (const [key, value] of symbolCache) {
      if (value == null) symbolCache.delete(key);
    }
    const calls = createCallResolver(store, subprojectId);
    for (const e of deferredEdges) {
      if (e.metadata?.call) continue;
      let sourceId = e.sourceId != null && store.getNode(e.sourceId) ? e.sourceId : null;
      if (sourceId == null && e.source_symbol) {
        sourceId = resolveSymbolId(store, subprojectId, e.source_symbol, e.source_kind, symbolCache);
      }

      if (sourceId == null && e.source_symbol && e.source_kind === 'file') {
        const fileNodes = inSourceOrder(store.getNodesByFile(subprojectId, e._sourceFile));
        const exported = fileNodes.find(n => n.exported);
        if (exported) sourceId = exported.id;
        else if (fileNodes.length > 0) sourceId = fileNodes[0].id;
      }

      let targetId = e.targetId != null && store.getNode(e.targetId) ? e.targetId : null;
      if (targetId == null && e.target_symbol) {
        targetId = resolveImportedName(store, subprojectId, e._sourceFile, importMaps.get(e._sourceFile), e, modules)
          || resolveSymbolId(store, subprojectId, e.target_symbol, e.target_kind, symbolCache);
      }

      if (targetId == null && (e.kind === 'imports' || e.kind === 'depends_on') && e.target_symbol) {
        targetId = resolveModulePath(store, subprojectId, e._sourceFile, e.target_symbol, e.metadata, modules);
      }

      if (sourceId != null && targetId != null) {
        if (isSelfReference({ ...e, sourceId, targetId })) continue;
        writeEdges([{ ...e, subprojectId, sourceId, targetId }]);
      } else {
        if (targetId == null) addRef(e._sourceFile, symbolKey(e.target_symbol));
        if (sourceId == null && e.source_symbol) addRef(e._sourceFile, symbolKey(e.source_symbol));
      }
    }

    // Method calls go last: they walk extends/implements/uses_trait edges,
    // which must all be written first.
    for (const e of deferredEdges) {
      if (e.metadata?.call) resolveCallEdge(e);
    }

    function resolveCallEdge(e) {
      const call = e.metadata.call;
      const key = symbolKey(call.method);
      let sourceId = e.sourceId != null && store.getNode(e.sourceId) ? e.sourceId : null;
      if (sourceId == null && e.source_symbol) {
        sourceId = resolveSymbolId(store, subprojectId, e.source_symbol, e.source_kind, symbolCache);
      }
      if (sourceId == null) {
        if (e.source_symbol) addRef(e._sourceFile, symbolKey(e.source_symbol));
        return;
      }
      // Calls on what another call returns depend on those methods' return types.
      for (const name of calls.chainMethods(call)) addRef(e._sourceFile, symbolKey(name), 'soft');
      let hit = calls.resolve(call);
      // A bare `name()` inside a class that is not one of its methods is a
      // top-level function.
      if (!hit && call.implicit) {
        const fnId = resolveSymbolId(store, subprojectId, call.method, 'function', symbolCache);
        if (fnId != null) hit = { targetId: fnId, resolution: 'function', inherited: false };
      }
      if (!hit) {
        if (call.receiver_type) {
          addRef(e._sourceFile, key);
          if (!calls.hasType(call.receiver_type)) addRef(e._sourceFile, symbolKey(call.receiver_type));
        } else {
          // Receiver of unknown type (or of a type no return type tells): a possible call site.
          addRef(e._sourceFile, key, 'call');
        }
        return;
      }
      if (hit.resolution === 'receiver_name' || hit.inherited) {
        addRef(e._sourceFile, key, 'soft');
        if (call.receiver_type) addRef(e._sourceFile, symbolKey(call.receiver_type), 'soft');
        for (const type of hit.path || []) addRef(e._sourceFile, symbolKey(type), 'soft');
      }
      const edgeKey = `${sourceId}\x00${hit.targetId}\x00calls`;
      const existing = callEdges.get(edgeKey);
      callEdges.set(edgeKey, {
        subprojectId,
        sourceId,
        targetId: hit.targetId,
        kind: 'calls',
        metadata: mergeCallMetadata(existing?.metadata, call, hit.resolution),
      });
    }
  }

  const rows = [];
  for (const [key, { edge, lines }] of lineEdges) {
    const metadata = { ...edge.metadata };
    delete metadata.line;
    // A function call and a method call between the same symbols share a row.
    const call = callEdges.get(key);
    if (call) for (const line of call.metadata.lines) lines.add(line);
    const merged = call ? call.metadata : metadata;
    rows.push({ ...edge, metadata: { ...merged, lines: [...lines].sort((a, b) => a - b).slice(0, MAX_EDGE_LINES) } });
  }
  for (const [key, call] of callEdges) if (!lineEdges.has(key)) rows.push(call);
  if (rows.length > 0) {
    store.upsertEdges(rows);
    countNewEdges(rows);
  }

  for (const [relPath, refs] of unresolvedByFile) {
    store.setUnresolvedRefs(subprojectId, relPath, [...refs].map(ref => {
      const [kind, key] = ref.split('\x00');
      return { key, kind };
    }));
  }

  return { filesProcessed, filesDeleted: deletedPaths.length, nodesCreated, edgesCreated: writtenEdges.size, skipped };
}

// Last name segment, lowercased: `App\Models\User`, `Foo.bar`, `./lib/user.js`
// map to `user`, `bar`, `user`. Coarse on purpose — used only to decide which
// files to revisit, never to resolve edges.
function symbolKey(symbol) {
  const text = String(symbol);
  const name = text.includes('/') ? basename(text, extname(text)) : text;
  const segments = name.split(/[\\.:#]+/).filter(Boolean);
  return (segments[segments.length - 1] || name).toLowerCase();
}

// Keys a newly added file can satisfy as a relative import target.
function fileKeys(relPath) {
  const base = basename(relPath, extname(relPath)).toLowerCase();
  return base === 'index' ? [base, basename(dirname(relPath)).toLowerCase()] : [base];
}

function addOracleSource(metadata, source) {
  let value = {};
  if (metadata && typeof metadata === 'object') value = { ...metadata };
  else if (typeof metadata === 'string') {
    try { value = JSON.parse(metadata); } catch {}
  }
  const sources = Array.isArray(value._oracle_sources) ? value._oracle_sources : [];
  value._oracle_sources = [...new Set([...sources, source])];
  return value;
}

function resolveSymbolId(store, subprojectId, symbol, kind, cache) {
  const cacheKey = cache ? `${kind || ''}\x00${symbol}` : null;
  if (cache && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    // A cached id whose node was deleted would make the edge insert fail its
    // foreign key and roll back the whole build.
    if (cached == null || store.getNode(cached)) return cached;
  }

  let rows = kind
    ? store.locate(subprojectId, symbol, kind)
    : store.locate(subprojectId, symbol);
  // Extractors cannot always tell a class from an interface, trait or enum
  // (`use Foo;`, a type hint): a reference to one type kind accepts any.
  if (rows.length === 0 && TYPE_KINDS.has(kind)) {
    rows = store.locate(subprojectId, symbol).filter(n => TYPE_KINDS.has(n.kind));
  }
  // Not locate's ref_count order: counts depend on how much of the graph is
  // written yet, and resolution must not.
  const best = rows.length > 1 ? [...rows].sort(stableRank)[0] : rows[0];
  const id = best ? best.id : null;

  if (cache) cache.set(cacheKey, id);
  return id;
}

function extractSqlTables(content, filePath, subprojectId) {
  const nodes = [];
  const tableColumns = new Map();

  // Phase 1: extract tables with static column lists
  const patterns = [
    { re: /INSERT\s+INTO\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/gi, type: 'insert' },
    { re: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi, type: 'create' },
  ];

  for (const { re, type } of patterns) {
    let m;
    while ((m = re.exec(content))) {
      const table = m[1];
      const colBlock = m[2];

      // Skip dynamic column lists like ${fields.join()}
      if (/\$\{/.test(colBlock)) continue;

      const columns = parseColumns(colBlock, type === 'insert');
      if (columns.length === 0) continue;

      const existing = tableColumns.get(table);
      if (!existing || columns.length > existing.columns.length) {
        tableColumns.set(table, { columns, index: m.index, type });
      }
    }
  }

  // Phase 2: extract UPDATE SET columns for tables not yet found
  const updateRe = /UPDATE\s+[`"']?(\w+)[`"']?\s+SET\s+([^WHERE]+?)(?:\s+WHERE|\s+RETURNING|\s*$)/gi;
  let um;
  while ((um = updateRe.exec(content))) {
    const table = um[1];
    if (tableColumns.has(table)) continue;

    const setBlock = um[2];
    if (/\$\{/.test(setBlock)) continue;

    const columns = setBlock
      .split(',')
      .map(c => c.trim().split(/\s*=\s*/)[0].replace(/[`"']/g, ''))
      .filter(c => c && /^\w+$/.test(c))
      .map(name => ({ name }));

    if (columns.length > 0) {
      tableColumns.set(table, { columns, index: um.index, type: 'update' });
    }
  }

  // Phase 3: tables referenced but only with dynamic columns — record table name only
  const dynInsertRe = /INSERT\s+INTO\s+[`"']?(\w+)[`"']?\s*\(/gi;
  let dm;
  while ((dm = dynInsertRe.exec(content))) {
    const table = dm[1];
    if (!tableColumns.has(table)) {
      tableColumns.set(table, { columns: [], index: dm.index, type: 'dynamic' });
    }
  }

  for (const [table, { columns, index }] of tableColumns) {
    const lineNum = content.slice(0, index).split('\n').length;
    const sig = columns.length > 0
      ? `${table}(${columns.map(c => c.name).join(', ')})`
      : table;

    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'sql',
      symbol: table,
      kind: 'db_table',
      parent_symbol: null,
      start_line: lineNum,
      end_line: lineNum,
      exported: false,
      signature: sig,
      doc: null,
      metadata: columns.length > 0 ? { columns } : null,
    });
  }

  return nodes;
}

function parseColumns(block, isInsert) {
  if (isInsert) {
    return block
      .split(',')
      .map(c => c.trim().replace(/[`"']/g, ''))
      .filter(Boolean)
      .map(name => ({ name }));
  }

  const columns = [];
  for (const line of block.split(',')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX)\s/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const name = parts[0].replace(/[`"']/g, '');
      const type = parts[1].replace(/[`"']/g, '');
      if (name && !/^[($]/.test(name)) {
        columns.push({ name, type });
      }
    }
  }
  return columns;
}

// Local name -> specifier, from the file's own import edges, for specifiers
// that map to files of the subproject (relative paths and aliases).
function importedNames(edges, sourceFile, modules) {
  const map = new Map();
  for (const e of edges) {
    if (e.kind !== 'imports' || !e.target_symbol || modules.candidates(sourceFile, e.target_symbol).length === 0) continue;
    for (const name of e.metadata?.names || []) map.set(name, e.target_symbol);
  }
  return map;
}

function isImportedName(importMap, edge) {
  return edge.kind !== 'imports' && edge.kind !== 'depends_on' && !!importMap?.has(edge.target_symbol);
}

// Resolves a reference through the file's imports: `createParser` imported
// from '../parser/index.js' is that module's node, not whichever global
// `createParser` happens to rank first. Exact names only; aliases fall back
// to global resolution.
function resolveImportedName(store, subprojectId, sourceFile, importMap, edge, modules) {
  if (!isImportedName(importMap, edge)) return null;
  const specifier = importMap.get(edge.target_symbol);
  for (const candidate of modules.candidates(sourceFile, specifier)) {
    const matches = inSourceOrder(store.findNodes({ subprojectId, path: candidate })).filter(n => n.symbol === edge.target_symbol);
    if (matches.length > 0) return (matches.find(n => n.exported) || matches[0]).id;
  }
  return null;
}

// A symbol referring to itself (`class Row implements Insertable<Row>`) says
// nothing; recursion (`calls`) does.
function isSelfReference(edge) {
  return edge.sourceId === edge.targetId && edge.kind !== 'calls';
}

function stableRank(a, b) {
  return (b.exported ? 1 : 0) - (a.exported ? 1 : 0) || a.path.localeCompare(b.path) || a.start_line - b.start_line || a.kind.localeCompare(b.kind);
}

// Row ids depend on a graph's history; picks such as "the file's first
// exported node" must not, or incremental and full builds would differ.
function inSourceOrder(nodes) {
  return [...nodes].sort((a, b) => a.start_line - b.start_line || a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind));
}

function resolveModulePath(store, subprojectId, sourceFile, specifier, metadata, modules, { global = true } = {}) {
  for (const candidate of modules.candidates(sourceFile, specifier)) {
    const nodes = inSourceOrder(store.findNodes({ subprojectId, path: candidate }));
    if (nodes.length === 0) continue;

    if (metadata?.names?.length > 0) {
      for (const name of metadata.names) {
        const match = nodes.find(n => n.symbol === name || n.symbol.endsWith('.' + name));
        if (match) return match.id;
      }
    }

    const exported = nodes.filter(n => n.exported);
    if (exported.length > 0) return exported[0].id;
    return nodes[0].id;
  }

  if (global && metadata?.local) {
    const rows = store.locate(subprojectId, metadata.local);
    if (rows.length > 0) return [...rows].sort(stableRank)[0].id;
  }

  return null;
}
