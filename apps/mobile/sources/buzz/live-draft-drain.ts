import { applyLiveOverlay, type LiveOverlay } from '@beeline/buzz-client';
import { provisionalDraftKey, rememberProvisionalDraft } from './draft-settle';

export const LIVE_DRAFT_TICK_MS = 32;
export const LIVE_DRAFT_KEEP_LINES = 2;
export const LIVE_DRAFT_PROMOTE_LINES = 4;
export const LIVE_DRAFT_KEEP_CHARS = 240;

const BASE_CHARACTERS_PER_SECOND = 900;
const MAX_CHARACTERS_PER_SECOND = 4_800;
const BACKLOG_RATE_GAIN = 1.5;
const MAX_RETAINED_LANES = 32;

export type LiveDraftPresentation = {
  readonly blocks: readonly string[];
  readonly liveText: string;
};

export type LiveDraftMetrics = {
  readonly arrivals: number;
  readonly paints: number;
  readonly promotions: number;
  readonly rewrites: number;
  readonly paintedCharacters: number;
};

export type LiveDraftPaint = LiveDraftPresentation & {
  readonly promoted: readonly string[];
};

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
  promotions: number;
  rewrites: number;
  paintedCharacters: number;
};

type Lane = {
  received: string;
  queued: string;
  blocks: string[];
  liveText: string;
  sink?: LiveDraftSink;
  lastTickAt?: number;
  characterBudget: number;
  instant: boolean;
  metrics: MutableMetrics;
  touchedAt: number;
};

const EMPTY_PRESENTATION: LiveDraftPresentation = { blocks: [], liveText: '' };
const EMPTY_METRICS: LiveDraftMetrics = {
  arrivals: 0,
  paints: 0,
  promotions: 0,
  rewrites: 0,
  paintedCharacters: 0,
};

function snapshotMetrics(metrics: MutableMetrics): LiveDraftMetrics {
  return { ...metrics };
}

function splitRewrite(text: string): LiveDraftPresentation {
  const lines = text.split(/(?<=\n)/u);
  const keep = Math.min(LIVE_DRAFT_KEEP_LINES, lines.length);
  const splitAt = Math.max(0, lines.length - keep);
  const settled = lines.slice(0, splitAt).join('');
  return capLiveChars({
    blocks: settled ? [settled] : [],
    liveText: lines.slice(splitAt).join(''),
  });
}

function capLiveChars(presentation: LiveDraftPresentation): LiveDraftPresentation {
  if (presentation.liveText.length <= LIVE_DRAFT_KEEP_CHARS) return presentation;
  const target = presentation.liveText.length - LIVE_DRAFT_KEEP_CHARS;
  let cut = presentation.liveText.lastIndexOf('\n', target);
  if (cut < 0) cut = presentation.liveText.lastIndexOf(' ', target);
  if (cut < 0) cut = target;
  else cut += 1;
  if (cut <= 0) return presentation;
  const prefix = presentation.liveText.slice(0, cut);
  return {
    blocks: prefix ? [...presentation.blocks, prefix] : presentation.blocks,
    liveText: presentation.liveText.slice(cut),
  };
}

function newlineEnds(text: string): number[] {
  const ends: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) ends.push(index + 1);
  }
  return ends;
}

function promoteCompleteLines(lane: Lane): string[] {
  const promoted: string[] = [];
  while (true) {
    const ends = newlineEnds(lane.liveText);
    if (ends.length < LIVE_DRAFT_KEEP_LINES + LIVE_DRAFT_PROMOTE_LINES) break;
    const cut = ends[LIVE_DRAFT_PROMOTE_LINES - 1]!;
    const block = lane.liveText.slice(0, cut);
    lane.liveText = lane.liveText.slice(cut);
    lane.blocks.push(block);
    promoted.push(block);
  }
  return promoted;
}

function promoteByChars(lane: Lane): string[] {
  if (lane.liveText.length <= LIVE_DRAFT_KEEP_CHARS) return [];
  const capped = capLiveChars({ blocks: [], liveText: lane.liveText });
  if (!capped.blocks.length) return [];
  lane.blocks.push(...capped.blocks);
  lane.liveText = capped.liveText;
  return [...capped.blocks];
}

function promoteLive(lane: Lane): string[] {
  return [...promoteCompleteLines(lane), ...promoteByChars(lane)];
}

export interface LiveDraftDrainStore {
  publish(key: string, cumulativeText: string): void;
  stop(key: string): void;
  finalize(key: string): void;
  remove(key: string): void;
  attach(key: string, sink: LiveDraftSink): () => void;
  setInstant(key: string, instant: boolean): void;
  /**
   * Pause the scheduler without flushing. A focused Room is active; leave and
   * unmount must flip this off synchronously so a mid-turn drain cannot occupy
   * the JS thread until the message is ready to paint.
   */
  setActive(active: boolean): void;
  subscribePromotion(listener: (key: string) => void): () => void;
  getPresentation(key: string): LiveDraftPresentation;
  getReceived(key: string): string;
  getMetrics(key: string): LiveDraftMetrics;
  reset(): void;
}

/**
 * One scheduler for every live draft lane.
 *
 * Network arrivals only append bytes to `queued`. The fixed tick spends a
 * character budget against that queue and mutates the row's narrow native text
 * surface through its sink. React hears only about an occasional immutable
 * block promotion; it never hears about an arrival or an ordinary paint.
 */
