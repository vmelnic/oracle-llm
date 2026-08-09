import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { loadWorkspace, getSubprojectDir, saveWorkspace, listWorkspaces } from '../../scanner/workspace.js';
import { scanWorkspace } from '../../scanner/index.js';
import { GraphStore } from '../../graph/store.js';
import { buildGraph } from '../../graph/builder.js';
import { createParser } from '../../parser/index.js';
import { createContractRegistry } from '../../contracts/index.js';
import { PatternCatalogue } from '../../patterns/index.js';
import { ManifestDrafter } from '../../manifest/index.js';
import { L2Index } from '../../retrieval/index.js';
import { processMarkdownFiles } from '../../markdown/index.js';
import { EmitGate } from '../../emit-gate/index.js';
import { acquireFileLock } from '../../utils/file-lock.js';
import { markIngestState, readIngestState } from '../../ingest/state.js';

let sharedParser = null;

function getParser() {
  if (!sharedParser) sharedParser = createParser();
  return sharedParser;
}

async function ingestSubproject(workspaceId, sp, opts = {}) {
  const dir = getSubprojectDir(workspaceId, sp.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireFileLock(path.join(dir, '.ingest.lock'));
  const dbPath = path.join(dir, 'entity_graph.sqlite');
  let store;
  const log = [];

  try {
    markIngestState(dir, 'building');
    store = new GraphStore(dbPath);
    const parser = getParser();
    const graphStats = await buildGraph(sp, parser, store);
    log.push(`entity_graph: ${graphStats.filesProcessed} files, ${graphStats.nodesCreated} nodes, ${graphStats.edgesCreated} edges`);

    const contracts = createContractRegistry(store);
    const surfacesPath = path.join(dir, 'contract_surfaces.json');
    const previousSurfaces = contracts.loadSurfacesJson(surfacesPath);
    const contractStats = await contracts.index(sp, { previousSurfaces });
    log.push(`contracts: ${contractStats.surfacesIndexed} surfaces`);
    contracts.saveSurfacesJson(contractStats.surfaces, surfacesPath);

    const patterns = new PatternCatalogue(store);
    patterns.extract(sp);
    try {
      const gitOutput = execFileSync('git', ['diff', '--name-only', 'HEAD@{1}', 'HEAD', '--'], {
        cwd: sp.root, encoding: 'utf-8', timeout: 5000,
      });
      const changedPaths = gitOutput.trim().split('\n').filter(Boolean);
      if (changedPaths.length > 0) patterns.rerank(changedPaths);
    } catch {}
    const patternCount = patterns.save(path.join(dir, 'pattern_catalog.json'));
    log.push(`patterns: ${patternCount}`);

    const mdStats = processMarkdownFiles(sp, store);
    if (mdStats.nodesCreated > 0 || mdStats.nodesEnriched > 0) {
      log.push(`markdown: ${mdStats.nodesCreated} doc_sections, ${mdStats.nodesEnriched} enriched`);
    }

    const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index.json'), embeddings: opts.embeddings });
    l2.load(); // seeds the hash->vector cache so unchanged nodes are not re-embedded
    const l2Stats = await l2.build(sp.id);
    l2.save();
    const embLabel = l2Stats.vectors > 0 ? ` + ${l2Stats.vectors} vectors (${l2Stats.embedded} embedded, ${l2Stats.reused} cached)` : '';
    log.push(`l2: ${l2Stats.indexed} indexed (BM25${embLabel})`);

    const drafter = new ManifestDrafter();
    const manifestPath = path.join(dir, 'manifest.yaml');
    const existing = drafter.load(manifestPath);
    const drafted = await drafter.draft(sp);
    const manifest = existing ? drafter.merge(existing, drafted) : drafted;
    await drafter.save(manifest, manifestPath);
    log.push(`manifest: ${existing ? 'merged' : 'drafted'}`);

    const storeStats = store.stats(sp.id);
    markIngestState(dir, 'ready', { nodes: storeStats.totalNodes, edges: storeStats.totalEdges });
    return { subproject_id: sp.id, nodes: storeStats.totalNodes, edges: storeStats.totalEdges, log };
  } catch (err) {
    markIngestState(dir, 'failed', { error: err.message });
    throw err;
  } finally {
    if (store) store.close();
    lock.release();
  }
}

// ── Tool handlers ──

export async function ingest(adminCtx, args) {
  const { workspace_id, subproject_id, embeddings } = args;

  const workspace = loadWorkspace(workspace_id);
  if (!workspace) return { error: `Workspace '${workspace_id}' not found. Use oracle.workspace_add first.` };

  const targets = subproject_id
    ? workspace.subprojects.filter(s => s.id === subproject_id)
    : workspace.subprojects;

  if (targets.length === 0) return { error: `No matching subproject(s) for '${subproject_id}'.` };

  const results = [];
  for (const sp of targets) {
    const stats = await ingestSubproject(workspace_id, sp, { embeddings });
    adminCtx.evict(workspace_id, sp.id);
    results.push(stats);
  }

  return { workspace_id, ingested: results.length, subprojects: results };
}

export async function workspaceAdd(adminCtx, args) {
  const dirPath = args.path;
  if (!dirPath) return { error: 'path is required' };

  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) return { error: `Path not found: ${resolved}` };
  const root = fs.realpathSync(resolved);
  if (!fs.statSync(root).isDirectory()) return { error: `Path is not a directory: ${root}` };
  if (adminCtx.allowedRoots?.length > 0 && !adminCtx.allowedRoots.some(allowed => isPathInside(allowed, root))) {
    return { error: `Path is outside ORACLE_ALLOWED_ROOTS: ${root}` };
  }

  const workspace = await scanWorkspace(root);
  saveWorkspace(workspace);

  return {
    workspace_id: workspace.id,
    root: workspace.root,
    subprojects: workspace.subprojects.map(sp => ({
      id: sp.id,
      framework: sp.framework || sp.language,
      build_manifest: sp.buildManifest,
    })),
  };
}

function isPathInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function workspaceScan(adminCtx, args) {
  const { workspace_id } = args;
  const existing = loadWorkspace(workspace_id);
  if (!existing) return { error: `Workspace '${workspace_id}' not found.` };

  const workspace = await scanWorkspace(existing.root);
  workspace.id = workspace_id;
  saveWorkspace(workspace);

  for (const sp of workspace.subprojects) {
    adminCtx.evict(workspace_id, sp.id);
  }

  return {
    workspace_id,
    root: workspace.root,
    subprojects: workspace.subprojects.map(sp => ({
      id: sp.id,
      framework: sp.framework || sp.language,
      build_manifest: sp.buildManifest,
    })),
  };
}

export async function workspaceListTool(adminCtx) {
  const ids = listWorkspaces();
  const workspaces = [];

  for (const id of ids) {
    const ws = loadWorkspace(id);
    if (ws?.root && !adminCtx.isRootAllowed(ws.root)) continue;
    workspaces.push({
      id,
      root: ws?.root || 'unknown',
      subprojects: ws?.subprojects?.map(sp => sp.id) || [],
    });
  }

  return { workspaces };
}

export async function status(adminCtx, args) {
  const { workspace_id } = args;
  const ids = workspace_id ? [workspace_id] : listWorkspaces();

  if (ids.length === 0) return { workspaces: [], hint: 'No workspaces. Use oracle.workspace_add.' };

  const result = [];
  for (const id of ids) {
    const workspace = loadWorkspace(id);
    if (!workspace) continue;
    if (!adminCtx.isRootAllowed(workspace.root)) continue;

    const subprojects = [];
    for (const sp of workspace.subprojects) {
      const dir = getSubprojectDir(id, sp.id);
      const ingestState = readIngestState(dir);
      const ingesting = fs.existsSync(path.join(dir, '.ingest.lock'))
        || ingestState?.status === 'building';
      const layers = [];
      if (fs.existsSync(path.join(dir, 'entity_graph.sqlite'))) layers.push('L1-graph');
      if (fs.existsSync(path.join(dir, 'pattern_catalog.json'))) layers.push('L1-patterns');
      if (fs.existsSync(path.join(dir, 'manifest.yaml'))) layers.push('L1-manifest');
      if (fs.existsSync(path.join(dir, 'ast_embed_index', 'bm25.json')) || fs.existsSync(path.join(dir, 'ast_embed_index.json'))) layers.push('L2');

      let nodes = 0, edges = 0;
      if (layers.includes('L1-graph') && !ingesting) {
        try {
          const store = new GraphStore(path.join(dir, 'entity_graph.sqlite'));
          const s = store.stats(sp.id);
          nodes = s.totalNodes;
          edges = s.totalEdges;
          store.close();
        } catch {}
      }

      subprojects.push({
        id: sp.id,
        framework: sp.framework || 'unknown',
        language: sp.language,
        layers,
        ingest: ingesting
          ? { ...(ingestState || {}), status: 'building' }
          : (ingestState || { status: layers.includes('L1-graph') ? 'legacy/unknown' : 'not-run' }),
        nodes,
        edges,
      });
    }

    result.push({ workspace_id: id, root: workspace.root, subprojects });
  }

  return { workspaces: result };
}

