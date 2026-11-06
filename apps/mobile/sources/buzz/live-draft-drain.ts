import { applyLiveOverlay, type LiveOverlay } from '@beeline/buzz-client';
import { provisionalDraftKey } from './draft-settle';

/** Latest whole snapshots paint on the host frame owned by the visible visit. */
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
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

const defaultClock: LiveDraftClock = {
  requestFrame: callback => globalThis.requestAnimationFrame(callback),
  cancelFrame: id => globalThis.cancelAnimationFrame(id),
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
  sink?: LiveDraftSink;
  metrics: MutableMetrics;
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
  rememberProvisionalDraft(key: string, text: string): void;
  takeProvisionalDraft(key: string): string | undefined;
  reset(): void;
}

export function createLiveDraftDrainStore({
  clock = defaultClock,
}: { clock?: LiveDraftClock } = {}): LiveDraftDrainStore {
  const lanes = new Map<string, Lane>();
  const provisional = new Map<string, string>();
  const rememberProvisionalDraft = (key: string, text: string) => {
    if (text) provisional.set(key, text);
  };
  const completedMetrics = new Map<string, LiveDraftMetrics>();
  const commitListeners = new Set<(key: string) => void>();
  let frameId: number | undefined;
  let active = true;

  const laneFor = (key: string): Lane => {
    const current = lanes.get(key);
    if (current) {
      return current;
    }
    const lane: Lane = {
      received: '',
      committed: '',
      metrics: { ...EMPTY_METRICS },
    };
    lanes.set(key, lane);
    return lane;
  };

  const hasPendingWork = () =>
    [...lanes.values()].some((lane) => lane.sink && lane.received !== lane.committed);

  const schedule = () => {
    if (!active || frameId !== undefined || !hasPendingWork()) return;
    frameId = clock.requestFrame(tick);
  };

  const cancelFrame = () => {
    if (frameId === undefined) return;
    clock.cancelFrame(frameId);
    frameId = undefined;
  };

  const notifyCommit = (key: string) => {
    for (const listener of commitListeners) listener(key);
  };

  /** Commit the whole latest snapshot: the latest-value rule, never a slice. */
  const commitLane = (key: string, lane: Lane, method: 'paint' | 'replace') => {
    if (!lane.sink || lane.received === lane.committed) return;
    const grew = lane.received.length - lane.committed.length;
    lane.committed = lane.received;
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
    frameId = undefined;
    if (!active) return;
    commitAll('paint');
    schedule();
  }

  const archive = (key: string, lane: Lane) => {
    rememberProvisionalDraft(key, lane.received);
    completedMetrics.set(key, snapshotMetrics(lane.metrics));
  };

  const cancelIdleFrame = () => {
    if (frameId === undefined || hasPendingWork()) return;
    cancelFrame();
  };

  return {
    publish(key, cumulativeText) {
      const lane = laneFor(key);
      if (lane.received === cumulativeText) return;
      lane.metrics.arrivals += 1;

      if (!cumulativeText.startsWith(lane.received)) {
        // A harness rewrote what it had written. Honesty rule: commit the
        // replacement immediately and whole, with no reveal.
        lane.received = cumulativeText;
        lane.committed = cumulativeText;
        lane.metrics.paints += 1;
        lane.metrics.rewrites += 1;
        lane.metrics.paintedCharacters += cumulativeText.length;
        lane.sink?.replace({ text: cumulativeText });
        if (lane.sink) notifyCommit(key);
        cancelIdleFrame();
        return;
      }

      lane.received = cumulativeText;
      schedule();
    },
    stop(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      commitLane(key, lane, 'paint');
      rememberProvisionalDraft(key, lane.received);
      cancelIdleFrame();
    },
    finalize(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      lane.committed = lane.received;
      archive(key, lane);
      cancelIdleFrame();
    },
    remove(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      archive(key, lane);
      lanes.delete(key);
      cancelIdleFrame();
    },
    attach(key, sink) {
      const lane = laneFor(key);
      lane.sink = sink;
      if (lane.committed) sink.replace({ text: lane.committed });
      schedule();
      return () => {
        const current = lanes.get(key);
        if (current?.sink === sink) current.sink = undefined;
        cancelIdleFrame();
      };
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        cancelFrame();
        return;
      }
      commitAll('replace');
      cancelIdleFrame();
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
    rememberProvisionalDraft,
    takeProvisionalDraft(key) {
      const text = provisional.get(key);
      provisional.delete(key);
      return text;
    },
    reset() {
      cancelFrame();
      active = true;
      lanes.clear();
      completedMetrics.clear();
      provisional.clear();
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

  // An empty baseline initializes the transport; it is not a transcript entry.
  // The first prose opens the lane, without displacing text from an older turn.
  if (!sameRequest && !store.getReceived(storeKey)) return current;

  if (!sameRequest && previous) {
    store.remove(liveDraftDrainKey(previous.agentPubkey, previous.requestId));
  }
  if (update.closed) store.stop(storeKey);
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
