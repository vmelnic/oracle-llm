import { describe, it } from 'node:test';
import assert from 'node:assert';
import { L2Index } from '../src/retrieval/index.js';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('L2Index', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-l2-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const store = new GraphStore(dbPath);

    store.upsertNodes([
      { subprojectId: 'sp1', path: 'a.js', lang: 'js', symbol: 'fetchUsers', kind: 'function', parentId: null, startLine: 1, endLine: 10, exported: true, signature: 'fetchUsers()', doc: 'Fetch all users from API', commitSha: null, fileBlobHash: 'a', metadata: null },
      { subprojectId: 'sp1', path: 'b.js', lang: 'js', symbol: 'UserList', kind: 'component', parentId: null, startLine: 1, endLine: 20, exported: true, signature: '<UserList>', doc: 'Renders user list', commitSha: null, fileBlobHash: 'b', metadata: null },
      { subprojectId: 'sp1', path: 'c.js', lang: 'js', symbol: 'users', kind: 'db_table', parentId: null, startLine: 1, endLine: 5, exported: false, signature: 'users(id, name, email)', doc: null, commitSha: null, fileBlobHash: 'c', metadata: JSON.stringify({ columns: [{ name: 'id' }, { name: 'name' }, { name: 'email' }] }) },
    ]);

    return { dir, store };
  }

  it('builds index from store', async () => {
    const { dir, store } = setup();
    const l2 = new L2Index(store, {});

    const result = await l2.build('sp1');
    assert.ok(result.indexed >= 3);
    assert.strictEqual(l2.isLoaded(), true);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('searches by text query', async () => {
    const { dir, store } = setup();
    const l2 = new L2Index(store, {});
    await l2.build('sp1');

    const results = await l2.search('fetch users');
    assert.ok(results.length > 0);
    assert.ok(results[0].node);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('searchByKind filters results', async () => {
    const { dir, store } = setup();
    const l2 = new L2Index(store, {});
    await l2.build('sp1');

    const results = await l2.searchByKind('users', 'db_table');
    assert.ok(results.length > 0);
    assert.ok(results.every(r => r.node.kind === 'db_table'));

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('saves and loads index', async () => {
    const { dir, store } = setup();
    const indexDir = path.join(dir, 'index');
    const l2 = new L2Index(store, { indexPath: indexDir });
    await l2.build('sp1');
    l2.save();

    assert.ok(fs.existsSync(path.join(indexDir, 'bm25.json')));

    const l2b = new L2Index(store, { indexPath: indexDir });
    const loaded = l2b.load();
    assert.strictEqual(loaded, true);
    assert.strictEqual(l2b.isLoaded(), true);

    const results = await l2b.search('users');
    assert.ok(results.length > 0);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('load returns false for missing path', () => {
    const l2 = new L2Index(null, { indexPath: '/nonexistent/path' });
    assert.strictEqual(l2.load(), false);
  });

  it('load returns false for no indexPath', () => {
    const l2 = new L2Index(null, {});
    assert.strictEqual(l2.load(), false);
  });

  it('respects limit option', async () => {
    const { dir, store } = setup();
    const l2 = new L2Index(store, {});
    await l2.build('sp1');

    const results = await l2.search('users', { limit: 1 });
    assert.strictEqual(results.length, 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
