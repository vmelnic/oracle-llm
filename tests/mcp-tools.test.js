import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GraphStore } from '../src/graph/store.js';
import { PatternCatalogue } from '../src/patterns/index.js';
import { L2Index } from '../src/retrieval/index.js';
import { locate } from '../src/mcp/tools/locate.js';
import { impact } from '../src/mcp/tools/impact.js';
import { context } from '../src/mcp/tools/context.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-mcp-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new GraphStore(dbPath);
  const patterns = new PatternCatalogue(store);
  const l2 = new L2Index(store, {});
  const manifest = {};
  const subproject = { id: 'sp1', root: dir, language: 'javascript' };

  store.upsertNodes([
    { subprojectId: 'sp1', path: 'src/users.js', lang: 'js', symbol: 'fetchUsers', kind: 'function', parentId: null, startLine: 1, endLine: 10, exported: true, signature: 'fetchUsers()', doc: null, commitSha: null, fileBlobHash: 'a', metadata: null },
    { subprojectId: 'sp1', path: 'src/users.js', lang: 'js', symbol: 'createUser', kind: 'function', parentId: null, startLine: 12, endLine: 25, exported: true, signature: 'createUser(data)', doc: null, commitSha: null, fileBlobHash: 'a', metadata: null },
    { subprojectId: 'sp1', path: 'src/routes.js', lang: 'js', symbol: 'GET /users', kind: 'route', parentId: null, startLine: 5, endLine: 15, exported: true, signature: 'GET /users', doc: null, commitSha: null, fileBlobHash: 'b', metadata: JSON.stringify({ method: 'GET', path: '/users' }) },
    { subprojectId: 'sp1', path: 'src/db.js', lang: 'js', symbol: 'users', kind: 'db_table', parentId: null, startLine: 1, endLine: 5, exported: false, signature: 'users(id, name, email)', doc: null, commitSha: null, fileBlobHash: 'c', metadata: JSON.stringify({ columns: [{ name: 'id' }, { name: 'name' }, { name: 'email' }] }) },
  ]);

  const [n1, n2, n3] = [1, 2, 3];
  store.upsertEdges([
    { subprojectId: 'sp1', sourceId: n3, targetId: n1, kind: 'calls', metadata: null },
  ]);

  const ctx = { store, subproject, patterns, manifest, l2 };
  return { dir, store, ctx };
}

describe('locate tool', () => {
  it('finds symbol by name', () => {
    const { dir, store, ctx } = setup();
    const result = locate(ctx, { symbol: 'fetchUsers' });
    assert.ok(result.answer.definitions.length > 0);
    assert.strictEqual(result.answer.definitions[0].symbol, 'fetchUsers');
    assert.ok(result.evidence.length > 0);
    assert.strictEqual(result.layer, 'L1');
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty for missing symbol', () => {
    const { dir, store, ctx } = setup();
    const result = locate(ctx, { symbol: 'nonExistentSymbol12345' });
    assert.strictEqual(result.answer.definitions.length, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty for null symbol', () => {
    const { dir, store, ctx } = setup();
    const result = locate(ctx, { symbol: null });
    assert.strictEqual(result.answer.definitions.length, 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('filters by kind', () => {
    const { dir, store, ctx } = setup();
    const result = locate(ctx, { symbol: 'users', kind: 'db_table' });
    assert.ok(result.answer.definitions.length > 0);
    assert.ok(result.answer.definitions.every(d => d.kind === 'db_table'));
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('finds partial symbol matches', () => {
    const { dir, store, ctx } = setup();
    const result = locate(ctx, { symbol: 'fetch' });
    assert.ok(result.answer.definitions.length > 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('impact tool', () => {
  it('analyzes impact of db change', () => {
    const { dir, store, ctx } = setup();
    const result = impact(ctx, { change: 'Add status column to users table' });
    assert.ok(result.answer);
    assert.ok(typeof result.answer.breaking === 'boolean');
    assert.ok(typeof result.answer.migration_needed === 'boolean');
    assert.ok(result.answer.recommendation.length > 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('returns default for no change', () => {
    const { dir, store, ctx } = setup();
    const result = impact(ctx, { change: null });
    assert.strictEqual(result.answer.breaking, false);
    assert.strictEqual(result.answer.migration_needed, false);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('detects breaking change for removal', () => {
    const { dir, store, ctx } = setup();
    const result = impact(ctx, { change: 'Remove the fetchUsers function' });
    assert.strictEqual(result.answer.breaking, true);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('detects breaking change for rename', () => {
    const { dir, store, ctx } = setup();
    const result = impact(ctx, { change: 'Rename createUser to addUser' });
    assert.strictEqual(result.answer.breaking, true);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});

describe('context tool', () => {
  it('returns task packet for a query', async () => {
    const { dir, store, ctx } = setup();
    const result = await context(ctx, { task: 'Show the user management code' });
    assert.ok(result.answer);
    assert.ok(Array.isArray(result.answer.existing));
    assert.ok(Array.isArray(result.answer.create));
    assert.ok(Array.isArray(result.answer.modify));
    assert.ok(result.answer.db);
    assert.ok(Array.isArray(result.answer.conventions));
    assert.ok(Array.isArray(result.answer.relevant_code));
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty packet for null task', async () => {
    const { dir, store, ctx } = setup();
    const result = await context(ctx, { task: null });
    assert.deepStrictEqual(result.answer.existing, []);
    assert.deepStrictEqual(result.answer.create, []);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('finds db tables matching keywords', async () => {
    const { dir, store, ctx } = setup();
    const result = await context(ctx, { task: 'Add email column to users table' });
    assert.ok(result.answer.db.tables.length > 0);
    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
