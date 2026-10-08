import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RoomViewHttpError,
  type RoomHistoryView,
  type RoomViewMessage,
} from '@beeline/buzz-client';

import {
  foldTranscriptRows,
  hostRowIndex,
  JUMP_NEWER_ROWS,
  useRoomMessageStore,
  type RoomHistoryClient,
} from './room-message-store';
import type { ChatDisplayMessage } from './room-view-presentation';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

/** Message `n` of a Room, ids and times in order. */
const row = (n: number): RoomViewMessage => ({
  id: n.toString(16).padStart(64, '0'),
  createdAt: n,
  text: `message-${n}`,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});
const room = (count: number) => Array.from({ length: count }, (_, index) => row(index + 1));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** The server's around page: 15 rows before the target, the target, 14 after. */
function serverOver(all: readonly RoomViewMessage[]): Required<RoomHistoryClient> {
  return {
    historyAround: vi.fn(async (_roomId: string, messageId: string) => {
      const index = all.findIndex((message) => message.id === messageId);
      if (index < 0) throw new RoomViewHttpError(404, 'not_found');
      return { roomId: 'room', messages: all.slice(Math.max(0, index - 15), index + 15) };
    }),
    historyAfter: vi.fn(async (_roomId: string, afterId: string) => {
      const index = all.findIndex((message) => message.id === afterId);
      return { roomId: 'room', messages: all.slice(index + 1, index + 31) };
    }),
    history: vi.fn(async (_roomId: string, before?: { id: string }) => {
      const index = all.findIndex((message) => message.id === before?.id);
      const start = Math.max(0, index - 30);
      return {
        roomId: 'room',
        messages: all.slice(start, index),
        ...(start > 0
          ? { nextBefore: { createdAt: all[start]!.createdAt, id: all[start]!.id } }
          : {}),
      };
    }),
  };
}

type Store = ReturnType<typeof useRoomMessageStore>;

