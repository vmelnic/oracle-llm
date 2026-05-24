import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ManifestDrafter } from '../src/manifest/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ManifestDrafter', () => {
  function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-manifest-'));
  }

  it('drafts a manifest for a JS project', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'test-app',
      dependencies: { next: '14.0.0' },
      scripts: { build: 'next build', dev: 'next dev' },
    }));
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });

    const drafter = new ManifestDrafter();
    const manifest = await drafter.draft({
      id: 'sp1', root: dir, framework: 'nextjs', language: 'javascript',
    });

    assert.strictEqual(manifest.subproject, 'sp1');
    assert.strictEqual(manifest.framework, 'nextjs');
    assert.strictEqual(manifest.language, 'javascript');
    assert.strictEqual(manifest.version, '14.0.0');
    assert.ok(manifest.build);
    assert.strictEqual(manifest.build.bundler, undefined);

    fs.rmSync(dir, { recursive: true });
  });

  it('detects test frameworks', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'jest.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { mocha: '10.0.0' } }));

    const drafter = new ManifestDrafter();
    const manifest = await drafter.draft({
      id: 'sp1', root: dir, framework: 'express', language: 'javascript',
    });

    assert.ok(manifest.test_frameworks);
    assert.ok(manifest.test_frameworks.includes('jest'));
    assert.ok(manifest.test_frameworks.includes('mocha'));

    fs.rmSync(dir, { recursive: true });
  });

  it('detects migrations', async () => {
    const dir = makeTempDir();
    const migDir = path.join(dir, 'migrations');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, '20240101000000_init.sql'), 'CREATE TABLE users();');
    fs.writeFileSync(path.join(migDir, '20240102000000_add_col.sql'), 'ALTER TABLE users ADD col;');

    const drafter = new ManifestDrafter();
    const manifest = await drafter.draft({
      id: 'sp1', root: dir, framework: 'unknown', language: 'javascript',
    });

    assert.ok(manifest.migrations);
    assert.strictEqual(manifest.migrations.count, 2);

    fs.rmSync(dir, { recursive: true });
  });

  it('detects entry points', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export default {};');

    const drafter = new ManifestDrafter();
    const manifest = await drafter.draft({
      id: 'sp1', root: dir, framework: 'express', language: 'javascript',
    });

    assert.ok(manifest.entry_points);
    assert.ok(manifest.entry_points.includes('src/index.js'));

    fs.rmSync(dir, { recursive: true });
  });

  it('detects vite bundler', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {};');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));

    const drafter = new ManifestDrafter();
    const manifest = await drafter.draft({
      id: 'sp1', root: dir, framework: 'vue', language: 'javascript',
    });

    assert.ok(manifest.build);
    assert.strictEqual(manifest.build.bundler, 'vite');

    fs.rmSync(dir, { recursive: true });
  });

  it('saves and loads manifest as YAML', async () => {
    const dir = makeTempDir();
    const outPath = path.join(dir, 'manifest.yaml');

    const drafter = new ManifestDrafter();
    const manifest = { subproject: 'sp1', framework: 'express', language: 'javascript' };

    await drafter.save(manifest, outPath);
    assert.ok(fs.existsSync(outPath));

    const loaded = drafter.load(outPath);
    assert.strictEqual(loaded.subproject, 'sp1');
    assert.strictEqual(loaded.framework, 'express');

    fs.rmSync(dir, { recursive: true });
  });

  it('load returns null for missing file', () => {
    const drafter = new ManifestDrafter();
    assert.strictEqual(drafter.load('/nonexistent.yaml'), null);
  });

  it('merges existing manifest with drafted', () => {
    const drafter = new ManifestDrafter();
    const existing = { framework: 'custom-express', lsp: 'tsserver' };
    const drafted = { framework: 'express', language: 'javascript', lsp: null };

    const merged = drafter.merge(existing, drafted);
    assert.strictEqual(merged.framework, 'custom-express');
    assert.strictEqual(merged.language, 'javascript');
    assert.strictEqual(merged.lsp, 'tsserver');
  });

  it('merge deep-merges objects', () => {
    const drafter = new ManifestDrafter();
    const existing = { conventions: { linter: 'eslint', custom: true } };
    const drafted = { conventions: { linter: 'none', formatter: 'prettier' } };

    const merged = drafter.merge(existing, drafted);
    assert.strictEqual(merged.conventions.linter, 'eslint');
    assert.strictEqual(merged.conventions.custom, true);
    assert.strictEqual(merged.conventions.formatter, 'prettier');
  });

  it('detects symfony version from composer.json', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({
      require: { 'symfony/framework-bundle': '^6.4.0' },
    }));

    const drafter = new ManifestDrafter();
    const manifest = await drafter.draft({
      id: 'sp1', root: dir, framework: 'symfony', language: 'php',
    });

    assert.strictEqual(manifest.version, '6.4.0');
    fs.rmSync(dir, { recursive: true });
  });
});
