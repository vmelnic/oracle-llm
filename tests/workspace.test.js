import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('workspace module', () => {
  let originalHome;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-ws-'));
    originalHome = process.env.ORACLE_HOME;
    process.env.ORACLE_HOME = tmpDir;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.ORACLE_HOME = originalHome;
    else delete process.env.ORACLE_HOME;
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('saveWorkspace and loadWorkspace round-trip', async () => {
    const { saveWorkspace, loadWorkspace } = await import('../src/scanner/workspace.js');
    const ws = { id: 'test-ws', root: '/tmp/test', subprojects: [] };
    saveWorkspace(ws);
    const loaded = loadWorkspace('test-ws');
    assert.deepStrictEqual(loaded, ws);
  });

  it('loadWorkspace returns null for missing workspace', async () => {
    const { loadWorkspace } = await import('../src/scanner/workspace.js');
    assert.strictEqual(loadWorkspace('nonexistent'), null);
  });

  it('getOracleDir returns correct path', async () => {
    const { getOracleDir } = await import('../src/scanner/workspace.js');
    const dir = getOracleDir('my-ws');
    assert.ok(dir.includes('my-ws'));
  });

  it('getSubprojectDir returns correct path', async () => {
    const { getSubprojectDir } = await import('../src/scanner/workspace.js');
    const dir = getSubprojectDir('my-ws', 'sp1');
    assert.ok(dir.includes('my-ws'));
    assert.ok(dir.includes('sp1'));
    assert.ok(dir.includes('subprojects'));
  });
});
