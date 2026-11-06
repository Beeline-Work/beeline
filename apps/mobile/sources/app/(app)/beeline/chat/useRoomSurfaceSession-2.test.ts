import { controls, roomView, Harness, stubFrameScheduler, flushMicrotasks, flushEffects } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { prefetchPushRoom } from '@/push/push-room-prefetch';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { loadBuzzIdentity, loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';
import { LIVE_TRACE_STORAGE_KEY, type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';
import BuzzChat from './[channelId]';
import { type MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

describe('useRoomSurfaceSession', () => {

  it('renders the hot target before the asynchronous session has even read its identity', async () => {
    controls.hotViewer = true;
    controls.viewerRead = new Promise(() => undefined);
    controls.cached = {
      ...roomView('room-a'),
      messages: [
        {
          id: 'target',
          text: 'Newest received row',
          createdAt: 10,
          author: { pubkey: 'author', kind: 'human', name: 'Author' },
          presentation: 'message',
        },
      ],
    };
    const { queued } = stubFrameScheduler();
    const reset = vi.fn();
    const props = { channelId: 'room-a', capture: () => undefined, onResetTranscript: reset };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Harness, props));
    });
    expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
      'Newest received row',
    );
    expect(reset).not.toHaveBeenCalled();
    expect(loadBuzzViewerPubkey).not.toHaveBeenCalled();
    await act(async () => {
      queued.splice(0).forEach((frame) => frame(0));
    });
    expect(controls.transportCount).toBe(0);
    expect(controls.roomReads).toBe(0);
    await act(async () =>
      renderer.update(React.createElement(Harness, { ...props, isFocused: false })),
    );
    await act(async () => renderer.update(React.createElement(Harness, props)));
    expect(reset).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });


  it('paints an opening reply while cached-frame callbacks and identity setup are still pending', async () => {
    controls.hotViewer = true;
    controls.viewerRead = new Promise(() => undefined);
    controls.cached = roomView('room-a');
    stubFrameScheduler();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await act(async () => {
      controls.cached = {
        ...roomView('room-a'),
        messages: [
          {
            id: 'arrived',
            text: 'Arrived during opening',
            createdAt: 10,
            author: { pubkey: 'author', kind: 'human', name: 'Author' },
            presentation: 'message',
          },
        ],
      };
      controls.cacheListeners.forEach((listener) => listener());
    });
    expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
      'Arrived during opening',
    );
    expect(loadBuzzViewerPubkey).not.toHaveBeenCalled();
    expect(controls.roomReads).toBe(0);
    await act(async () => renderer.unmount());
    expect(controls.cacheListeners.size).toBe(0);
  });


  it('paints a missing-row publish after disk read while identity and then outbox remain pending', async () => {
    controls.hotViewer = true;
    controls.cached = roomView('room-a');
    let resolveIdentity!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => {
      resolveIdentity = resolve;
    });
    controls.outboxRestore = new Promise(() => undefined);
    const { queued } = stubFrameScheduler();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'late-opening-reply',
          capture: () => undefined,
        }),
      );
    });
    await act(async () => {
      queued.splice(0).forEach((frame) => frame(0));
      queued.splice(0).forEach((frame) => frame(0));
    });
    await flushMicrotasks();
    expect(mobileSurfaceCache.read).toHaveBeenCalled();
    expect(loadBuzzIdentity).toHaveBeenCalled();
    const publish = async (text: string) => {
      await act(async () => {
        controls.cached = {
          ...roomView('room-a'),
          messages: [
            {
              id: text,
              text,
              createdAt: 10,
              author: { pubkey: 'author', kind: 'human', name: 'Author' },
              presentation: 'message',
            },
          ],
        };
        controls.cacheListeners.forEach((listener) => listener());
      });
      expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(text);
    };
    try {
      await publish('Reply after disk read, identity pending');
      expect(controls.transportCount).toBe(0);
      await act(async () =>
        resolveIdentity({ publicKey: 'viewer', secretKey: new Uint8Array(32) }),
      );
      await flushMicrotasks();
      expect(controls.transportCount).toBe(1);
      await publish('Reply while outbox restore is pending');
      expect(controls.roomReads).toBe(0);
    } finally {
      await act(async () => renderer.unmount());
    }
    expect(controls.cacheListeners.size).toBe(0);
  });


  it.each([1, 5])(
    'paints %i received messages on the first frame before any network read',
    async (count) => {
      controls.hotViewer = true;
      const { queued } = stubFrameScheduler();
      controls.cached = {
        ...roomView('room-a'),
        messages: Array.from({ length: count }, (_, n) => ({
          id: `received-${n}`,
          text: `received ${n}`,
          createdAt: 10 + n,
          author: { pubkey: 'author', kind: 'human' as const, name: 'Author' },
          presentation: 'message' as const,
        })),
      };
      let current!: UseRoomSurfaceSessionResult;
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          React.createElement(Harness, {
            channelId: 'room-a',
            capture: (result: UseRoomSurfaceSessionResult) => {
              current = result;
            },
          }),
        );
      });
      expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
        `received ${count - 1}`,
      );
      expect(controls.roomReads).toBe(0);
      await flushMicrotasks();
      await act(async () => {
        queued.splice(0).forEach((frame) => frame(0));
      });
      expect(current.roomSurface?.messages.at(-1)?.id).toBe(`received-${count - 1}`);
      expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
        `received ${count - 1}`,
      );
      expect(controls.transportCount).toBe(0);
      expect(controls.roomReads).toBe(0);
      expect(controls.subscriptions).toHaveLength(0);
      await act(async () => renderer.unmount());
    },
  );


  it('paints cached newest row before authorization occupies the session', async () => {
    const { queued, receivers } = stubFrameScheduler();
    let resolveAuth!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => {
      resolveAuth = resolve;
    });
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
    await flushMicrotasks();
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(controls.transportCount).toBe(0);

    await act(async () => {
      queued.splice(0).forEach((callback) => callback(0));
      queued.splice(0).forEach((callback) => callback(0));
    });
    await flushMicrotasks();
    expect(controls.transportCount).toBe(0);

    await act(async () => {
      resolveAuth({ publicKey: 'viewer', secretKey: new Uint8Array(32) });
    });
    await flushMicrotasks();
    expect(controls.transportCount).toBe(1);
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
    await act(async () => renderer.unmount());
  });


  it('acknowledges every burst delta after its committed render without a follow-up read', async () => {
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
    const acknowledgements: string[] = [];
    const first = {
      id: 'reply-one',
      text: 'one',
      createdAt: 1,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Greeter' },
      presentation: 'message' as const,
    };
    const second = { ...first, id: 'reply-two', text: 'two', createdAt: 2 };

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: first,
          trace: { id: 'trace-one', startedAt: 10, databaseAt: 11, emittedAt: 12 },
        },
        acknowledgePaint: () => acknowledgements.push('one'),
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: second,
          trace: { id: 'trace-two', startedAt: 20, databaseAt: 21, emittedAt: 22 },
        },
        acknowledgePaint: () => acknowledgements.push('two'),
      });
      expect(acknowledgements).toEqual([]);
    });

    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual([
      'reply-one',
      'reply-two',
    ]);
    expect(acknowledgements).toEqual(['one', 'two']);

    const full = { ...roomView('room-a'), messages: [first, second] };
    await act(async () => controls.responses[0]!.apply(full));
    expect(current.roomSurface).toEqual(full);
    await act(async () => renderer.unmount());
  });


  it('acknowledges an idempotent delta immediately because its row is already painted', async () => {
    const reply = {
      id: 'reply-existing',
      text: 'done',
      createdAt: 1,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Greeter' },
      presentation: 'message' as const,
    };
    controls.cached = { ...roomView('room-a'), messages: [reply] };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();
    const acknowledgePaint = vi.fn();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: reply,
          trace: { id: 'trace-existing', startedAt: 10, databaseAt: 11, emittedAt: 12 },
        },
        acknowledgePaint,
      });
    });

    expect(acknowledgePaint).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });


  it('records the same-server pre-write-to-paint upper bound returned by the server', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'trace-painted',
          id: 'trace-bound',
          startedAt: 1_000,
          databaseAt: 1_025,
          serverReceivedAt: 1_240,
          upperBoundMs: 240,
        },
      });
    });
    await vi.waitFor(() =>
      expect(controls.traceSetItem).toHaveBeenCalledWith(
        LIVE_TRACE_STORAGE_KEY,
        expect.stringContaining('"upperBoundMs":240'),
      ),
    );
    const stored = String(controls.traceSetItem.mock.calls.at(-1)?.[1]);
    expect(stored).toContain('"startedAt":1000');
    expect(stored).toContain('"databaseAt":1025');
    expect(stored).toContain('"serverReceivedAt":1240');
    await act(async () => renderer.unmount());
  });


  it('opens a cached corner and applies its fresh response without a draw handshake', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness, {
      channelId: 'room-a', capture: value => { current = value; },
    })); });
    await flushEffects();
    const fresh = { ...roomView('room-a'), messages: [{ id: 'fresh-row', createdAt: 2,
      text: 'new corner contents', presentation: 'message' as const,
      author: { pubkey: 'viewer', kind: 'human' as const, name: 'Viewer' } }] };
    await act(async () => controls.responses[0]!.apply(fresh));
    expect(current.roomSurface).toEqual(fresh);
    await act(async () => renderer.unmount());
  });


  it('Send: pending state reaches the Room once, unchanged bookkeeping stays quiet, and failures remain visible', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    controls.scopeProbe = (value: UseRoomSurfaceSessionResult) => { current = value; };
    await act(async () => {
      renderer = create(React.createElement(BuzzChat));
    });
    await flushEffects();
    const outbox = current.outbox.current()!;
    const record = {
      event: { id: 'queued', pubkey: 'viewer', kind: 9, created_at: 1, content: 'Hello',
        sig: '', tags: [['h', 'room-a']] },
      row: { id: 'queued', createdAt: 1, text: 'Hello', presentation: 'message' as const,
        author: { pubkey: 'viewer', kind: 'human' as const, name: 'Viewer' } },
      status: 'pending' as 'pending' | 'failed', attempts: 0, queuedAt: 1,
    };
    const emit = async () => act(async () => {
      for (const listener of controls.outboxListeners) listener();
    });
    vi.mocked(outbox.list).mockReturnValue([record]);
    controls.outboxStates.set('queued', { kind: 'sending', text: 'Sending' });
    const renders = controls.surfaceRenders;
    await emit();
    expect(current.outbox.states.get('queued')?.kind).toBe('sending');
    const pendingRenders = controls.surfaceRenders;
    await emit();
    expect(controls.surfaceRenders).toBe(pendingRenders);
    expect(pendingRenders).toBeGreaterThan(renders);
    vi.mocked(outbox.list).mockReturnValue([]);
    await emit();
    expect(current.outbox.states.size).toBe(0);

    vi.mocked(outbox.list).mockReturnValue([record]);
    controls.outboxStates.set('queued', { kind: 'offline', text: 'Not sent yet · no connection' });
    await emit();
    expect(current.outbox.states?.get('queued')?.kind).toBe('offline');
    record.status = 'failed';
    controls.outboxStates.set('queued', { kind: 'refused', text: 'Not sent · access denied' });
    await emit();
    expect(current.outbox.failedIds.has('queued')).toBe(true);
    expect(current.outbox.states?.get('queued')?.kind).toBe('refused');
    vi.mocked(outbox.list).mockReturnValue([]);
    await emit();
    expect(current.outbox.states?.size).toBe(0);
    expect(current.outbox.failedIds.size).toBe(0);
    await act(async () => renderer.unmount());
  });


  it('Send: pushed queued commands paint without a follow-up Room read', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result) => {
            current = result;
          },
        }),
      );
    });
    await flushEffects();
    const commands = [{ requestId: 'sent', agentPubkey: 'agent-a', createdAt: 1 }];
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'room-commands',
          roomId: 'room-a',
          commands,
        },
      } as unknown as MonolithSurfaceEvent),
    );
    expect(current.roomSurface?.pendingAgentCommands).toEqual(commands);
    await act(async () => renderer.unmount());
  });


  it('signals a targetless phone-write so an open Room can paint without remounting', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'phone-write' },
      });
    });

    await act(async () => renderer.unmount());
  });


  it('still waits for the committed-row delta when a phone-write names its message', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'phone-write',
          messageId: 'posted-message',
        },
      });
    });

    await act(async () => renderer.unmount());
  });


  it.each([
    [
      'SYNC-01',
      {
        type: 'invalidate' as const,
        roomId: 'room-a',
        reason: 'postgres:messages',
        messageId: 'message-stalled',
        deliveryId: 'delivery-sync',
      },
    ],
    [
      'STOP-01',
      {
        type: 'invalidate' as const,
        roomId: 'room-a',
        reason: 'postgres:agent_turns',
        agentId: 'agent-a',
        requestId: 'request-a',
        deliveryId: 'delivery-stop',
      },
    ],
  ])('reads nothing for the %s hint whose delta follows', async (_id, event) => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: event });
    });

    await act(async () => renderer.unmount());
  });


  it('STOP-01 clears the working turn from its turn delta, with no Room read', async () => {
    controls.cached = {
      ...roomView('room-a'),
      latestAgentTurns: [
        {
          requestId: 'request-a',
          agentPubkey: 'agent-a',
          status: 'working',
          createdAt: 1,
        },
      ],
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
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:agent_turns',
          agentId: 'agent-a',
          requestId: 'request-a',
          deliveryId: 'delivery-stop',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'turn-delta',
          roomId: 'room-a',
          reconcilesDelivery: 'delivery-stop',
          turn: {
            requestId: 'request-a',
            agentPubkey: 'agent-a',
            status: 'cancelled',
            createdAt: 1,
          },
        },
      });
    });

    expect(current.roomSurface?.latestAgentTurns).toEqual([
      expect.objectContaining({ requestId: 'request-a', status: 'cancelled' }),
    ]);
    await act(async () => renderer.unmount());
  });


  it('paints a paired delta and reads no Room for it', async () => {
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

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:messages',
          messageId: 'message-a',
          deliveryId: 'delivery-a',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          reconcilesDelivery: 'delivery-a',
          message: {
            id: 'message-a',
            text: 'Done',
            createdAt: 2,
            author: { pubkey: 'agent-a', kind: 'agent', name: 'Greeter' },
            presentation: 'message',
          },
        },
      });
    });

    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual(['message-a']);
    await act(async () => renderer.unmount());
  });


  it('reconciles immediately when a committed delta cannot be delivered', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'delta-fallback:postgres:messages',
        },
      });
    });

    await act(async () => renderer.unmount());
  });


  it('reads the Room once for the fallback of a delivery the server could not read', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:messages',
          messageId: 'message-deleted',
          deliveryId: 'delivery-deleted',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'delta-fallback:postgres:messages',
          messageId: 'message-deleted',
          reconcilesDelivery: 'delivery-deleted',
        },
      });
    });

    await act(async () => renderer.unmount());
  });


  it('starts the single opening Room read after its subscribe', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    // No subscribed frame yet: the cache paints while the read waits for coverage.
    expect(controls.subscriptions).toHaveLength(1);
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      }),
    );
    await act(async () => renderer.unmount());
  });


  it('reads once on its first handshake and never starts reads from resubscribe', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      });
    });

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      });
    });
    await act(async () => renderer.unmount());
  });






  it('uses the push read already started before route mount without a subscription reread', async () => {
    controls.roomResponse = roomView('room-a');
    prefetchPushRoom('response-prefetched', 'room-a');
    await flushMicrotasks();
    expect(controls.roomReads).toBe(1);
    let session!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'response-prefetched',
          capture: (value) => {
            session = value;
          },
        }),
      );
    });
    await flushEffects();
    expect(session.roomSurface?.room.id).toBe('room-a');
    expect(controls.roomReads).toBe(1);
    await flushEffects();
    expect(controls.subscriptions).toHaveLength(1);
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      }),
    );
    expect(controls.roomReads).toBe(1);
    expect(controls.subscriptions).toHaveLength(1);
    await act(async () => renderer.unmount());
  });
});
