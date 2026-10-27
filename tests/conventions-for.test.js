import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GraphStore } from '../src/graph/store.js';
import { conventionsFor } from '../src/mcp/tools/conventions-for.js';

const SP = 'sp';
const cleanups = [];

function repo(nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-conv-'));
  const store = new GraphStore(path.join(dir, 'db.sqlite'));
  cleanups.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.upsertNodes(nodes.map(n => ({
    subprojectId: SP, lang: 'x', parentId: null, startLine: 1, endLine: 5, exported: true,
    signature: null, doc: null, commitSha: null, fileBlobHash: 'h', kind: 'class',
    metadata: n.metadata ? JSON.stringify(n.metadata) : null,
    ...n,
    ...(n.metadata ? { metadata: JSON.stringify(n.metadata) } : {}),
  })));
  const ctx = { store, subproject: { id: SP }, patterns: null, manifest: {} };
  return (topic) => conventionsFor(ctx, { topic });
}
const symbols = (result) => result.answer.examples.map(e => e.symbol);

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe('conventions_for: word matching', () => {
  it('matches "log" against logger and logging but not login', () => {
    const ask = repo([
      { symbol: 'Logger', path: 'src/Logger.js' },
      { symbol: 'LoggingMiddleware', path: 'src/mw.js' },
      { symbol: 'LoginController', path: 'src/Login.js' },
      { symbol: 'Catalog', path: 'src/Catalog.js' },
    ]);
    const found = symbols(ask('log'));
    assert.ok(found.includes('Logger'));
    assert.ok(found.includes('LoggingMiddleware'));
    assert.ok(!found.includes('LoginController'));
    assert.ok(!found.includes('Catalog'));
  });

  it('matches the valid* prefix (validator, validation) but not invalidate', () => {
    const ask = repo([
      { symbol: 'OrderValidator', path: 'src/a.js' },
      { symbol: 'InputValidation', path: 'src/b.js' },
      { symbol: 'invalidateCache', kind: 'function', path: 'src/c.js' },
    ]);
    const found = symbols(ask('validation'));
    assert.ok(found.includes('OrderValidator'));
    assert.ok(found.includes('InputValidation'));
    assert.ok(!found.includes('invalidateCache'));
  });

  it('matches auth as a whole word, not Author', () => {
    const ask = repo([
      { symbol: 'AuthService', path: 'src/a.js' },
      { symbol: 'LoginController', path: 'src/b.js' },
      { symbol: 'Author', path: 'src/Author.js' },
      { symbol: 'AuthorRepository', path: 'src/AuthorRepository.js' },
    ]);
    const found = symbols(ask('auth'));
    assert.ok(found.includes('AuthService'));
    assert.ok(found.includes('LoginController'));
    assert.ok(!found.includes('Author'));
    assert.ok(!found.includes('AuthorRepository'));
  });

  it('resolves topic aliases (authentication -> auth)', () => {
    const ask = repo([{ symbol: 'AuthService', path: 'src/a.js' }]);
    assert.deepStrictEqual(symbols(ask('authentication')), ['AuthService']);
  });
});

