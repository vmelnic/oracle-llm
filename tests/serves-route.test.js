import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GraphStore } from '../src/graph/store.js';
import { PatternCatalogue } from '../src/patterns/index.js';

const SP = 'sp1';

function node(over) {
  return {
    subprojectId: SP, path: 'app/x.php', lang: 'php', symbol: 'x', kind: 'function', parentId: null,
    startLine: 1, endLine: 5, exported: true, signature: null, doc: null, commitSha: null, fileBlobHash: 'h', metadata: null,
    ...over,
  };
}

describe('serves_route edges in GraphStore', () => {
  let dir;
  let store;
  let handlerId;
  let routeId;
  let callerId;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-serves-'));
    store = new GraphStore(path.join(dir, 'db.sqlite'));
    [handlerId, routeId, callerId] = store.upsertNodes([
      node({ symbol: 'OrderController::index', kind: 'method', path: 'app/OrderController.php' }),
      node({ symbol: 'GET /orders', kind: 'route', path: 'routes/api.php' }),
      node({ symbol: 'OrderService::list', kind: 'method', path: 'app/OrderService.php' }),
    ]);
    store.upsertEdges([
      { subprojectId: SP, sourceId: handlerId, targetId: routeId, kind: 'serves_route', metadata: { line: 3 } },
      { subprojectId: SP, sourceId: callerId, targetId: handlerId, kind: 'calls', metadata: null },
    ]);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('getConsumers(handler) includes the route and the plain callers', () => {
    const symbols = store.getConsumers(handlerId).map(n => n.symbol).sort();
    assert.deepStrictEqual(symbols, ['GET /orders', 'OrderService::list']);
  });

  it('the handler is not a consumer of the route', () => {
    assert.deepStrictEqual(store.getConsumers(routeId), []);
    assert.deepStrictEqual(store.consumers(SP, routeId), []);
    assert.deepStrictEqual(store.impact(SP, [routeId]), []);
  });

  it('consumers() lists the route at depth 1 with its edge kind', () => {
    const rows = store.consumers(SP, handlerId);
    const route = rows.find(r => r.symbol === 'GET /orders');
    assert.ok(route);
    assert.strictEqual(route.depth, 1);
    assert.strictEqual(route.edge_kind, 'serves_route');
    assert.ok(rows.some(r => r.symbol === 'OrderService::list' && r.edge_kind === 'calls'));
  });

  it('impact() of the handler reaches the route', () => {
    const rows = store.impact(SP, [handlerId]);
    const route = rows.find(r => r.symbol === 'GET /orders');
    assert.ok(route);
    assert.strictEqual(route.edge_kind, 'serves_route');
  });

  it('impact() of a callee reaches the route through the handler', () => {
    const [leafId] = store.upsertNodes([node({ symbol: 'OrderRepo::all', kind: 'method', path: 'app/OrderRepo.php' })]);
    store.upsertEdges([{ subprojectId: SP, sourceId: handlerId, targetId: leafId, kind: 'calls', metadata: null }]);
    const rows = store.impact(SP, [leafId]);
    const route = rows.find(r => r.symbol === 'GET /orders');
    assert.ok(route);
    assert.strictEqual(route.depth, 2);
  });
});

describe('route shapes in PatternCatalogue', () => {
  function catalogueFor(routes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pat-route-'));
    const store = new GraphStore(path.join(dir, 'db.sqlite'));
    store.upsertNodes(routes.map((r, i) => node({
      symbol: `${r.method} ${r.path}`, kind: 'route', path: `routes/r${i}.php`,
      signature: `${r.method} ${r.path}`,
      metadata: JSON.stringify({ method: r.method, path: r.path, ...(r.middleware ? { middleware: r.middleware } : {}) }),
    })));
    const catalogue = new PatternCatalogue(store);
    catalogue.extract({ id: SP, root: dir });
    return { catalogue, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it('flags a route with auth middleware as auth=true', () => {
    const { catalogue, done } = catalogueFor([
      { method: 'GET', path: '/orders', middleware: ['auth:sanctum'] },
      { method: 'GET', path: '/invoices', middleware: ['auth:sanctum', 'verified'] },
    ]);
    const [pattern] = catalogue.listPatterns();
    assert.strictEqual(pattern.name, 'route:GET:depth=1:auth=true');
    assert.strictEqual(pattern.template.structure.auth, true);
    assert.match(pattern.template.pattern, /\[auth\]$/);
    done();
  });

  it('recognises other auth middleware spellings and ignores unrelated ones', () => {
    const guarded = catalogueFor([
      { method: 'GET', path: '/a', middleware: ['can:edit'] },
      { method: 'GET', path: '/b', middleware: ['role:admin'] },
    ]);
    assert.strictEqual(guarded.catalogue.listPatterns()[0].name, 'route:GET:depth=1:auth=true');
    guarded.done();

    const open = catalogueFor([
      { method: 'GET', path: '/a', middleware: ['throttle:60'] },
      { method: 'GET', path: '/b' },
    ]);
    const [pattern] = open.catalogue.listPatterns();
    assert.strictEqual(pattern.name, 'route:GET:depth=1:auth=false');
    assert.strictEqual(pattern.template.structure.auth, false);
    open.done();
  });
});
