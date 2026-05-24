import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Bm25Index } from '../src/retrieval/bm25.js';

describe('Bm25Index', () => {
  it('indexes and searches documents', () => {
    const idx = new Bm25Index();
    idx.addDocument('1', 'function foo returns string async', { kind: 'function', symbol: 'foo' });
    idx.addDocument('2', 'class Bar extends Foo', { kind: 'class', symbol: 'Bar' });
    idx.addDocument('3', 'function baz async handler', { kind: 'function', symbol: 'baz' });

    const results = idx.search('async function');
    assert.ok(results.length >= 2);
    assert.ok(results[0].score > 0);
  });

  it('filters by kind', () => {
    const idx = new Bm25Index();
    idx.addDocument('1', 'function foo', { kind: 'function', symbol: 'foo' });
    idx.addDocument('2', 'class Foo', { kind: 'class', symbol: 'Foo' });

    const results = idx.search('foo', { kinds: ['class'] });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].node.kind, 'class');
  });

  it('removes and re-adds documents', () => {
    const idx = new Bm25Index();
    idx.addDocument('1', 'hello world', { kind: 'function', symbol: 'a' });
    idx.removeDocument('1');
    const results = idx.search('hello');
    assert.strictEqual(results.length, 0);
  });

  it('serializes and loads', () => {
    const idx = new Bm25Index();
    idx.addDocument('1', 'route GET /users auth middleware', { kind: 'route', symbol: 'GET /users' });
    const data = idx.serialize();

    const idx2 = new Bm25Index();
    idx2.load(data);
    const results = idx2.search('users route');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].node.symbol, 'GET /users');
  });
});
