import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GraphStore } from '../src/graph/store.js';
import { whereWould } from '../src/mcp/tools/where-would.js';

const SP = 'sp';
const cleanups = [];

// A graph made of indexed files (file_hashes) and optional nodes.
function repo(files, nodes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-where-'));
  const store = new GraphStore(path.join(dir, 'db.sqlite'));
  cleanups.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const f of new Set([...files, ...nodes.map(n => n.path)])) store.setFileHash(SP, f, 'h');
  store.upsertNodes(nodes.map(n => ({
    subprojectId: SP, lang: 'x', parentId: null, startLine: 1, endLine: 5, exported: true,
    signature: null, doc: null, commitSha: null, fileBlobHash: 'h', metadata: null, ...n,
  })));
  return (intent) => whereWould({ store, subproject: { id: SP } }, { intent });
}
const paths = (result) => result.answer.proposed_paths.map(p => p.path);

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

describe('where_would: role detection', () => {
  it('finds the role from the file-name suffix', () => {
    const ask = repo(['app/Http/Controllers/OrderController.php', 'app/Http/Controllers/InvoiceController.php', 'app/Http/Controllers/UserController.php'], [
      { path: 'app/Http/Controllers/OrderController.php', symbol: 'OrderController', kind: 'class', startLine: 4, endLine: 20 },
      { path: 'app/Http/Controllers/InvoiceController.php', symbol: 'InvoiceController', kind: 'class', startLine: 4, endLine: 20 },
      { path: 'app/Http/Controllers/UserController.php', symbol: 'UserController', kind: 'class', startLine: 4, endLine: 20 },
    ]);
    const result = ask('controller for photos');
    assert.deepStrictEqual(paths(result), ['app/Http/Controllers/PhotoController.php']);
    const p = result.answer.proposed_paths[0];
    assert.strictEqual(p.convention.suffix, 'controller');
    assert.strictEqual(p.convention.style, 'pascal');
    assert.strictEqual(p.convention.extension, '.php');
    assert.strictEqual(result.layer, 'L1');
    assert.strictEqual(result.evidence.length, 1);
    assert.ok(result.evidence[0].path.startsWith('app/Http/Controllers/'));
    assert.match(result.evidence[0].symbol, /Controller$/);
    assert.deepStrictEqual(result.evidence[0].line_range, [4, 20]);
  });

  it('finds the role from the parent directory', () => {
    const ask = repo([
      'app/Http/Middleware/Authenticate.php', 'app/Http/Middleware/TrimStrings.php',
      'app/Http/Middleware/EnsureJson.php', 'app/Http/Middleware/CheckAge.php', 'app/Http/Kernel.php',
    ]);
    const result = ask('middleware for photos');
    assert.deepStrictEqual(paths(result), ['app/Http/Middleware/Photos.php']);
  });

  it('finds the role from the node kind when names do not say it', () => {
    const ask = repo(['src/other/a.ts'], [
      { path: 'src/state/useA.ts', symbol: 'useA', kind: 'hook' },
      { path: 'src/state/useB.ts', symbol: 'useB', kind: 'hook' },
    ]);
    const result = ask('a hook for photos');
    assert.strictEqual(result.answer.found, undefined);
    assert.ok(paths(result)[0].startsWith('src/state/'));
    assert.strictEqual(path.posix.extname(paths(result)[0]), '.ts');
  });

  it('proposes nothing when no role matches, with an explanatory note', () => {
    const ask = repo(['src/a/OrderController.php', 'src/b/InvoiceController.php']);
    const result = ask('frobnicate the zorp');
    assert.deepStrictEqual(result.answer.proposed_paths, []);
    assert.strictEqual(result.answer.found, false);
    assert.match(result.answer.note, /No existing files match/);
    assert.deepStrictEqual(result.evidence, []);
  });

  it('handles an empty intent and an empty index', () => {
    const ask = repo(['src/a/OrderController.php']);
    assert.strictEqual(ask('   ').answer.found, false);
    const emptyRepo = repo([]);
    const result = emptyRepo('controller for photos');
    assert.strictEqual(result.answer.found, false);
    assert.match(result.answer.note, /No indexed files/);
  });
});

