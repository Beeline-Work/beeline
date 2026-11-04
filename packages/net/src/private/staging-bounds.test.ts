import { describe, expect, it } from 'vitest';
import { jsonBytes, remember } from './staging-bounds.js';

describe('shared private staging helpers', () => {
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
