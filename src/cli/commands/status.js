import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { loadWorkspace, listWorkspaces, getSubprojectDir } from '../../scanner/workspace.js';
import { GraphStore } from '../../graph/store.js';
import { readIngestState } from '../../ingest/state.js';

export function statusCommand() {
  const cmd = new Command('status');
  cmd
    .description('Show status of workspaces and their subprojects')
    .argument('[workspace_id]', 'Optional workspace ID')
    .action((workspaceId) => {
      const ids = workspaceId ? [workspaceId] : listWorkspaces();

      if (ids.length === 0) {
        console.log('No workspaces. Use `oracle workspace add <path>`.');
        return;
      }

      for (const id of ids) {
        const workspace = loadWorkspace(id);
        if (!workspace) {
          console.log(`${id}: not found`);
          continue;
        }

        console.log(`\n${id} — ${workspace.root}`);
        for (const sp of workspace.subprojects) {
          const dir = getSubprojectDir(id, sp.id);
          const hasGraph = fs.existsSync(path.join(dir, 'entity_graph.sqlite'));
          const hasPatterns = fs.existsSync(path.join(dir, 'pattern_catalog.json'));
          const hasManifest = fs.existsSync(path.join(dir, 'manifest.yaml'));
          const hasL2 = fs.existsSync(path.join(dir, 'ast_embed_index.json'))
            || fs.existsSync(path.join(dir, 'ast_embed_index', 'bm25.json'));
          const ingestState = readIngestState(dir);
          const ingesting = fs.existsSync(path.join(dir, '.ingest.lock'))
            || ingestState?.status === 'building';
          let nodeCount = '-';
          let edgeCount = '-';
          if (hasGraph && !ingesting) {
            try {
              const store = new GraphStore(path.join(dir, 'entity_graph.sqlite'));
              const s = store.stats(sp.id);
              nodeCount = s.totalNodes;
              edgeCount = s.totalEdges;
              store.close();
            } catch {}
          }

          const layers = [];
          if (hasGraph) layers.push('L1-graph');
          if (hasPatterns) layers.push('L1-patterns');
          if (hasManifest) layers.push('L1-manifest');
          if (hasL2) layers.push('L2-retrieval');

          console.log(`  ${sp.id}`);
          console.log(`    framework: ${sp.framework || 'unknown'} | lang: ${sp.language}`);
          console.log(`    layers: ${layers.length > 0 ? layers.join(', ') : 'none (run ingest)'}`);
          console.log(`    ingest: ${ingesting ? 'building' : (ingestState?.status || (hasGraph ? 'legacy/unknown' : 'not-run'))}`);
          console.log(`    nodes: ${nodeCount} | edges: ${edgeCount}`);
        }
      }
    });

  return cmd;
}
