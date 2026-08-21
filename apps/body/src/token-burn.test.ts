/**
 * What the daemon spends when nobody asked it to.
 *
 * The report was "dozens of tool calls doing nothing" and a 5-hour model limit
 * gone. None of that spend is visible in a transcript, so it was measured off
 * the captain's own durable state instead:
 *
 *   ~/.local/state/beeline/agents/07cc9948…/rooms/1f6e289d…/body-state.json
 *     file size            5.47 MB
 *     conversation entries 200          (the durable cap)
 *     characters           114,630
 *     ≈ input tokens       ~28,700
 *
 * That transcript was replayed IN FULL into every re-primed ACP session's
 * SYSTEM prompt — and a system prompt is re-sent by the harness on every
 * request, so the cost recurred per TURN, not per restart. Their claude daemon
 * restarted 14 times that day.
 *
 * Sources measured here rather than argued:
 *   1. the unbounded re-prime block;
 *   2. a Room denial that names the rule but not "stop", inviting the model to
 *      walk the tool ladder (write → edit → bash → patch), each rung a turn.
 * Restart continuation is separately exercised through `restoreSubchannels`
 * in `body.test.ts`: original authority, one process-wide attempt, bounded
 * re-prime, and explicit spend attribution.
 */
import { describe, expect, it } from 'vitest';
import {
  CORNER_RESUME_MAX_TURNS,
  SESSION_REPRIME_ELIDED_NOTE,
  SESSION_REPRIME_MAX_CHARS,
  measureSessionReprime,
  repriseSystemPromptBlock,
  repriseTranscriptLines,
  type RepriseEntry,
} from './session-reprime.js';
import { ROOM_READ_ONLY_STEER } from './session-sandbox.js';

/** Measured shape of the captain's Room: 200 entries, ~114,630 characters. */
function capturedRoomTranscript(): RepriseEntry[] {
  const entries: RepriseEntry[] = [];
  for (let index = 0; index < 200; index++) {
    // ~573 chars/entry is the measured mean (114,630 / 200).
    const role = index % 2 === 0 ? 'user' : 'agent';
    entries.push({ role, text: `message ${index} `.padEnd(573, 'x') });
  }
  return entries;
}

describe('re-priming a session does not replay the whole Room', () => {
  const transcript = capturedRoomTranscript();

  it('measures the burn the captain was paying, per turn', () => {
    const measured = measureSessionReprime(transcript);
    const before = 'x'.repeat(measured.beforeChars);
    const after = measured.block;
    const tokens = (text: string) => Math.round(text.length / 4);

    // The captured size, to within rounding of the real file.
    expect(before.length).toBeGreaterThan(110_000);
    expect(tokens(before)).toBeGreaterThan(27_000);

    // And what it costs now.
    expect(after.length).toBeLessThanOrEqual(SESSION_REPRIME_MAX_CHARS + 400);
    expect(tokens(after)).toBeLessThan(2_500);
    // Better than a 90% cut on every turn of every restored session.
    expect(after.length / before.length).toBeLessThan(0.1);
    expect(measured).toMatchObject({ entries: 200 });
    expect(measured.beforeTokens).toBeGreaterThan(27_000);
    expect(measured.afterTokens).toBeLessThan(2_500);
  });

  it('keeps the NEWEST exchanges, because that is the thread being resumed', () => {
    const lines = repriseTranscriptLines(transcript);
    // The last entry survives; the first does not.
    expect(lines.some((line) => line.includes('message 199'))).toBe(true);
    expect(lines.some((line) => line.includes('message 0 '))).toBe(false);
  });

  it('says out loud that older history was left out', () => {
    expect(repriseTranscriptLines(transcript)[0]).toBe(SESSION_REPRIME_ELIDED_NOTE);
  });

  it('restores a short conversation completely, with no note and no loss', () => {
    const short: RepriseEntry[] = [
      { role: 'user', text: 'fix the offline banner' },
      { role: 'agent', text: 'done, pushed for review' },
    ];
    const lines = repriseTranscriptLines(short);
    expect(lines).toEqual(['[user] fix the offline banner', '[agent] done, pushed for review']);
  });

  it('restores nothing at all for a brand-new channel', () => {
    expect(repriseSystemPromptBlock([])).toBe('');
    expect(repriseSystemPromptBlock([{ role: 'user', text: '   ' }])).toBe('');
  });

  it('never lets one enormous entry eat the whole budget', () => {
    const lines = repriseTranscriptLines([
      { role: 'user', text: 'the question that matters' },
      { role: 'agent', text: 'x'.repeat(200_000) },
    ]);
    expect(lines.join('\n').length).toBeLessThanOrEqual(SESSION_REPRIME_MAX_CHARS);
    // …and the short entry beside it still survives.
    expect(lines.some((line) => line.includes('the question that matters'))).toBe(true);
  });
  it('resumes a corner from structured facts and only the recent tail', () => {
    const turns = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'agent' : 'user', text: `turn-${index} detail` }));
    const measured = measureSessionReprime(turns, SESSION_REPRIME_MAX_CHARS, { objective: 'Preserve continuity', plan: { items: [{ step: 'Protect steers', status: 'in_progress' }] }, changedFiles: ['a.ts'], commits: ['abc123 change'] });
    expect(measured.block).toContain('CORNER RESUME BRIEF');
    expect(measured.block).toContain('[in_progress] Protect steers');
    expect(measured.block).not.toContain('turn-0 ');
    expect(measured.block).toContain(`turn-${20 - CORNER_RESUME_MAX_TURNS}`);
    expect(measured.block.length).toBeLessThanOrEqual(SESSION_REPRIME_MAX_CHARS);
  });
});

describe('a denial closes the search instead of inviting the next tool', () => {
  it('tells the agent to stop, not merely what is forbidden', () => {
    expect(ROOM_READ_ONLY_STEER).toMatch(/read-only/i);
    expect(ROOM_READ_ONLY_STEER).toMatch(/open a corner/i);
    // The part that ends the retry ladder.
    expect(ROOM_READ_ONLY_STEER).toMatch(/do not retry with a different tool/i);
    expect(ROOM_READ_ONLY_STEER).toMatch(/whichever tool asks/i);
    expect(ROOM_READ_ONLY_STEER).toMatch(/stop trying/i);
  });

  it('names the classes of action that are refused, so none reads as untried', () => {
    for (const action of ['write', 'edit', 'move', 'delete', 'shell']) {
      expect(ROOM_READ_ONLY_STEER.toLowerCase()).toContain(action);
    }
  });
});
