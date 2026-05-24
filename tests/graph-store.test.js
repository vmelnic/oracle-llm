import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('GraphStore', () => {
  function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-db-'));
    return path.join(dir, 'test.sqlite');
  }

  it('creates schema and inserts nodes', () => {
    const db = tempDb();
    const store = new GraphStore(db);

    const ids = store.upsertNodes([
      {
        subprojectId: 'sp1',
        path: 'src/index.js',
        lang: 'javascript',
        symbol: 'foo',
        kind: 'function',
        parentId: null,
        startLine: 1,
        endLine: 10,
        exported: true,
        signature: 'foo()',
        doc: null,
        commitSha: null,
        fileBlobHash: 'abc',
        metadata: { async: true },
      },
    ]);

    assert.strictEqual(ids.length, 1);
    assert.strictEqual(typeof ids[0], 'number');

    const found = store.locate('sp1', 'foo');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].symbol, 'foo');

    store.close();
    fs.rmSync(path.dirname(db), { recursive: true });
  });

  it('tracks edges and consumers', () => {
    const db = tempDb();
    const store = new GraphStore(db);

    const [n1, n2] = store.upsertNodes([
      {
        subprojectId: 'sp1',
        path: 'a.js',
        lang: 'javascript',
        symbol: 'foo',
        kind: 'function',
        parentId: null,
        startLine: 1,
        endLine: 5,
        exported: true,
        signature: 'foo()',
        doc: null,
        commitSha: null,
        fileBlobHash: 'a',
        metadata: null,
      },
      {
        subprojectId: 'sp1',
        path: 'b.js',
        lang: 'javascript',
        symbol: 'bar',
        kind: 'function',
        parentId: null,
        startLine: 1,
        endLine: 5,
        exported: true,
        signature: 'bar()',
        doc: null,
        commitSha: null,
        fileBlobHash: 'b',
        metadata: null,
      },
    ]);

    store.upsertEdges([
      {
        subprojectId: 'sp1',
        sourceId: n2,
        targetId: n1,
        kind: 'calls',
        metadata: null,
      },
    ]);

    const consumers = store.consumers('sp1', n1);
    assert.strictEqual(consumers.length, 1);
    assert.strictEqual(consumers[0].symbol, 'bar');

    store.close();
    fs.rmSync(path.dirname(db), { recursive: true });
  });

  it('computes impact BFS', () => {
    const db = tempDb();
    const store = new GraphStore(db);

    const [n1, n2, n3] = store.upsertNodes([
      {
        subprojectId: 'sp1', path: 'a.js', lang: 'js', symbol: 'A', kind: 'function',
        parentId: null, startLine: 1, endLine: 2, exported: true, signature: 'A()', doc: null,
        commitSha: null, fileBlobHash: 'a', metadata: null,
      },
      {
        subprojectId: 'sp1', path: 'b.js', lang: 'js', symbol: 'B', kind: 'function',
        parentId: null, startLine: 1, endLine: 2, exported: true, signature: 'B()', doc: null,
        commitSha: null, fileBlobHash: 'b', metadata: null,
      },
      {
        subprojectId: 'sp1', path: 'c.js', lang: 'js', symbol: 'C', kind: 'function',
        parentId: null, startLine: 1, endLine: 2, exported: true, signature: 'C()', doc: null,
        commitSha: null, fileBlobHash: 'c', metadata: null,
      },
    ]);

    store.upsertEdges([
      { subprojectId: 'sp1', sourceId: n2, targetId: n1, kind: 'calls', metadata: null },
      { subprojectId: 'sp1', sourceId: n3, targetId: n2, kind: 'calls', metadata: null },
    ]);

    const impact = store.impact('sp1', [n1]);
    assert.strictEqual(impact.length, 2);
    assert.ok(impact.some((n) => n.symbol === 'B'));
    assert.ok(impact.some((n) => n.symbol === 'C'));

    store.close();
    fs.rmSync(path.dirname(db), { recursive: true });
  });
});
