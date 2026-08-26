import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvValues.set(key, value);
    }
    delete(key: string) {
      mmkvValues.delete(key);
    }
  },
}));

import {
  commitRoomCoverage,
  createWorkspaceSnapshot,
  reduceWorkspaceSnapshot,
  selectTranscript,
  type HumanMessage,
} from '@beeline/buzz-client';
import { clearBuzzLocalCache, channelCacheKey, useBuzzLocalCache } from './local-cache';
import {
  COLD_TAIL_DEADLINE_MS,
  COLD_TAIL_TIMEOUT_MESSAGE,
  revalidateCachedMessages,
} from './local-cache-sync';
import { beginColdOpenSample, coldOpenSamples, resetColdOpenSamples } from './cold-open-metrics';

const VIEWER = 'viewer';
// One channel per test: the transport keeps ONE deferred reconciliation per
// channel until it settles, so a wedged one in an earlier test must not
// suppress a later test's scheduling.
let CORNER = 'corner-channel';

function humanMessage(id: string, createdAt: number, body = id): HumanMessage {
  return {
    type: 'human-message',
    eventId: id,
    channelId: CORNER,
    workspaceId: 'workspace',
    scope: 'channel',
    authorPubkey: VIEWER,
    createdAt,
    sourceKind: 9,
    signature: 'verified',
    body,
    attachments: [],
    mentionPubkeys: [],
  } as HumanMessage;
}

function tailResult(count = 4) {
  const events = Array.from({ length: count }, (_, index) => humanMessage(`m${index}`, index + 1));
  let snapshot = reduceWorkspaceSnapshot(
    createWorkspaceSnapshot({ workspaceId: 'workspace' }),
    events[0]!,
  );
  for (const event of events.slice(1)) {
    snapshot = reduceWorkspaceSnapshot(snapshot, event);
  }
  snapshot = commitRoomCoverage(snapshot, CORNER, {
    epoch: Date.now(),
    initialBackfillComplete: true,
  });
  return {
    snapshot,
    events: events.map((event) => ({ type: 'read-model', sessionId: CORNER, event })),
  };
}

type TailTransport = {
  readModelTail: ReturnType<typeof vi.fn>;
  readModelBackfill: ReturnType<typeof vi.fn>;
};

function snapshotMessages() {
  const snapshot =
    useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, CORNER)]!.snapshot!;
  return selectTranscript(snapshot, CORNER).map((item) => item.id);
}

