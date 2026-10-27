import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GroundingWrapper } from '../src/grounding/index.js';

const ENV_KEYS = ['ORACLE_TOKEN_CAP', 'ORACLE_TOKEN_CAP_EXTENDED'];

describe('GroundingWrapper truncation', () => {
  const saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ORACLE_TOKEN_CAP = '400';
    process.env.ORACLE_TOKEN_CAP_EXTENDED = '1500';
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const items = (n) => Array.from({ length: n }, (_, i) => `item number ${i} with some text`);
  const wrapper = () => new GroundingWrapper(null, {});

  it('leaves an answer under the cap untouched', () => {
    const answer = { list: ['a', 'b'], count: 2 };
    const result = wrapper().wrap({ answer, evidence: [] }, 'oracle.signature');
    assert.deepStrictEqual(result.answer, answer);
    assert.strictEqual(result._truncated, undefined);
  });

  it('keeps a small list whole next to a huge one and reports the huge total', () => {
    const answer = { small: ['a', 'b'], existing: items(300), count: 42, flag: true, nothing: null };
    const result = wrapper().wrap({ answer, evidence: [] }, 'oracle.signature');
    assert.strictEqual(result._truncated, true);
    assert.deepStrictEqual(result.answer.small, ['a', 'b']);
    assert.strictEqual(result.answer.small_total, undefined);
    assert.ok(result.answer.existing.length > 0 && result.answer.existing.length < 300);
    assert.deepStrictEqual(result.answer.existing, items(300).slice(0, result.answer.existing.length));
    assert.strictEqual(result.answer.existing_total, 300);
    assert.strictEqual(result.answer.count, 42);
    assert.strictEqual(result.answer.flag, true);
    assert.strictEqual(result.answer.nothing, null);
    assert.ok(result._hint);
    assert.ok(result.confidence <= 0.6);
  });

  it('cuts long prose with an ellipsis', () => {
    const prose = 'word '.repeat(400);
    const result = wrapper().wrap({ answer: { list: items(300), prose }, evidence: [] }, 'oracle.signature');
    assert.ok(result.answer.prose.endsWith('...'));
    assert.ok(result.answer.prose.length < prose.length);
  });

  it('omits short strings that lost their room instead of cutting them', () => {
    const answer = { file: 'y'.repeat(100), n: 7, flag: false };
    for (let i = 0; i < 20; i++) answer[`list${i}`] = items(50);
    const result = wrapper().wrap({ answer, evidence: [] }, 'oracle.signature');
    assert.strictEqual('file' in result.answer, false);
    assert.strictEqual(result.answer.n, 7);
    assert.strictEqual(result.answer.flag, false);
    for (let i = 0; i < 20; i++) assert.strictEqual(result.answer[`list${i}_total`], 50);
  });

  it('uses the extended cap for extended tools', () => {
    const answer = { existing: items(120) };
    const normal = wrapper().wrap({ answer, evidence: [] }, 'oracle.signature');
    const extended = wrapper().wrap({ answer, evidence: [] }, 'oracle.context');
    assert.strictEqual(normal._token_cap, 400);
    assert.strictEqual(extended._truncated, undefined);
    assert.ok(normal.answer.existing.length < 120);
  });

  it('never truncates read_exact', () => {
    const answer = { text: 'z'.repeat(20000) };
    const result = wrapper().wrap({ answer, evidence: [] }, 'oracle.read_exact');
    assert.strictEqual(result.answer.text.length, 20000);
  });
});

describe('GroundingWrapper.verifyEvidence symbols', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-verify-'));
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write('routes/api.php', [
      '<?php',
      "Route::prefix('users')->group(function () {",
      "  Route::get('/{id}/active', [UserController::class, 'active']);",
      '});',
    ].join('\n'));
    write('database/migrations/2024_01_01_create_courses.php', [
      '<?php',
      'class CreateCourses {',
      "  public function up() { Schema::create('courses', fn () => 1); }",
      '}',
    ].join('\n'));
    write('src/graph.test.js', [
      "describe('GraphStore', () => {",
      "  it('works', () => {});",
      '});',
    ].join('\n'));
    write('src/legacy.js', [
      'const a = 1;',
      'module.exports = { a };',
    ].join('\n'));
    write('app/CourseStatus.php', [
      '<?php',
      'class CourseStatus extends Model {',
      '}',
    ].join('\n'));
    write('docs/openapi.yaml', [
      'openapi: 3.0.0',
      'paths: {}',
    ].join('\n'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const verify = (evidence) => new GroundingWrapper(null, { subprojectRoot: dir }).verifyEvidence(evidence);

  it('verifies a route by its last literal path segment, under a group prefix', () => {
    assert.strictEqual(verify({ path: 'routes/api.php', line_range: [3, 3], symbol: 'GET /users/{id}/active', kind: 'route' }), true);
    assert.strictEqual(verify({ path: 'routes/api.php', line_range: [3, 3], symbol: 'GET /users/{id}/missing', kind: 'route' }), false);
  });

  it('verifies a multi-verb route', () => {
    assert.strictEqual(verify({ path: 'routes/api.php', line_range: [3, 3], symbol: 'GET|POST /users/{id}/active', kind: 'route' }), true);
  });

  it('verifies migration:<file>:<table> by the table name', () => {
    const ev = (table) => ({ path: 'database/migrations/2024_01_01_create_courses.php', line_range: [3, 3], symbol: `migration:2024_01_01_create_courses.php:${table}`, kind: 'migration' });
    assert.strictEqual(verify(ev('courses')), true);
    assert.strictEqual(verify(ev('invoices')), false);
  });

  it('verifies test blocks by their title', () => {
    assert.strictEqual(verify({ path: 'src/graph.test.js', line_range: [1, 3], symbol: 'describe GraphStore', kind: 'test' }), true);
    assert.strictEqual(verify({ path: 'src/graph.test.js', line_range: [2, 2], symbol: 'it works', kind: 'test' }), true);
    assert.strictEqual(verify({ path: 'src/graph.test.js', line_range: [1, 3], symbol: 'describe Missing', kind: 'test' }), false);
  });

  it('verifies the `default` symbol against module.exports', () => {
    assert.strictEqual(verify({ path: 'src/legacy.js', line_range: [2, 2], symbol: 'default', kind: 'variable' }), true);
    assert.strictEqual(verify({ path: 'src/legacy.js', line_range: [1, 1], symbol: 'default', kind: 'variable' }), false);
  });

  it('verifies a db_table named after its model class', () => {
    assert.strictEqual(verify({ path: 'app/CourseStatus.php', line_range: [2, 2], symbol: 'course_statuses', kind: 'db_table' }), true);
    assert.strictEqual(verify({ path: 'app/CourseStatus.php', line_range: [2, 2], symbol: 'invoices', kind: 'db_table' }), false);
  });

  it('accepts a file-level contract named after the file', () => {
    assert.strictEqual(verify({ path: 'docs/openapi.yaml', line_range: [1, 1], symbol: 'openapi:openapi.yaml', kind: 'api_endpoint' }), true);
  });

  it('still rejects an unrelated symbol and out-of-range lines', () => {
    assert.strictEqual(verify({ path: 'src/legacy.js', line_range: [1, 1], symbol: 'nothing', kind: 'function' }), false);
    assert.strictEqual(verify({ path: 'src/legacy.js', line_range: [1, 99], symbol: 'a', kind: 'variable' }), false);
  });
});
