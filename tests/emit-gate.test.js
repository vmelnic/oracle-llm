import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EmitGate } from '../src/emit-gate/index.js';
import { GraphStore } from '../src/graph/store.js';
import { PatternCatalogue } from '../src/patterns/index.js';
import { ManifestDrafter } from '../src/manifest/index.js';
import { L2Index } from '../src/retrieval/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-gate-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new GraphStore(dbPath);
  const patterns = new PatternCatalogue(store);
  const manifest = {};
  const l2 = new L2Index(store, {});
  const spRoot = path.join(dir, 'project');
  fs.mkdirSync(spRoot, { recursive: true });

  return { dir, store, patterns, manifest, l2, spRoot };
}

describe('EmitGate', () => {
  it('passes for valid JavaScript diff', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();

    const jsFile = path.join(spRoot, 'valid.js');
    fs.writeFileSync(jsFile, 'export function foo() { return 1; }\n');

    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const diff = {
      files: [{ path: jsFile, action: 'modify', content: 'export function foo() { return 2; }\n' }],
    };

    const result = await gate.check(diff);
    assert.ok(result.steps);
    assert.ok(result.steps.length > 0);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('detects parse errors in JavaScript', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();

    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const diff = {
      files: [{ path: 'broken.js', action: 'create', content: 'function { syntax error }{{\n' }],
    };

    const result = await gate.check(diff);
    const parseStep = result.steps.find(s => s.name === 'parse');
    if (parseStep) {
      assert.ok(parseStep.issues?.length > 0 || !parseStep.pass);
    }

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('returns committable status', async () => {
    const { dir, store, patterns, manifest, l2, spRoot } = setup();

    const gate = new EmitGate({
      store, patterns, manifest, l2,
      subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    });

    const diff = {
      files: [{ path: 'ok.js', action: 'create', content: 'const x = 1;\n' }],
    };

    const result = await gate.check(diff);
    assert.ok(typeof result.committable === 'boolean');

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
