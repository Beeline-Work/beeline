import { applyLiveOverlay, type LiveOverlay } from '@beeline/buzz-client';
import { provisionalDraftKey } from './draft-settle';

export const LIVE_DRAFT_MIN_COMMIT_MS = 33;
export const LIVE_DRAFT_DEADLINE_MS = 50;

export type LiveDraftCommitReason = 'frame' | 'deadline' | 'rewrite' | 'drain';

export type LiveDraftSnapshot = {
  readonly text: string;
  readonly revision: number;
  readonly reveal: boolean;
  readonly reason: LiveDraftCommitReason | 'empty';
};

const EMPTY_SNAPSHOT: LiveDraftSnapshot = {
  text: '',
  revision: 0,
  reveal: false,
  reason: 'empty',
};

export interface LiveDraftClock {
  now(): number;
  requestFrame(callback: (at: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(id: number): void;
}

const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();

const defaultClock: LiveDraftClock = {
  now: monotonicNow,
  requestFrame(callback) {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      return globalThis.requestAnimationFrame(callback);
    }
    return setTimeout(() => callback(monotonicNow()), 16) as unknown as number;
  },
  cancelFrame(id) {
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(id);
    } else {
      clearTimeout(id);
    }
  },
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs) as unknown as number;
  },
  clearTimer(id) {
    clearTimeout(id);
  },
};

type Lane = {
  snapshot: LiveDraftSnapshot;
  received: string;
  pending?: string;
  pendingSince?: number;
  lastCommitAt?: number;
  frameId?: number;
  deadlineId?: number;
  listeners: Set<() => void>;
  touchedAt: number;
};

export interface LiveDraftStore {
  publish(key: string, cumulativeText: string): void;
  /** Commit the newest bytes synchronously and cancel any cosmetic reveal. */
  drain(key: string): void;
  remove(key: string): void;
  getReceived(key: string): string;
  getSnapshot(key: string): LiveDraftSnapshot;
  subscribe(key: string, listener: () => void): () => void;
  reset(): void;
}

const MAX_RETAINED_LANES = 32;

/**
 * Latest-value, row-local draft storage.
 *
 * Socket arrivals only mutate this keyed store. Subscribers hear about text
 * commits after the frame/33/50 policy decides one is paintable; the Room and
 * its FlatList data never participate in a cumulative text update.
 */
