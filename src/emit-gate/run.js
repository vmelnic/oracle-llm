import fs from 'node:fs';
import path from 'node:path';
import { PatternCatalogue } from '../patterns/index.js';
import { ManifestDrafter } from '../manifest/index.js';
import { L2Index } from '../retrieval/index.js';
import { EmitGate } from './index.js';

/**
 * Runs the emit gate for a subproject, shared by `oracle gate` and the
 * `oracle.gate` MCP tool. `diff` is either `{ files: [...] }` or a bare array;
 * each change may carry its code as `proposed_code` or `content`.
 */
export async function runEmitGate({ subproject, dir, store, parser, diff }) {
  const catalogue = new PatternCatalogue(store);
  const cataloguePath = path.join(dir, 'pattern_catalog.json');
  if (fs.existsSync(cataloguePath)) catalogue.load(cataloguePath);

  const manifest = new ManifestDrafter().load(path.join(dir, 'manifest.yaml')) || {};
  // LSP settings may live in the manifest or in the scanned subproject.
  const lsp = manifest.lsp || subproject.lsp;
  const sp = lsp ? { ...subproject, lsp } : subproject;
  if (lsp) manifest.lsp = lsp;

  const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index') });
  l2.load();

  const gate = new EmitGate({ subproject: sp, store, parser, l2, patterns: catalogue, manifest });
  return gate.check(normalizeDiff(diff));
}

function normalizeDiff(diff) {
  const files = Array.isArray(diff) ? diff : (diff?.files || []);
  return {
    ...(Array.isArray(diff) ? {} : diff),
    files: files.map(change => ({ ...change, proposed_code: change.proposed_code ?? change.content })),
  };
}
