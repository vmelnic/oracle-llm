import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GraphStore } from '../graph/store.js';
import { buildGraph } from '../graph/builder.js';
import { createContractRegistry } from '../contracts/index.js';
import { PatternCatalogue } from '../patterns/index.js';
import { ManifestDrafter } from '../manifest/index.js';
import { L2Index } from '../retrieval/index.js';
import { processMarkdownFiles } from '../markdown/index.js';
import { getSubprojectDir } from '../scanner/workspace.js';
import { acquireFileLock } from '../utils/file-lock.js';
import { markIngestState } from './state.js';

/**
 * The one ingest sequence shared by the CLI, the MCP admin tool, the file
 * watcher and git hooks. Order matters: patterns are extracted after markdown
 * so doc sections are present on the first ingest as on every later one, and
 * the L2 index is built last over the final node set.
 *
 * The caller owns the store, the lock and the ingest state. Pass a long-lived
 * `l2` (the watcher) to reuse its embedding cache; otherwise one is created
 * and seeded from disk so unchanged nodes are not re-embedded.
 */
export async function runIngestPipeline({ subproject, dir, store, parser, embeddings, changedPaths, l2 }) {
  const graph = await buildGraph(subproject, parser, store);

  const contracts = createContractRegistry(store);
  const surfacesPath = path.join(dir, 'contract_surfaces.json');
  const contractStats = await contracts.index(subproject, { previousSurfaces: contracts.loadSurfacesJson(surfacesPath) });
  contracts.saveSurfacesJson(contractStats.surfaces, surfacesPath);

  const markdown = processMarkdownFiles(subproject, store);

  const patterns = new PatternCatalogue(store);
  patterns.extract(subproject);
  const recent = changedPaths ?? recentlyChangedPaths(subproject.root);
  if (recent.length > 0) patterns.rerank(recent);
  const patternCount = patterns.save(path.join(dir, 'pattern_catalog.json'));

  let index = l2;
  if (!index) {
    index = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index'), embeddings });
    index.load();
  }
  const l2Stats = await index.build(subproject.id);
  index.save();

  const drafter = new ManifestDrafter();
  const manifestPath = path.join(dir, 'manifest.yaml');
  // The last raw draft is kept beside the manifest so the next merge can tell
  // user edits (kept) from stale derived values (refreshed).
  const draftPath = path.join(dir, 'manifest.drafted.yaml');
  const existing = drafter.load(manifestPath);
  const drafted = await drafter.draft(subproject);
  await drafter.save(existing ? drafter.merge(existing, drafted, drafter.load(draftPath)) : drafted, manifestPath);
  await drafter.save(drafted, draftPath);

  return {
    graph,
    contracts: contractStats.surfacesIndexed,
    markdown,
    patterns: patternCount,
    l2: l2Stats,
    manifest: existing ? 'merged' : 'drafted',
    totals: store.stats(subproject.id),
  };
}

/**
 * Lock, open the store, run the pipeline and record the ingest state for one
 * subproject. Throws ORACLE_LOCKED (state untouched) when another ingest owns
 * the subproject; on any other failure the state is marked `failed`.
 */
export async function ingestSubproject({ workspaceId, subproject, parser, embeddings }) {
  const dir = getSubprojectDir(workspaceId, subproject.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireFileLock(path.join(dir, '.ingest.lock'));
  let store;
  try {
    markIngestState(dir, 'building');
    store = new GraphStore(path.join(dir, 'entity_graph.sqlite'));
    const stats = await runIngestPipeline({ subproject, dir, store, parser, embeddings });
    markIngestState(dir, 'ready', { nodes: stats.totals.totalNodes, edges: stats.totals.totalEdges });
    return stats;
  } catch (err) {
    markIngestState(dir, 'failed', { error: err.message });
    throw err;
  } finally {
    if (store) store.close();
    lock.release();
  }
}

/** One-line summaries of pipeline stats, shared by CLI and MCP output. */
export function describeIngest(stats) {
  const { graph, l2 } = stats;
  const vectors = l2.vectors > 0 ? ` + ${l2.vectors} vectors (${l2.embedded ?? 0} embedded, ${l2.reused ?? 0} cached)` : '';
  return [
    `entity graph: ${graph.filesProcessed} files processed, ${graph.filesDeleted} deleted, ${graph.nodesCreated} nodes, ${graph.edgesCreated} edges (${graph.skipped} unchanged/skipped)`,
    `contracts: ${stats.contracts} surfaces`,
    `markdown: ${stats.markdown.nodesCreated} doc sections, ${stats.markdown.nodesEnriched} nodes enriched (${stats.markdown.filesProcessed} files)`,
    `patterns: ${stats.patterns}`,
    `L2 index: ${l2.indexed} nodes (BM25${vectors})`,
    `manifest: ${stats.manifest}`,
    `totals: ${stats.totals.totalNodes} nodes, ${stats.totals.totalEdges} edges`,
  ];
}

// Files changed by the last checkout/merge, used to rank fresh patterns first.
function recentlyChangedPaths(root) {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD@{1}', 'HEAD', '--'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
