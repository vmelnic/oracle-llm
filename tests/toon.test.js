import { describe, it } from 'node:test';
import assert from 'node:assert';
import { toToon, estimateToonSavings } from '../src/grounding/toon.js';

describe('toToon', () => {
  it('serializes null and undefined', () => {
    assert.strictEqual(toToon(null), 'null');
    assert.strictEqual(toToon(undefined), 'null');
  });

  it('serializes primitives', () => {
    assert.strictEqual(toToon(42), '42');
    assert.strictEqual(toToon('hello'), 'hello');
    assert.strictEqual(toToon(true), 'true');
  });

  it('serializes empty object', () => {
    assert.strictEqual(toToon({}), '{}');
  });

  it('serializes simple object', () => {
    const result = toToon({ name: 'foo', count: 3 });
    assert.ok(result.includes('name: foo'));
    assert.ok(result.includes('count: 3'));
  });

  it('serializes null values as dash', () => {
    const result = toToon({ x: null });
    assert.ok(result.includes('x: -'));
  });

  it('skips undefined values', () => {
    const result = toToon({ a: 1, b: undefined, c: 2 });
    assert.ok(!result.includes('b:'));
    assert.ok(result.includes('a: 1'));
    assert.ok(result.includes('c: 2'));
  });

  it('serializes flat array as inline', () => {
    const result = toToon({ items: [1, 2, 3] });
    assert.ok(result.includes('[1,2,3]'));
  });

  it('serializes empty array', () => {
    const result = toToon({ items: [] });
    assert.ok(result.includes('[]'));
  });

  it('tabularizes homogeneous object arrays', () => {
    const result = toToon({
      rows: [
        { name: 'a', val: 1 },
        { name: 'b', val: 2 },
      ],
    });
    assert.ok(result.includes('{name,val}'));
    assert.ok(result.includes('a,1'));
    assert.ok(result.includes('b,2'));
  });

  it('serializes nested objects', () => {
    const result = toToon({ outer: { inner: 'val' } });
    assert.ok(result.includes('inner: val'));
  });

  it('handles strings needing quotes', () => {
    const result = toToon({ msg: 'hello world' });
    assert.ok(result.includes('"hello world"'));
  });

  it('handles boolean values in formatVal', () => {
    const result = toToon({ active: true, deleted: false });
    assert.ok(result.includes('active: true'));
    assert.ok(result.includes('deleted: false'));
  });

  it('handles arrays of mixed objects (non-tabular)', () => {
    const result = toToon({
      items: [
        { a: 1, nested: { x: 1 } },
        { a: 2, nested: { x: 2 } },
      ],
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

describe('estimateToonSavings', () => {
  it('computes savings for array of objects', () => {
    const data = {
      items: [
        { name: 'alpha', value: 100, active: true },
        { name: 'beta', value: 200, active: false },
        { name: 'gamma', value: 300, active: true },
      ],
    };
    const savings = estimateToonSavings(data);
    assert.ok(savings.json_chars > 0);
    assert.ok(savings.toon_chars > 0);
    assert.ok(typeof savings.savings_pct === 'number');
    assert.ok(savings.json_tokens_est > 0);
    assert.ok(savings.toon_tokens_est > 0);
  });

  it('works with simple objects', () => {
    const savings = estimateToonSavings({ x: 1 });
    assert.ok(typeof savings.savings_pct === 'number');
  });
});
