import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import type { NeedsYouItemView, NeedsYouListResult } from '@beeline/api-contract/phone';

export type NeedsYouLiveDelta = { readonly workspaceId: string; readonly sourceRoomId: string;
  readonly count: number; readonly items: readonly NeedsYouItemView[] };

/**
 * One viewer's Needs-you projection for one relay and Workspace. The tray list and the
 * badge both read it, so the badge is always the list's length once a list is
 * known. Before that (the tray never read), the badge shows the server count,
 * which starts no clock.
 */
export type NeedsYouEntry = {
  /** The list from a tray read or its disk copy; null while only a count is known. */
  readonly items: readonly NeedsYouItemView[] | null;
  /** The server count while `items` is null; null when no count is known. */
  readonly count: number | null;
  /** Cells a held section clear hides until its Undo window closes. */
  readonly held: ReadonlySet<string>;
};

/** The relay and identity a slot belongs to. */
type Viewer = { readonly key: string; readonly relay: string; readonly pubkey: string };

/** An optimistic clear. Until `settled`, a read may answer from before it. */
type Clear = { readonly ids: ReadonlySet<string>; readonly items: readonly NeedsYouItemView[]; settled?: number };

/** A change a list read started earlier may not include yet. */
type Operation =
  | { readonly at: number; readonly delta: NeedsYouLiveDelta }
  | { readonly clear: Clear };

/**
 * One viewer and Workspace. Every change bumps `revision`, the one freshness
 * rule: a read replays the logged changes newer than its start, a read applies
 * only when it started after the last applied read, and a count or disk copy
 * applies only when nothing changed while it was out.
 */
type Slot = {
  readonly viewer: Viewer;
  readonly workspaceId: string;
  entry: NeedsYouEntry;
  revision: number;
  /** Start revision of the newest applied read. */
  readAt: number;
  /** Start revisions of reads in flight. */
  readonly reads: Set<number>;
  log: Operation[];
  /** The list came from the server, so its disk copy is kept current. */
  persist: boolean;
};

const EMPTY: NeedsYouEntry = { items: null, count: null, held: new Set() };
const NEEDS_YOU_ENDPOINT = '/workspace/:id/needs-you';
/** Live signals after which the Needs-you list may have missed changes. */
export const NEEDS_YOU_GAP_REASONS: ReadonlySet<string> =
  new Set(['needs-you-gap', 'reconnect', 'postgres:memberships']);

const slots = new Map<string, Slot>();
/** Mounted trays per Workspace. A gap with no tray drops the list back to a count. */
const listHolders = new Map<string, number>();
const storeListeners = new Set<() => void>();
/** The relay and identity the entries belong to; `undefined` until resolved. */
let viewer: Viewer | undefined;
let viewerRead: Promise<Viewer> | undefined;
let liveStop: (() => void) | undefined;
let liveStarting = false;

function slotKey(viewerKey: string, workspaceId: string): string {
  return `${viewerKey}\u0000${workspaceId}`;
}

/**
 * The slot for the viewer the caller resolved. A viewer a client reset
 * replaced gets a detached slot, so the caller's writes go nowhere.
 */
function slotFor(owner: Viewer, workspaceId: string): Slot {
  const key = slotKey(owner.key, workspaceId);
  const existing = slots.get(key);
  if (existing && owner === viewer) return existing;
  const slot: Slot = { viewer: owner, workspaceId, entry: EMPTY, revision: 0, readAt: 0,
    reads: new Set(), log: [], persist: false };
  if (owner === viewer) slots.set(key, slot);
  return slot;
}

/** The current viewer's slot, or none before the viewer resolves. */
function currentSlot(workspaceId: string): Slot | undefined {
  return viewer === undefined ? undefined : slotFor(viewer, workspaceId);
}

/** A slot dropped by a client reset takes no more writes. */
function live(slot: Slot): boolean {
  return slots.get(slotKey(slot.viewer.key, slot.workspaceId)) === slot;
}

