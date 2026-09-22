import { applyLiveOverlay, type LiveOverlay } from '@beeline/buzz-client';
import { provisionalDraftKey, rememberProvisionalDraft } from './draft-settle';

/**
 * The one scheduler for every live draft lane.
 *
 * This is the latest-value half of the streaming design: arrivals only replace
 * the lane's pending snapshot, and each eligible frame commits the WHOLE latest
 * value — never a rate-limited slice. There is no character budget and no
 * reveal timer, so a lane stops painting the moment the producer stops. The
 * fixed 33 ms tick is the gate; because every tick commits the entire pending
 * snapshot, no value is ever held past the 50 ms deadline.
 *
 * The row-local invalidation boundary stays where it was: a cumulative arrival
 * mutates only this keyed store, and React state changes once to open or close
 * a lane, never for text (see `useRoomSurfaceSession.ts`).
 */
export const LIVE_DRAFT_TICK_MS = 33;
/** A pending snapshot is never held longer than this; a full commit is catch-up. */
export const LIVE_DRAFT_DEADLINE_MS = 50;
const MAX_RETAINED_LANES = 32;

export type LiveDraftPresentation = {
  readonly text: string;
};

export type LiveDraftMetrics = {
  readonly arrivals: number;
  readonly paints: number;
  readonly rewrites: number;
  readonly paintedCharacters: number;
};

export type LiveDraftPaint = LiveDraftPresentation;

export interface LiveDraftSink {
  paint(update: LiveDraftPaint): void;
  replace(presentation: LiveDraftPresentation): void;
}

export interface LiveDraftClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(id: number): void;
}

const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();

const defaultClock: LiveDraftClock = {
  now: monotonicNow,
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs) as unknown as number;
  },
  clearTimer(id) {
    clearTimeout(id);
  },
};

type MutableMetrics = {
  arrivals: number;
  paints: number;
  rewrites: number;
  paintedCharacters: number;
};

type Lane = {
  /** Every character the producer has sent so far. */
  received: string;
  /** The whole value currently on the row: text React has already painted. */
  committed: string;
  /** When the pending value first arrived, for the 50 ms catch-up bound. */
  pendingSince: number;
  sink?: LiveDraftSink;
  metrics: MutableMetrics;
  touchedAt: number;
};

const EMPTY_PRESENTATION: LiveDraftPresentation = { text: '' };
const EMPTY_METRICS: LiveDraftMetrics = {
  arrivals: 0,
  paints: 0,
  rewrites: 0,
  paintedCharacters: 0,
};

function snapshotMetrics(metrics: MutableMetrics): LiveDraftMetrics {
  return { ...metrics };
}

export interface LiveDraftDrainStore {
  publish(key: string, cumulativeText: string): void;
  stop(key: string): void;
  finalize(key: string): void;
  remove(key: string): void;
  attach(key: string, sink: LiveDraftSink): () => void;
  /**
   * Pause the scheduler without flushing. A focused Room is active; leave and
   * unmount must flip this off synchronously so a mid-turn drain cannot occupy
   * the JS thread until the message is ready to paint.
   */
  setActive(active: boolean): void;
  /**
   * Called once per lane commit — the row just grew, so a pinned reader may
   * need to follow it. Never called on an arrival that only queued.
   */
  subscribeCommit(listener: (key: string) => void): () => void;
  getPresentation(key: string): LiveDraftPresentation;
  getReceived(key: string): string;
  getMetrics(key: string): LiveDraftMetrics;
  reset(): void;
}

