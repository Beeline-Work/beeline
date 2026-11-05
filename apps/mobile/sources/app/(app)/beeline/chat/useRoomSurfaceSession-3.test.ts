import { controls, roomView, Harness, flushEffects, fixtureScope3 } from './useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { visibleLiveOverlays } from '@beeline/buzz-client';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { roomMessageRecord, writeRoomBookmark } from '@/buzz/room-message-records';
import { type NostrEvent, type RoomView } from '@beeline/buzz-client';
import { type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';

describe('useRoomSurfaceSession', () => {

  it('closes a watch still waiting on its subscribe when the reader leaves', async () => {
    vi.useFakeTimers();
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    expect(controls.subscriptions).toHaveLength(1);
    expect(controls.subscriptions[0]!.stop).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    await flushEffects();
    expect(controls.subscriptions[0]!.stop).toHaveBeenCalled();
    vi.useRealTimers();
  });


  it('records a bounded correlation trace when the phone socket receives an invalidation', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:agent_turns',
          trace: { id: 'trace-turn', databaseAt: 100, emittedAt: 125 },
        },
      });
    });

    expect(info).not.toHaveBeenCalled();
    expect(controls.traceSetItem).not.toHaveBeenCalled();
    controls.roomResponse = {
      ...roomView('room-a'),
      latestAgentTurns: [
        {
          requestId: 'request-a',
          agentPubkey: 'agent-a',
          status: 'working',
          createdAt: Math.floor(Date.now() / 1_000),
        },
      ],
    };
    await act(async () => {
      controls.responses[0]!.apply(await controls.responses[0]!.fetch());
    });
    await vi.waitFor(() => expect(controls.traceSetItem).toHaveBeenCalled());
    const [key, stored] = controls.traceSetItem.mock.calls.at(-1)!;
    expect(key).toBe('@beeline/live-event-trace-v1');
    expect(stored).toContain('"phase":"socket-receipt"');
    expect(stored).toContain('"id":"trace-turn"');
    expect(stored).not.toContain('room-a');
    info.mockRestore();
    await act(async () => renderer.unmount());
  });


  it('keeps a child corner’s monolith draft and thought lanes out of its parent Room', async () => {
    const parent = roomView('room-a', [{ '#h': ['room-a', 'corner-a'] }]);
    controls.cached = {
      ...parent,
      members: [{ identity: { pubkey: 'agent-a', kind: 'agent', name: 'Agent' }, role: 'member' }],
    };
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'draft',
          roomId: 'corner-a',
          agentId: 'agent-a',
          turnId: 'corner-turn',
          text: 'This narration belongs only in the corner.',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'thought',
          roomId: 'corner-a',
          agentId: 'agent-a',
          turnId: 'corner-turn',
          text: 'The parent must not render this thought.',
        },
      });
    });

    expect(current.liveOverlays).toEqual([]);
    await act(async () => renderer.unmount());
  });


  it('streams a corner’s own draft into the corner, and settles it on the durable reply', async () => {
    // A corner is the same route as a Room, so the whole streaming
    // presentation is shared. What was never covered is the corner viewed as
    // ITSELF: the server builds a corner's watch filters around the corner id
    // and its parent, and the corner's live lane is the only place its prose
    // exists before the answer lands.
    const cornerFilters: RoomView['watchFilters'] = [
      { kinds: [9], '#h': ['workspace', 'corner-a', 'room-a'] },
      { kinds: [30078], '#d': ['agent-draft:corner-a', 'agent-thought:corner-a'] },
    ];
    controls.cached = { ...roomView('corner-a', cornerFilters), parent: roomView('room-a').room };
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'corner-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    // The corner's own id has to reach the live subscription, or nothing the
    // turn writes can ever be delivered to the reader sitting in it. Family
    // ids in watchFilters must not become extra subscriptions.
    expect(controls.subscriptions[0]!.filters).toEqual([{ '#h': ['corner-a'] }]);

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: 'corner-a', ...live } });
    await act(async () => {
      emit({
        type: 'draft',
        agentId: 'agent-a',
        turnId: 'turn-c',
        text: "I'll trace the producer",
      });
      emit({
        type: 'draft',
        agentId: 'agent-a',
        turnId: 'turn-c',
        text: "I'll trace the producer, then make the smallest correction",
      });
    });

    expect(current.liveOverlays).toHaveLength(1);
    expect(current.liveOverlays[0]).toMatchObject({
      kind: 'draft',
      // The author is half a draft row's identity (C107).
      stableId: 'live-turn:agent-a:turn-c',
      agentPubkey: 'agent-a',
      requestId: 'turn-c',
      closed: false,
    });
    expect(current.liveDraftStore.getReceived('agent-a:turn-c')).toBe(
      "I'll trace the producer, then make the smallest correction",
    );

    // Exactly as a Room settles: the durable reply carries the turn's request
    // id, and the provisional row stops being visible the moment it lands.
    const reply = {
      id: 'e'.repeat(64),
      text: "I'll trace the producer, then make the smallest correction. Done.",
      createdAt: 20,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const,
      requestId: 'turn-c',
    };
    await act(async () => {
      emit({ type: 'retract', kind: 'draft', agentId: 'agent-a', turnId: 'turn-c' });
      controls.responses[0]!.apply({
        ...roomView('corner-a', cornerFilters),
        parent: roomView('room-a').room,
        messages: [reply],
      });
    });
    expect(visibleLiveOverlays(current.liveOverlays, [reply])).toEqual([]);
    await act(async () => renderer.unmount());
  });


  it('keeps cumulative draft arrivals out of Room React state after opening the live row', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let roomRenders = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => {
            current = result;
            roomRenders += 1;
          },
        }),
      );
    });
    await flushEffects();

    const emitDraft = (text: string) =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'draft',
          roomId: 'room-a',
          agentId: 'agent-a',
          turnId: 'turn-a',
          text,
        },
      });

    await act(async () => emitDraft('0'));
    const structuralRows = current.liveOverlays;
    const rendersAfterOpeningRow = roomRenders;

    // Separate React turns are intentional. Batching a burst would hide the
    // one Room render currently paid for by every network arrival.
    for (let chunk = 1; chunk < 40; chunk += 1) {
      await act(async () => emitDraft(String(chunk).padStart(chunk + 1, 'x')));
    }

    expect(current.liveOverlays).toBe(structuralRows);
    expect(roomRenders).toBe(rendersAfterOpeningRow);
    await act(async () => renderer.unmount());
  });


  it('anchors a joining reader’s two snapshot drafts into two rows that stay put', async () => {
    // The join of #920 and C107: `PhoneService.liveDraftSnapshot` hands a
    // socket the drafts its turns are already writing — one row per agent —
    // and each has to land as its OWN transcript entry that later deltas edit
    // in place. Both agents were addressed by one message, so both turns
    // carry that message's id: the request alone cannot tell the rows apart.
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: 'room-a', ...live } });
    await act(async () => {
      // The subscribe-time burst, in the order the snapshot serves it.
      emit({ type: 'draft', agentId: 'goosy', turnId: 'turn-x', text: 'goosy so far' });
      emit({ type: 'draft', agentId: 'terra', turnId: 'turn-x', text: 'terra so far' });
    });

    expect(
      current.liveOverlays.map((overlay) => [
        overlay.kind === 'draft' ? overlay.stableId : '',
        overlay.agentPubkey,
      ]),
    ).toEqual([
      ['live-turn:goosy:turn-x', 'goosy'],
      ['live-turn:terra:turn-x', 'terra'],
    ]);
    const anchors = current.liveOverlays.map((overlay) => overlay.createdAt);

    await act(async () => {
      emit({ type: 'draft', agentId: 'terra', turnId: 'turn-x', text: 'terra so far, and more' });
      emit({ type: 'draft', agentId: 'goosy', turnId: 'turn-x', text: 'goosy so far, and more' });
    });

    // Two rows still, in the same order, each carrying its own newer text:
    // neither agent took the other's row and neither stamp moved.
    expect(
      current.liveOverlays.map((overlay) => [
        overlay.agentPubkey,
        overlay.kind === 'draft'
          ? current.liveDraftStore.getReceived(`${overlay.agentPubkey}:${overlay.requestId}`)
          : '',
        overlay.createdAt,
      ]),
    ).toEqual([
      ['goosy', 'goosy so far, and more', anchors[0]],
      ['terra', 'terra so far, and more', anchors[1]],
    ]);
    await act(async () => renderer.unmount());
  });


  it('settles a retracted corner draft in place instead of blanking streamed chunks', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: 'room-a', ...live } });
    await act(async () => {
      emit({ type: 'draft', agentId: 'agent-a', turnId: 'turn-1', text: 'I' });
      emit({ type: 'draft', agentId: 'agent-a', turnId: 'turn-1', text: 'I will update only X,' });
      emit({
        type: 'draft',
        agentId: 'agent-a',
        turnId: 'turn-1',
        text: 'I will update only X, then commit.',
      });
      // The final is about to land: the helper retracts the live lane first.
      emit({ type: 'retract', kind: 'draft', agentId: 'agent-a', turnId: 'turn-1' });
    });

    // The retract must NOT blank the streamed text — the settled draft row
    // stays visible while the server read catches up.
    expect(current.liveOverlays).toHaveLength(1);
    expect(current.liveOverlays[0]).toMatchObject({
      kind: 'draft',
      requestId: 'turn-1',
      closed: true,
    });
    expect(current.liveDraftStore.getReceived('agent-a:turn-1')).toBe(
      'I will update only X, then commit.',
    );

    // The durable final lands with the same request id and takes over the
    // row's slot: no gap, no duplicate bubble.
    const finalMessage = {
      id: 'b'.repeat(64),
      text: 'I will update only X, then commit. Done.',
      createdAt: 11,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const,
      requestId: 'turn-1',
    };
    await act(async () => {
      controls.responses[0]!.apply({ ...roomView('room-a'), messages: [finalMessage] });
      await Promise.resolve();
    });
    expect(visibleLiveOverlays(current.liveOverlays, current.roomSurface!.messages)).toEqual([]);
    await act(async () => renderer.unmount());
  });


  it('subscribes once to the opened Room even when watchFilters name a family', async () => {
    const familyFilters: RoomView['watchFilters'] = [
      {
        kinds: [9],
        '#h': [
          'workspace',
          'room-a',
          ...Array.from({ length: 58 }, (_, index) => `corner-${index}`),
        ],
      },
      {
        kinds: [30078],
        '#d': ['agent-draft:room-a', 'agent-thought:room-a', 'agent-presence:room-a'],
      },
    ];
    controls.cached = roomView('room-a', familyFilters);
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    expect(current.roomSurface).toMatchObject({
      room: controls.cached.room,
      messages: controls.cached.messages,
    });
    expect(controls.subscriptions).toHaveLength(1);
    expect(controls.subscriptions[0]!.filters).toEqual([{ '#h': ['room-a'] }]);
    const firstStop = controls.subscriptions[0]!.stop;

    await act(async () => {
      controls.responses[0]!.apply(roomView('room-a', [{ '#d': ['agent-a'] }]));
      await Promise.resolve();
    });
    expect(controls.subscriptions).toHaveLength(1);
    expect(firstStop).not.toHaveBeenCalled();
    expect(current.roomSurface?.watchFilters).toEqual([{ '#d': ['agent-a'] }]);
    await act(async () => renderer.unmount());
  });


  it('requests one reconciliation for a legacy live message', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    const event: NostrEvent = {
      id: 'f'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 10,
      kind: 9,
      tags: [
        ['h', 'room-a'],
        ['t', 'agent-message'],
      ],
      content: 'Delivered after the index catches up',
      sig: '0'.repeat(128),
    };
    await act(async () => controls.subscriptions[0]!.emit(event));

    await act(async () => renderer.unmount());
  });


  it('requests one reconciliation per legacy turn or lifecycle event', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    const turn = {
      id: '1'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 10,
      kind: 9,
      tags: [
        ['h', 'room-a'],
        ['t', 'body-control'],
        ['t', 'agent-turn'],
        ['request', '2'.repeat(64)],
        ['status', 'working'],
      ],
      content: '',
      sig: '0'.repeat(128),
    } satisfies NostrEvent;
    await act(async () => controls.subscriptions[0]!.emit(turn));

    const landed = {
      ...turn,
      id: '3'.repeat(64),
      tags: [
        ['h', 'room-a'],
        ['t', 'daemon-fact'],
        ['t', 'corner-branch-ended'],
        ['subchannel', 'corner-a'],
        ['outcome', 'landed'],
      ],
      content: 'Landed “Smoke lifecycle PR” into main.',
    } satisfies NostrEvent;
    await act(async () => controls.subscriptions[0]!.emit(landed));
    await act(async () => renderer.unmount());
  });


  it('covers a fresh replayed working receipt with the opening Corner GET', async () => {
    controls.replayEvents.push({
      id: '4'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: Math.floor(Date.now() / 1_000),
      kind: 9,
      tags: [
        ['h', 'corner-a'],
        ['t', 'body-control'],
        ['t', 'agent-turn'],
        ['request', '5'.repeat(64)],
        ['status', 'working'],
      ],
      content: '',
      sig: '0'.repeat(128),
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'corner-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    // The replay marks the not-yet-started scheduler dirty. startAfter folds
    // that signal into its single opening read.
    await act(async () => renderer.unmount());
  });


  it('cancels stale identity work and replaces the whole watch on notification hydration', async () => {
    let resolveIdentity!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => (resolveIdentity = resolve));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'notice-1',
          capture: () => undefined,
        }),
      );
    });
    await act(async () => renderer.unmount());
    resolveIdentity({ publicKey: 'viewer', secretKey: new Uint8Array(32) });
    await flushEffects();
    expect(controls.transportCount).toBe(0);

    controls.identityPromise = null;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'notice-1',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();
    const firstResponse = controls.responses[0]!;
    await act(async () => {
      renderer.update(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'notice-2',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();
    expect(controls.responses).toHaveLength(2);
    await act(async () => renderer.unmount());
  });


  it.each([false, true])('keeps socket recovery out of the Room error state (cached: %s)', async (cached) => {
    if (cached) controls.cached = roomView('room-a');
    // The socket owner supplies recovery; the Room must not duplicate its
    // connection failure copy or lose the ability to paint a later answer.
    controls.roomError = new RoomViewHttpError(0, 'timeout');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    await act(async () => controls.responses[0]!.error(controls.roomError));
    expect(current.roomSurface?.room.id ?? null).toBe(cached ? 'room-a' : null);
    expect(current.hydrationFailed).toBe(false);
    expect(current.hydrationError).toBeNull();

    // The connection owner invalidates on network-online; no Retry tap.
    controls.roomError = null;
    controls.roomResponse = roomView('room-a');
    await act(async () => controls.subscriptions[0]!.emit({
      monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'reconnect' },
    }));
    await flushEffects();
    expect(controls.responses).toHaveLength(1);
    expect(controls.roomReads).toBeGreaterThan(1);
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(current.hydrationFailed).toBe(false);
    await act(async () => renderer.unmount());
  });


  it('keeps the cached page with an action error and clears private data on access loss', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    await act(async () => controls.responses[0]!.error(new TypeError('Network request failed')));
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(current.hydrationFailed).toBe(true);
    expect(current.hydrationError).toBe('Could not load this Room.');

    await act(async () => controls.responses[0]!.error(new RoomViewHttpError(403, 'forbidden')));
    expect(current.roomSurface).toBeNull();
    expect(current.hydrationFailed).toBe(true);
    expect(current.hydrationError).toBe('Could not load this Room.');
    await act(async () => renderer.unmount());
  });
});
describe('Room history follows live row changes', () => {
const scope3 = fixtureScope3();


  it('shows an edit to a row older than the newest 30', async () => {
    const { current, renderer } = await scope3.openWithHistory();
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: { ...scope3.old, text: 'after' },
        },
      }),
    );
    expect(current().historyRows.find((message) => message.id === 'old-row')?.text).toBe('after');
    expect(current().session.roomSurface?.messages.map((message) => message.id)).toEqual(
      scope3.tail.map((message) => message.id),
    );
    await act(async () => renderer.unmount());
  });


  it('keeps a delete on an older row once the server answers', async () => {
    const { current, renderer } = await scope3.openWithHistory();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...scope3.old, text: '', deleted: true }),
    );
    expect(current().historyRows.find((message) => message.id === 'old-row')?.deleted).toBe(true);
    await act(async () => renderer.unmount());
  });


  it('keeps a live edit on a tail row after the windows re-render', async () => {
    const { current, renderer } = await scope3.openWithHistory();
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: { ...scope3.tail[29]!, text: 'edited' },
        },
      }),
    );
    await scope3.emitUnrelatedDelta('later-1');
    await scope3.emitUnrelatedDelta('later-2');
    expect(scope3.byId(current().tailRows, 'tail-29')?.text).toBe('edited');
    await act(async () => renderer.unmount());
  });


  it('keeps a delete on an older row after the windows re-render', async () => {
    const { current, renderer } = await scope3.openWithHistory();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...scope3.old, text: '', deleted: true }),
    );
    await scope3.emitUnrelatedDelta('later-1');
    await scope3.emitUnrelatedDelta('later-2');
    expect(scope3.byId(current().historyRows, 'old-row')?.deleted).toBe(true);
    await act(async () => renderer.unmount());
  });


  it('keeps the server bookmark on an older row after the windows re-render', async () => {
    const { current, renderer } = await scope3.openWithHistory();
    // The chat screen's bookmark settlement: the server value onto the record.
    await act(async () => {
      writeRoomBookmark(current().session.messageRecordScope, 'room-a', 'old-row', true);
      current().session.applyRoomMessageResult({
        ...roomMessageRecord(current().session.messageRecordScope, 'room-a', 'old-row')!,
        bookmarked: true,
      });
    });
    await scope3.emitUnrelatedDelta('later-1');
    await scope3.emitUnrelatedDelta('later-2');
    expect(scope3.byId(current().historyRows, 'old-row')?.bookmarked).toBe(true);
    await act(async () => renderer.unmount());
  });


  it('writes a live delta to the Room disk cache', async () => {
    const { mobileSurfaceCache } = await import('@/buzz/surface-storage');
    vi.useFakeTimers();
    const { renderer } = await scope3.openWithHistory();
    vi.mocked(mobileSurfaceCache.write).mockClear();
    const fresh = scope3.row('fresh-row', 200, 'new');
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'message-delta', roomId: 'room-a', message: fresh },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const written = vi.mocked(mobileSurfaceCache.write).mock.calls.at(-1)?.[1] as RoomView;
    expect(written.messages.at(-1)?.id).toBe('fresh-row');
    await act(async () => renderer.unmount());
  });


  it('writes a mutation result to the Room disk cache', async () => {
    const { mobileSurfaceCache } = await import('@/buzz/surface-storage');
    vi.useFakeTimers();
    const { current, renderer } = await scope3.openWithHistory();
    vi.mocked(mobileSurfaceCache.write).mockClear();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...scope3.tail[29]!, text: 'edited', version: 2 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const written = vi.mocked(mobileSurfaceCache.write).mock.calls.at(-1)?.[1] as RoomView;
    expect(written.messages.at(-1)?.text).toBe('edited');
    await act(async () => renderer.unmount());
  });


  it('ignores a delta frame older than the row it already shows', async () => {
    const { current, renderer } = await scope3.openWithHistory();
    const emit = (text: string, version: number) =>
      act(async () =>
        controls.subscriptions[0]!.emit({
          monolithLive: {
            type: 'message-delta',
            roomId: 'room-a',
            message: { ...scope3.tail[29]!, text },
            version,
          },
        }),
      );
    await emit('second edit', 3);
    await emit('first edit', 2);
    expect(scope3.byId(current().tailRows, 'tail-29')?.text).toBe('second edit');
    await act(async () => renderer.unmount());
  });
});
