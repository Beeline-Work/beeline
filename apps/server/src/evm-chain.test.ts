import { describe, expect, it } from 'vitest';
import { formatUnits, parseUnits } from './evm-chain.js';

describe('units', () => {
  it('converts decimals exactly and rejects excess precision', () => {
    expect(parseUnits('0.017', 18)).toBe(17_000_000_000_000_000n);
    expect(parseUnits('5', 6)).toBe(5_000_000n);
    expect(formatUnits(18193414389356520n, 18)).toBe('0.01819341438935652');
    expect(() => parseUnits('1.0000001', 6)).toThrow('more than 6 decimals');
    expect(() => parseUnits('-1', 6)).toThrow('invalid amount');
  });
});
