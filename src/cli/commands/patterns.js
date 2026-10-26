import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { requireGraph, requireSubproject } from '../resolve.js';
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
      requireSubproject(workspaceId, subprojectId);
      const { dir, dbPath } = requireGraph(workspaceId, subprojectId);
      const cataloguePath = path.join(dir, 'pattern_catalog.json');
      if (!fs.existsSync(cataloguePath)) {
        throw new Error(`No pattern catalogue for '${workspaceId}/${subprojectId}'. Run \`oracle ingest ${workspaceId}\` first.`);
      }

      const store = new GraphStore(dbPath);
      try {
        listPatterns(store, cataloguePath, opts);
      } finally {
        store.close();
      }
    });

  return cmd;
}

function listPatterns(store, cataloguePath, opts) {
  const catalogue = new PatternCatalogue(store);
  const count = catalogue.load(cataloguePath);

  if (count === 0) {
    console.log('The pattern catalogue is empty.');
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
}
