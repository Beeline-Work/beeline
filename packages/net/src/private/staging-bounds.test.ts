import { describe, expect, it } from 'vitest';
import { jsonBytes, remember, stagingWithinBudget } from './staging-bounds.js';

const KiB = 1024;
const size = (value: { bytes: number }) => value.bytes;
const position = (value: { position: number }) => value.position;

describe('shared private staging bounds', () => {
  it('preserves insertion-primary versus earliest-position-primary budgets without reordering maps', () => {
    const entries = new Map([['first', { bytes: 256 * KiB, position: 10 }], ['earlier', { bytes: 1024 * KiB, position: 0 }]]);
    expect(stagingWithinBudget(entries.values(), size)).toBe(false);
    expect(stagingWithinBudget(entries.values(), size, position)).toBe(true);
    expect([...entries.keys()]).toEqual(['first', 'earlier']);
    entries.get('earlier')!.position = 10;
    expect(stagingWithinBudget(entries.values(), size, position)).toBe(false);
  });

  it('accepts exact logical/future/count boundaries and rejects the next byte or entry', () => {
    const primary = { bytes: 1024 * KiB, position: 0 };
    const entries = [primary, ...Array.from({ length: 16 }, (_, index) => ({ bytes: 16 * KiB, position: index + 1 }))];
    expect(stagingWithinBudget([], size)).toBe(true);
    expect(stagingWithinBudget(entries, size, position)).toBe(true);
    expect(stagingWithinBudget([...entries, { bytes: 0, position: 17 }], size, position)).toBe(false);
    entries[1]!.bytes++;
    expect(stagingWithinBudget(entries, size, position)).toBe(false);
    expect(stagingWithinBudget([{ bytes: 1024 * KiB + 1 }], size)).toBe(true);
  });

  it('evicts insertion-old history even when its duplicate value was replaced', () => {
    const history = new Map<number, string>();
    for (let index = 0; index < 128; index++) remember(history, index, `value-${index}`);
    remember(history, 0, 'replacement');
    expect(history.size).toBe(128); expect(history.get(0)).toBe('replacement');
    remember(history, 128, 'next');
    expect(history.size).toBe(128); expect(history.has(0)).toBe(false);
    expect([...history.keys()]).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
  });

  it('counts serialized UTF8 bytes rather than code units', () => {
    expect(jsonBytes({ text: 'é🙂' })).toBe(Buffer.byteLength(JSON.stringify({ text: 'é🙂' })));
    expect(jsonBytes({ text: 'é🙂' })).toBeGreaterThan(JSON.stringify({ text: 'é🙂' }).length);
  });
});
