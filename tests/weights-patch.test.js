import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WeightsThenPatch } from '../src/l3/weights-patch.js';
import { GraphStore } from '../src/graph/store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-wtp-'));
  return { dir, dbPath: path.join(dir, 'test.sqlite') };
}

function seedStore(store) {
  store.upsertNodes([
    {
      subprojectId: 'sp1', path: 'src/auth.js', lang: 'javascript',
      symbol: 'login', kind: 'function', parentId: null,
      startLine: 10, endLine: 30, exported: true,
      signature: 'login()', doc: null,
      commitSha: null, fileBlobHash: 'a1', metadata: null,
    },
    {
      subprojectId: 'sp1', path: 'src/user.js', lang: 'javascript',
      symbol: 'UserService', kind: 'class', parentId: null,
      startLine: 1, endLine: 50, exported: true,
      signature: 'class UserService', doc: null,
      commitSha: null, fileBlobHash: 'b1', metadata: null,
    },
  ]);
}

describe('WeightsThenPatch', () => {
  it('returns validated answer when no mismatches', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);
    seedStore(store);

    const wtp = new WeightsThenPatch(store, null, null);
    const result = wtp.validate({
      answer: {
        definitions: [{ symbol: 'login', path: 'src/auth.js', start_line: 10, kind: 'function' }],
      },
      confidence: 0.9,
    }, 'sp1');

    assert.strictEqual(result._validated, true);
    assert.strictEqual(result._patches, 0);
    assert.strictEqual(result.confidence, 0.9);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('patches path mismatch', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);
    seedStore(store);

    const wtp = new WeightsThenPatch(store, null, null);
    const result = wtp.validate({
      answer: {
        definitions: [{ symbol: 'login', path: 'wrong/path.js', start_line: 10, kind: 'function' }],
      },
      confidence: 0.9,
    }, 'sp1');

    assert.strictEqual(result._patches, 1);
    assert.ok(result.confidence < 0.9);
    assert.strictEqual(result.answer.definitions[0].path, 'src/auth.js');

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('patches kind mismatch', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);
    seedStore(store);

    const wtp = new WeightsThenPatch(store, null, null);
    const result = wtp.validate({
      answer: {
        definitions: [{ symbol: 'login', path: 'src/auth.js', start_line: 10, kind: 'method' }],
      },
      confidence: 0.8,
    }, 'sp1');

    assert.ok(result._patches >= 1);
    assert.ok(result.confidence < 0.8);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('records drift log', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);
    seedStore(store);

    const wtp = new WeightsThenPatch(store, null, null);
    wtp.validate({
      answer: {
        definitions: [{ symbol: 'login', path: 'wrong.js', start_line: 999, kind: 'function' }],
      },
      confidence: 0.8,
    }, 'sp1');

    const drift = wtp.getDriftLog();
    assert.strictEqual(drift.length, 1);
    assert.ok(drift[0].patches.length > 0);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('saves drift log to file', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);
    seedStore(store);

    const wtp = new WeightsThenPatch(store, null, null);
    wtp.validate({
      answer: { definitions: [{ symbol: 'login', path: 'x.js', start_line: 1 }] },
      confidence: 0.5,
    }, 'sp1');

    const logPath = path.join(dir, 'drift.json');
    wtp.saveDriftLog(logPath);
    assert.ok(fs.existsSync(logPath));
    const saved = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    assert.strictEqual(saved.length, 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('handles null answer gracefully', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);

    const wtp = new WeightsThenPatch(store, null, null);
    const result = wtp.validate(null, 'sp1');
    assert.strictEqual(result, null);

    const result2 = wtp.validate({ answer: null }, 'sp1');
    assert.ok(result2);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('validates convention claims against manifest', () => {
    const { dir, dbPath } = tempDb();
    const store = new GraphStore(dbPath);

    const manifest = { conventions: { auth: 'JWT' } };
    const wtp = new WeightsThenPatch(store, null, manifest);
    const result = wtp.validate({
      answer: { conventions: [{ topic: 'auth', value: 'session-based' }] },
      confidence: 0.9,
    }, 'sp1');

    assert.ok(result._patches >= 1);

    store.close();
    fs.rmSync(dir, { recursive: true });
  });
});
