import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';

function recorder() {
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  const api = {
    execute: vi.fn(async (name: string, input: Record<string, unknown>) => {
      writes.push({ name, input });
      return { id: 'write-id', createdAt: 1 };
    }),
  } as unknown as DaemonApiClient;
  return { api, writes };
}

/** Let every already-scheduled microtask and its followers run. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A recorder whose draft writes hang on the wire until the test releases them —
 * slow HTTP, deterministically. Every other operation answers at once, so a
 * held draft is the only thing a test is measuring.
 */
function gatedRecorder() {
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  const gates: Array<(error?: Error) => void> = [];
  const api = {
    execute: vi.fn((name: string, input: Record<string, unknown>) => {
      writes.push({ name, input });
      if (name !== 'postAgentDraft') return Promise.resolve({ id: 'write-id', createdAt: 1 });
      return new Promise((resolve, reject) => {
        gates.push((error) =>
          error ? reject(error) : resolve({ id: 'write-id', createdAt: 1 }),
        );
      });
    }),
  } as unknown as DaemonApiClient;
  /** Complete (or fail) the oldest draft still on the wire. */
  const release = async (error?: Error) => {
    gates.shift()?.(error);
    await settled();
  };
  const names = () => writes.map((write) => write.name);
  const texts = () =>
    writes.filter((write) => write.name === 'postAgentDraft').map((write) => write.input.text);
  return { api, writes, release, names, texts, held: () => gates.length };
}

const streamFor = (api: DaemonApiClient, roomId = 'room-id', label = 'monolith Room room-id') =>
  new AgentTurnStream({ api, agentId: 'a'.repeat(64), roomId, requestId: 'request-id', label });

/** One streamed turn as the ACP hook sees it: every run joined, growing. */
const PROSE_TOOL_PROSE = [
  'I inspected',
  'I inspected the code.',
  'I inspected the code.\n\nThe fix',
  'I inspected the code.\n\nThe fix is ready.',
];

describe('durable reply text', () => {
  it('returns the harness final whole, never a slice of a longer stream', () => {
    // The retired corner arithmetic cut the final by the number of characters
    // already streamed. The offset indexed the JOINED stream while the cut was
    // applied to the last run alone, so this turn lost its closing message.
    const streamed = PROSE_TOOL_PROSE.at(-1)!;
    const agentText = 'The fix is ready.';
    expect(streamed.length).toBeGreaterThan(agentText.length);
    expect(agentText.slice(streamed.indexOf('The fix'))).toBe('');
    expect(durableReplyText(agentText)).toBe('The fix is ready.');
  });

  it('keeps an uninterrupted turn, whose stream and final are the same string', () => {
    expect(durableReplyText('I will update only the ledger. Then commit.')).toBe(
      'I will update only the ledger. Then commit.',
    );
  });

  it('drops harness startup preamble and scaffold echo, and reports a silent turn as empty', () => {
    expect(durableReplyText('pi v1.2.3\n\nHere is the answer.')).toBe('Here is the answer.');
    expect(durableReplyText("Answer the human's newest message.\nThe fix is ready.")).toBe(
      'The fix is ready.',
    );
    expect(durableReplyText('   ')).toBe('');
  });
});

