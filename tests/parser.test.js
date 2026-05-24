import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createParser } from '../src/parser/index.js';

describe('createParser', () => {
  const parser = createParser();

  it('returns parser with expected methods', () => {
    assert.ok(typeof parser.parse === 'function');
    assert.ok(typeof parser.parseFile === 'function');
    assert.ok(typeof parser.walk === 'function');
    assert.ok(typeof parser.query === 'function');
    assert.ok(typeof parser.supportedLanguages === 'function');
    assert.ok(typeof parser.languageFor === 'function');
  });

  it('supportedLanguages includes javascript', () => {
    const langs = parser.supportedLanguages();
    assert.ok(langs.includes('javascript'));
  });

  it('languageFor maps .js to javascript', () => {
    assert.strictEqual(parser.languageFor('foo.js'), 'javascript');
  });

  it('languageFor maps .ts to typescript', () => {
    assert.strictEqual(parser.languageFor('foo.ts'), 'typescript');
  });

  it('languageFor maps .tsx to tsx', () => {
    assert.strictEqual(parser.languageFor('foo.tsx'), 'tsx');
  });

  it('languageFor returns null for unknown extensions', () => {
    assert.strictEqual(parser.languageFor('foo.xyz'), null);
  });

  it('parses JavaScript code', () => {
    const tree = parser.parse('const x = 1;', 'javascript');
    assert.ok(tree);
    assert.ok(tree.rootNode);
    assert.ok(!tree.rootNode.hasError);
  });

  it('parses TypeScript code', () => {
    const tree = parser.parse('const x: number = 1;', 'typescript');
    assert.ok(tree);
    assert.ok(!tree.rootNode.hasError);
  });

  it('parses Vue files by extracting script block', () => {
    const vue = `<template><div></div></template>\n<script>\nexport default { name: 'App' }\n</script>`;
    const tree = parser.parse(vue, 'vue');
    assert.ok(tree);
  });

  it('parses Vue with TypeScript lang', () => {
    const vue = `<script lang="ts">\nconst x: number = 1;\n</script>`;
    const tree = parser.parse(vue, 'vue');
    assert.ok(tree);
  });

  it('walk visits all nodes', () => {
    const tree = parser.parse('const x = 1;', 'javascript');
    const types = [];
    parser.walk(tree, (node) => { types.push(node.type); });
    assert.ok(types.length > 0);
    assert.ok(types.includes('program'));
  });

  it('walk can skip children by returning false', () => {
    const tree = parser.parse('const x = 1; const y = 2;', 'javascript');
    const types = [];
    parser.walk(tree, (node) => {
      types.push(node.type);
      if (node.type === 'lexical_declaration') return false;
    });
    assert.ok(types.includes('lexical_declaration'));
  });

  it('query with node type string', () => {
    const tree = parser.parse('function foo() {} function bar() {}', 'javascript');
    const matches = parser.query(tree, 'function_declaration', 'javascript');
    assert.strictEqual(matches.length, 2);
  });

  it('throws for unavailable language', () => {
    assert.throws(() => parser.parse('test', 'nonexistent_lang'), /not available/);
  });

  it('parseFile returns null for unknown extension', async () => {
    const result = await parser.parseFile('/some/file.xyz');
    assert.strictEqual(result, null);
  });
});