describe('conventions_for: aggregation', () => {
  it('aggregates base types and locations of on-topic classes', () => {
    const ask = repo([
      { symbol: 'OrderValidator', path: 'src/validators/OrderValidator.php', metadata: { extends: 'App\\Support\\BaseValidator' } },
      { symbol: 'InvoiceValidator', path: 'src/validators/InvoiceValidator.php', metadata: { extends: 'BaseValidator' } },
      { symbol: 'UserValidator', path: 'src/validators/UserValidator.php', metadata: { extends: 'Other' } },
      { symbol: 'TagValidator', path: 'src/tags/TagValidator.php', metadata: { extends: 'Other' } },
    ]);
    const { answer, evidence } = ask('validation');
    assert.deepStrictEqual(answer.base_types, [{ name: 'BaseValidator', count: 2 }, { name: 'Other', count: 2 }]);
    assert.deepStrictEqual(answer.locations, [{ dir: 'src/validators', count: 3 }]);
    assert.ok(evidence.length > 0);
    assert.strictEqual(answer.examples_total, 4);
    assert.strictEqual(answer.found, undefined);
  });

  it('counts route middleware for auth and routing topics', () => {
    const route = (symbol, middleware) => ({ symbol, kind: 'route', path: 'routes/api.php', metadata: { method: 'GET', path: symbol.slice(4), middleware } });
    const ask = repo([
      route('GET /orders', ['auth:sanctum', 'verified']),
      route('GET /invoices', ['auth:sanctum']),
      route('GET /health', []),
    ]);
    for (const topic of ['auth', 'routing']) {
      const { answer } = ask(topic);
      assert.deepStrictEqual(answer.route_middleware, {
        routes: 3,
        // Only recurring middleware (count >= 2) is reported.
        middleware: [{ name: 'auth:sanctum', count: 2 }],
      });
    }
  });

  it('does not report route middleware for other topics', () => {
    const ask = repo([
      { symbol: 'OrderValidator', path: 'src/a.js' },
      { symbol: 'GET /orders', kind: 'route', path: 'routes/api.php', metadata: { middleware: ['auth'] } },
    ]);
    assert.strictEqual(ask('validation').answer.route_middleware, undefined);
  });
});

describe('conventions_for: generic and unknown topics', () => {
  it('handles a multi-word topic with a partial-match note', () => {
    const ask = repo([
      { symbol: 'DataLoader', path: 'src/a.js' },
      { symbol: 'fetchOrders', kind: 'function', path: 'src/b.js' },
    ]);
    const { answer } = ask('data fetching');
    assert.ok(answer.examples.length > 0);
    assert.match(answer.note, /Little code names all of "data fetching"/);
  });

  it('prefers code naming every word of a multi-word topic', () => {
    const ask = repo([
      { symbol: 'DataFetcher', path: 'src/a.js' },
      { symbol: 'FetchDataJob', path: 'src/b.js' },
      { symbol: 'DataFetchService', path: 'src/c.js' },
      { symbol: 'DataStore', path: 'src/d.js' },
    ]);
    const { answer } = ask('data fetch');
    assert.strictEqual(answer.note, undefined);
    assert.ok(!answer.examples.some(e => e.symbol === 'DataStore'));
  });

  it('reports found:false for an unknown topic', () => {
    const ask = repo([{ symbol: 'OrderService', path: 'src/a.js' }]);
    const { answer, evidence } = ask('quantum entanglement');
    assert.strictEqual(answer.found, false);
    assert.match(answer.note, /No code, recurring pattern or documented rule found/);
    assert.deepStrictEqual(answer.examples, []);
    assert.deepStrictEqual(evidence, []);
  });

  it('reports found:false for an empty topic', () => {
    const ask = repo([{ symbol: 'OrderService', path: 'src/a.js' }]);
    assert.strictEqual(ask('  ').answer.found, false);
  });
});

describe('conventions_for: tests and generated code', () => {
  const nodes = () => [
    { symbol: 'OrderValidator', path: 'src/OrderValidator.js' },
    { symbol: 'ValidatorFake', path: 'tests/ValidatorFake.js' },
    { symbol: 'GeneratedValidator', path: 'src/generated/GeneratedValidator.js' },
    { symbol: 'describe Order tests', kind: 'test', path: 'src/order.test.js' },
  ];

  it('ignores test and generated files for ordinary topics', () => {
    const found = symbols(repo(nodes())('validation'));
    assert.deepStrictEqual(found, ['OrderValidator']);
  });

  it('includes test files for the testing topic, still not generated code', () => {
    const ask = repo([
      ...nodes(),
      { symbol: 'describe Order tests', kind: 'test', path: 'tests/order.test.js' },
      { symbol: 'GeneratedSpec', path: 'src/generated/GeneratedSpec.js' },
    ]);
    const found = symbols(ask('testing'));
    assert.ok(found.includes('describe Order tests'));
    assert.ok(!found.includes('GeneratedSpec'));
  });
});