describe('agent turn stream', () => {
  it('shows the reader every snapshot the wire keeps up with, in order', async () => {
    const { api, writes } = recorder();
    const stream = streamFor(api);
    // A wire that keeps pace with the harness publishes each snapshot: the
    // reader's experience of a streamed answer is unchanged.
    for (const full of PROSE_TOOL_PROSE) {
      stream.onChunk('', full);
      await settled();
    }
    expect(writes.map((write) => write.name)).toEqual(Array(4).fill('postAgentDraft'));
    expect(writes.map((write) => write.input.text)).toEqual(PROSE_TOOL_PROSE);
    for (const write of writes) expect(write.input.turnId).toBe('request-id');
    // The joined stream is the draft lane's material, and it is longer than
    // the final run whenever the turn spoke before a tool call.
    expect(stream.streamedText).toBe(PROSE_TOOL_PROSE.at(-1));
  });

  it('keeps ONE draft on the wire and only the newest snapshot waiting', async () => {
    // This replaces the old "publishes every chunk" rule. A draft is a picture
    // of the whole answer so far, so a snapshot overtaken before it reached the
    // wire is a frame nobody needed — not a lost message. What survives is that
    // the reader only ever sees the text move forward.
    const { api, release, texts, held } = gatedRecorder();
    const stream = streamFor(api);
    for (const full of PROSE_TOOL_PROSE) stream.onChunk('', full);
    // Four deltas, one write: the lane no longer chains a write per delta.
    expect(texts()).toEqual([PROSE_TOOL_PROSE[0]]);
    expect(held()).toBe(1);
    await release();
    // The two snapshots in between were dropped; the reader jumps to the newest.
    expect(texts()).toEqual([PROSE_TOOL_PROSE[0], PROSE_TOOL_PROSE.at(-1)]);
    await release();
    expect(texts()).toHaveLength(2);
    expect(held()).toBe(0);
  });

  it('never publishes an empty or preamble-only draft', async () => {
    const { api, writes } = recorder();
    const stream = streamFor(api, 'room-id', 'corner room-id');
    stream.onChunk('', '');
    stream.onChunk('', 'pi v1.2.3');
    await settled();
    expect(writes).toEqual([]);
  });

  it('forgets the abandoned run, waiting snapshot and all, when a retry starts', async () => {
    const { api, release, texts } = gatedRecorder();
    const stream = streamFor(api, 'room-id', 'corner room-id');
    stream.onChunk('', 'First run text.');
    stream.onChunk('', 'First run text. More of it.');
    stream.beginRun();
    expect(stream.streamedText).toBe('');
    stream.onChunk('', 'Second run.');
    await release();
    // The abandoned run's waiting snapshot is dead text: the retry rewrites the
    // answer from its first delta, so generations never interleave.
    expect(texts()).toEqual(['First run text.', 'Second run.']);
    await release();
    expect(stream.streamedText).toBe('Second run.');
  });

  it('lets the finished answer overtake a draft still on the wire', async () => {
    const { api, release, names, writes } = gatedRecorder();
    const stream = streamFor(api);
    for (const full of PROSE_TOOL_PROSE) stream.onChunk('', full);
    stream.close();
    const turn = stream.settle('The fix is ready.', { triggerMessageId: 'request-id' });
    await settled();
    // The durable reply is already published while the first draft has still
    // not landed, and the snapshots waiting behind it were dropped by close().
    expect(names()).toEqual(['postAgentDraft', 'postRoomMessage']);
    await release();
    await turn;
    // The retract is the LAST word on the lane, after the late write.
    expect(names()).toEqual(['postAgentDraft', 'postRoomMessage', 'retractAgentLiveOutput']);
    const durable = writes.filter((write) => write.name === 'postRoomMessage');
    expect(durable).toHaveLength(1);
    expect(durable[0]?.input).toMatchObject({ requestId: 'request-id', text: 'The fix is ready.' });
  });

  it('keeps a failed draft publish off the turn, and the lane alive after it', async () => {
    const { api, release, names, texts } = gatedRecorder();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = streamFor(api, 'room-id', 'corner room-id');
    stream.onChunk('', 'Working on it.');
    stream.onChunk('', 'Working on it. Nearly there.');
    await release(new Error('relay refused the draft'));
    // A refused write is logged and the next snapshot still goes out.
    expect(texts()).toEqual(['Working on it.', 'Working on it. Nearly there.']);
    await release();
    await stream.settle('The fix is ready.');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    expect(names()).toEqual([
      'postAgentDraft',
      'postAgentDraft',
      'postRoomMessage',
      'retractAgentLiveOutput',
    ]);
  });

  it('settles even when the late draft write fails after the answer landed', async () => {
    const { api, release, names } = gatedRecorder();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = streamFor(api, 'room-id', 'corner room-id');
    stream.onChunk('', 'Working on it.');
    const turn = stream.settle('The fix is ready.');
    await settled();
    await release(new Error('relay refused the draft'));
    await expect(turn).resolves.toBeUndefined();
    errors.mockRestore();
    expect(names()).toEqual(['postAgentDraft', 'postRoomMessage', 'retractAgentLiveOutput']);
  });

  it('settles a silent turn by dissolving the draft with no durable message', async () => {
    const { api, writes } = recorder();
    const stream = streamFor(api, 'room-id', 'corner room-id');
    await stream.settle('');
    expect(writes).toEqual([
      {
        name: 'retractAgentLiveOutput',
        input: {
          agentId: 'a'.repeat(64),
          roomId: 'room-id',
          turnId: 'request-id',
          kind: 'draft',
        },
      },
    ]);
  });
});

describe('Room and corner streaming parity (C100)', () => {
  it('produces the same presentation for the same turn on both surfaces', async () => {
    const agentId = 'a'.repeat(64);
    const run = async (roomId: string, label: string, fields = {}) => {
      const { api, writes } = recorder();
      const stream = new AgentTurnStream({ api, agentId, roomId, requestId: 'request-id', label });
      for (const full of PROSE_TOOL_PROSE) {
        stream.onChunk('', full);
        await settled();
      }
      await stream.settle(durableReplyText('The fix is ready.'), fields);
      return writes;
    };
    const room = await run('room-id', 'monolith Room room-id', { triggerMessageId: 'request-id' });
    const corner = await run('corner-id', 'corner corner-id');
    // Identical shape: four provisional drafts, one durable reply under the
    // turn's request id, one retract. The corner posts no extra durable row.
    expect(corner.map((write) => write.name)).toEqual(room.map((write) => write.name));
    expect(corner.map((write) => write.name)).toEqual([
      ...Array(4).fill('postAgentDraft'),
      'postRoomMessage',
      'retractAgentLiveOutput',
    ]);
    expect(corner.map((write) => ({ ...write.input, roomId: 'x' }))).toEqual(
      room.map((write) => ({
        ...write.input,
        roomId: 'x',
        // Routing, not presentation: only a Room reply names its trigger.
        ...(write.name === 'postRoomMessage' ? { triggerMessageId: undefined } : {}),
      })),
    );
  });

  it('leaves exactly one implementation of the draft lane in the tree', () => {
    const source = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8');
    for (const file of ['monolith-room-turn.ts', 'monolith-corner-turn.ts']) {
      const text = source(file);
      expect(text).toContain("from './turn-stream.js'");
      // Neither loop may publish, or retract, live output of its own.
      expect(text).not.toContain('postAgentDraft');
      expect(text).not.toContain('retractAgentLiveOutput');
    }
    expect(source('turn-stream.ts')).toContain('postAgentDraft');
  });
});
