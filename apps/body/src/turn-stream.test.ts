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
  it('publishes every chunk as a provisional draft keyed by the turn’s request id', async () => {
    const { api, writes } = recorder();
    const stream = new AgentTurnStream({
      api,
      agentId: 'a'.repeat(64),
      roomId: 'room-id',
      requestId: 'request-id',
      label: 'monolith Room room-id',
    });
    for (const full of PROSE_TOOL_PROSE) stream.onChunk('', full);
    await stream.drained();
    expect(writes.map((write) => write.name)).toEqual(Array(4).fill('postAgentDraft'));
    expect(writes.map((write) => write.input.text)).toEqual(PROSE_TOOL_PROSE);
    for (const write of writes) expect(write.input.turnId).toBe('request-id');
    // The joined stream is the draft lane's material, and it is longer than
    // the final run whenever the turn spoke before a tool call.
    expect(stream.streamedText).toBe(PROSE_TOOL_PROSE.at(-1));
  });

  it('never publishes an empty or preamble-only draft', async () => {
    const { api, writes } = recorder();
    const stream = new AgentTurnStream({
      api,
      agentId: 'a'.repeat(64),
      roomId: 'room-id',
      requestId: 'request-id',
      label: 'corner room-id',
    });
    stream.onChunk('', '');
    stream.onChunk('', 'pi v1.2.3');
    await stream.drained();
    expect(writes).toEqual([]);
  });

  it('forgets the previous run when a re-pinned retry starts', async () => {
    const { api } = recorder();
    const stream = new AgentTurnStream({
      api,
      agentId: 'a'.repeat(64),
      roomId: 'room-id',
      requestId: 'request-id',
      label: 'corner room-id',
    });
    stream.onChunk('', 'First run text.');
    stream.beginRun();
    expect(stream.streamedText).toBe('');
    await stream.drained();
  });

  it('keeps a failed draft publish off the turn: the reply still settles', async () => {
    const writes: string[] = [];
    const api = {
      execute: vi.fn(async (name: string) => {
        writes.push(name);
        if (name === 'postAgentDraft') throw new Error('relay refused the draft');
        return { id: 'write-id', createdAt: 1 };
      }),
    } as unknown as DaemonApiClient;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = new AgentTurnStream({
      api,
      agentId: 'a'.repeat(64),
      roomId: 'room-id',
      requestId: 'request-id',
      label: 'corner room-id',
    });
    stream.onChunk('', 'Working on it.');
    await stream.drained();
    await stream.settle('The fix is ready.');
    errors.mockRestore();
    expect(writes).toEqual(['postAgentDraft', 'postRoomMessage', 'retractAgentLiveOutput']);
  });

  it('settles a silent turn by dissolving the draft with no durable message', async () => {
    const { api, writes } = recorder();
    const stream = new AgentTurnStream({
      api,
      agentId: 'a'.repeat(64),
      roomId: 'room-id',
      requestId: 'request-id',
      label: 'corner room-id',
    });
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
      for (const full of PROSE_TOOL_PROSE) stream.onChunk('', full);
      await stream.drained();
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
