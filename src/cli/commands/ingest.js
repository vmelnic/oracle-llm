import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { loadWorkspace, getSubprojectDir } from '../../scanner/workspace.js';
import { GraphStore } from '../../graph/store.js';
import { buildGraph } from '../../graph/builder.js';
import { createParser } from '../../parser/index.js';
import { createContractRegistry } from '../../contracts/index.js';
import { PatternCatalogue } from '../../patterns/index.js';
import { ManifestDrafter } from '../../manifest/index.js';
import { L2Index } from '../../retrieval/index.js';
import { processMarkdownFiles } from '../../markdown/index.js';
import { acquireFileLock } from '../../utils/file-lock.js';
import { markIngestState } from '../../ingest/state.js';


export function ingestCommand() {
  const cmd = new Command('ingest');
  cmd
    .description('Build entity graph, patterns, manifest, and contracts for a subproject (or all)')
    .argument('<workspace_id>', 'Workspace ID')
    .argument('[subproject_id]', 'Optional subproject ID (ingests all if omitted)')
    .option('--embeddings', 'Enable semantic embeddings for L2 index')
    .option('--no-embeddings', 'Disable semantic embeddings')
    .action(async (workspaceId, subprojectId, opts) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) {
        console.error(`Workspace '${workspaceId}' not found.`);
        process.exit(1);
      }

      const targets = subprojectId
        ? workspace.subprojects.filter(s => s.id === subprojectId)
        : workspace.subprojects;

      if (targets.length === 0) {
        console.error(`No matching subproject(s).`);
        process.exit(1);
      }

      const parser = createParser();
      console.log(`Parser loaded: ${parser.supportedLanguages().join(', ')}`);

      const failed = [];

      for (const sp of targets) {
        console.log(`\nIngesting ${sp.id} ...`);
        const dir = getSubprojectDir(workspaceId, sp.id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const lock = acquireFileLock(path.join(dir, '.ingest.lock'));
        const dbPath = path.join(dir, 'entity_graph.sqlite');
        let store;

        try {
          markIngestState(dir, 'building');
          store = new GraphStore(dbPath);
          const graphStats = await buildGraph(sp, parser, store);
          console.log(`  Entity graph: ${graphStats.filesProcessed} files, ${graphStats.nodesCreated} nodes, ${graphStats.edgesCreated} edges (${graphStats.skipped} skipped)`);

          const contracts = createContractRegistry(store);
          const surfacesPath = path.join(dir, 'contract_surfaces.json');
          const previousSurfaces = contracts.loadSurfacesJson(surfacesPath);
          const contractStats = await contracts.index(sp, { previousSurfaces });
          console.log(`  Contracts: ${contractStats.surfacesIndexed} surfaces indexed`);

          contracts.saveSurfacesJson(contractStats.surfaces, surfacesPath);

          const patterns = new PatternCatalogue(store);
          patterns.extract(sp);

          // Rerank patterns based on recently changed files
          try {
            const gitOutput = execFileSync('git', ['diff', '--name-only', 'HEAD@{1}', 'HEAD', '--'], {
              cwd: sp.root,
              encoding: 'utf-8',
              timeout: 5000,
            });
            const changedPaths = gitOutput.trim().split('\n').filter(Boolean);
            if (changedPaths.length > 0) {
              patterns.rerank(changedPaths);
            }
          } catch {
            // No git history or not a repo — skip rerank
          }

          const cataloguePath = path.join(dir, 'pattern_catalog.json');
          const patternCount = patterns.save(cataloguePath);
          console.log(`  Patterns: ${patternCount} patterns extracted`);

          const mdStats = processMarkdownFiles(sp, store);
          if (mdStats.nodesCreated > 0 || mdStats.nodesEnriched > 0) {
            console.log(`  Markdown: ${mdStats.nodesCreated} doc sections, ${mdStats.nodesEnriched} nodes enriched (${mdStats.filesProcessed} files)`);
          }

          const embeddingsOpt = opts.embeddings !== undefined ? opts.embeddings : undefined;
          const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index.json'), embeddings: embeddingsOpt });
          l2.load(); // seeds the hash->vector cache so unchanged nodes are not re-embedded
          const l2Stats = await l2.build(sp.id);
          l2.save();
          const embLabel = l2Stats.vectors > 0
            ? ` + ${l2Stats.vectors} vectors (${l2Stats.embedded} embedded, ${l2Stats.reused} cached)`
            : '';
          console.log(`  L2 index: ${l2Stats.indexed} nodes indexed (BM25${embLabel})`);

          const drafter = new ManifestDrafter();
          const manifestPath = path.join(dir, 'manifest.yaml');
          let manifest;
          const existing = drafter.load(manifestPath);
          const drafted = await drafter.draft(sp);
          if (existing) {
            manifest = drafter.merge(existing, drafted);
            console.log(`  Manifest: merged with existing`);
          } else {
            manifest = drafted;
            console.log(`  Manifest: auto-drafted`);
          }
          await drafter.save(manifest, manifestPath);

          const storeStats = store.stats(sp.id);
          console.log(`  Totals: ${storeStats.totalNodes} nodes, ${storeStats.totalEdges} edges`);
          markIngestState(dir, 'ready', { nodes: storeStats.totalNodes, edges: storeStats.totalEdges });

        } catch (err) {
          console.error(`  ERROR: ${err.message}`);
          markIngestState(dir, 'failed', { error: err.message });
          failed.push(sp.id);
        } finally {
          if (store) store.close();
          lock.release();
        }
      }

      if (failed.length > 0) {
        console.error(`\nFailed subprojects: ${failed.join(', ')}`);
        process.exit(1);
      }
      console.log('\nDone.');
    });

  return cmd;
}
