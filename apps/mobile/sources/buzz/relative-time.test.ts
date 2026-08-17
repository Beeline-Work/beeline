import { describe, expect, it } from 'vitest';

import { compactRelativeTime, ledgerStamp } from './relative-time';

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

describe('compactRelativeTime', () => {
  it('renders nothing for a missing or zero timestamp', () => {
    expect(compactRelativeTime(undefined, NOW_MS)).toBe('');
    expect(compactRelativeTime(0, NOW_MS)).toBe('');
  });

  it('treats a clock-skewed future timestamp as now rather than a negative age', () => {
    expect(compactRelativeTime(NOW_S + 90, NOW_MS)).toBe('now');
  });

  it('steps through units without ever rendering a full unit of the smaller one', () => {
    expect(compactRelativeTime(NOW_S - 10, NOW_MS)).toBe('now');
    expect(compactRelativeTime(NOW_S - 44, NOW_MS)).toBe('now');
    expect(compactRelativeTime(NOW_S - 45, NOW_MS)).toBe('1m');
    expect(compactRelativeTime(NOW_S - 3599, NOW_MS)).toBe('59m');
    expect(compactRelativeTime(NOW_S - 3600, NOW_MS)).toBe('1h');
    expect(compactRelativeTime(NOW_S - 86_399, NOW_MS)).toBe('23h');
    expect(compactRelativeTime(NOW_S - 86_400, NOW_MS)).toBe('1d');
    expect(compactRelativeTime(NOW_S - 6 * 86_400, NOW_MS)).toBe('6d');
    expect(compactRelativeTime(NOW_S - 7 * 86_400, NOW_MS)).toBe('1w');
    expect(compactRelativeTime(NOW_S - 300 * 86_400, NOW_MS)).toBe('42w');
    expect(compactRelativeTime(NOW_S - 400 * 86_400, NOW_MS)).toBe('1y');
  });

  it('never grows past three characters, so the mono column cannot reflow', () => {
    for (const elapsed of [0, 60, 3_600, 86_400, 604_800, 31_536_000, 315_360_000]) {
      expect(compactRelativeTime(NOW_S - elapsed, NOW_MS).length).toBeLessThanOrEqual(3);
    }
  });
});

describe('ledgerStamp', () => {
  it('renders nothing to hang in the margin for a missing timestamp', () => {
    expect(ledgerStamp(undefined)).toBe('');
    expect(ledgerStamp(0)).toBe('');
    expect(ledgerStamp(Number.NaN)).toBe('');
  });

  it('is a zero-padded 24h clock, so the gutter is the same width on every row', () => {
    for (const seconds of [NOW_S, NOW_S - 3_600, NOW_S - 86_400, 1, 2_000_000_000]) {
      expect(ledgerStamp(seconds)).toMatch(/^[0-2]\d:[0-5]\d$/);
      expect(ledgerStamp(seconds)).toHaveLength(5);
    }
  });

  it('reads the writer’s wall clock, not an age that shifts under the reader', () => {
    const at = new Date(NOW_S * 1000);
    const expected = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(ledgerStamp(NOW_S)).toBe(expected);
    // Same input, same output, however much later it is read.
    expect(ledgerStamp(NOW_S)).toBe(expected);
  });
});
