import { describe, expect, it } from 'vitest';
import { WarmTranscript, type TranscriptRow } from './warm-transcript.js';

const rows = (count: number, from = 1, authorId = 'human'): TranscriptRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index + from}`,
    line: `line ${index + from}`,
    authorId,
  }));

describe('warm transcript', () => {
  it('sends the whole window to a session that has never seen it', () => {
    const warm = new WarmTranscript();
    const selection = warm.select('session-a', rows(30));
    expect(selection.rows).toHaveLength(30);
    expect(selection.elided).toBe(0);
  });

  it('sends only rows the same warm session has not seen', () => {
    const warm = new WarmTranscript();
    const first = rows(30);
    warm.select('session-a', first);
    // Two more messages arrived; the window slid by two.
    const second = [...first.slice(2), ...rows(2, 31)];
    const selection = warm.select('session-a', second);
    expect(selection.rows.map((row) => row.id)).toEqual(['m31', 'm32']);
    expect(selection.elided).toBe(second.length - 2);
  });

  it("never resends the agent's own reply to the warm session that wrote it", () => {
    const warm = new WarmTranscript();
    const first = rows(5);
    warm.select('session-a', first, 'self');
    const second = [...first, ...rows(1, 6, 'self'), ...rows(1, 7)];
    expect(warm.select('session-a', second, 'self').rows.map((row) => row.id)).toEqual(['m7']);
  });

  it("keeps the agent's own rows when the session is cold", () => {
    const warm = new WarmTranscript();
    const window = [...rows(2), ...rows(1, 3, 'self')];
    expect(warm.select('session-a', window, 'self').rows).toHaveLength(3);
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
    expect(attemptOne.rows).toHaveLength(0);
    expect(attemptOne.elided).toBe(30);
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
});