describe('where_would: placement', () => {
  const featureRepo = () => repo([
    'modules/orders/controllers/OrderController.php',
    'modules/invoices/controllers/InvoiceController.php',
    'modules/users/controllers/UserController.php',
    'modules/users/controllers/ProfileController.php',
  ]);

  it('goes into the existing feature directory of the intent domain', () => {
    const result = featureRepo()('controller for users');
    const [first] = result.answer.proposed_paths;
    assert.strictEqual(path.posix.dirname(first.path), 'modules/users/controllers');
    assert.match(first.reason, /already holds 2 controller files for this feature/);
  });

  it('creates a new feature directory for a per-feature layout with >= 3 features', () => {
    const result = featureRepo()('controller for photos');
    const [first] = result.answer.proposed_paths;
    assert.strictEqual(first.path, 'modules/photos/controllers/PhotoController.php');
    assert.match(first.reason, /modules\/<feature>\/controllers \(3 features/);
  });

  it('does not infer a per-feature layout from two features', () => {
    const ask = repo([
      'modules/orders/controllers/OrderController.php',
      'modules/invoices/controllers/InvoiceController.php',
    ]);
    const result = ask('controller for photos');
    assert.ok(paths(result).every(p => !p.startsWith('modules/photos/')));
  });

  it('uses a fixed file name inside a new feature directory', () => {
    const ask = repo([
      'app/orders/page.tsx', 'app/invoices/page.tsx', 'app/users/page.tsx',
      'app/users/layout.tsx', 'app/layout.tsx',
    ]);
    const result = ask('page for photos');
    const [first] = result.answer.proposed_paths;
    assert.strictEqual(first.path, 'app/photos/page.tsx');
    assert.strictEqual(first.convention.file_name, 'page.tsx');
    assert.strictEqual(first.convention.style, 'kebab');
  });

  it('puts reusable code outside per-feature directories', () => {
    const ask = repo([
      'src/orders/components/Button.tsx', 'src/invoices/components/Card.tsx', 'src/users/components/Avatar.tsx',
      'src/shared/components/Modal.tsx', 'src/shared/components/Tabs.tsx',
    ]);
    const shared = ask('reusable component for dropdowns');
    assert.deepStrictEqual(paths(shared), ['src/shared/components/Dropdowns.tsx']);
    assert.match(shared.answer.proposed_paths[0].reason, /outside per-feature directories/);

    const plain = ask('component for photos');
    assert.strictEqual(paths(plain)[0], 'src/photos/components/Photo.tsx');
  });

  it('places new code beside the symbol named after "like"', () => {
    const ask = repo(['src/services/Mailer.php', 'src/services/Billing.php', 'src/a/OrderController.php']);
    const result = ask('new service like Mailer');
    assert.strictEqual(path.posix.dirname(paths(result)[0]), 'src/services');
    assert.match(result.answer.proposed_paths[0].reason, /Mailer, named in the request, lives in src\/services/);
  });

  it('places new code beside a "similar to X" symbol, preferring its own node as evidence', () => {
    const ask = repo(['src/other/OrderController.php'], [
      { path: 'src/billing/Invoicer.php', symbol: 'Invoicer', kind: 'class', startLine: 3, endLine: 9 },
      { path: 'src/billing/Ledger.php', symbol: 'Ledger', kind: 'class' },
    ]);
    const result = ask('service similar to Invoicer');
    assert.strictEqual(path.posix.dirname(paths(result)[0]), 'src/billing');
    assert.deepStrictEqual(result.evidence[0].line_range, [3, 9]);
    assert.strictEqual(result.evidence[0].symbol, 'Invoicer');
  });

  it('accepts an anchor symbol that ends in -ing', () => {
    const ask = repo(['src/other/OrderController.php', 'src/other/UserController.php'], [
      { path: 'src/billing/Billing.php', symbol: 'Billing', kind: 'class' },
    ]);
    const result = ask('thing similar to Billing');
    assert.strictEqual(path.posix.dirname(paths(result)[0]), 'src/billing');
  });
});

describe('where_would: naming conventions', () => {
  it('copies a prefix and suffix shared across several directories', () => {
    const ask = repo([
      'app/a/ApiOrderController.php', 'app/b/ApiInvoiceController.php',
      'app/c/ApiUserController.php', 'app/d/ApiTagController.php',
    ]);
    const result = ask('controller for photos');
    const [first] = result.answer.proposed_paths;
    assert.strictEqual(path.posix.basename(first.path), 'ApiPhotoController.php');
    assert.strictEqual(first.convention.prefix, 'api');
    assert.strictEqual(first.convention.suffix, 'controller');
  });

  it('copies a kebab-case use- prefix spread over feature directories', () => {
    const ask = repo(['src/orders/use-orders.ts', 'src/users/use-users.ts', 'src/tags/use-tags.ts', 'src/tags/tags.ts'], [
      { path: 'src/orders/use-orders.ts', symbol: 'useOrders', kind: 'hook' },
      { path: 'src/users/use-users.ts', symbol: 'useUsers', kind: 'hook' },
      { path: 'src/tags/use-tags.ts', symbol: 'useTags', kind: 'hook' },
    ]);
    const result = ask('hook for photos');
    assert.ok(paths(result).some(p => path.posix.basename(p) === 'use-photos.ts'), paths(result).join(', '));
  });

  it('does not use a prefix that only one directory shares', () => {
    const ask = repo([
      'app/a/CourseOneController.php', 'app/a/CourseTwoController.php', 'app/a/CourseThreeController.php',
      'app/b/OtherController.php',
    ]);
    const result = ask('controller for photos');
    const [first] = result.answer.proposed_paths;
    assert.strictEqual(path.posix.basename(first.path), 'PhotosController.php');
    assert.strictEqual(first.convention.prefix, undefined);
    assert.strictEqual(first.convention.suffix, 'controller');
  });

  it('prefixes migrations with a timestamp of the same shape', () => {
    const ask = repo([
      'database/migrations/2024_01_01_000001_create_orders_table.php',
      'database/migrations/2024_02_01_000001_create_users_table.php',
    ]);
    const result = ask('migration to add photos table');
    const [first] = result.answer.proposed_paths;
    assert.strictEqual(path.posix.dirname(first.path), 'database/migrations');
    assert.match(path.posix.basename(first.path), /^\d{4}_\d{2}_\d{2}_\d{6}_add_photos_table\.php$/);
    assert.strictEqual(first.convention.timestamp_prefix, true);
    assert.strictEqual(first.convention.style, 'snake');
  });
});

describe('where_would: exclusions and existing names', () => {
  const files = [
    'src/a/OrderController.php', 'src/b/InvoiceController.php', 'src/c/UserController.php',
    'src/tests/FooController.php', 'tests/FakeController.php', 'src/generated/GenController.php',
    'src/a/mocks/MockController.php', 'src/a/WidgetController.test.php',
  ];

  it('never learns from tests, generated code or mocks by default', () => {
    const result = repo(files)('controller for photos');
    for (const p of paths(result)) assert.doesNotMatch(p, /tests|generated|mocks/);
    for (const e of result.evidence) assert.doesNotMatch(e.path, /tests|generated|mocks/);
  });

  it('learns only from test files when the intent mentions tests', () => {
    const ask = repo(['tests/OrderTest.php', 'tests/UserTest.php', 'tests/InvoiceTest.php', 'app/OrderController.php', 'app/UserController.php']);
    const result = ask('test for photos');
    assert.deepStrictEqual(paths(result), ['tests/PhotoTest.php']);
    const noTest = ask('controller for photos');
    assert.deepStrictEqual(paths(noTest), ['app/PhotosController.php']);
  });

  it('reports found:false with a note when the file already exists', () => {
    const ask = repo([
      'modules/orders/controllers/OrderController.php',
      'modules/invoices/controllers/InvoiceController.php',
      'modules/users/controllers/UserController.php',
    ]);
    const result = ask('controller for order');
    assert.deepStrictEqual(result.answer.proposed_paths, []);
    assert.strictEqual(result.answer.found, false);
    assert.match(result.answer.note, /modules\/orders\/controllers\/OrderController\.php already exists/);
    assert.ok(!JSON.stringify(result).includes('_2'));
  });
});

describe('where_would: singular or plural like the neighbours', () => {
  it('uses the singular when the neighbours do', () => {
    const ask = repo(['src/controllers/OrderController.php', 'src/controllers/UserController.php', 'src/controllers/InvoiceController.php']);
    assert.deepStrictEqual(paths(ask('controller for photos')), ['src/controllers/PhotoController.php']);
  });

  it('uses the plural when the neighbours do', () => {
    const ask = repo(['lib/views/orders_view.dart', 'lib/views/users_view.dart', 'lib/views/invoices_view.dart']);
    assert.deepStrictEqual(paths(ask('view for photo')), ['lib/views/photos_view.dart']);
  });

  it('keeps the words as written when the neighbours are mixed', () => {
    const ask = repo(['src/hooks/use-orders.ts', 'src/hooks/use-user.ts', 'src/hooks/use-invoices.ts', 'src/hooks/use-cart.ts']);
    assert.deepStrictEqual(paths(ask('hook for photos')), ['src/hooks/use-photos.ts']);
  });

  it('names a new feature directory like the existing ones', () => {
    const ask = repo([
      'app/Http/Requests/Order/StoreOrderRequest.php', 'app/Http/Requests/User/StoreUserRequest.php',
      'app/Http/Requests/Invoice/StoreInvoiceRequest.php',
    ]);
    assert.ok(paths(ask('request for photos'))[0].startsWith('app/Http/Requests/Photo/'));
  });

  it('keeps the words of a timestamped name', () => {
    const ask = repo([
      'database/migrations/2024_01_01_000001_create_orders_table.php',
      'database/migrations/2024_01_02_000001_create_users_table.php',
      'database/migrations/2024_01_03_000001_create_invoices_table.php',
    ]);
    assert.match(paths(ask('migration to add status to photos'))[0], /_add_status_to_photos_table\.php$/);
  });
});
