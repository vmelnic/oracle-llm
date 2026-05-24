import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { GraphStore } from '../src/graph/store.js';
import { GroundingWrapper } from '../src/grounding/index.js';
import { PatternCatalogue } from '../src/patterns/index.js';
import { L2Index } from '../src/retrieval/index.js';

import { locate } from '../src/mcp/tools/locate.js';
import { exists } from '../src/mcp/tools/exists.js';
import { stats } from '../src/mcp/tools/graph-stats.js';
import { readExact } from '../src/mcp/tools/read-exact.js';
import { nearby } from '../src/mcp/tools/nearby.js';

import fs from 'fs';
import path from 'path';
import os from 'os';

function makeCtx(store, spRoot) {
  const catalogue = new PatternCatalogue(store);
  const l2 = new L2Index(store, {});
  return {
    store,
    subproject: { id: 'sp1', root: spRoot, language: 'javascript' },
    grounding: new GroundingWrapper(store),
    workspace: { id: 'ws1', subprojects: [{ id: 'sp1', root: spRoot }] },
    patterns: catalogue,
    manifest: {},
    l2,
    l3: null,
    weightsPatch: null,
  };
}

describe('MCP Tools', () => {
  let dir, dbPath, store, spRoot;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-mcp-'));
    dbPath = path.join(dir, 'test.sqlite');
    store = new GraphStore(dbPath);
    spRoot = path.join(dir, 'project');
    fs.mkdirSync(path.join(spRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(spRoot, 'src', 'index.js'), 'export function hello() {\n  return "world";\n}\n');

    store.upsertNodes([
      {
        subprojectId: 'sp1', path: 'src/index.js', lang: 'javascript',
        symbol: 'hello', kind: 'function', parentId: null,
        startLine: 1, endLine: 3, exported: true, signature: 'hello()',
        doc: null, commitSha: null, fileBlobHash: 'a', metadata: null,
      },
      {
        subprojectId: 'sp1', path: 'src/index.js', lang: 'javascript',
        symbol: 'goodbye', kind: 'function', parentId: null,
        startLine: 5, endLine: 7, exported: true, signature: 'goodbye()',
        doc: null, commitSha: null, fileBlobHash: 'a', metadata: null,
      },
    ]);
  });

  after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('oracle.locate finds a symbol', async () => {
    const ctx = makeCtx(store, spRoot);
    const result = await locate(ctx, { symbol: 'hello' });
    assert.ok(result.answer);
    assert.ok(result.answer.definitions?.length > 0 || result.answer.length > 0);
  });

  it('oracle.exists searches by description', async () => {
    const ctx = makeCtx(store, spRoot);
    const result = await exists(ctx, { description: 'hello function' });
    assert.ok(result.answer !== undefined);
  });

  it('oracle.stats returns counts', async () => {
    const ctx = makeCtx(store, spRoot);
    const result = await stats(ctx, {});
    assert.ok(result.answer);
  });

  it('oracle.read_exact reads file lines', async () => {
    const ctx = makeCtx(store, spRoot);
    const result = await readExact(ctx, { path: 'src/index.js', line_range: [1, 2] });
    assert.ok(result.answer);
    const answer = typeof result.answer === 'string' ? result.answer : JSON.stringify(result.answer);
    assert.ok(answer.includes('hello'));
  });

  it('oracle.nearby finds symbols near a line', async () => {
    const ctx = makeCtx(store, spRoot);
    const result = await nearby(ctx, { path: 'src/index.js', line: 2 });
    assert.ok(result.answer);
  });
});
