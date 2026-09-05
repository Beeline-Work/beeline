import { describe, expect, it } from 'vitest';
import { WARM_TRANSCRIPT_OVERLAP, WarmTranscript, type TranscriptRow } from './warm-transcript.js';

const rows = (count: number, from = 1): TranscriptRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index + from}`,
    line: `line ${index + from}`,
  }));

describe('warm transcript', () => {
  it('sends the whole window to a session that has never seen it', () => {
    const warm = new WarmTranscript();
    const selection = warm.select('session-a', rows(30));
    expect(selection.rows).toHaveLength(30);
    expect(selection.elided).toBe(0);
  });

  it('sends only what is new to the same warm session, keeping a recency overlap', () => {
    const warm = new WarmTranscript();
    const first = rows(30);
    warm.select('session-a', first);
    // Two more messages arrived; the window slid by two.
    const second = [...first.slice(2), ...rows(2, 31)];
    const selection = warm.select('session-a', second);
    expect(selection.rows.map((row) => row.id)).toEqual([
      ...second.slice(-WARM_TRANSCRIPT_OVERLAP).map((row) => row.id),
    ]);
    expect(selection.rows.map((row) => row.id)).toContain('m31');
    expect(selection.rows.map((row) => row.id)).toContain('m32');
    expect(selection.elided).toBe(second.length - WARM_TRANSCRIPT_OVERLAP);
  });

  it('replays everything to a session evicted and started cold again', () => {
    const warm = new WarmTranscript();
    const window = rows(30);
    warm.select('session-a', window);
    // The scheduler suspended the process; the next activation is a new id.
    const selection = warm.select('session-b', window);
    expect(selection.rows).toHaveLength(30);
    expect(selection.elided).toBe(0);
  });

  it('replays everything when a C92 re-pin retries the same turn on a fresh session', () => {
    const warm = new WarmTranscript();
    const window = rows(30);
    warm.select('session-a', window);
    const attemptOne = warm.select('session-a', window);
    expect(attemptOne.elided).toBeGreaterThan(0);
    // repinNextProvider() cleared the client and opened a new session.
    const attemptTwo = warm.select('session-c', window);
    expect(attemptTwo.rows).toHaveLength(30);
    expect(attemptTwo.elided).toBe(0);
  });

  it('replays everything when there is no live session yet', () => {
    const warm = new WarmTranscript();
    const window = rows(30);
    warm.select(undefined, window);
    expect(warm.select(undefined, window).elided).toBe(0);
  });

  it('never elides a window shorter than the overlap', () => {
    const warm = new WarmTranscript();
    const window = rows(WARM_TRANSCRIPT_OVERLAP);
    warm.select('session-a', window);
    expect(warm.select('session-a', window).elided).toBe(0);
  });

  it('says plainly when a render is only what is new', () => {
    const warm = new WarmTranscript();
    const window = rows(30);
    const whole = WarmTranscript.render(warm.select('session-a', window), 'Whole:', 'Since:');
    expect(whole.startsWith('Whole:\n')).toBe(true);
    expect(whole).toContain('line 1');
    const partial = WarmTranscript.render(warm.select('session-a', window), 'Whole:', 'Since:');
    expect(partial.startsWith('Since:\n')).toBe(true);
    expect(partial).not.toContain('line 1\n');
    expect(WarmTranscript.render(warm.select('session-a', []), 'Whole:', 'Since:')).toBe('');
  });
});
