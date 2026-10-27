import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createParser } from '../src/parser/index.js';
import { extract } from '../src/graph/extractors/php.js';

const parser = createParser();

function run(code) {
  const tree = parser.parse(`<?php\n${code}`, 'php');
  const { nodes, edges } = extract(tree, 'routes/api.php', 'sp');
  const routes = nodes.filter(n => n.kind === 'route');
  const bySymbol = (symbol) => routes.find(r => r.symbol === symbol);
  return { nodes, edges, routes, bySymbol, serves: edges.filter(e => e.kind === 'serves_route') };
}

describe('Laravel routes: groups', () => {
  it('applies prefix and middleware of a fluent group', () => {
    const { routes, bySymbol } = run(`
use App\\Http\\Controllers\\OrderController;
Route::prefix('orders')->middleware(['auth:sanctum', 'verified'])->group(function () {
  Route::get('/', [OrderController::class, 'index']);
  Route::post('/{id}', [OrderController::class, 'store']);
});`);
    assert.strictEqual(routes.length, 2);
    const index = bySymbol('GET /orders');
    assert.ok(index);
    assert.deepStrictEqual(index.metadata.middleware, ['auth:sanctum', 'verified']);
    assert.strictEqual(index.metadata.controller, 'App\\Http\\Controllers\\OrderController');
    assert.strictEqual(index.metadata.action, 'index');
    assert.ok(bySymbol('POST /orders/{id}'));
  });

  it('reads prefix, middleware and as from an options array', () => {
    const { bySymbol } = run(`
Route::group(['prefix' => 'v1', 'middleware' => 'auth', 'as' => 'v1.'], function () {
  Route::get('/plain', [PingController::class, 'plain']);
  Route::get('/named', [PingController::class, 'named'])->name('named');
});`);
    const plain = bySymbol('GET /v1/plain');
    assert.deepStrictEqual(plain.metadata.middleware, ['auth']);
    // A group `as` alone does not name a route.
    assert.strictEqual(plain.metadata.name, undefined);
    assert.strictEqual(bySymbol('GET /v1/named').metadata.name, 'v1.named');
  });

  it('nests groups, outer first, and mixes fluent and array forms', () => {
    const { routes } = run(`
Route::prefix('api')->group(function () {
  Route::middleware('auth')->prefix('v2')->group(function () {
    Route::group(['prefix' => 'orders', 'as' => 'o.'], function () {
      Route::delete('/{id}', [OrderController::class, 'destroy'])->middleware('throttle:10')->name('destroy');
    });
  });
  Route::get('/ping', [PingController::class, 'ping']);
});`);
    const del = routes.find(r => r.symbol === 'DELETE /api/v2/orders/{id}');
    assert.ok(del);
    assert.deepStrictEqual(del.metadata.middleware, ['auth', 'throttle:10']);
    assert.strictEqual(del.metadata.name, 'o.destroy');
    const ping = routes.find(r => r.symbol === 'GET /api/ping');
    assert.ok(ping);
    assert.strictEqual(ping.metadata.middleware, undefined);
  });

  it('supports arrow-function groups', () => {
    const { bySymbol } = run(`
Route::prefix('orders')->middleware('auth')->group(fn () => Route::get('/export', ExportOrders::class));`);
    const r = bySymbol('GET /orders/export');
    assert.ok(r);
    assert.deepStrictEqual(r.metadata.middleware, ['auth']);
    assert.strictEqual(r.metadata.action, '__invoke');
  });

  it('removes inherited middleware with withoutMiddleware', () => {
    const { bySymbol } = run(`
Route::middleware(['auth', 'verified'])->group(function () {
  Route::get('/a', [AController::class, 'a']);
  Route::get('/b', [AController::class, 'b'])->withoutMiddleware('verified');
});`);
    assert.deepStrictEqual(bySymbol('GET /a').metadata.middleware, ['auth', 'verified']);
    assert.deepStrictEqual(bySymbol('GET /b').metadata.middleware, ['auth']);
  });

  it('keeps middleware given as Class::class by its short name', () => {
    const { bySymbol } = run(`
use App\\Http\\Middleware\\CheckUserStatus;
Route::middleware([CheckUserStatus::class])->group(function () {
  Route::get('/a', [AController::class, 'a']);
});`);
    assert.deepStrictEqual(bySymbol('GET /a').metadata.middleware, ['CheckUserStatus']);
  });
});

