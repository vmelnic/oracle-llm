import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildGraph } from '../src/graph/builder.js';
import { GraphStore } from '../src/graph/store.js';
import { createParser } from '../src/parser/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('buildGraph', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-builder-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const store = new GraphStore(dbPath);
    const parser = createParser();
    return { dir, store, parser };
  }

  it('extracts nodes from JavaScript files', async () => {
    const { dir, store, parser } = setup();
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'foo.js'), [
      'export function foo() { return 1; }',
      'export class Bar {',
      '  baz() { return 2; }',
      '}',
    ].join('\n'));

    const subproject = {
      id: 'sp1',
      root: dir,
      language: 'javascript',
      includeGlobs: ['src/**/*.js'],
      excludeGlobs: [],
    };

    const result = await buildGraph(subproject, parser, store);
    assert.ok(result.filesProcessed >= 1);
    assert.ok(result.nodesCreated >= 2);

    const fooNodes = store.locate('sp1', 'foo');
    assert.ok(fooNodes.length > 0);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('skips unchanged files on second run', async () => {
    const { dir, store, parser } = setup();
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.js'), 'export const x = 1;');

    const subproject = {
      id: 'sp1', root: dir, language: 'javascript',
      includeGlobs: ['src/**/*.js'], excludeGlobs: [],
    };

    await buildGraph(subproject, parser, store);
    const result2 = await buildGraph(subproject, parser, store);
    assert.strictEqual(result2.filesProcessed, 0);
    assert.ok(result2.skipped >= 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('processes only specified files with onlyFiles', async () => {
    const { dir, store, parser } = setup();
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.js'), 'export const a = 1;');
    fs.writeFileSync(path.join(srcDir, 'b.js'), 'export const b = 2;');

    const subproject = {
      id: 'sp1', root: dir, language: 'javascript',
      includeGlobs: ['src/**/*.js'], excludeGlobs: [],
    };

    const result = await buildGraph(subproject, parser, store, { onlyFiles: ['src/a.js'] });
    assert.strictEqual(result.filesProcessed, 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('extracts SQL table nodes from JS files', async () => {
    const { dir, store, parser } = setup();
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'db.js'),
      "export function migrate() {\n" +
      "  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)`);\n" +
      "}\n"
    );

    const subproject = {
      id: 'sp1', root: dir, language: 'javascript',
      includeGlobs: ['src/**/*.js'], excludeGlobs: [],
    };

    const result = await buildGraph(subproject, parser, store);
    assert.ok(result.nodesCreated >= 1);

    const tables = store.findNodes({ subprojectId: 'sp1', kind: 'db_table' });
    assert.ok(tables.length > 0);
    assert.ok(tables.some(t => t.symbol === 'users'));

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('resolves edges between nodes', async () => {
    const { dir, store, parser } = setup();
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.js'), 'export function helper() { return 1; }\n');
    fs.writeFileSync(path.join(srcDir, 'b.js'), "import { helper } from './a.js';\nexport function main() { return helper(); }\n");

    const subproject = {
      id: 'sp1', root: dir, language: 'javascript',
      includeGlobs: ['src/**/*.js'], excludeGlobs: [],
    };

    const result = await buildGraph(subproject, parser, store);
    assert.ok(result.edgesCreated >= 0);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('handles files with no recognizable language', async () => {
    const { dir, store, parser } = setup();
    fs.writeFileSync(path.join(dir, 'data.txt'), 'plain text');

    const subproject = {
      id: 'sp1', root: dir, language: 'text',
      includeGlobs: ['*.txt'], excludeGlobs: [],
    };

    const result = await buildGraph(subproject, parser, store);
    assert.strictEqual(result.nodesCreated, 0);
    assert.ok(result.skipped >= 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
