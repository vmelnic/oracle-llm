import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EmitGate } from '../src/emit-gate/index.js';
import { GraphStore } from '../src/graph/store.js';
import { PatternCatalogue } from '../src/patterns/index.js';
import { L2Index } from '../src/retrieval/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-gate2-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new GraphStore(dbPath);
  const patterns = new PatternCatalogue(store);
  const manifest = {};
  const l2 = new L2Index(store, {});
  const spRoot = path.join(dir, 'project');
  fs.mkdirSync(spRoot, { recursive: true });
  return { dir, store, patterns, manifest, l2, spRoot };
}

describe('EmitGate extended', () => {
  it('handles empty diff', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();
    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const result = await gate.check({ files: [] });
    assert.ok(result.committable === true || result.committable === false);
    assert.ok(Array.isArray(result.steps));

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('handles multiple files in diff', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();
    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const diff = {
      files: [
        { path: 'a.js', action: 'create', content: 'export const a = 1;\n' },
        { path: 'b.js', action: 'create', content: 'export const b = 2;\n' },
      ],
    };

    const result = await gate.check(diff);
    assert.ok(typeof result.committable === 'boolean');

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('handles delete action', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();
    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const diff = {
      files: [{ path: 'old.js', action: 'delete' }],
    };

    const result = await gate.check(diff);
    assert.ok(typeof result.committable === 'boolean');

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('handles non-JS file gracefully', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();
    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const diff = {
      files: [{ path: 'readme.md', action: 'modify', content: '# Hello\n' }],
    };

    const result = await gate.check(diff);
    assert.ok(typeof result.committable === 'boolean');

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
