import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';

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

const EMPTY: NeedsYouEntry = { items: null, count: null, held: new Set() };
const entries = new Map<string, NeedsYouEntry>();
/** Bumped by every live delta, so an older read cannot overwrite a newer slice. */
const versions = new Map<string, number>();
/**
 * Each list read in flight: live deltas heard meanwhile, replayed onto its
 * result, and cells cleared meanwhile, left out of it.
 */
type ReadInFlight = { readonly deltas: NeedsYouLiveDelta[]; readonly cleared: Set<string> };
const readsInFlight = new Map<string, Set<ReadInFlight>>();
/**
 * Cells whose clear the server has not answered yet, counted per clear. A read
 * that starts meanwhile may answer from before the clear, so it leaves them out.
 */
const pendingClears = new Map<string, Map<string, number>>();
/** Start order of list reads; a read never overwrites one that started after it. */
let readsStarted = 0;
const newestRead = new Map<string, number>();
/** Mounted trays per Workspace. A gap with no tray drops the list back to a count. */
const listHolders = new Map<string, number>();
const storeListeners = new Set<() => void>();
/** The relay and identity the entries belong to; `undefined` until resolved. */
let viewer: string | undefined;
let viewerRead: Promise<string> | undefined;
let liveStop: (() => void) | undefined;
let liveStarting = false;

function entryKey(viewerId: string, workspaceId: string): string {
  return `${viewerId}\u0000${workspaceId}`;
}

function notify(): void {
  for (const listener of storeListeners) listener();
}

function write(workspaceId: string, change: (entry: NeedsYouEntry) => NeedsYouEntry): void {
  if (viewer === undefined) return;
  const key = entryKey(viewer, workspaceId);
  entries.set(key, change(entries.get(key) ?? EMPTY));
  notify();
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
 * An identity or relay change forgets every entry, every in-flight count and
 * the live registration. Work started before it carries an older
 * `clientResetGeneration()` and writes nothing.
 */
subscribeClientReset(() => {
  entries.clear();
  versions.clear();
  readsInFlight.clear();
  pendingClears.clear();
  newestRead.clear();
  countsInFlight.clear();
  viewer = undefined;
  viewerRead = undefined;
  liveStop?.();
  liveStop = undefined;
  notify();
});

async function readViewer(): Promise<string> {
  const [relay, identity] = await Promise.all([getEffectiveRelayUrl(), loadBuzzIdentity()]);
  return `${relay}\u0000${identity?.publicKey ?? ''}`;
}

function resolveViewer(): Promise<string> {
  if (viewer !== undefined) return Promise.resolve(viewer);
  const at = clientResetGeneration();
  viewerRead ??= readViewer()
    .catch(() => '')
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
    const live = (event as MonolithSurfaceEvent).monolithLive;
    if (live.type === 'needs-you-delta') applyNeedsYouLiveDelta(live);
    else if (live.type === 'invalidate' && (live.reason === 'needs-you-gap' ||
        live.reason === 'reconnect' || live.reason === 'postgres:memberships'))
      invalidateNeedsYou();
  }).then((stop) => {
    liveStarting = false;
    if (at === clientResetGeneration()) {
      liveStop = stop;
      return;
    }
    stop();
    if (viewer !== undefined) startLive();
  }, () => {
    liveStarting = false;
  });
}

export function applyNeedsYouLiveDelta(delta: NeedsYouLiveDelta): void {
  if (viewer === undefined) return;
  const key = entryKey(viewer, delta.workspaceId);
  versions.set(key, (versions.get(key) ?? 0) + 1);
  for (const read of readsInFlight.get(key) ?? []) read.deltas.push(delta);
  write(delta.workspaceId, (entry) => entry.items
    ? { ...entry, items: applyNeedsSlice(entry.items, delta) }
    : { ...entry, count: delta.count });
}

/**
 * A gap may have dropped deltas. A mounted tray re-reads both sections on the
 * same signal; any other list falls back to a fresh server count.
 */
function invalidateNeedsYou(): void {
  if (viewer === undefined) return;
  const prefix = entryKey(viewer, '');
  let changed = false;
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix) || listHolders.get(key.slice(prefix.length))) continue;
    entries.set(key, { ...entry, items: null, count: null });
    changed = true;
  }
  if (changed) notify();
}

/** Live delta version for a Workspace; a disk copy read across a change must not paint. */
export function needsYouVersion(workspaceId: string): number {
  return viewer === undefined ? 0 : versions.get(entryKey(viewer, workspaceId)) ?? 0;
}

