import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseMarkdown, extractConventionRules, findConventionFiles, findDocFiles } from '../src/markdown/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('parseMarkdown', () => {
  it('parses headings into sections', () => {
    const md = `# Title\nSome text\n## Sub\nMore text`;
    const sections = parseMarkdown(md);
    assert.strictEqual(sections.length, 2);
    assert.strictEqual(sections[0].title, 'Title');
    assert.strictEqual(sections[0].level, 1);
    assert.strictEqual(sections[1].title, 'Sub');
    assert.strictEqual(sections[1].level, 2);
  });

  it('extracts tables', () => {
    const md = `# Table Section\n| Col1 | Col2 |\n| --- | --- |\n| a | b |\n| c | d |`;
    const sections = parseMarkdown(md);
    assert.strictEqual(sections[0].tables.length, 1);
    assert.deepStrictEqual(sections[0].tables[0].headers, ['Col1', 'Col2']);
    assert.strictEqual(sections[0].tables[0].rows.length, 2);
    assert.strictEqual(sections[0].tables[0].rows[0].Col1, 'a');
  });

  it('extracts code blocks', () => {
    const md = "# Code\n```js\nconst x = 1;\n```";
    const sections = parseMarkdown(md);
    assert.strictEqual(sections[0].codeBlocks.length, 1);
    assert.strictEqual(sections[0].codeBlocks[0].lang, 'js');
    assert.ok(sections[0].codeBlocks[0].content.includes('const x'));
  });

  it('extracts bullets', () => {
    const md = '# Bullets\n- item one\n- item two\n* item three';
    const sections = parseMarkdown(md);
    assert.strictEqual(sections[0].bullets.length, 3);
    assert.strictEqual(sections[0].bullets[0], 'item one');
  });

  it('returns empty for no headings', () => {
    assert.deepStrictEqual(parseMarkdown('just some text'), []);
  });

  it('handles empty input', () => {
    assert.deepStrictEqual(parseMarkdown(''), []);
  });
});

describe('extractConventionRules', () => {
  it('extracts table-based conventions', () => {
    const sections = parseMarkdown(`# Naming\n| Key | Value |\n| --- | --- |\n| variables | camelCase |\n| files | kebab-case |`);
    const rules = extractConventionRules(sections);
    assert.ok(rules.naming);
    assert.strictEqual(rules.naming.variables, 'camelCase');
    assert.strictEqual(rules.naming.files, 'kebab-case');
  });

  it('extracts bold key-value bullets', () => {
    const sections = parseMarkdown(`# Config\n- **timeout**: 30 seconds\n- **retries**: 3 attempts`);
    const rules = extractConventionRules(sections);
    assert.ok(rules.config);
    assert.strictEqual(rules.config.timeout, '30 seconds');
  });

  it('extracts code block examples', () => {
    const sections = parseMarkdown("# Example\n```js\nfoo()\n```");
    const rules = extractConventionRules(sections);
    assert.ok(rules.example);
    assert.ok(rules.example._example);
    assert.strictEqual(rules.example._lang, 'js');
  });
});

describe('findConventionFiles', () => {
  it('finds CLAUDE.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-md-'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Test');
    const found = findConventionFiles(dir);
    assert.ok(found.some(f => f.endsWith('CLAUDE.md')));
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty when no convention files exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-md-'));
    assert.deepStrictEqual(findConventionFiles(dir), []);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('findDocFiles', () => {
  it('finds README.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-md-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# README');
    const found = findDocFiles(dir);
    assert.ok(found.some(f => f.endsWith('README.md')));
    fs.rmSync(dir, { recursive: true });
  });

  it('finds docs directory markdown files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-md-'));
    const docsDir = path.join(dir, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide');
    const found = findDocFiles(dir);
    assert.ok(found.some(f => f.endsWith('guide.md')));
    fs.rmSync(dir, { recursive: true });
  });
});
