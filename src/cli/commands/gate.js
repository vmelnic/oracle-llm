import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { loadWorkspace, getSubprojectDir } from '../../scanner/workspace.js';
import { GraphStore } from '../../graph/store.js';
import { PatternCatalogue } from '../../patterns/index.js';
import { ManifestDrafter } from '../../manifest/index.js';
import { createParser } from '../../parser/index.js';
import { L2Index } from '../../retrieval/index.js';
import { EmitGate } from '../../emit-gate/index.js';

export function gateCommand() {
  const cmd = new Command('gate');
  cmd
    .description('Run the emit gate on a proposed diff')
    .argument('<workspace_id>', 'Workspace ID')
    .argument('<subproject_id>', 'Subproject ID')
    .requiredOption('--diff <path>', 'Path to a JSON diff file')
    .action(async (workspaceId, subprojectId, opts) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) {
        console.error(`Workspace '${workspaceId}' not found.`);
        process.exit(1);
      }

      const sp = workspace.subprojects.find((s) => s.id === subprojectId);
      if (!sp) {
        console.error(`Subproject '${subprojectId}' not found.`);
        process.exit(1);
      }

      if (!fs.existsSync(opts.diff)) {
        console.error(`Diff file not found: ${opts.diff}`);
        process.exit(1);
      }

      const diff = JSON.parse(fs.readFileSync(opts.diff, 'utf-8'));

      const dir = getSubprojectDir(workspaceId, subprojectId);
      const dbPath = path.join(dir, 'entity_graph.sqlite');
      if (!fs.existsSync(dbPath)) {
        console.error(`Entity graph not built. Run 'oracle ingest' first.`);
        process.exit(1);
      }

      const store = new GraphStore(dbPath);
      const parser = createParser();

      const catalogue = new PatternCatalogue(store);
      const cataloguePath = path.join(dir, 'pattern_catalog.json');
      if (fs.existsSync(cataloguePath)) catalogue.load(cataloguePath);

      const drafter = new ManifestDrafter();
      const manifest = drafter.load(path.join(dir, 'manifest.yaml')) || {};
      // Prefer manifest LSP config over subproject scan, with fallback
      if (!manifest.lsp && sp.lsp) {
        manifest.lsp = sp.lsp;
      } else if (manifest.lsp && !sp.lsp) {
        sp.lsp = manifest.lsp;
      }

      const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index.json') });
      l2.load();

      const gate = new EmitGate({
        subproject: sp,
        store,
        parser,
        l2,
        patterns: catalogue,
        manifest,
      });

      const result = await gate.check(diff);

      console.log(JSON.stringify(result, null, 2));

      store.close();

      if (!result.committable) {
        process.exit(1);
      }
    });

  return cmd;
}