async function mountStore(tail: readonly RoomViewMessage[], client: RoomHistoryClient) {
  const state: { current: Store } = { current: undefined as unknown as Store };
  function Probe() {
    state.current = useRoomMessageStore({
      roomId: 'room',
      tailMessages: tail,
      roomClient: client,
      enabled: true,
      initialVisibleCount: 30,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  return { state, renderer };
}

/** What the transcript shows: the window, then the tail once attached. */
const shownIds = (store: Store, tail: readonly RoomViewMessage[]) => {
  const ids = store.rows.map((message) => message.id);
  if (!store.attached) return ids;
  const seen = new Set(ids);
  return [...ids, ...tail.filter((message) => !seen.has(message.id)).map((message) => message.id)];
};

describe('jumpTo', () => {
  it('opens a distant target with at most a screen of newer rows below it', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const target = all[26]!;
    const client = serverOver(all);
    const { state, renderer } = await mountStore(tail, client);

    await act(async () => state.current.jumpTo(target.id));

    expect(client.historyAround).toHaveBeenCalledExactlyOnceWith('room', target.id);
    expect(state.current.jump).toEqual({ messageId: target.id, status: 'ready' });
    expect(state.current.attached).toBe(false);
    const ids = shownIds(state.current, tail);
    // The around page holds 14 rows after the target, fewer than the limit.
    expect(ids.length - 1 - ids.indexOf(target.id)).toBe(Math.min(14, JUMP_NEWER_ROWS));
    await act(async () => renderer.unmount());
  });

  it('walks the window forward to the tail without gaps or duplicates', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const client = serverOver(all);
    const { state, renderer } = await mountStore(tail, client);

    await act(async () => state.current.jumpTo(all[26]!.id));
    await act(async () => state.current.loadOlder(0));
    for (let step = 0; step < 12 && !state.current.attached; step += 1) {
      await act(async () => state.current.loadNewer());
    }

    expect(state.current.attached).toBe(true);
    const ids = shownIds(state.current, tail);
    expect(ids).toEqual(all.map((message) => message.id));
    await act(async () => renderer.unmount());
  });

  it('opens a resident target without a read', async () => {
    const tail = room(30);
    const client = serverOver(tail);
    const { state, renderer } = await mountStore(tail, client);

    await act(async () => state.current.jumpTo(tail[5]!.id));

    expect(client.historyAround).not.toHaveBeenCalled();
    expect(state.current.jump?.status).toBe('ready');
    expect(shownIds(state.current, tail).at(-1 - JUMP_NEWER_ROWS)).toBe(tail[5]!.id);
    await act(async () => state.current.loadNewer());
    expect(state.current.attached).toBe(true);
    expect(shownIds(state.current, tail)).toEqual(tail.map((message) => message.id));
    await act(async () => renderer.unmount());
  });

  it('keeps a target near the newest rows attached to the live tail', async () => {
    const tail = room(30);
    const { state, renderer } = await mountStore(tail, serverOver(tail));

    await act(async () => state.current.jumpTo(tail[27]!.id));

    expect(state.current.attached).toBe(true);
    expect(state.current.jump?.status).toBe('ready');
    await act(async () => renderer.unmount());
  });
});

describe('Reproduction NOTIFICATION-TAP-HANG', () => {
  it('path 1: a session reset during the read runs the jump again', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const target = all[26]!;
    const server = serverOver(all);
    const first = deferred<RoomHistoryView>();
    const historyAround = vi
      .fn<(roomId: string, messageId: string) => Promise<RoomHistoryView>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(server.historyAround);
    const { state, renderer } = await mountStore(tail, { ...server, historyAround });

    await act(async () => state.current.jumpTo(target.id));
    // The session effect resets the transcript in the same commit.
    await act(async () => state.current.reset());
    await act(async () => {
      first.resolve({ roomId: 'room', messages: [] });
      await first.promise;
    });

    expect(historyAround).toHaveBeenCalledTimes(2);
    expect(state.current.jump).toEqual({ messageId: target.id, status: 'ready' });
    expect(shownIds(state.current, tail)).toContain(target.id);
    await act(async () => renderer.unmount());
  });

  it('path 1: a reset after the landing leaves the reader where they are', async () => {
    const all = room(227);
    const client = serverOver(all);
    const { state, renderer } = await mountStore(all.slice(197), client);

    await act(async () => state.current.jumpTo(all[26]!.id));
    act(() => state.current.endJump());
    await act(async () => state.current.reset());

    expect(client.historyAround).toHaveBeenCalledTimes(1);
    expect(state.current.jump).toBeNull();
    await act(async () => renderer.unmount());
  });

  it('path 4: a read that fails ends in a retry state, never loading forever', async () => {
    const all = room(227);
    const server = serverOver(all);
    const historyAround = vi
      .fn<(roomId: string, messageId: string) => Promise<RoomHistoryView>>()
      .mockRejectedValueOnce(new RoomViewHttpError(0, 'timeout'))
      .mockImplementation(server.historyAround);
    const { state, renderer } = await mountStore(all.slice(197), { ...server, historyAround });

    await act(async () => state.current.jumpTo(all[26]!.id));
    expect(state.current.jump).toEqual({ messageId: all[26]!.id, status: 'error' });
    expect(state.current.attached).toBe(true);

    await act(async () => state.current.jumpTo(all[26]!.id));
    expect(state.current.jump?.status).toBe('ready');
    await act(async () => renderer.unmount());
  });

  it('a deleted or hidden target leaves the room at its newest rows, marked missing', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const { state, renderer } = await mountStore(tail, serverOver(all));

    await act(async () => state.current.jumpTo('f'.repeat(64)));

    expect(state.current.jump).toEqual({ messageId: 'f'.repeat(64), status: 'missing' });
    expect(state.current.attached).toBe(true);
    expect(shownIds(state.current, tail)).toEqual(tail.map((message) => message.id));
    // A reset does not ask again for a row the server does not have.
    await act(async () => state.current.reset());
    expect(state.current.jump?.status).toBe('missing');
    await act(async () => renderer.unmount());
  });

  it('a missing target from a detached window returns to the newest rows', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const { state, renderer } = await mountStore(tail, serverOver(all));

    await act(async () => state.current.jumpTo(all[26]!.id));
    act(() => state.current.endJump());
    expect(state.current.attached).toBe(false);

    await act(async () => state.current.jumpTo('f'.repeat(64)));

    expect(state.current.jump).toEqual({ messageId: 'f'.repeat(64), status: 'missing' });
    expect(state.current.attached).toBe(true);
    expect(shownIds(state.current, tail).slice(-tail.length)).toEqual(
      tail.map((message) => message.id),
    );
    await act(async () => renderer.unmount());
  });

  it('a page without the target from a detached window returns to the newest rows', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const server = serverOver(all);
    const client = {
      ...server,
      historyAround: vi.fn(async (roomId: string, messageId: string) =>
        messageId === 'e'.repeat(64)
          ? { roomId, messages: all.slice(11, 41) }
          : server.historyAround(roomId, messageId),
      ),
    };
    const { state, renderer } = await mountStore(tail, client);

    await act(async () => state.current.jumpTo(all[26]!.id));
    act(() => state.current.endJump());
    expect(state.current.attached).toBe(false);

    await act(async () => state.current.jumpTo('e'.repeat(64)));

    expect(state.current.jump).toEqual({ messageId: 'e'.repeat(64), status: 'missing' });
    expect(state.current.attached).toBe(true);
    expect(shownIds(state.current, tail).slice(-tail.length)).toEqual(
      tail.map((message) => message.id),
    );
    await act(async () => renderer.unmount());
  });

  it('a reader who scrolls before the read answers keeps their place', async () => {
    const all = room(227);
    const tail = all.slice(197);
    const pending = deferred<RoomHistoryView>();
    const client = { ...serverOver(all), historyAround: vi.fn(() => pending.promise) };
    const { state, renderer } = await mountStore(tail, client);

    await act(async () => state.current.jumpTo(all[26]!.id));
    act(() => state.current.endJump());
    await act(async () => {
      pending.resolve({ roomId: 'room', messages: all.slice(11, 41) });
      await pending.promise;
    });

    expect(state.current.jump).toBeNull();
    expect(state.current.attached).toBe(true);
    expect(shownIds(state.current, tail)).toEqual(tail.map((message) => message.id));
    await act(async () => renderer.unmount());
  });
});