export function createLiveDraftDrainStore({
  clock = defaultClock,
}: { clock?: LiveDraftClock } = {}): LiveDraftDrainStore {
  const lanes = new Map<string, Lane>();
  const completedMetrics = new Map<string, LiveDraftMetrics>();
  const commitListeners = new Set<(key: string) => void>();
  let timerId: number | undefined;
  let active = true;

  const laneFor = (key: string): Lane => {
    const current = lanes.get(key);
    if (current) {
      current.touchedAt = clock.now();
      return current;
    }
    const lane: Lane = {
      received: '',
      committed: '',
      pendingSince: clock.now(),
      metrics: { ...EMPTY_METRICS },
      touchedAt: clock.now(),
    };
    lanes.set(key, lane);
    return lane;
  };

  const hasPendingWork = () =>
    [...lanes.values()].some((lane) => lane.sink && lane.received !== lane.committed);

  /**
   * The 33 ms gate, capped by the 50 ms deadline: a lane whose oldest pending
   * snapshot has already waited most of its budget flushes on the next tick
   * rather than waiting out the full gate.
   */
  const pendingDelay = () => {
    const now = clock.now();
    let delay = LIVE_DRAFT_TICK_MS;
    for (const lane of lanes.values()) {
      if (!lane.sink || lane.received === lane.committed) continue;
      delay = Math.min(delay, Math.max(0, LIVE_DRAFT_DEADLINE_MS - (now - lane.pendingSince)));
    }
    return delay;
  };

  const schedule = () => {
    if (!active || timerId !== undefined || !hasPendingWork()) return;
    timerId = clock.setTimer(tick, pendingDelay());
  };

  const stopTimer = () => {
    if (timerId === undefined) return;
    clock.clearTimer(timerId);
    timerId = undefined;
  };

  const notifyCommit = (key: string) => {
    for (const listener of commitListeners) listener(key);
  };

  /** Commit the whole latest snapshot: the latest-value rule, never a slice. */
  const commitLane = (key: string, lane: Lane, method: 'paint' | 'replace') => {
    if (!lane.sink || lane.received === lane.committed) return;
    const grew = lane.received.length - lane.committed.length;
    lane.committed = lane.received;
    lane.pendingSince = clock.now();
    lane.metrics.paints += 1;
    lane.metrics.paintedCharacters += grew;
    if (method === 'replace') lane.sink.replace({ text: lane.received });
    else lane.sink.paint({ text: lane.received });
    notifyCommit(key);
  };

  const commitAll = (method: 'paint' | 'replace') => {
    for (const [key, lane] of lanes) commitLane(key, lane, method);
  };

  function tick() {
    timerId = undefined;
    if (!active) return;
    commitAll('paint');
    schedule();
  }

  const archive = (key: string, lane: Lane) => {
    rememberProvisionalDraft(key, lane.received);
    completedMetrics.set(key, snapshotMetrics(lane.metrics));
    if (completedMetrics.size > MAX_RETAINED_LANES) {
      completedMetrics.delete(completedMetrics.keys().next().value as string);
    }
  };

  const prune = () => {
    if (lanes.size <= MAX_RETAINED_LANES) return;
    const removable = [...lanes.entries()]
      .filter(([, lane]) => !lane.sink)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    while (lanes.size > MAX_RETAINED_LANES && removable.length) {
      const [key, lane] = removable.shift()!;
      archive(key, lane);
      lanes.delete(key);
    }
  };

  const cancelIdleTimer = () => {
    if (timerId === undefined || hasPendingWork()) return;
    stopTimer();
  };

  return {
    publish(key, cumulativeText) {
      const lane = laneFor(key);
      if (lane.received === cumulativeText) return;
      lane.metrics.arrivals += 1;
      lane.touchedAt = clock.now();

      if (!cumulativeText.startsWith(lane.received)) {
        // A harness rewrote what it had written. Honesty rule: commit the
        // replacement immediately and whole, with no reveal.
        lane.received = cumulativeText;
        lane.committed = cumulativeText;
        lane.pendingSince = clock.now();
        lane.metrics.paints += 1;
        lane.metrics.rewrites += 1;
        lane.metrics.paintedCharacters += cumulativeText.length;
        lane.sink?.replace({ text: cumulativeText });
        if (lane.sink) notifyCommit(key);
        cancelIdleTimer();
        prune();
        return;
      }

      const wasPending = lane.received !== lane.committed;
      lane.received = cumulativeText;
      if (!wasPending) lane.pendingSince = clock.now();
      schedule();
      prune();
    },
    stop(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      commitLane(key, lane, 'paint');
      rememberProvisionalDraft(key, lane.received);
      cancelIdleTimer();
    },
    finalize(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      lane.committed = lane.received;
      archive(key, lane);
      cancelIdleTimer();
    },
    remove(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      archive(key, lane);
      lanes.delete(key);
      cancelIdleTimer();
    },
    attach(key, sink) {
      const lane = laneFor(key);
      lane.sink = sink;
      if (lane.committed) sink.replace({ text: lane.committed });
      schedule();
      return () => {
        const current = lanes.get(key);
        if (current?.sink === sink) current.sink = undefined;
        cancelIdleTimer();
      };
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        stopTimer();
        return;
      }
      commitAll('replace');
      cancelIdleTimer();
    },
    subscribeCommit(listener) {
      commitListeners.add(listener);
      return () => commitListeners.delete(listener);
    },
    getPresentation(key) {
      const lane = lanes.get(key);
      return lane ? { text: lane.committed } : EMPTY_PRESENTATION;
    },
    getReceived(key) {
      return lanes.get(key)?.received ?? '';
    },
    getMetrics(key) {
      const lane = lanes.get(key);
      return lane ? snapshotMetrics(lane.metrics) : (completedMetrics.get(key) ?? EMPTY_METRICS);
    },
    reset() {
      stopTimer();
      active = true;
      lanes.clear();
      completedMetrics.clear();
      commitListeners.clear();
    },
  };
}

export const liveDraftDrainStore = createLiveDraftDrainStore();

export function liveDraftDrainKey(agentPubkey: string, requestId: string): string {
  return provisionalDraftKey(agentPubkey, requestId);
}

/** Keep only row identity and lifecycle in Room-owned React state. */
export function applyLiveOverlayStructure(
  current: readonly LiveOverlay[],
  update: LiveOverlay,
  store: LiveDraftDrainStore = liveDraftDrainStore,
): readonly LiveOverlay[] {
  if (update.kind !== 'draft') return applyLiveOverlay(current, update);

  const storeKey = liveDraftDrainKey(update.agentPubkey, update.requestId);
  if (update.text !== undefined) store.publish(storeKey, update.text);

  const at = current.findIndex(
    (item) => item.kind === 'draft' && item.agentPubkey === update.agentPubkey,
  );
  const previous = at < 0 ? undefined : (current[at] as Extract<LiveOverlay, { kind: 'draft' }>);
  const sameRequest = previous?.requestId === update.requestId;

  if (!sameRequest && previous) {
    store.remove(liveDraftDrainKey(previous.agentPubkey, previous.requestId));
  }
  if (update.closed) store.stop(storeKey);
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