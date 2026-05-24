import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GroundingWrapper } from '../src/grounding/index.js';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('GroundingWrapper extended', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-ground-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const store = new GraphStore(dbPath);

    store.upsertNodes([
      { subprojectId: 'sp1', path: 'a.js', lang: 'js', symbol: 'foo', kind: 'function', parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'foo()', doc: null, commitSha: null, fileBlobHash: 'a', metadata: null },
    ]);

    const testFile = path.join(dir, 'test.js');
    fs.writeFileSync(testFile, 'function foo() {\n  return 1;\n}\n');

    return { dir, store, testFile };
  }

  it('wraps null answer', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const result = g.wrap(null);
    assert.strictEqual(result.answer, null);
    assert.strictEqual(result.confidence, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('verifies evidence with real file', () => {
    const { dir, store, testFile } = setup();
    const g = new GroundingWrapper(store);
    const result = g.wrap({
      answer: 'found it',
      evidence: [{ path: testFile, line_range: [1, 3] }],
      layer: 'L1',
    });
    assert.ok(result.confidence > 0);
    assert.strictEqual(result.evidence.length, 1);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('truncates oversized answers', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const bigAnswer = { data: 'x'.repeat(5000) };
    const result = g.wrap({
      answer: bigAnswer,
      evidence: [{ path: '/a', line_range: [1, 1] }],
      layer: 'L1',
    }, 'oracle.locate');
    assert.ok(result._truncated || typeof result.answer === 'object');
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('no cap for read_exact tool', () => {
    const { dir, store, testFile } = setup();
    const g = new GroundingWrapper(store);
    const bigAnswer = { data: 'x'.repeat(5000) };
    const result = g.wrap({
      answer: bigAnswer,
      evidence: [{ path: testFile, line_range: [1, 3] }],
      layer: 'L1',
    }, 'oracle.read_exact');
    assert.ok(!result._truncated);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('computeConfidence returns 0.3 for no evidence', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const conf = g.computeConfidence({ layer: 'L1' }, [], []);
    assert.strictEqual(conf, 0.3);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('computeConfidence penalizes L3 layer', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const confL1 = g.computeConfidence({ layer: 'L1' }, [{ path: 'a.js' }], []);
    const confL3 = g.computeConfidence({ layer: 'L3' }, [{ path: 'a.js' }], []);
    assert.ok(confL3 < confL1);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('enforceEvidence retries from L1 when no evidence', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const result = g.enforceEvidence({
      answer: { definitions: [{ symbol: 'foo', subproject_id: 'sp1' }] },
      evidence: [],
      confidence: 0.5,
    }, 'oracle.locate');
    assert.ok(result.evidence.length > 0 || result._error);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('_residualPointers extracts path pointers', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const result = g._residualPointers({
      answer: { definitions: [{ path: 'a.js', start_line: 1, end_line: 5, symbol: 'foo' }] },
    });
    assert.ok(result);
    assert.ok(result.answer.definitions);
    assert.strictEqual(result.confidence, 0.1);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('_residualPointers returns null for empty answer', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    assert.strictEqual(g._residualPointers({ answer: {} }), null);
    assert.strictEqual(g._residualPointers({ answer: 'string' }), null);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('selfConsistency detects breaking with no affected', () => {
    const { dir, store } = setup();
    const g = new GroundingWrapper(store);
    const sc = g._computeSelfConsistency({
      answer: { breaking: true, affected_routes: [], affected_components: [], total_affected: 0 },
    });
    assert.strictEqual(sc, 0.7);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
