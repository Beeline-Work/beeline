import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';

export type NeedsYouLiveDelta = { readonly workspaceId: string; readonly sourceRoomId: string;
  readonly count: number; readonly items: readonly NeedsYouItemView[] };

/**
 * One viewer's Needs-you projection for one Workspace. The tray list and the
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
/** Live deltas heard while a list read is in flight, replayed onto its result. */
const readsInFlight = new Map<string, Set<NeedsYouLiveDelta[]>>();
/** Mounted trays per Workspace. A gap with no tray drops the list back to a count. */
const listHolders = new Map<string, number>();
const storeListeners = new Set<() => void>();
/** `undefined` until resolved; `''` when no identity is stored. */
let viewer: string | undefined;
let viewerRead: Promise<string> | undefined;
/** Bumped on identity change; work started under an older epoch writes nothing. */
let epoch = 0;
let liveStop: (() => void) | undefined;
let liveStarting = false;
let identityHooked = false;

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

/** Forget every viewer's entries: the account changed or signed out. */
export function resetNeedsYou(): void {
  epoch += 1;
  entries.clear();
  versions.clear();
  readsInFlight.clear();
  countsInFlight.clear();
  viewer = undefined;
  viewerRead = undefined;
  liveStop?.();
  liveStop = undefined;
  notify();
}

function hookIdentity(): void {
  if (identityHooked) return;
  identityHooked = true;
  monolithSession.subscribeIdentityChange(resetNeedsYou);
}

function resolveViewer(): Promise<string> {
  hookIdentity();
  if (viewer !== undefined) return Promise.resolve(viewer);
  const at = epoch;
  viewerRead ??= loadBuzzIdentity()
    .then((identity) => identity?.publicKey ?? '', () => '')
    .then((resolved) => {
      if (at !== epoch) return resolved;
      viewer = resolved;
      startLive();
      notify();
      return resolved;
    });
  return viewerRead;
}

/**
 * The store's own roomless registration: deltas and gap signals reach it
 * whether or not a tray or badge is mounted. The live connection closes it on
 * identity change; the next viewer resolution registers again.
 */
function startLive(): void {
  if (liveStop || liveStarting) return;
  liveStarting = true;
  const at = epoch;
  void sharedLiveConnection().register([], (event) => {
    if (!('monolithLive' in event)) return;
    const live = (event as MonolithSurfaceEvent).monolithLive;
    if (live.type === 'needs-you-delta') applyNeedsYouLiveDelta(live);
    else if (live.type === 'invalidate' && (live.reason === 'needs-you-gap' ||
        live.reason === 'reconnect' || live.reason === 'postgres:memberships'))
      invalidateNeedsYou();
  }).then((stop) => {
    liveStarting = false;
    if (at === epoch) {
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
  for (const heard of readsInFlight.get(key) ?? []) heard.push(delta);
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
  const viewerId = await resolveViewer();
  const at = epoch;
  const key = entryKey(viewerId, workspaceId);
  const heard: NeedsYouLiveDelta[] = [];
  const reads = readsInFlight.get(key) ?? new Set();
  reads.add(heard);
  readsInFlight.set(key, reads);
  try {
    const result = await monolithPhoneOperation('readNeedsYou', { workspaceId });
    const items = heard.reduce(applyNeedsSlice, sortNeeds([...result.items]));
    if (at === epoch && viewer === viewerId)
      write(workspaceId, (entry) => ({ ...entry, items, count: null }));
    return items;
  } finally {
    readsInFlight.get(key)?.delete(heard);
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

/** An optimistic clear: the cells leave the list and the badge together. */
export function removeNeedsYou(workspaceId: string, messageIds: Iterable<string>): void {
  const ids = new Set(messageIds);
  write(workspaceId, (entry) => entry.items
    ? { ...entry, items: entry.items.filter((item) => !ids.has(item.messageId)) }
    : entry);
}

/** A failed clear puts its cells back in the list and the badge together. */
export function restoreNeedsYou(workspaceId: string, items: readonly NeedsYouItemView[]): void {
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
  const countedFor = useRef<unknown>(undefined);
  useEffect(() => {
    // A caller with nothing read yet has nothing to count against.
    if (!workspaceId || refreshKey === undefined || listed) return;
    if (countKnown && countedFor.current === refreshKey) return;
    countedFor.current = refreshKey;
    let cancelled = false;
    void (async () => {
      const viewerId = await resolveViewer();
      if (cancelled) return;
      const at = epoch;
      const key = entryKey(viewerId, workspaceId);
      const version = versions.get(key) ?? 0;
      try {
        const next = await countNeedsYou(key, workspaceId);
        // A delta heard meanwhile already carried a newer count.
        if (at !== epoch || viewer !== viewerId || version !== (versions.get(key) ?? 0)) return;
        write(workspaceId, (current) => current.items ? current : { ...current, count: next });
      } catch {
        // A failed count keeps the last one.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey, listed, countKnown]);
  const items = visible(entry);
  return items ? items.length : entry.count ?? 0;
}
