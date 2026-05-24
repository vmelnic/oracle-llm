import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GroundingWrapper } from '../src/grounding/index.js';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('GroundingWrapper', () => {
  function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-ground-'));
    return path.join(dir, 'test.sqlite');
  }

  it('wraps answers with evidence and confidence', () => {
    const db = tempDb();
    const store = new GraphStore(db);
    const g = new GroundingWrapper(store);

    const result = g.wrap({
      answer: 'foo is here',
      evidence: [
        { path: '/nonexistent/file.js', line_range: [1, 5] },
      ],
      layer: 'L1',
    });

    assert.ok(result.confidence < 0.5);
    assert.ok(result.unverified_evidence);

    store.close();
    fs.rmSync(path.dirname(db), { recursive: true });
  });

  it('rejects when no evidence', () => {
    const db = tempDb();
    const store = new GraphStore(db);
    const g = new GroundingWrapper(store);

    const result = g.enforceEvidence({ answer: 'foo', confidence: 0.9 }, 'oracle.locate');
    assert.strictEqual(result.confidence, 0);
    assert.strictEqual(result.answer, null);
    assert.ok(result._error);

    store.close();
    fs.rmSync(path.dirname(db), { recursive: true });
  });

  it('allows tools without evidence requirements', () => {
    const db = tempDb();
    const store = new GraphStore(db);
    const g = new GroundingWrapper(store);

    const result = g.enforceEvidence({ answer: { total_nodes: 0 }, confidence: 0.9 }, 'oracle.stats');
    assert.strictEqual(result.confidence, 0.9);
    assert.ok(result.answer);

    store.close();
    fs.rmSync(path.dirname(db), { recursive: true });
  });
});