/** Read the list (this starts first-paint clocks) and store it with any deltas heard meanwhile. */
export async function loadNeedsYouList(workspaceId: string): Promise<readonly NeedsYouItemView[]> {
  const at = clientResetGeneration();
  const viewerId = await resolveViewer();
  const key = entryKey(viewerId, workspaceId);
  const started = ++readsStarted;
  const read: ReadInFlight = { deltas: [], cleared: new Set(pendingClears.get(key)?.keys()) };
  const reads = readsInFlight.get(key) ?? new Set();
  reads.add(read);
  readsInFlight.set(key, reads);
  try {
    const result = await monolithPhoneOperation('readNeedsYou', { workspaceId });
    const items = read.deltas.reduce(applyNeedsSlice, sortNeeds([...result.items]))
      .filter((item) => !read.cleared.has(item.messageId));
    if (at === clientResetGeneration() && viewer === viewerId && started > (newestRead.get(key) ?? 0)) {
      newestRead.set(key, started);
      write(workspaceId, (entry) => ({ ...entry, items, count: null }));
    }
    return items;
  } finally {
    readsInFlight.get(key)?.delete(read);
  }
}

/** Paint a disk copy only while no read or delta has supplied the list. */
export function seedNeedsYouList(workspaceId: string, items: readonly NeedsYouItemView[]): void {
  write(workspaceId, (entry) => entry.items ? entry : { ...entry, items: sortNeeds([...items]) });
}

/** Replace the list outright, e.g. empty once Workspace membership is lost. */
export function setNeedsYouList(workspaceId: string, items: readonly NeedsYouItemView[]): void {
  write(workspaceId, (entry) => ({ ...entry, items: sortNeeds([...items]), count: null }));
}

/** Every list read in flight for this viewer and Workspace. */
function pendingReads(workspaceId: string): Iterable<ReadInFlight> {
  return viewer === undefined ? [] : readsInFlight.get(entryKey(viewer, workspaceId)) ?? [];
}

/**
 * An optimistic clear: the cells leave the list and the badge together. A read
 * in flight, or one that starts before the server answers the clear, may answer
 * from before it, so it leaves them out too. Call the returned function once
 * the server answers, before any restore; after a client reset it does nothing.
 */
export function removeNeedsYou(workspaceId: string, messageIds: Iterable<string>): () => void {
  const ids = new Set(messageIds);
  for (const read of pendingReads(workspaceId)) for (const id of ids) read.cleared.add(id);
  const pending = viewer === undefined ? undefined : entryKey(viewer, workspaceId);
  if (pending !== undefined) {
    const counts = pendingClears.get(pending) ?? new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    pendingClears.set(pending, counts);
  }
  write(workspaceId, (entry) => entry.items
    ? { ...entry, items: entry.items.filter((item) => !ids.has(item.messageId)) }
    : entry);
  const at = clientResetGeneration();
  let settled = false;
  return () => {
    if (settled || pending === undefined || at !== clientResetGeneration()) return;
    settled = true;
    const counts = pendingClears.get(pending);
    if (!counts) return;
    for (const id of ids) {
      const left = (counts.get(id) ?? 1) - 1;
      if (left) counts.set(id, left);
      else counts.delete(id);
    }
    if (!counts.size) pendingClears.delete(pending);
  };
}

/** A failed clear puts its cells back in the list and the badge together. */
export function restoreNeedsYou(workspaceId: string, items: readonly NeedsYouItemView[]): void {
  for (const read of pendingReads(workspaceId))
    for (const item of items) read.cleared.delete(item.messageId);
  write(workspaceId, (entry) => {
    if (!entry.items) return entry;
    const present = new Set(entry.items.map((item) => item.messageId));
    return { ...entry, items: sortNeeds([...entry.items,
      ...items.filter((item) => !present.has(item.messageId))]) };
  });
}

/** Hide exactly these cells (an empty list shows them all again). */
export function holdNeedsYou(workspaceId: string, messageIds: readonly string[]): void {
  write(workspaceId, (entry) => ({ ...entry, held: new Set(messageIds) }));
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => { storeListeners.delete(listener); };
}

function useNeedsYouEntry(workspaceId: string | null | undefined): NeedsYouEntry {
  useEffect(() => { void resolveViewer(); }, []);
  return useSyncExternalStore(subscribeStore, () =>
    workspaceId && viewer !== undefined ? entries.get(entryKey(viewer, workspaceId)) ?? EMPTY : EMPTY);
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
      const at = clientResetGeneration();
      const viewerId = await resolveViewer();
      if (cancelled) return;
      const key = entryKey(viewerId, workspaceId);
      const version = versions.get(key) ?? 0;
      try {
        const next = await countNeedsYou(key, workspaceId);
        // A delta heard meanwhile already carried a newer count.
        if (at !== clientResetGeneration() || viewer !== viewerId || version !== (versions.get(key) ?? 0)) return;
        write(workspaceId, (current) => current.items ? current : { ...current, count: next });
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
