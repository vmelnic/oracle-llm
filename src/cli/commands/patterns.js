import { Command } from 'commander';
import path from 'path';
import { loadWorkspace, getSubprojectDir } from '../../scanner/workspace.js';
import { GraphStore } from '../../graph/store.js';
import { PatternCatalogue } from '../../patterns/index.js';

export function patternsCommand() {
  const cmd = new Command('patterns');
  cmd.description('Manage pattern catalogue');

  cmd
    .command('list <workspace_id> <subproject_id>')
    .description('List extracted patterns for a subproject')
    .option('--kind <kind>', 'Filter by node kind')
    .action((workspaceId, subprojectId, opts) => {
      const dir = getSubprojectDir(workspaceId, subprojectId);
      const cataloguePath = path.join(dir, 'pattern_catalog.json');

      const dbPath = path.join(dir, 'entity_graph.sqlite');
      const store = new GraphStore(dbPath);
      const catalogue = new PatternCatalogue(store);
      const count = catalogue.load(cataloguePath);

      if (count === 0) {
        console.log('No patterns found. Run `oracle ingest` first.');
        store.close();
        return;
      }

      let patterns = catalogue.listPatterns();
      if (opts.kind) {
        patterns = patterns.filter(p => p.kind === opts.kind);
      }

      for (const p of patterns) {
        console.log(`\n${p.name}`);
        console.log(`  kind: ${p.kind}`);
        console.log(`  frequency: ${p.frequency.count}/${p.frequency.total}`);
        console.log(`  canonical: ${p.canonical.path}:${p.canonical.line}`);
        if (p.variants.length > 0) {
          console.log(`  variants: ${p.variants.map(v => v.name).join(', ')}`);
        }
      }

      console.log(`\n${patterns.length} pattern(s) total.`);
      store.close();
    });

  return cmd;
}
