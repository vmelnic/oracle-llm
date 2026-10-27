import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LaravelRouteDetector } from '../src/contracts/detectors/laravel-route.js';
import { DoctrineMigrationDetector } from '../src/contracts/detectors/doctrine-migration.js';
import { KafkaTopicDetector } from '../src/contracts/detectors/kafka-topic.js';

describe('contract detectors report real start lines', () => {
  let root;
  const write = (rel, lines) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), lines.join('\n'));
  };
  const line = (surfaces, symbol) => surfaces.find(s => s.symbol === symbol)?.startLine;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-contracts-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('laravel routes, resources and models', async () => {
    write('routes/api.php', [
      '<?php',
      '',
      "Route::get('/orders', [OrderController::class, 'index']);",
      '',
      "Route::post('/orders', [OrderController::class, 'store']);",
      '',
      "Route::resource('invoices', InvoiceController::class);",
    ]);
    write('app/Models/Invoice.php', [
      '<?php',
      '',
      'namespace App\\Models;',
      '',
      'class Invoice extends Model',
      '{',
      "    protected $table = 'billing_invoices';",
      '}',
    ]);
    write('app/Models/Order.php', [
      '<?php',
      '',
      'class Order extends Model',
      '{',
      '}',
    ]);
    const surfaces = await new LaravelRouteDetector().detect({ id: 'sp', root, framework: 'laravel' });
    assert.strictEqual(line(surfaces, 'GET /orders'), 3);
    assert.strictEqual(line(surfaces, 'POST /orders'), 5);
    assert.strictEqual(line(surfaces, 'GET invoices'), 7);
    assert.strictEqual(line(surfaces, 'DELETE invoices'), 7);
    // Points at `$table = ...` when present, else at the class.
    assert.strictEqual(line(surfaces, 'table:billing_invoices'), 7);
    assert.strictEqual(line(surfaces, 'table:orders'), 3);
  });

  it('doctrine migrations: created and altered tables', async () => {
    write('migrations/Version20240101000000.php', [
      '<?php',
      'final class Version20240101000000 extends AbstractMigration',
      '{',
      '    public function up(Schema $schema): void',
      '    {',
      "        $t = $schema->createTable('orders');",
      "        $t->addColumn('id', 'integer');",
      '',
      "        $this->addSql('ALTER TABLE invoices ADD total INT');",
      '    }',
      '}',
    ]);
    const surfaces = await new DoctrineMigrationDetector().detect({ id: 'sp', root, framework: 'symfony' });
    assert.strictEqual(line(surfaces, 'doctrine:orders'), 6);
    assert.strictEqual(line(surfaces, 'doctrine_alter:invoices'), 9);
  });

  it('kafka topics from JSON and YAML registries', async () => {
    write('kafka/topics.json', [
      '{',
      '  "topics": [',
      '    "orders.created",',
      '    { "name": "invoices.paid" }',
      '  ]',
      '}',
    ]);
    write('kafka/consumers.yml', [
      'consumers:',
      '  - group: a',
      '    topic: shipments.sent',
    ]);
    const surfaces = await new KafkaTopicDetector().detect({ id: 'sp', root });
    assert.strictEqual(line(surfaces, 'kafka:orders.created'), 3);
    assert.strictEqual(line(surfaces, 'kafka:invoices.paid'), 4);
    assert.strictEqual(line(surfaces, 'kafka:shipments.sent'), 3);
  });
});
