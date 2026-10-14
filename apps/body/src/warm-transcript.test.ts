import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WarmTranscript, type TranscriptRow } from './warm-transcript.js';

const rows = (count: number, from = 1, authorId = 'human'): TranscriptRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index + from}`,
    line: `line ${index + from}`,
    authorId,
  }));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function persisted() {
  const root = mkdtempSync(join(tmpdir(), 'beeline-warm-transcript-'));
  roots.push(root);
  return { path: join(root, 'warm-transcript.json') };
}

describe('warm transcript', () => {
  it('restores delivered rows and completed messages for the same native session after restart', () => {
    const options = persisted();
    const first = new WarmTranscript(options);
    first.rememberSession('native-session', 'configuration');
    first.select('native-session', rows(3));
    first.complete('native-session', ['m4']);
    const restarted = new WarmTranscript(options);
    expect(restarted.resumeSessionId('configuration')).toBe('native-session');
    expect(restarted.select('native-session', rows(5)).rows.map(row => row.id)).toEqual(['m5']);
    expect(statSync(options.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(options.path, 'utf8')).not.toContain('line 1');
  });

  it('starts cold for a different native session or changed configuration', () => {
    const options = persisted();
    const first = new WarmTranscript(options);
    first.rememberSession('session-a', 'configuration');
    first.select('session-a', rows(3));
    const restarted = new WarmTranscript(options);
    expect(restarted.resumeSessionId('new-configuration')).toBeUndefined();
    expect(restarted.select('session-b', rows(3)).rows).toHaveLength(3);
  });

  it('does not resume across the existing 30-minute idle boundary', () => {
    let now = 1;
    const options = { ...persisted(), now: () => now };
    const first = new WarmTranscript(options);
    first.rememberSession('session-a', 'configuration');
    first.select('session-a', rows(3));
    now += 30 * 60_000;
    expect(new WarmTranscript(options).resumeSessionId('configuration')).toBeUndefined();
  });

  it('checkpoints a still-active long turn at update handover without delivering its unfinished ask', () => {
    let now = 1;
    const options = { ...persisted(), now: () => now };
    const first = new WarmTranscript(options);
    first.rememberSession('session-a', 'configuration');
    first.select('session-a', rows(3));
    now += 40 * 60_000;
    first.complete('session-a', []);
    const restarted = new WarmTranscript(options);
    expect(restarted.resumeSessionId('configuration')).toBe('session-a');
    expect(restarted.select('session-a', rows(4)).rows.map(row => row.id)).toEqual(['m4']);
  });

  it('invalidates discarded sessions durably and tolerates a truncated record', () => {
    const options = persisted();
    const first = new WarmTranscript(options);
    first.rememberSession('session-a', 'configuration');
    first.select('session-a', rows(3));
    first.forgetSession();
    expect(new WarmTranscript(options).resumeSessionId('configuration')).toBeUndefined();
    writeFileSync(options.path, '{');
    expect(new WarmTranscript(options).select('session-a', rows(3)).rows).toHaveLength(3);
  });

  it('excludes completed task and steer messages from the next warm transcript', () => {
    const warm = new WarmTranscript();
    warm.select('session-a', rows(2));
    warm.complete('session-a', ['m3', 'm4']);
    expect(warm.select('session-a', rows(5)).rows.map((row) => row.id)).toEqual(['m5']);
  });

  it('does not mark a task completed in a different session as delivered', () => {
    const warm = new WarmTranscript();
    warm.select('session-b', rows(2));
    warm.complete('session-a', ['m3']);
    expect(warm.select('session-b', rows(3)).rows.map((row) => row.id)).toEqual(['m3']);
  });

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
