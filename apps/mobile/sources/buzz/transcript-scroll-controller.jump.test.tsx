import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';

import { useRoomMessageStore } from './room-message-store';
import {
  requestMessageJump,
  useTranscriptScrollController,
  type TranscriptScrollController,
} from './transcript-scroll-controller';

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

const row = (n: number): RoomViewMessage => ({
  id: n.toString(16).padStart(64, '0'),
  createdAt: n,
  text: `message-${n}`,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

type Probe = {
  store: ReturnType<typeof useRoomMessageStore>;
  controller: TranscriptScrollController<{ id: string }>;
};

/**
 * The store and the controller wired as the chat surface wires them: a
 * jump's cancellation drops only its own read, and a notification starts
 * through `requestMessageJump`.
 */
function Transcript({
  tail,
  client,
  probe,
}: {
  tail: RoomViewMessage[];
  client: {
    history: () => Promise<RoomHistoryView>;
    historyAround: (r: string, id: string) => Promise<RoomHistoryView>;
  };
  probe: Probe;
}) {
  const store = useRoomMessageStore({
    roomId: 'room',
    tailMessages: tail,
    roomClient: client,
    enabled: true,
    initialVisibleCount: 30,
  });
  const controller = useTranscriptScrollController<{ id: string }>({
    list: () => null,
    rows: () => store.rows,
    rowIndex: (destination, rows) => rows.findIndex((r) => r.id === destination.messageId),
    onCancelled: (destination) => {
      if (
        destination.kind === 'message' &&
        destination.jump &&
        store.jump?.messageId === destination.messageId
      )
        store.endJump();
    },
    schedule: () => {},
  });
  probe.store = store;
  probe.controller = controller;
  return null;
}

describe('message jumps on the scroll controller', () => {
  it('shows the second of two pending notification targets', async () => {
    const all = Array.from({ length: 200 }, (_, index) => row(index + 1));
    const tail = all.slice(170);
    const first = all[20]!;
    const second = all[60]!;
    const reads = new Map<string, ReturnType<typeof deferred<RoomHistoryView>>>();
    const client = {
      history: vi.fn(async (): Promise<RoomHistoryView> => ({ roomId: 'room', messages: [] })),
      historyAround: vi.fn((_roomId: string, messageId: string) => {
        const read = deferred<RoomHistoryView>();
        reads.set(messageId, read);
        return read.promise;
      }),
    };
    const page = (target: RoomViewMessage) => {
      const index = all.indexOf(target);
      return { roomId: 'room', messages: all.slice(index - 15, index + 15) };
    };
    const probe = {} as Probe;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Transcript tail={tail} client={client} probe={probe} />);
    });

    await act(async () => requestMessageJump(probe.controller, first.id, probe.store.jumpTo));
    // A second notification arrives while the first read is still out.
    await act(async () => requestMessageJump(probe.controller, second.id, probe.store.jumpTo));
    expect(probe.store.jump).toEqual({ messageId: second.id, status: 'loading' });
    expect(probe.controller.active()).toMatchObject({ kind: 'message', messageId: second.id });

    await act(async () => reads.get(first.id)!.resolve(page(first)));
    await act(async () => reads.get(second.id)!.resolve(page(second)));

    expect(probe.store.jump).toEqual({ messageId: second.id, status: 'ready' });
    expect(probe.store.rows.map((message) => message.id)).toContain(second.id);
    expect(probe.store.rows.map((message) => message.id)).not.toContain(first.id);
    await act(async () => renderer.unmount());
  });

  it('drops the read of a jump the reader drags away from', async () => {
    const all = Array.from({ length: 200 }, (_, index) => row(index + 1));
    const target = all[40]!;
    const read = deferred<RoomHistoryView>();
    const client = {
      history: vi.fn(async (): Promise<RoomHistoryView> => ({ roomId: 'room', messages: [] })),
      historyAround: vi.fn(() => read.promise),
    };
    const probe = {} as Probe;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Transcript tail={all.slice(170)} client={client} probe={probe} />);
    });
    await act(async () => requestMessageJump(probe.controller, target.id, probe.store.jumpTo));
    await act(async () => probe.controller.dragStarted());
    expect(probe.store.jump).toBeNull();
    await act(async () => read.resolve({ roomId: 'room', messages: all.slice(25, 55) }));
    expect(probe.store.rows.map((message) => message.id)).not.toContain(target.id);
    await act(async () => renderer.unmount());
  });
});