function check(id: string, action = 'started', timestamp = 100): ChatDisplayMessage {
  return {
    id,
    text: `GitHub ${action} a check SERVER SUITE`,
    timestamp,
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb: `${action} a check`,
      object: {
        text: 'SERVER SUITE',
        headSha: 'a'.repeat(40),
        url: 'https://github.com/acme/repo/actions/runs/1',
      },
    },
  };
}

function chat(id: string, timestamp: number): ChatDisplayMessage {
  return { id, text: id, timestamp, isUser: false };
}

function toolRow(id: string, timestamp: number): ChatDisplayMessage {
  return {
    id,
    text: '',
    timestamp,
    isUser: false,
    pubkey: 'b'.repeat(64),
    requestId: 'turn-1',
    isAgentActivity: true,
    activity: [{ kind: 'tool', toolKind: 'execute', command: `run ${id}` }],
  } as ChatDisplayMessage;
}

describe('foldTranscriptRows host map', () => {
  it('path 2: a notification for a folded check card lands on the run row that shows it', () => {
    const { rows, hostIds } = foldTranscriptRows(
      [chat('before', 90), check('started'), check('passed', 'passed', 110)],
      null,
    );
    expect(rows.map((message) => message.id)).toEqual(['before', 'started']);
    expect(hostRowIndex(rows, hostIds, 'passed')).toBe(1);
  });

  it('path 2: a folded tool row lands on the activity row that absorbed it', () => {
    const { rows, hostIds } = foldTranscriptRows(
      [chat('ask', 90), toolRow('tool-1', 100), toolRow('tool-2', 101)],
      null,
    );
    expect(rows.map((message) => message.id)).toEqual(['ask', 'tool-1']);
    expect(hostRowIndex(rows, hostIds, 'tool-2')).toBe(1);
  });

  it('path 3: a target that folds into an older row after loading still resolves', () => {
    const alone = foldTranscriptRows([check('passed', 'passed', 110)], null);
    expect(hostRowIndex(alone.rows, alone.hostIds, 'passed')).toBe(0);
    // Older history arrives with the run's first card; the target folds into it.
    const folded = foldTranscriptRows(
      [chat('before', 90), check('started'), check('passed', 'passed', 110)],
      null,
    );
    expect(folded.rows.some((message) => message.id === 'passed')).toBe(false);
    expect(folded.rows[hostRowIndex(folded.rows, folded.hostIds, 'passed')]!.id).toBe('started');
  });

  it('returns -1 for an id no row shows, so a landing waits instead of guessing', () => {
    const { rows, hostIds } = foldTranscriptRows([chat('one', 1)], null);
    expect(hostRowIndex(rows, hostIds, 'other')).toBe(-1);
  });
});
