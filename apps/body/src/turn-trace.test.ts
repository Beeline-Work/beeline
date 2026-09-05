import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatTurnTraceLine,
  TURN_PHASES,
  TurnTrace,
  TurnTraceFile,
  turnTraceDirectory,
  type TurnTraceRecord,
} from './turn-trace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A hand-driven monotonic clock: every duration here is a difference of two of its readings. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function trace(now: () => number, sink?: { write(record: TurnTraceRecord): Promise<void> }) {
  return new TurnTrace({
    surface: 'room',
    agentId: 'agent-1',
    roomId: 'room-1',
    requestId: 'ask-1',
    now,
    ...(sink ? { sink } : {}),
  });
}

describe('turn phase trace', () => {
  it('separates queue, activation, context, model and publish time on one attempt', async () => {
    const { now, advance } = clock();
    const turn = trace(now);
    turn.noteScheduler('queue', {
      live: 4,
      pending: 0,
      busy: 4,
      queuedChannels: 2,
      maxLive: 4,
      perRoom: 10,
    });
    turn.start('queue-wait');
    advance(2_500);
    turn.noteCapacityWait();
    turn.end('queue-wait');
    turn.noteActivation('cold');
    turn.start('activation');
    advance(3_100);
    turn.end('activation');
    turn.start('context-fetch');
    advance(220);
    turn.end('context-fetch');
    turn.promptSent();
    advance(1_900);
    turn.firstModelOutput();
    advance(2_900);
    turn.promptSettled();
    turn.start('publish');
    advance(180);
    turn.end('publish');

    const record = await turn.finish('complete');
    expect(record.attempts).toHaveLength(1);
    const [attempt] = record.attempts;
    expect(attempt!.activation).toBe('cold');
    expect(attempt!.capacityWait).toBe(true);
    expect(attempt!.phases).toEqual({
      'queue-wait': 2_500,
      activation: 3_100,
      'context-fetch': 220,
      'first-model-output': 1_900,
      'model-stream': 2_900,
      publish: 180,
    });
    expect(record.totalMs).toBe(10_800);
    expect(record.scheduler.atQueue?.maxLive).toBe(4);
  });

  it('records a warm turn as zero activation, not as a missing measurement', async () => {
    const { now, advance } = clock();
    const turn = trace(now);
    turn.start('queue-wait');
    advance(1);
    turn.end('queue-wait');
    turn.noteActivation('warm');
    turn.promptSent();
    advance(400);
    turn.firstModelOutput();
    advance(600);
    turn.promptSettled();
    const record = await turn.finish('complete');
    expect(record.attempts[0]!.activation).toBe('warm');
    expect(record.attempts[0]!.phases.activation).toBeUndefined();
    expect(record.attempts[0]!.phases['first-model-output']).toBe(400);
  });

  it('gives a provider retry its own attempt and its own activation', async () => {
    const { now, advance } = clock();
    const turn = trace(now);
    turn.noteActivation('cold');
    turn.start('activation');
    advance(3_000);
    turn.end('activation');
    turn.promptSent();
    advance(4_000);
    turn.promptSettled();

    turn.retry({ provider: 'novita', reason: 'the model ended its turn with no text' });
    turn.start('activation');
    advance(2_000);
    turn.end('activation');
    turn.promptSent();
    advance(700);
    turn.firstModelOutput();
    advance(1_300);
    turn.promptSettled();

    const record = await turn.finish('complete');
    expect(record.attempts.map((attempt) => attempt.attemptId)).toEqual(['ask-1#1', 'ask-1#2']);
    // The silent first attempt streamed nothing: its whole wait is first-token time.
    expect(record.attempts[0]!.phases).toEqual({
      activation: 3_000,
      'first-model-output': 4_000,
    });
    expect(record.attempts[1]).toMatchObject({
      attempt: 2,
      activation: 'cold',
      provider: 'novita',
      retryReason: 'the model ended its turn with no text',
      phases: { activation: 2_000, 'first-model-output': 700, 'model-stream': 1_300 },
    });
  });

  it('measures tool work as the union of outstanding calls, never a sum', async () => {
    const { now, advance } = clock();
    const turn = trace(now);
    turn.promptSent();
    advance(100);
    turn.firstModelOutput();
    // Two calls run at once for 500ms; a sum would say 1000ms.
    turn.toolCalls([{ id: 'a' }, { id: 'b' }]);
    advance(500);
    turn.toolCalls([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
    ]);
    advance(200);
    turn.toolCalls([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'in_progress' },
    ]);
    advance(300);
    turn.promptSettled();
    const record = await turn.finish('complete');
    expect(record.attempts[0]!.phases['tool-work']).toBe(800);
    expect(record.attempts[0]!.phases['model-stream']).toBe(1_000);
    expect(record.attempts[0]!.toolCalls).toBe(3);
  });

  it('still yields a timeline when the turn fails mid-phase', async () => {
    const { now, advance } = clock();
    const turn = trace(now);
    turn.start('queue-wait');
    advance(50);
    turn.end('queue-wait');
    turn.noteActivation('cold');
    turn.start('activation');
    advance(9_000);
    const record = await turn.finish('failed', 'harness exited before session/new');
    expect(record.outcome).toBe('failed');
    expect(record.reason).toBe('harness exited before session/new');
    expect(record.attempts[0]!.phases.activation).toBe(9_000);
  });

  it('writes one JSON line per turn under the runtime directory and never returns a Room row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-turn-trace-'));
    roots.push(root);
    const directory = turnTraceDirectory(root);
    expect(directory).toBe(join(root, 'turn-traces'));
    const lines: string[] = [];
    const sink = new TurnTraceFile(directory, {
      log: (line) => lines.push(line),
      clock: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    const { now, advance } = clock();
    const turn = trace(now, sink);
    turn.promptSent();
    advance(1_200);
    turn.firstModelOutput();
    advance(800);
    turn.promptSettled();
    await turn.finish('complete');

    const path = join(directory, 'turns-2026-09-04.jsonl');
    const written = (await readFile(path, 'utf8')).trim().split('\n');
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!) as TurnTraceRecord;
    expect(parsed.requestId).toBe('ask-1');
    expect(parsed.attempts[0]!.phases['first-model-output']).toBe(1_200);
    // The first line names where the record went; both stay operator-local.
    expect(lines[0]).toContain(path);
    expect(lines[0]).toContain('first-model-output 1.20s');
  });

  it('prunes traces older than the retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-turn-trace-prune-'));
    roots.push(root);
    const directory = turnTraceDirectory(root);
    const sink = new TurnTraceFile(directory, {
      log: () => undefined,
      clock: () => new Date('2026-09-04T10:00:00.000Z'),
    });
    await sink.write({
      version: 1,
      surface: 'room',
      agentId: 'a',
      roomId: 'r',
      requestId: 'q',
      startedAt: '2026-09-04T10:00:00.000Z',
      outcome: 'complete',
      totalMs: 1,
      attempts: [],
      scheduler: {},
    });
    const stale = join(directory, 'turns-2026-08-01.jsonl');
    const fresh = join(directory, 'turns-2026-09-01.jsonl');
    await writeFile(stale, '{}\n');
    await writeFile(fresh, '{}\n');
    // The day is already pruned in this process; a second day rolls it again.
    const nextDay = new TurnTraceFile(directory, {
      log: () => undefined,
      clock: () => new Date('2026-09-05T10:00:00.000Z'),
    });
    await nextDay.write({
      version: 1,
      surface: 'room',
      agentId: 'a',
      roomId: 'r',
      requestId: 'q2',
      startedAt: '2026-09-05T10:00:00.000Z',
      outcome: 'complete',
      totalMs: 1,
      attempts: [],
      scheduler: {},
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('names tool work as nested so no reader sums the phases', () => {
    const line = formatTurnTraceLine({
      version: 1,
      surface: 'room',
      agentId: 'a',
      roomId: 'room-1',
      requestId: 'ask-1',
      startedAt: '2026-09-04T10:00:00.000Z',
      outcome: 'complete',
      totalMs: 5_000,
      attempts: [
        {
          attemptId: 'ask-1#1',
          attempt: 1,
          activation: 'warm',
          phases: { 'model-stream': 4_000, 'tool-work': 2_500 },
          toolCalls: 2,
        },
      ],
      scheduler: {},
    });
    expect(line).toContain('tool-work 2.50s (within model time)');
    expect(line).toContain('2 tool calls');
  });

  it('holds the phase vocabulary the task named', () => {
    expect(TURN_PHASES).toEqual([
      'queue-wait',
      'activation',
      'context-fetch',
      'first-model-output',
      'model-stream',
      'tool-work',
      'publish',
    ]);
  });
});