export async function gate(adminCtx, args) {
  const { workspace_id, subproject_id, diff } = args;

  const workspace = loadWorkspace(workspace_id);
  if (!workspace) return { error: `Workspace '${workspace_id}' not found.` };

  const sp = workspace.subprojects.find(s => s.id === subproject_id);
  if (!sp) return { error: `Subproject '${subproject_id}' not found.` };

  if (!diff || !Array.isArray(diff) || diff.length === 0) {
    return { error: 'diff is required — array of {path, content} objects' };
  }

  const dir = getSubprojectDir(workspace_id, subproject_id);
  const dbPath = path.join(dir, 'entity_graph.sqlite');
  if (!fs.existsSync(dbPath)) return { error: 'Entity graph not built. Run oracle.ingest first.' };

  const store = new GraphStore(dbPath);
  try {
    const parser = getParser();
    const catalogue = new PatternCatalogue(store);
    const cataloguePath = path.join(dir, 'pattern_catalog.json');
    if (fs.existsSync(cataloguePath)) catalogue.load(cataloguePath);

    const drafter = new ManifestDrafter();
    const manifest = drafter.load(path.join(dir, 'manifest.yaml')) || {};
    const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index.json') });
    l2.load();

    const emitGate = new EmitGate({ subproject: sp, store, parser, l2, patterns: catalogue, manifest });
    const normalizedDiff = {
      files: diff.map(change => ({
        ...change,
        proposed_code: change.proposed_code ?? change.content,
      })),
    };
    return await emitGate.check(normalizedDiff);
  } finally {
    store.close();
  }
}

export async function manifestShow(adminCtx, args) {
  const { workspace_id, subproject_id } = args;
  const workspace = loadWorkspace(workspace_id);
  if (!workspace) return { error: `Workspace '${workspace_id}' not found.` };
  if (!workspace.subprojects.some(sp => sp.id === subproject_id)) {
    return { error: `Subproject '${subproject_id}' not found.` };
  }

  const dir = getSubprojectDir(workspace_id, subproject_id);
  const manifestPath = path.join(dir, 'manifest.yaml');
  const drafter = new ManifestDrafter();
  const manifest = drafter.load(manifestPath);

  if (!manifest) return { error: `No manifest for ${workspace_id}/${subproject_id}. Run oracle.ingest first.` };
  return { manifest };
}

export async function patternsList(adminCtx, args) {
  const { workspace_id, subproject_id } = args;
  const workspace = loadWorkspace(workspace_id);
  if (!workspace) return { error: `Workspace '${workspace_id}' not found.` };
  if (!workspace.subprojects.some(sp => sp.id === subproject_id)) {
    return { error: `Subproject '${subproject_id}' not found.` };
  }

  const dir = getSubprojectDir(workspace_id, subproject_id);
  const dbPath = path.join(dir, 'entity_graph.sqlite');
  if (!fs.existsSync(dbPath)) return { error: 'Entity graph not built. Run oracle.ingest first.' };

  const store = new GraphStore(dbPath);
  try {
    const catalogue = new PatternCatalogue(store);
    const cataloguePath = path.join(dir, 'pattern_catalog.json');
    if (fs.existsSync(cataloguePath)) catalogue.load(cataloguePath);

    const patterns = catalogue.listPatterns();
    return {
      count: patterns.length,
      patterns: patterns.map(p => ({
        name: p.name,
        kind: p.kind,
        frequency: p.frequency,
        canonical: p.canonical,
      })),
    };
  } finally {
    store.close();
  }
}
