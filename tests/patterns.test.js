import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PatternCatalogue } from '../src/patterns/index.js';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pat-'));
  return { dir, dbPath: path.join(dir, 'test.sqlite') };
}

describe('PatternCatalogue', () => {
  it('extracts patterns from graph nodes', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);

    store.upsertNodes([
      {
        subprojectId: 'sp1', path: 'src/controllers/UserController.js', lang: 'javascript',
        symbol: 'GET /users', kind: 'route', parentId: null,
        startLine: 1, endLine: 10, exported: true, signature: 'GET /users',
        doc: null, commitSha: null, fileBlobHash: 'a', metadata: { http_method: 'GET', route_path: '/users' },
      },
      {
        subprojectId: 'sp1', path: 'src/controllers/PostController.js', lang: 'javascript',
        symbol: 'GET /posts', kind: 'route', parentId: null,
        startLine: 1, endLine: 10, exported: true, signature: 'GET /posts',
        doc: null, commitSha: null, fileBlobHash: 'b', metadata: { http_method: 'GET', route_path: '/posts' },
      },
      {
        subprojectId: 'sp1', path: 'src/controllers/CommentController.js', lang: 'javascript',
        symbol: 'GET /comments', kind: 'route', parentId: null,
        startLine: 1, endLine: 10, exported: true, signature: 'GET /comments',
        doc: null, commitSha: null, fileBlobHash: 'c', metadata: { http_method: 'GET', route_path: '/comments' },
      },
    ]);

    const catalogue = new PatternCatalogue(store);
    catalogue.extract({ id: 'sp1', root: dir });

    const patterns = catalogue.listPatterns();
    assert.ok(patterns.length > 0, 'should extract at least one pattern');

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('saves and loads patterns', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);

    store.upsertNodes([
      {
        subprojectId: 'sp1', path: 'a.js', lang: 'js', symbol: 'foo', kind: 'function',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'foo()',
        doc: null, commitSha: null, fileBlobHash: 'a', metadata: { async: false, param_count: 0 },
      },
      {
        subprojectId: 'sp1', path: 'b.js', lang: 'js', symbol: 'bar', kind: 'function',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'bar()',
        doc: null, commitSha: null, fileBlobHash: 'b', metadata: { async: false, param_count: 0 },
      },
    ]);

    const catalogue = new PatternCatalogue(store);
    catalogue.extract({ id: 'sp1', root: dir });

    const savePath = path.join(dir, 'patterns.json');
    catalogue.save(savePath);
    assert.ok(fs.existsSync(savePath));

    const catalogue2 = new PatternCatalogue(store);
    catalogue2.load(savePath);
    assert.strictEqual(catalogue2.listPatterns().length, catalogue.listPatterns().length);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('finds patterns by kind', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);

    store.upsertNodes([
      {
        subprojectId: 'sp1', path: 'a.js', lang: 'js', symbol: 'foo', kind: 'function',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'foo()',
        doc: null, commitSha: null, fileBlobHash: 'a', metadata: { async: false, param_count: 0 },
      },
      {
        subprojectId: 'sp1', path: 'b.js', lang: 'js', symbol: 'bar', kind: 'function',
        parentId: null, startLine: 1, endLine: 5, exported: true, signature: 'bar()',
        doc: null, commitSha: null, fileBlobHash: 'b', metadata: { async: false, param_count: 0 },
      },
      {
        subprojectId: 'sp1', path: 'c.js', lang: 'js', symbol: 'Baz', kind: 'class',
        parentId: null, startLine: 1, endLine: 20, exported: true, signature: 'class Baz',
        doc: null, commitSha: null, fileBlobHash: 'c', metadata: {},
      },
    ]);

    const catalogue = new PatternCatalogue(store);
    catalogue.extract({ id: 'sp1', root: dir });

    const funcPatterns = catalogue.findPatternsForKind('function');
    for (const p of funcPatterns) {
      assert.strictEqual(p.kind, 'function');
    }

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