function notify(): void {
  for (const listener of storeListeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNeedsYouList(value: unknown): value is NeedsYouListResult {
  return isRecord(value) && Array.isArray(value.items) && value.items.every((item: unknown) =>
    isRecord(item) && typeof item.messageId === 'string' && typeof item.workspaceId === 'string' &&
    typeof item.roomId === 'string' && typeof item.roomName === 'string' && typeof item.text === 'string' &&
    typeof item.createdAt === 'number');
}

function diskAddress(slot: Slot) {
  return surfaceAddress(slot.viewer.relay, slot.viewer.pubkey, NEEDS_YOU_ENDPOINT, { workspaceId: slot.workspaceId });
}

/** Change one slot's entry, and keep its disk copy current once the server supplied the list. */
function write(slot: Slot, change: (entry: NeedsYouEntry) => NeedsYouEntry): void {
  if (!live(slot)) return;
  const previous = slot.entry;
  slot.entry = change(previous);
  if (slot.entry === previous) return;
  if (slot.persist && slot.entry.items && slot.entry.items !== previous.items && slot.viewer.pubkey)
    void mobileSurfaceCache.write(diskAddress(slot), { items: [...slot.entry.items] }, isNeedsYouList)
      .catch(() => undefined);
  notify();
}

/** Drop logged changes that no read in flight can still be missing. */
function trim(slot: Slot): void {
  const oldest = Math.min(...slot.reads);
  slot.log = slot.log.filter((operation) => 'clear' in operation
    ? operation.clear.settled === undefined || operation.clear.settled > oldest
    : operation.at > oldest);
}

function sortNeeds(items: NeedsYouItemView[]): NeedsYouItemView[] {
  return items.sort((a, b) => Number(!a.approval) - Number(!b.approval) ||
    (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
    a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
}

function applyNeedsSlice(
  current: readonly NeedsYouItemView[], delta: NeedsYouLiveDelta,
): NeedsYouItemView[] {
  return sortNeeds([...current.filter((item) => item.roomId !== delta.sourceRoomId), ...delta.items]);
}

/**
 * An identity or relay change forgets every slot, every in-flight count and
 * the live registration. Work holding a dropped slot writes nothing.
 */
subscribeClientReset(() => {
  slots.clear();
  countsInFlight.clear();
  viewer = undefined;
  viewerRead = undefined;
  liveStop?.();
  liveStop = undefined;
  notify();
});

async function readViewer(): Promise<Viewer> {
  const [relay, identity] = await Promise.all([getEffectiveRelayUrl(), loadBuzzIdentity()]);
  const pubkey = identity?.publicKey ?? '';
  return { key: `${relay}\u0000${pubkey}`, relay, pubkey };
}

function resolveViewer(): Promise<Viewer> {
  if (viewer !== undefined) return Promise.resolve(viewer);
  const at = clientResetGeneration();
  viewerRead ??= readViewer()
    .catch((): Viewer => ({ key: '', relay: '', pubkey: '' }))
    .then((resolved) => {
      if (at !== clientResetGeneration()) return resolved;
      viewer = resolved;
      startLive();
      notify();
      return resolved;
    });
  return viewerRead;
}

/**
 * The store's own roomless registration: deltas and gap signals reach it
 * whether or not a tray or badge is mounted. A client reset closes it; the
 * next viewer resolution registers again.
 */
function startLive(): void {
  if (liveStop || liveStarting) return;
  liveStarting = true;
  const at = clientResetGeneration();
  void sharedLiveConnection().register([], (event) => {
    if (!('monolithLive' in event)) return;
    const signal = (event as MonolithSurfaceEvent).monolithLive;
    if (signal.type === 'needs-you-delta') applyNeedsYouLiveDelta(signal);
    else if (signal.type === 'invalidate' && NEEDS_YOU_GAP_REASONS.has(signal.reason)) invalidateNeedsYou();
  }).then((stop) => {
    liveStarting = false;
    if (at === clientResetGeneration()) liveStop = stop;
    else stop();
  }, () => {
    liveStarting = false;
  });
}

export function applyNeedsYouLiveDelta(delta: NeedsYouLiveDelta): void {
  const slot = currentSlot(delta.workspaceId);
  if (!slot) return;
  slot.revision += 1;
  if (slot.reads.size) slot.log.push({ at: slot.revision, delta });
  write(slot, (entry) => entry.items
    ? { ...entry, items: applyNeedsSlice(entry.items, delta) }
    : { ...entry, count: delta.count });
}

/**
 * A gap may have dropped deltas. A mounted tray re-reads both sections on the
 * same signal; any other list falls back to a fresh server count.
 */
function invalidateNeedsYou(): void {
  if (viewer === undefined) return;
  for (const slot of slots.values()) {
    if (slot.viewer !== viewer || listHolders.get(slot.workspaceId)) continue;
    slot.revision += 1;
    write(slot, (entry) => ({ ...entry, items: null, count: null }));
  }
}

/** Read the list (this starts first-paint clocks) and store it with the changes heard meanwhile. */
export async function loadNeedsYouList(workspaceId: string): Promise<readonly NeedsYouItemView[]> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  const from = ++slot.revision;
  slot.reads.add(from);
  try {
    const result = await monolithPhoneOperation('readNeedsYou', { workspaceId });
    let items = sortNeeds([...result.items]);
    for (const operation of slot.log) {
      if ('clear' in operation) {
        const { ids, settled } = operation.clear;
        if ((settled ?? Infinity) > from) items = items.filter((item) => !ids.has(item.messageId));
      } else if (operation.at > from) {
        items = applyNeedsSlice(items, operation.delta);
      }
    }
    if (from > slot.readAt && live(slot)) {
      slot.readAt = from;
      slot.persist = true;
      write(slot, (entry) => ({ ...entry, items, count: null }));
    }
    return items;
  } finally {
    slot.reads.delete(from);
    trim(slot);
  }
}

/**
 * Paint the disk copy while no read or change has supplied the list. Resolves
 * whether a disk copy exists.
 */
export async function seedNeedsYouList(workspaceId: string): Promise<boolean> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  if (!slot.viewer.pubkey) return false;
  const at = slot.revision;
  const saved = await mobileSurfaceCache.read(diskAddress(slot), isNeedsYouList).catch(() => null);
  if (!saved) return false;
  if (slot.revision === at && !slot.entry.items)
    write(slot, (entry) => ({ ...entry, items: sortNeeds([...saved.items]) }));
  return true;
}

/** Membership was lost: the list is empty and its disk copy is removed. */
export function forgetNeedsYouList(workspaceId: string): void {
  const slot = currentSlot(workspaceId);
  if (!slot) return;
  slot.revision += 1;
  slot.persist = false;
  write(slot, (entry) => ({ ...entry, items: [], count: null }));
  if (slot.viewer.pubkey) void mobileSurfaceCache.remove(diskAddress(slot)).catch(() => undefined);
}

export type NeedsYouRemoval = {
  /** The server applied the clear; a read that starts from now on includes it. */
  readonly settle: () => void;
  /** The server refused the clear: the cells come back. False after a client reset. */
  readonly restore: () => boolean;
};

/**
 * An optimistic clear: the cells leave the list and the badge together. Until
 * it settles, every read leaves them out, since the server may answer from
 * before the clear. Both returned calls act once, and only on this viewer.
 */
export function removeNeedsYou(workspaceId: string, messageIds: Iterable<string>): NeedsYouRemoval {
  const slot = currentSlot(workspaceId);
  if (!slot) return { settle: () => undefined, restore: () => false };
  const ids = new Set(messageIds);
  const clear: Clear = { ids, items: slot.entry.items?.filter((item) => ids.has(item.messageId)) ?? [] };
  const operation = { clear };
  slot.revision += 1;
  slot.log.push(operation);
  write(slot, (entry) => entry.items
    ? { ...entry, items: entry.items.filter((item) => !ids.has(item.messageId)) }
    : entry);
  let done = false;
  return {
    settle: () => {
      if (done || !live(slot)) return;
      done = true;
      clear.settled = ++slot.revision;
      trim(slot);
    },
    restore: () => {
      if (done || !live(slot)) return false;
      done = true;
      slot.revision += 1;
      slot.log = slot.log.filter((logged) => logged !== operation);
      write(slot, (entry) => {
        if (!entry.items) return entry;
        const present = new Set(entry.items.map((item) => item.messageId));
        return { ...entry, items: sortNeeds([...entry.items,
          ...clear.items.filter((item) => !present.has(item.messageId))]) };
      });
      return true;
    },
  };
}

/** Hide exactly these cells (an empty list shows them all again). */
export function holdNeedsYou(workspaceId: string, messageIds: readonly string[]): void {
  const slot = currentSlot(workspaceId);
  if (slot) write(slot, (entry) => ({ ...entry, held: new Set(messageIds) }));
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => { storeListeners.delete(listener); };
}

function useNeedsYouEntry(workspaceId: string | null | undefined): NeedsYouEntry {
  useEffect(() => { void resolveViewer(); }, []);
  return useSyncExternalStore(subscribeStore, () =>
    workspaceId && viewer !== undefined ? slots.get(slotKey(viewer.key, workspaceId))?.entry ?? EMPTY : EMPTY);
}

function visible(entry: NeedsYouEntry): readonly NeedsYouItemView[] | null {
  if (!entry.items || !entry.held.size) return entry.items;
  return entry.items.filter((item) => !entry.held.has(item.messageId));
}

/** The tray's list: null until a read or disk copy supplies it. Held cells are left out. */
export function useNeedsYouList(workspaceId: string | null | undefined): {
  readonly items: readonly NeedsYouItemView[] | null;
  readonly all: readonly NeedsYouItemView[] | null;
} {
  const entry = useNeedsYouEntry(workspaceId);
  useEffect(() => {
    if (!workspaceId) return;
    listHolders.set(workspaceId, (listHolders.get(workspaceId) ?? 0) + 1);
    return () => {
      const left = (listHolders.get(workspaceId) ?? 1) - 1;
      if (left) listHolders.set(workspaceId, left);
      else listHolders.delete(workspaceId);
    };
  }, [workspaceId]);
  return useMemo(() => ({ items: visible(entry), all: entry.items }), [entry]);
}

/** One count per viewer and Workspace in flight, shared by every badge that asks at once. */
const countsInFlight = new Map<string, Promise<number>>();

function countNeedsYou(key: string, workspaceId: string): Promise<number> {
  const pending = countsInFlight.get(key);
  if (pending) return pending;
  const request = monolithPhoneOperation('countNeedsYou', { workspaceId })
    .then((result) => result.count)
    .finally(() => {
      if (countsInFlight.get(key) === request) countsInFlight.delete(key);
    });
  countsInFlight.set(key, request);
  return request;
}

/**
 * The tray badge: the list's length once a list is known, else the server
 * count. A covering Room-list read (`refreshKey`) or a gap asks for a fresh
 * count. Reading a count never starts a cell's 24-hour clock; only opening
 * the tray does.
 */
export function useNeedsYouCount(workspaceId: string | null | undefined, refreshKey: unknown) {
  const entry = useNeedsYouEntry(workspaceId);
  const listed = entry.items !== null;
  const countKnown = entry.count !== null;
  // A reset while a count is in flight leaves the entry looking unchanged; ask again.
  const generation = useSyncExternalStore(subscribeClientReset, clientResetGeneration);
  const countedFor = useRef<unknown>(undefined);
  useEffect(() => {
    // A caller with nothing read yet has nothing to count against.
    if (!workspaceId || refreshKey === undefined || listed) return;
    if (countKnown && countedFor.current === refreshKey) return;
    countedFor.current = refreshKey;
    let cancelled = false;
    void (async () => {
      const slot = slotFor(await resolveViewer(), workspaceId);
      if (cancelled) return;
      const at = slot.revision;
      try {
        const next = await countNeedsYou(slotKey(slot.viewer.key, workspaceId), workspaceId);
        // A change heard meanwhile already carried a newer count.
        if (slot.revision === at)
          write(slot, (current) => current.items ? current : { ...current, count: next });
      } catch {
        // A failed count keeps the last one.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey, listed, countKnown, generation]);
  const items = visible(entry);
  return items ? items.length : entry.count ?? 0;
}
