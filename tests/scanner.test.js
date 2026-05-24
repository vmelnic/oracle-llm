import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectSubprojects } from '../src/scanner/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-test-'));
}

describe('detectSubprojects', () => {
  it('finds a single package.json project', async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.js'), '');

    const sp = await detectSubprojects(root);
    assert.strictEqual(sp.length, 1);
    assert.strictEqual(sp[0].language, 'javascript');
    assert.strictEqual(sp[0].framework, null);

    fs.rmSync(root, { recursive: true });
  });

  it('detects nextjs framework', async () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '14.0.0' } })
    );

    const sp = await detectSubprojects(root);
    assert.strictEqual(sp[0].framework, 'nextjs');

    fs.rmSync(root, { recursive: true });
  });

  it('detects symfony framework', async () => {
    const root = makeTempDir();
    fs.writeFileSync(
      path.join(root, 'composer.json'),
      JSON.stringify({ require: { 'symfony/framework-bundle': '6.4.0' } })
    );

    const sp = await detectSubprojects(root);
    assert.strictEqual(sp[0].framework, 'symfony');
    assert.strictEqual(sp[0].language, 'php');

    fs.rmSync(root, { recursive: true });
  });

  it('excludes nested manifests', async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }));
    const nested = path.join(root, 'packages', 'a');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'a' }));

    const sp = await detectSubprojects(root);
    assert.strictEqual(sp.length, 1);
    assert.strictEqual(sp[0].id, 'root');

    fs.rmSync(root, { recursive: true });
  });
});