describe('Laravel routes: single routes', () => {
  it('chains middleware and name on the route itself', () => {
    const { bySymbol } = run(`Route::get('/orders', [OrderController::class, 'index'])->middleware('auth')->name('orders.index');`);
    const r = bySymbol('GET /orders');
    assert.deepStrictEqual(r.metadata.middleware, ['auth']);
    assert.strictEqual(r.metadata.name, 'orders.index');
  });

  it('only names a route that has its own name', () => {
    const { bySymbol } = run(`Route::get('/orders', [OrderController::class, 'index']);`);
    assert.strictEqual('name' in bySymbol('GET /orders').metadata, false);
  });

  it('joins several verbs of Route::match', () => {
    const { routes } = run(`Route::match(['get', 'post'], '/x', [OrderController::class, 'x']);`);
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].symbol, 'GET|POST /x');
    assert.strictEqual(routes[0].metadata.method, 'GET|POST');
    assert.strictEqual(routes[0].metadata.path, '/x');
  });

  it('treats an invokable controller as action __invoke', () => {
    const { bySymbol, serves } = run(`
use App\\Http\\Controllers\\ShowReport;
Route::get('/report', ShowReport::class);`);
    const r = bySymbol('GET /report');
    assert.strictEqual(r.metadata.action, '__invoke');
    assert.strictEqual(r.metadata.controller, 'App\\Http\\Controllers\\ShowReport');
    assert.strictEqual(serves[0].source_symbol, 'App\\Http\\Controllers\\ShowReport::__invoke');
  });

  it('adds an api_endpoint twin only for /api paths', () => {
    const { nodes } = run(`
Route::get('/api/orders', [OrderController::class, 'index']);
Route::get('/web/orders', [OrderController::class, 'web']);`);
    const api = nodes.filter(n => n.kind === 'api_endpoint');
    assert.deepStrictEqual(api.map(n => n.symbol), ['API GET /api/orders']);
  });
});

describe('Laravel routes: resources', () => {
  it('expands resource into 7 routes and apiResource into 5', () => {
    const resource = run(`Route::resource('users', UserController::class);`);
    assert.strictEqual(resource.routes.length, 7);
    assert.deepStrictEqual(resource.routes.map(r => r.symbol), [
      'GET /users', 'GET /users/create', 'POST /users', 'GET /users/{user}',
      'GET /users/{user}/edit', 'PUT|PATCH /users/{user}', 'DELETE /users/{user}',
    ]);
    assert.strictEqual(resource.routes[0].metadata.name, 'users.index');
    assert.strictEqual(resource.routes[0].metadata.action, 'index');

    const api = run(`Route::apiResource('users', UserController::class);`);
    assert.strictEqual(api.routes.length, 5);
    assert.ok(!api.routes.some(r => ['create', 'edit'].includes(r.metadata.action)));
  });

  it('honours only() and except()', () => {
    const only = run(`Route::apiResource('invoices', InvoiceController::class)->only(['index', 'show']);`);
    assert.deepStrictEqual(only.routes.map(r => r.metadata.action), ['index', 'show']);
    const except = run(`Route::apiResource('invoices', InvoiceController::class)->except(['destroy']);`);
    assert.deepStrictEqual(except.routes.map(r => r.metadata.action), ['index', 'store', 'show', 'update']);
  });

  it('builds nested resource paths from dotted names', () => {
    const { routes } = run(`Route::apiResource('photos.comments', CommentController::class)->only(['index', 'show']);`);
    assert.deepStrictEqual(routes.map(r => r.symbol), ['GET /photos/{photo}/comments', 'GET /photos/{photo}/comments/{comment}']);
    assert.strictEqual(routes[1].metadata.name, 'photos.comments.show');
  });

  it('applies group prefix, middleware and name prefix to resources', () => {
    const { routes } = run(`
Route::group(['prefix' => 'admin', 'middleware' => 'auth', 'as' => 'admin.'], function () {
  Route::apiResource('invoices', InvoiceController::class)->only(['index']);
});`);
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].symbol, 'GET /admin/invoices');
    assert.deepStrictEqual(routes[0].metadata.middleware, ['auth']);
    assert.strictEqual(routes[0].metadata.name, 'admin.invoices.index');
  });
});

describe('Laravel routes: serves_route edges', () => {
  it('links Controller::action (method) to the route symbol', () => {
    const { serves } = run(`
use App\\Http\\Controllers\\OrderController;
Route::get('/orders', [OrderController::class, 'index']);`);
    assert.strictEqual(serves.length, 1);
    const e = serves[0];
    assert.strictEqual(e.source_symbol, 'App\\Http\\Controllers\\OrderController::index');
    assert.strictEqual(e.source_kind, 'method');
    assert.strictEqual(e.target_symbol, 'GET /orders');
    assert.strictEqual(e.target_kind, 'route');
    assert.strictEqual(e.metadata.line, 4);
  });

  it('emits one edge per resource action and none for closures', () => {
    const { serves } = run(`
Route::apiResource('invoices', InvoiceController::class);
Route::get('/closure', function () { return 1; });`);
    assert.strictEqual(serves.length, 5);
    assert.ok(serves.every(e => e.source_symbol.startsWith('InvoiceController::')));
  });
});

describe('Laravel routes: known gaps', () => {
  it('reads a double-quoted action name', () => {
    const { bySymbol, serves } = run(`Route::get('/orders', [OrderController::class, "index"]);`);
    assert.strictEqual(bySymbol('GET /orders').metadata.action, 'index');
    assert.strictEqual(serves.length, 1);
  });
});
