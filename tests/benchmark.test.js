import { describe, it } from 'node:test';
import assert from 'node:assert';
import { estimateTokens, BenchmarkRunner, generateDefaultTasks } from '../src/benchmark/index.js';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('estimateTokens', () => {
  it('estimates tokens from string', () => {
    const tokens = estimateTokens('hello world this is a test');
    assert.ok(tokens > 0);
    assert.ok(tokens < 20);
  });

  it('estimates tokens from object', () => {
    const tokens = estimateTokens({ answer: 'foo', evidence: [{ path: 'a.js' }] });
    assert.ok(tokens > 0);
  });

  it('returns 0 for null', () => {
    assert.strictEqual(estimateTokens(null), 0);
  });
});

describe('generateDefaultTasks', () => {
  it('generates tasks from graph store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-bench-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const store = new GraphStore(dbPath);

    store.upsertNodes([
      {
        subprojectId: 'sp1', path: 'a.js', lang: 'js', symbol: 'foo', kind: 'function',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'foo()',
        doc: null, commitSha: null, fileBlobHash: 'a', metadata: null,
      },
      {
        subprojectId: 'sp1', path: 'b.js', lang: 'js', symbol: 'GET /users', kind: 'route',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'GET /users',
        doc: null, commitSha: null, fileBlobHash: 'b', metadata: null,
      },
      {
        subprojectId: 'sp1', path: 'c.js', lang: 'js', symbol: 'users', kind: 'db_table',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: null,
        doc: null, commitSha: null, fileBlobHash: 'c', metadata: null,
      },
    ]);

    const tasks = generateDefaultTasks(store, 'sp1');
    assert.ok(tasks.length >= 4);
    assert.ok(tasks.some(t => t.tool === 'oracle.locate'));
    assert.ok(tasks.some(t => t.tool === 'oracle.context'));
    assert.ok(tasks.some(t => t.tool === 'oracle.impact'));
    assert.ok(tasks.some(t => t.tool === 'oracle.conventions_for'));

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
