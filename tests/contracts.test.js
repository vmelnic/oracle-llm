import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ContractRegistry } from '../src/contracts/index.js';

describe('ContractRegistry', () => {
  function mockStore() {
    const nodes = [];
    return {
      upsertNode(n) { nodes.push(n); return nodes.length; },
      findNodes(q) { return nodes.filter(n => (!q.kind || n.kind === q.kind) && (!q.subprojectId || n.subproject_id === q.subprojectId)); },
      getConsumers() { return []; },
      getProducers() { return []; },
      getNode(id) { return nodes[id - 1] || null; },
      _nodes: nodes,
    };
  }

  it('registers and scans detectors', async () => {
    const store = mockStore();
    const registry = new ContractRegistry(store);

    const detector = {
      async detect() {
        return [
          { path: 'routes.yaml', symbol: 'GET /users', kind: 'route', lang: 'yaml', startLine: 1, endLine: 5, signature: 'GET /users' },
        ];
      },
    };

    registry.registerDetector(detector);
    const surfaces = await registry.scan({ id: 'sp1', language: 'php' });
    assert.strictEqual(surfaces.length, 1);
    assert.strictEqual(surfaces[0].symbol, 'GET /users');
  });

  it('indexes surfaces into the store', async () => {
    const store = mockStore();
    const registry = new ContractRegistry(store);

    registry.registerDetector({
      async detect() {
        return [
          { path: 'api.yaml', symbol: 'POST /items', kind: 'api_endpoint', startLine: 10, endLine: 20 },
        ];
      },
    });

    const result = await registry.index({ id: 'sp1', language: 'javascript' });
    assert.strictEqual(result.surfacesIndexed, 1);
    assert.strictEqual(store._nodes.length, 1);
    assert.strictEqual(store._nodes[0].symbol, 'POST /items');
    assert.strictEqual(store._nodes[0].exported, 1);
  });

  it('swallows detector failures', async () => {
    const store = mockStore();
    const registry = new ContractRegistry(store);

    registry.registerDetector({ async detect() { throw new Error('boom'); } });
    registry.registerDetector({ async detect() { return [{ path: 'a', symbol: 'ok', kind: 'route' }]; } });

    const surfaces = await registry.scan({ id: 'sp1' });
    assert.strictEqual(surfaces.length, 1);
  });

  it('saves and loads surfaces JSON', () => {
    const store = mockStore();
    const registry = new ContractRegistry(store);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-contract-'));
    const outPath = path.join(dir, 'surfaces.json');

    const surfaces = [
      { symbol: 'GET /api', kind: 'route', path: 'routes.yaml', lang: 'yaml', startLine: 1, endLine: 5 },
    ];
    const count = registry.saveSurfacesJson(surfaces, outPath);
    assert.strictEqual(count, 1);

    const loaded = registry.loadSurfacesJson(outPath);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].symbol, 'GET /api');

    fs.rmSync(dir, { recursive: true });
  });

  it('loadSurfacesJson returns empty for missing file', () => {
    const registry = new ContractRegistry(mockStore());
    assert.deepStrictEqual(registry.loadSurfacesJson('/nonexistent/path.json'), []);
  });

  it('queries nodes by kind', async () => {
    const store = mockStore();
    const registry = new ContractRegistry(store);
    registry.registerDetector({
      async detect() {
        return [
          { path: 'a', symbol: 'R1', kind: 'route' },
          { path: 'b', symbol: 'E1', kind: 'api_endpoint' },
        ];
      },
    });
    await registry.index({ id: 'sp1', language: 'php' });
    const routes = registry.query('sp1', 'route');
    assert.ok(routes.length >= 1);
  });

  it('schema returns node with parsed metadata', async () => {
    const nodes = [];
    const store = {
      upsertNode(n) { nodes.push({ ...n, id: nodes.length + 1, metadata: JSON.stringify(n.metadata || {}) }); return nodes.length; },
      getNode(id) { return nodes[id - 1] || null; },
      findNodes() { return nodes; },
    };
    const registry = new ContractRegistry(store);
    registry.registerDetector({
      async detect() {
        return [{ path: 'a', symbol: 'T1', kind: 'route', metadata: { method: 'GET' } }];
      },
    });
    await registry.index({ id: 'sp1', language: 'php' });
    const schema = registry.schema('sp1', 1);
    assert.ok(schema);
    assert.strictEqual(schema.metadata.method, 'GET');
  });

  it('schema returns null for missing node', () => {
    const store = { getNode() { return null; } };
    const registry = new ContractRegistry(store);
    assert.strictEqual(registry.schema('sp1', 999), null);
  });
});