export function createLiveDraftStore({
  clock = defaultClock,
}: { clock?: LiveDraftClock } = {}): LiveDraftStore {
  const lanes = new Map<string, Lane>();

  const laneFor = (key: string): Lane => {
    const current = lanes.get(key);
    if (current) {
      current.touchedAt = clock.now();
      return current;
    }
    const lane: Lane = {
      snapshot: EMPTY_SNAPSHOT,
      received: '',
      listeners: new Set(),
      touchedAt: clock.now(),
    };
    lanes.set(key, lane);
    return lane;
  };

  const cancelScheduled = (lane: Lane) => {
    if (lane.frameId !== undefined) clock.cancelFrame(lane.frameId);
    if (lane.deadlineId !== undefined) clock.clearTimer(lane.deadlineId);
    lane.frameId = undefined;
    lane.deadlineId = undefined;
  };

  const notify = (lane: Lane) => {
    for (const listener of [...lane.listeners]) listener();
  };

  const commit = (lane: Lane, text: string, reveal: boolean, reason: LiveDraftCommitReason) => {
    cancelScheduled(lane);
    lane.pending = undefined;
    lane.pendingSince = undefined;
    lane.lastCommitAt = clock.now();
    lane.snapshot = {
      text,
      revision: lane.snapshot.revision + 1,
      reveal,
      reason,
    };
    notify(lane);
  };

  const schedule = (lane: Lane) => {
    if (lane.pending === undefined) return;
    if (lane.frameId === undefined) {
      lane.frameId = clock.requestFrame(() => {
        lane.frameId = undefined;
        if (lane.pending === undefined) return;
        const now = clock.now();
        if (
          lane.lastCommitAt === undefined ||
          now - lane.lastCommitAt >= LIVE_DRAFT_MIN_COMMIT_MS
        ) {
          commit(lane, lane.pending, true, 'frame');
          return;
        }
        schedule(lane);
      });
    }
    if (lane.deadlineId === undefined && lane.pendingSince !== undefined) {
      const remaining = Math.max(0, LIVE_DRAFT_DEADLINE_MS - (clock.now() - lane.pendingSince));
      lane.deadlineId = clock.setTimer(() => {
        lane.deadlineId = undefined;
        if (lane.pending === undefined) return;
        commit(lane, lane.pending, false, 'deadline');
      }, remaining);
    }
  };

  const prune = () => {
    if (lanes.size <= MAX_RETAINED_LANES) return;
    const removable = [...lanes.entries()]
      .filter(([, lane]) => lane.listeners.size === 0)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    while (lanes.size > MAX_RETAINED_LANES && removable.length) {
      const [key, lane] = removable.shift()!;
      cancelScheduled(lane);
      lanes.delete(key);
    }
  };

  return {
    publish(key, cumulativeText) {
      const lane = laneFor(key);
      if (lane.received === cumulativeText) return;
      lane.received = cumulativeText;
      lane.touchedAt = clock.now();

      // The displayed value is the honesty boundary: a replacement is not an
      // arriving suffix, so it paints immediately and fully visible.
      if (lane.snapshot.text && !cumulativeText.startsWith(lane.snapshot.text)) {
        commit(lane, cumulativeText, false, 'rewrite');
        prune();
        return;
      }

      lane.pending = cumulativeText;
      lane.pendingSince ??= clock.now();
      schedule(lane);
      prune();
    },
    drain(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      commit(lane, lane.received, false, 'drain');
    },
    remove(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      cancelScheduled(lane);
      lanes.delete(key);
    },
    getReceived(key) {
      return lanes.get(key)?.received ?? '';
    },
    getSnapshot(key) {
      return lanes.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
    },
    subscribe(key, listener) {
      const lane = laneFor(key);
      lane.listeners.add(listener);
      return () => lane.listeners.delete(listener);
    },
    reset() {
      for (const lane of lanes.values()) cancelScheduled(lane);
      lanes.clear();
    },
  };
}

export const liveDraftStore = createLiveDraftStore();

export function liveDraftStoreKey(agentPubkey: string, requestId: string): string {
  return provisionalDraftKey(agentPubkey, requestId);
}

/**
 * Keep only row structure in Room-owned React state. Draft text is written to
 * the keyed store first; an update to an already-open request returns the
 * exact same array so neither the Room nor FlatList sees it.
 */
export function applyLiveOverlayStructure(
  current: readonly LiveOverlay[],
  update: LiveOverlay,
  store: LiveDraftStore = liveDraftStore,
): readonly LiveOverlay[] {
  if (update.kind !== 'draft') return applyLiveOverlay(current, update);

  const storeKey = liveDraftStoreKey(update.agentPubkey, update.requestId);
  if (update.text !== undefined) store.publish(storeKey, update.text);
  if (update.closed) store.drain(storeKey);

  const at = current.findIndex(
    (item) => item.kind === 'draft' && item.agentPubkey === update.agentPubkey,
  );
  const previous = at < 0 ? undefined : (current[at] as Extract<LiveOverlay, { kind: 'draft' }>);
  const sameRequest = previous?.requestId === update.requestId;

  if (!sameRequest && previous) {
    store.remove(liveDraftStoreKey(previous.agentPubkey, previous.requestId));
  }

  if (update.closed && !previous && !store.getReceived(storeKey)) return current;
  if (sameRequest && previous?.closed === update.closed) return current;

  const structural: Extract<LiveOverlay, { kind: 'draft' }> = {
    kind: 'draft',
    key: update.key,
    stableId: update.stableId,
    agentPubkey: update.agentPubkey,
    requestId: update.requestId,
    closed: update.closed,
    createdAt: sameRequest && previous ? previous.createdAt : update.createdAt,
  };
  if (at < 0) return [...current, structural];
  return current.map((item, index) => (index === at ? structural : item));
}
