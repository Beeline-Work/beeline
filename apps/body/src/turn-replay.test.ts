import { expect, it } from 'vitest';
import { sanitizeTurnReplay } from '@beeline/api-contract/daemon';
import { TurnTrace } from './turn-trace.js';

it('records ordered calls, terminal durations and unfinished calls without arguments or personal details', () => {
  let clock = 0;
  const trace = new TurnTrace({ surface: 'room', agentId: 'agent', roomId: 'room', requestId: 'request', now: () => clock });
  const privateText = 'person@example.com sk-secret1234567890 https://example.com/path?secret=yes';
  trace.toolCalls([{ id: 'a', title: 'read', status: 'in_progress', rawInput: privateText }]);
  clock = 12;
  trace.toolCalls([{ id: 'a', title: 'read', status: 'completed', content: privateText },
    { id: 'b', title: 'post', status: 'in_progress' }]);
  clock = 25;
  trace.toolCalls([{ id: 'b', title: 'post', status: 'failed', content: `permission denied ${privateText}` }]);
  trace.toolCalls([{ id: 'c', title: `shell ${privateText}`, status: 'in_progress' }]);
  const replay = trace.replay()!;
  expect(replay.attempts[0]?.tools).toEqual([
    { name: 'read', outcome: 'ok', durationMs: 12 },
    { name: 'post', outcome: 'refused', durationMs: 13, error: 'permission denied [EMAIL] [TOKEN] [URL]' },
    { name: 'unknown', outcome: 'unfinished', durationMs: 0 },
  ]);
  const stored = JSON.stringify(trace.snapshot('failed', privateText));
  for (const secret of ['person@example.com', 'sk-secret1234567890', 'secret=yes', 'rawInput']) expect(stored).not.toContain(secret);
  expect(sanitizeTurnReplay({ ...replay, arguments: privateText })).toEqual(replay);
});

it('whitelists malicious wire payloads and caps excerpts at the server boundary', () => {
  const trace = sanitizeTurnReplay({ totalMs: Infinity, message: 'private', attempts: [null, {
    phases: { publish: 10, private: 'message' }, tools: [{ name: 'a@example.com', outcome: 'bad', durationMs: -1,
      error: 'email me at me@example.com token=abcdef https://x.test/?secret=abcd ' + 'a '.repeat(200), arguments: 'private' }],
  }] });
  expect(trace?.attempts[0]?.tools).toEqual([]);
  expect(trace?.attempts[1]?.tools[0]).toMatchObject({ name: 'unknown', outcome: 'unfinished', durationMs: 0 });
  expect(trace?.attempts[1]?.tools[0]?.error?.length).toBeLessThanOrEqual(160);
  expect(JSON.stringify(trace)).not.toMatch(/private|example.com|secret=|arguments/);
});

it('bounds and redacts optional pre-session failure metadata without changing normal traces', () => {
  const base = {totalMs:0, attempts:[]};
  expect(sanitizeTurnReplay(base)).toEqual(base);
  expect(sanitizeTurnReplay({...base, reason:'token=private https://private.example', reasonKind:'workspace-failure'}))
    .toEqual({...base,reason:'[SECRET] [URL]',reasonKind:'workspace-failure'});
  for (const reasonKind of ['BAD', 'a'.repeat(41), 'contains secret', 12, null]) {
    expect(sanitizeTurnReplay({...base,reason:12,reasonKind})).toEqual(base);
  }
});