beforeEach(() => {
  clearBuzzLocalCache();
  mmkvValues.clear();
  resetColdOpenSamples();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('corner-open fast path: one bounded tail read is the whole critical path', () => {
  beforeEach(() => {
    CORNER = `corner-${Math.random().toString(36).slice(2, 8)}`;
  });

  it('paints four messages from the single tail read while the full machinery hangs forever', async () => {
    const transport: TailTransport = {
      readModelTail: vi.fn(async () => tailResult(4)),
      // The deferred reconciliation never settles — simulating emulated
      // mobile latency on every secondary read. First paint must not care.
      readModelBackfill: vi.fn(() => new Promise(() => undefined)),
    };

    await revalidateCachedMessages(transport as never, VIEWER, CORNER);

    expect(transport.readModelTail).toHaveBeenCalledTimes(1);
    expect(snapshotMessages()).toEqual(['m0', 'm1', 'm2', 'm3']);
    // The transcript stayed painted with the deferred read still wedged.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshotMessages()).toEqual(['m0', 'm1', 'm2', 'm3']);
    const sample = coldOpenSamples().at(-1)!;
    expect(sample.channelId).toBe(CORNER);
    expect(sample.tailMs).toBeLessThan(COLD_TAIL_DEADLINE_MS);
    expect(sample.tailEventCount).toBe(4);
    expect(sample.deferredError).toBeUndefined();
  });

  it('commits the deferred full result so directory truth enriches the painted tail', async () => {
    // The tail paints from placeholder authority (agent signers unknown);
    // the deferred full reconciliation later lands directory-backed
    // identities plus one more event. Both must reach the cache without ever
    // re-entering or delaying the first-paint path.
    const tail = tailResult(4);
    const agentPubkey = 'a'.repeat(64);
    const lateAgentRow: HumanMessage = {
      ...humanMessage('m-late', 9, 'late sibling row'),
      authorPubkey: agentPubkey,
      type: 'agent-message',
    } as unknown as HumanMessage;
    let enriched = reduceWorkspaceSnapshot(tail.snapshot, lateAgentRow);
    enriched = commitRoomCoverage(enriched, CORNER, {
      epoch: Date.now(),
      initialBackfillComplete: true,
    });
    enriched = {
      ...enriched,
      identities: {
        ...enriched.identities,
        [agentPubkey]: {
          kind: 'agent',
          pubkey: agentPubkey as `0x${string}` & { length: 64 },
          displayName: 'Buzzy',
          revision: 'f'.repeat(64),
        } as never,
      },
    };
    const transport: TailTransport = {
      readModelTail: vi.fn(async () => tail),
      readModelBackfill: vi.fn(
        () =>
          new Promise<{ snapshot: typeof enriched; events: unknown[] }>((resolve) =>
            setTimeout(() => resolve({ snapshot: enriched, events: [] }), 25),
          ),
      ),
    };

    await revalidateCachedMessages(transport as never, VIEWER, CORNER);

    // First paint: exactly the tail rows, before the deferred read settles.
    expect(snapshotMessages()).toEqual(['m0', 'm1', 'm2', 'm3']);
    const beforeIdentity =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, CORNER)]!.snapshot!
        .identities[agentPubkey];
    expect(beforeIdentity?.revision.startsWith('-tail:') ?? true).toBe(true);

    // Deferred commit lands: gap-fill-only merge enriches without blanking,
    // and the directory-backed agent identity outranks any placeholder.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(snapshotMessages()).toEqual(['m0', 'm1', 'm2', 'm3', 'm-late']);
    const upgraded =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, CORNER)]!.snapshot!
        .identities[agentPubkey];
    expect(upgraded?.kind).toBe('agent');
    expect(upgraded?.revision).toBe('f'.repeat(64));
    const sample = coldOpenSamples().at(-1)!;
    expect(sample.deferredMs).toBeGreaterThanOrEqual(0);
    expect(sample.deferredError).toBeUndefined();
  });

  it('never lets a failing deferred reconciliation delay, blank, or reject the open', async () => {
    const transport: TailTransport = {
      readModelTail: vi.fn(async () => tailResult(4)),
      readModelBackfill: vi.fn(async () => {
        throw new Error('authority projection exploded');
      }),
    };

    await expect(
      revalidateCachedMessages(transport as never, VIEWER, CORNER),
    ).resolves.toBeTruthy();

    expect(snapshotMessages()).toEqual(['m0', 'm1', 'm2', 'm3']);
    // Give the fire-and-forget rejection one macrotask to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sample = coldOpenSamples().at(-1)!;
    expect(sample.deferredMs).toBeUndefined();
    expect(sample.deferredError).toContain('authority projection exploded');
  });

  it('applies the eight-second timeout to the tail read alone and reports that exact failure', async () => {
    vi.useFakeTimers();
    const transport: TailTransport = {
      readModelTail: vi.fn(() => new Promise(() => undefined)),
      readModelBackfill: vi.fn(async () => tailResult()),
    };

    const pending = revalidateCachedMessages(transport as never, VIEWER, CORNER);
    const assertion = expect(pending).rejects.toThrow(COLD_TAIL_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(COLD_TAIL_DEADLINE_MS + 1);
    await assertion;

    // The timeout fired off the tail read, not off any secondary step: the
    // full-machinery read was never even reached.
    expect(transport.readModelBackfill).not.toHaveBeenCalled();
    const sample = coldOpenSamples().at(-1)!;
    expect(sample.tailTimedOutAfterMs).toBe(COLD_TAIL_DEADLINE_MS);
    expect(sample.tailError).toBeUndefined();
  }, 20_000);

  it('keeps the legacy single-read shape when the transport has no fast path', async () => {
    const transport = {
      readModelBackfill: vi.fn(async () => tailResult(4)),
    };

    await revalidateCachedMessages(transport as never, VIEWER, CORNER);

    expect(transport.readModelBackfill).toHaveBeenCalledTimes(1);
    expect(snapshotMessages()).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(coldOpenSamples()).toHaveLength(0);
  });

  it('records deferred latency separately from the critical-path read', async () => {
    const recorder = beginColdOpenSample(CORNER);
    recorder.tailSettled(120, 4);
    recorder.deferredSettled(900, undefined);

    const sample = coldOpenSamples().at(-1)!;
    expect(sample.tailMs).toBe(120);
    expect(sample.tailEventCount).toBe(4);
    expect(sample.deferredMs).toBe(900);
  });
});