export function createLiveDraftDrainStore({
  clock = defaultClock,
}: { clock?: LiveDraftClock } = {}): LiveDraftDrainStore {
  const lanes = new Map<string, Lane>();
  const completedMetrics = new Map<string, LiveDraftMetrics>();
  const promotionListeners = new Set<(key: string) => void>();
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
      queued: '',
      blocks: [],
      liveText: '',
      characterBudget: 0,
      instant: false,
      metrics: { ...EMPTY_METRICS },
      touchedAt: clock.now(),
    };
    lanes.set(key, lane);
    return lane;
  };

  const hasPaintableWork = () =>
    [...lanes.values()].some((lane) => lane.queued.length > 0 && lane.sink);

  const schedule = () => {
    if (!active || timerId !== undefined || !hasPaintableWork()) return;
    timerId = clock.setTimer(tick, LIVE_DRAFT_TICK_MS);
  };

  const stopTimer = () => {
    if (timerId === undefined) return;
    clock.clearTimer(timerId);
    timerId = undefined;
  };

  const catchUpQueued = () => {
    for (const [key, lane] of lanes) {
      if (!lane.sink || !lane.queued) continue;
      const flushed = lane.queued.length;
      lane.liveText += lane.queued;
      lane.queued = '';
      lane.characterBudget = 0;
      const promoted = promoteLive(lane);
      lane.metrics.promotions += promoted.length;
      lane.metrics.paintedCharacters += flushed;
      lane.sink.replace({ blocks: lane.blocks, liveText: lane.liveText });
      if (promoted.length) notifyPromotion(key);
    }
  };

  const notifyPromotion = (key: string) => {
    for (const listener of promotionListeners) listener(key);
  };

  const paintLane = (key: string, lane: Lane, at: number) => {
    if (!lane.sink || !lane.queued) return;
    const elapsed = Math.max(
      LIVE_DRAFT_TICK_MS,
      Math.min(100, at - (lane.lastTickAt ?? at - LIVE_DRAFT_TICK_MS)),
    );
    lane.lastTickAt = at;
    const rate = Math.min(
      MAX_CHARACTERS_PER_SECOND,
      BASE_CHARACTERS_PER_SECOND + lane.queued.length * BACKLOG_RATE_GAIN,
    );
    lane.characterBudget += (rate * elapsed) / 1_000;
    const take = Math.min(
      lane.queued.length,
      lane.instant ? lane.queued.length : Math.floor(lane.characterBudget),
    );
    if (take <= 0) return;

    const append = lane.queued.slice(0, take);
    lane.queued = lane.queued.slice(take);
    if (!lane.instant) lane.characterBudget -= take;
    else lane.characterBudget = 0;
    lane.liveText += append;
    const promoted = promoteLive(lane);
    lane.metrics.paints += 1;
    lane.metrics.promotions += promoted.length;
    lane.metrics.paintedCharacters += take;
    lane.sink.paint({ blocks: lane.blocks, liveText: lane.liveText, promoted });
    if (promoted.length > 0) notifyPromotion(key);
  };

  function tick() {
    timerId = undefined;
    if (!active) return;
    const at = clock.now();
    for (const [key, lane] of lanes) paintLane(key, lane, at);
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
    if (timerId === undefined || hasPaintableWork()) return;
    stopTimer();
  };

  return {
    publish(key, cumulativeText) {
      const lane = laneFor(key);
      if (lane.received === cumulativeText) return;
      lane.metrics.arrivals += 1;
      lane.touchedAt = clock.now();

      if (!cumulativeText.startsWith(lane.received)) {
        lane.received = cumulativeText;
        lane.queued = '';
        lane.characterBudget = 0;
        lane.lastTickAt = undefined;
        const replacement = splitRewrite(cumulativeText);
        lane.blocks = [...replacement.blocks];
        lane.liveText = replacement.liveText;
        lane.metrics.paints += 1;
        lane.metrics.rewrites += 1;
        lane.metrics.paintedCharacters += cumulativeText.length;
        lane.sink?.replace(replacement);
        if (lane.sink) notifyPromotion(key);
        cancelIdleTimer();
        prune();
        return;
      }

      lane.queued += cumulativeText.slice(lane.received.length);
      lane.received = cumulativeText;
      schedule();
      prune();
    },
    stop(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      if (lane.queued) {
        lane.liveText += lane.queued;
        lane.queued = '';
        const promoted = promoteLive(lane);
        lane.metrics.promotions += promoted.length;
        lane.sink?.replace({ blocks: lane.blocks, liveText: lane.liveText });
        if (promoted.length && lane.sink) notifyPromotion(key);
      }
      rememberProvisionalDraft(key, lane.received);
      lane.characterBudget = 0;
      lane.lastTickAt = undefined;
      cancelIdleTimer();
    },
    finalize(key) {
      const lane = lanes.get(key);
      if (!lane) return;
      lane.queued = '';
      lane.characterBudget = 0;
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
      if (lane.blocks.length || lane.liveText) {
        sink.replace({ blocks: lane.blocks, liveText: lane.liveText });
      }
      schedule();
      return () => {
        const current = lanes.get(key);
        if (current?.sink === sink) current.sink = undefined;
        cancelIdleTimer();
      };
    },
    setInstant(key, instant) {
      const lane = laneFor(key);
      lane.instant = instant;
      if (instant) schedule();
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        stopTimer();
        return;
      }
      catchUpQueued();
      cancelIdleTimer();
    },
    subscribePromotion(listener) {
      promotionListeners.add(listener);
      return () => promotionListeners.delete(listener);
    },
    getPresentation(key) {
      const lane = lanes.get(key);
      return lane ? { blocks: lane.blocks, liveText: lane.liveText } : EMPTY_PRESENTATION;
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
      promotionListeners.clear();
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
