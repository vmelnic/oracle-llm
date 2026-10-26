import path from 'path';
import fs from 'fs';
import { loadWorkspace, getSubprojectDir, saveWorkspace, listWorkspaces } from '../../scanner/workspace.js';
import { scanWorkspace } from '../../scanner/index.js';
import { GraphStore } from '../../graph/store.js';
import { createParser } from '../../parser/index.js';
import { PatternCatalogue } from '../../patterns/index.js';
import { ManifestDrafter } from '../../manifest/index.js';
import { runEmitGate } from '../../emit-gate/run.js';
import { readIngestState } from '../../ingest/state.js';
import { describeIngest, ingestSubproject } from '../../ingest/pipeline.js';

let sharedParser = null;

function getParser() {
  if (!sharedParser) sharedParser = createParser();
  return sharedParser;
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
  const failed = [];
  for (const subproject of targets) {
    try {
      const stats = await ingestSubproject({ workspaceId: workspace_id, subproject, parser: getParser(), embeddings });
      results.push({
        subproject_id: subproject.id,
        nodes: stats.totals.totalNodes,
        edges: stats.totals.totalEdges,
        log: describeIngest(stats),
      });
    } catch (err) {
      failed.push({ subproject_id: subproject.id, error: err.message });
    } finally {
      adminCtx.evict(workspace_id, subproject.id);
    }
  }

  return {
    workspace_id,
    ingested: results.length,
    subprojects: results,
    ...(failed.length > 0 ? { failed, error: `Failed subprojects: ${failed.map(f => f.subproject_id).join(', ')}` } : {}),
  };
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

  let workspace;
  try {
    workspace = await scanWorkspace(root, { only: args.subprojects });
  } catch (err) {
    return { error: err.message };
  }
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

  // Without `subprojects`, the selection saved at add time is kept; an empty
  // list selects everything again.
  let workspace;
  try {
    workspace = await scanWorkspace(existing.root, { only: args.subprojects ?? existing.only });
  } catch (err) {
    return { error: err.message };
  }
  workspace.id = workspace_id;
  saveWorkspace(workspace);

  for (const sp of new Set([...existing.subprojects, ...workspace.subprojects].map(s => s.id))) {
    adminCtx.evict(workspace_id, sp);
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
    return await runEmitGate({ subproject: sp, dir, store, parser: getParser(), diff });
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
