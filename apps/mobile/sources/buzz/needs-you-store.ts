import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import type { MessageBookmarkListResult, MessageBookmarkView, NeedsYouItemView, NeedsYouListResult } from '@beeline/api-contract/phone';

export type NeedsYouLiveDelta = { readonly workspaceId: string; readonly sourceRoomId: string;
  readonly count: number; readonly items: readonly NeedsYouItemView[] };
export type BookmarkDelta = { readonly messageId: string; readonly bookmark: MessageBookmarkView | null };
const GAP_REASONS = new Set(['needs-you-gap', 'bookmark-gap', 'reconnect', 'postgres:memberships']);

type Entry = { needs: readonly NeedsYouItemView[] | null; count: number | null;
  saved: readonly MessageBookmarkView[] | null; next?: string; held: ReadonlySet<string> };
/** A read replays later live changes, then edits still pending at its start. */
type Change = { at: number; kind: 'needs' | 'saved'; apply: (entry: Entry) => Entry;
  pending?: boolean; settled?: number };
type Slot = { key: string; relay: string; pubkey: string; workspaceId: string;
  /** One order for both sections, count reads, and local edits. */
  entry: Entry; clock: number; needsRead: number; savedRead: number;
  reads: Set<number>; changes: Change[]; countRead?: Promise<{ count: number; at: number }>;
  trayRead?: Promise<{ needsError?: string; savedError?: string }>;
  forgotten?: boolean };
const EMPTY: Entry = { needs: null, count: null, saved: null, held: new Set() };
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
const trayReaders = new Map<string, Set<(reason: string) => void>>();
let viewer: { key: string; relay: string; pubkey: string } | undefined;
let resolving: Promise<NonNullable<typeof viewer>> | undefined;
let liveStop: (() => void) | undefined;
let liveStarting = false;
const notify = () => listeners.forEach((listener) => listener());
const active = (slot: Slot) => slots.get(slot.key) === slot;
const address = (slot: Slot, kind: 'needs-you' | 'bookmarks') =>
  surfaceAddress(slot.relay, slot.pubkey, `/workspace/:id/${kind}`, { workspaceId: slot.workspaceId });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const needsList = (value: unknown): value is NeedsYouListResult => record(value) && Array.isArray(value.items) &&
  value.items.every((item: unknown) => record(item) && typeof item.messageId === 'string' &&
    typeof item.workspaceId === 'string' && typeof item.roomId === 'string' &&
    typeof item.roomName === 'string' && typeof item.text === 'string' && typeof item.createdAt === 'number');
const savedList = (value: unknown): value is MessageBookmarkListResult => record(value) &&
  (value.next === undefined || typeof value.next === 'string') && Array.isArray(value.bookmarks) &&
  value.bookmarks.every((item: unknown) => record(item) && typeof item.messageId === 'string' &&
    typeof item.workspaceId === 'string' && typeof item.roomId === 'string' &&
    typeof item.roomName === 'string' && typeof item.bookmarkedAt === 'number' && typeof item.available === 'boolean');

function slotFor(owner: NonNullable<typeof viewer>, workspaceId: string): Slot {
  const key = `${owner.key}\u0000${workspaceId}`;
  const known = slots.get(key);
  if (known && owner === viewer) return known;
  const slot: Slot = { key, relay: owner.relay, pubkey: owner.pubkey, workspaceId,
    entry: EMPTY, clock: 0, needsRead: 0, savedRead: 0, reads: new Set(), changes: [] };
  if (owner === viewer) slots.set(key, slot);
  return slot;
}
const current = (workspaceId: string) => viewer && slots.get(`${viewer.key}\u0000${workspaceId}`);
function write(slot: Slot, entry: Entry, persist = true): void {
  if (!active(slot) || entry === slot.entry) return;
  const before = slot.entry;
  slot.entry = entry;
  if (persist && slot.pubkey) {
    if (entry.needs && entry.needs !== before.needs)
      void mobileSurfaceCache.write(address(slot, 'needs-you'), { items: [...entry.needs] }, needsList).catch(() => undefined);
    if (entry.saved && (entry.saved !== before.saved || entry.next !== before.next))
      void mobileSurfaceCache.write(address(slot, 'bookmarks'),
        { bookmarks: [...entry.saved], next: entry.next }, savedList).catch(() => undefined);
  }
  notify();
}
function trim(slot: Slot): void {
  const oldest = Math.min(...slot.reads);
  slot.changes = slot.changes.filter((change) =>
    change.pending ? change.settled === undefined || change.settled > oldest : change.at > oldest);
}
function replay(slot: Slot, kind: Change['kind'], at: number, entry: Entry): Entry {
  let next = entry;
  for (const change of slot.changes)
    if (change.kind === kind && !change.pending && change.at > at) next = change.apply(next);
  for (const change of slot.changes)
    if (change.kind === kind && change.pending && (change.settled ?? Infinity) > at)
      next = change.apply(next);
  return next;
}
const orderedNeeds = (items: NeedsYouItemView[]) => items.sort((a, b) =>
  Number(!a.approval) - Number(!b.approval) || (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
  a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
const needsSlice = (items: readonly NeedsYouItemView[], delta: NeedsYouLiveDelta) =>
  orderedNeeds([...items.filter((item) => item.roomId !== delta.sourceRoomId), ...delta.items]);
const savedSlice = (items: readonly MessageBookmarkView[], delta: BookmarkDelta) =>
  [...items.filter((item) => item.messageId !== delta.messageId), ...(delta.bookmark ? [delta.bookmark] : [])]
    .sort((a, b) => b.bookmarkedAt - a.bookmarkedAt || a.messageId.localeCompare(b.messageId));

subscribeClientReset(() => {
  slots.clear(); viewer = undefined; resolving = undefined;
  liveStop?.(); liveStop = undefined; liveStarting = false; notify();
  if (listeners.size) void resolveViewer();
});
function startLive(): void {
  if (liveStop || liveStarting) return;
  liveStarting = true;
  const generation = clientResetGeneration();
  void sharedLiveConnection().register([], (event) => {
    if (generation !== clientResetGeneration()) return;
    if (!('monolithLive' in event)) return;
    const signal = (event as MonolithSurfaceEvent).monolithLive;
    if (signal.type === 'needs-you-delta') applyNeedsYouLiveDelta(signal);
    else if (signal.type === 'bookmark-delta') applyBookmarkDelta(signal);
    else if (signal.type === 'invalidate' && GAP_REASONS.has(signal.reason)) {
      for (const slot of slots.values()) if (signal.reason !== 'bookmark-gap' && !trayReaders.has(slot.workspaceId)) {
        slot.clock += 1;
        write(slot, { ...slot.entry, needs: null, count: null }, false);
      }
      for (const readers of trayReaders.values()) for (const read of readers) read(signal.reason);
    }
  }).then((stop) => {
    if (generation !== clientResetGeneration()) { stop(); return; }
    liveStarting = false; liveStop = stop;
  }, () => { if (generation === clientResetGeneration()) liveStarting = false; });
}
function resolveViewer(): Promise<NonNullable<typeof viewer>> {
  if (viewer) { startLive(); return Promise.resolve(viewer); }
  const generation = clientResetGeneration();
  resolving ??= Promise.all([getEffectiveRelayUrl(), loadBuzzIdentity()])
    .then(([relay, identity]) => ({ key: `${relay}\u0000${identity?.publicKey ?? ''}`,
      relay, pubkey: identity?.publicKey ?? '' }))
    .catch(() => ({ key: '', relay: '', pubkey: '' }))
    .then((owner) => {
      if (generation === clientResetGeneration()) { viewer = owner; startLive(); notify(); }
      return owner;
    });
  return resolving;
}
function changed(slot: Slot, change: Change): void {
  slot.clock += 1;
  change.at = slot.clock;
  if (slot.reads.size || change.pending) slot.changes.push(change);
}
export function applyNeedsYouLiveDelta(delta: NeedsYouLiveDelta): void {
  const slot = current(delta.workspaceId);
  if (!slot || slot.forgotten) return;
  const apply = (entry: Entry): Entry => entry.needs
    ? { ...entry, needs: needsSlice(entry.needs, delta) } : { ...entry, count: delta.count };
  changed(slot, { at: 0, kind: 'needs', apply });
  write(slot, apply(slot.entry));
}
export function applyBookmarkDelta(delta: BookmarkDelta & { readonly workspaceId: string }): void {
  const slot = current(delta.workspaceId);
  if (!slot || slot.forgotten) return;
  const apply = (entry: Entry): Entry => entry.saved
    ? { ...entry, saved: savedSlice(entry.saved, delta) } : entry;
  changed(slot, { at: 0, kind: 'saved', apply });
  write(slot, apply(slot.entry));
}
export async function loadNeedsYouList(workspaceId: string): Promise<readonly NeedsYouItemView[]> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  const at = ++slot.clock;
  slot.reads.add(at);
  try {
    const result = await monolithPhoneOperation('readNeedsYou', { workspaceId });
    const entry = replay(slot, 'needs', at,
      { ...slot.entry, needs: orderedNeeds([...result.items]), count: null });
    if (active(slot) && at > slot.needsRead) {
      slot.needsRead = at;
      slot.forgotten = false;
      write(slot, entry);
    }
    return entry.needs ?? [];
  } finally { slot.reads.delete(at); trim(slot); }
}
export async function loadSavedList(workspaceId: string, before?: string): Promise<void> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  const at = ++slot.clock;
  slot.reads.add(at);
  try {
    const result = await monolithPhoneOperation('listMessageBookmarks', { workspaceId, ...(before ? { before } : {}) });
    if (!active(slot) || at <= slot.savedRead) return;
    const items: readonly MessageBookmarkView[] = before
      ? [...slot.entry.saved ?? [], ...result.bookmarks.filter((item) =>
        !slot.entry.saved?.some((known) => known.messageId === item.messageId))]
      : [...result.bookmarks];
    const entry = replay(slot, 'saved', at, { ...slot.entry, saved: items, next: result.next });
    slot.savedRead = at;
    slot.forgotten = false;
    write(slot, entry);
  } finally { slot.reads.delete(at); trim(slot); }
}

/** One cold tray response seeds both sections; a held pair costs no request. */
export async function loadTrayList(workspaceId: string, force = false): Promise<{ needsError?: string; savedError?: string }> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  if (!slot.entry.needs) await seed(workspaceId, 'needs-you');
  if (!slot.entry.saved) await seed(workspaceId, 'bookmarks');
  if (!force && !slot.forgotten && slot.entry.needs && slot.entry.saved) return {};
  if (slot.trayRead) return slot.trayRead;
  const at = ++slot.clock;
  slot.reads.add(at);
  const read = monolithPhoneOperation('readTray', { workspaceId }).then((result) => {
    if (!active(slot) || (slot.forgotten && at <= Math.max(slot.needsRead, slot.savedRead))) return {};
    let entry = slot.entry;
    if (result.needs && at > slot.needsRead) {
      entry = replay(slot, 'needs', at,
        { ...entry, needs: orderedNeeds([...result.needs.items]), count: null });
      slot.needsRead = at;
    }
    if (result.saved && at > slot.savedRead) {
      entry = replay(slot, 'saved', at,
        { ...entry, saved: result.saved.bookmarks, next: result.saved.next });
      slot.savedRead = at;
    }
    slot.forgotten = false;
    write(slot, entry);
    return { needsError: result.needsError, savedError: result.savedError };
  }).finally(() => {
    slot.reads.delete(at);
    trim(slot);
    if (slot.trayRead === read) slot.trayRead = undefined;
  });
  slot.trayRead = read;
  return read;
}
async function seed(workspaceId: string, kind: 'needs-you' | 'bookmarks'): Promise<boolean> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  if (!slot.pubkey) return false;
  const at = slot.clock;
  const saved = kind === 'needs-you'
    ? await mobileSurfaceCache.read(address(slot, kind), needsList).catch(() => null)
    : await mobileSurfaceCache.read(address(slot, kind), savedList).catch(() => null);
  if (!saved) return false;
  if (at === slot.clock && active(slot)) {
    if (kind === 'needs-you' && 'items' in saved && !slot.entry.needs)
      write(slot, { ...slot.entry, needs: orderedNeeds([...saved.items]) }, false);
    if (kind === 'bookmarks' && 'bookmarks' in saved && !slot.entry.saved)
      write(slot, { ...slot.entry, saved: saved.bookmarks, next: saved.next }, false);
  }
  return true;
}
export const seedNeedsYouList = (workspaceId: string) => seed(workspaceId, 'needs-you');
export const seedSavedList = (workspaceId: string) => seed(workspaceId, 'bookmarks');
export function forgetTray(workspaceId: string): void {
  const slot = current(workspaceId);
  if (!slot) return;
  slot.forgotten = true;
  slot.needsRead = slot.savedRead = ++slot.clock;
  slot.changes = [];
  write(slot, { ...slot.entry, needs: [], saved: [], count: null, next: undefined }, false);
  if (slot.pubkey) for (const kind of ['needs-you', 'bookmarks'] as const)
    void mobileSurfaceCache.remove(address(slot, kind)).catch(() => undefined);
}
export function updateSavedList(workspaceId: string,
  change: (items: readonly MessageBookmarkView[]) => readonly MessageBookmarkView[], next?: string | null) {
  const slot = current(workspaceId);
  if (!slot || slot.forgotten)
    return { settle: () => undefined, cancel: () => undefined };
  const apply = (entry: Entry): Entry => ({ ...entry, saved: change(entry.saved ?? []),
    next: next === undefined ? entry.next : next ?? undefined });
  const edit: Change = { at: 0, kind: 'saved', apply, pending: true };
  changed(slot, edit);
  write(slot, apply(slot.entry));
  return {
    settle: () => { if (active(slot)) { edit.settled = ++slot.clock; trim(slot); } },
    cancel: () => { if (active(slot)) { slot.clock += 1;
      slot.changes = slot.changes.filter((item) => item !== edit); } },
  };
}
export function removeNeedsYou(workspaceId: string, messageIds: Iterable<string>) {
  const slot = current(workspaceId);
  if (!slot || slot.forgotten)
    return { settle: () => undefined, restore: () => false };
  const ids = new Set(messageIds);
  const original = slot.entry.needs?.filter((item) => ids.has(item.messageId)) ?? [];
  const apply = (entry: Entry): Entry => entry.needs
    ? { ...entry, needs: entry.needs.filter((item) => !ids.has(item.messageId)) } : entry;
  const change: Change = { at: 0, kind: 'needs', apply, pending: true };
  changed(slot, change);
  write(slot, apply(slot.entry));
  let done = false;
  return {
    settle: () => {
      if (done || !active(slot)) return;
      done = true; change.settled = ++slot.clock; trim(slot);
    },
    restore: () => {
      if (done || !active(slot) || slot.forgotten) return false;
      done = true; slot.clock += 1;
      slot.changes = slot.changes.filter((item) => item !== change);
      if (slot.entry.needs) write(slot, { ...slot.entry,
        needs: orderedNeeds([...slot.entry.needs, ...original.filter((item) =>
          !slot.entry.needs?.some((known) => known.messageId === item.messageId))]) });
      return true;
    },
  };
}
export function holdNeedsYou(workspaceId: string, messageIds: readonly string[]): void {
  const slot = current(workspaceId);
  if (slot) write(slot, { ...slot.entry, held: new Set(messageIds) }, false);
}
export function subscribeTrayGap(workspaceId: string, read: (reason: string) => void): () => void {
  const readers = trayReaders.get(workspaceId) ?? new Set<(reason: string) => void>();
  readers.add(read);
  trayReaders.set(workspaceId, readers);
  return () => { readers.delete(read); if (!readers.size) trayReaders.delete(workspaceId); };
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function useEntry(workspaceId: string | null | undefined): Entry {
  useEffect(() => { void resolveViewer(); }, []);
  return useSyncExternalStore(subscribe, () =>
    workspaceId && viewer ? slots.get(`${viewer.key}\u0000${workspaceId}`)?.entry ?? EMPTY : EMPTY);
}
const EMPTY_SAVED: readonly MessageBookmarkView[] = [];
export function useTrayList(workspaceId: string | null | undefined) {
  const entry = useEntry(workspaceId);
  return { needs: entry.needs && entry.held.size
    ? entry.needs.filter((item) => !entry.held.has(item.messageId)) : entry.needs,
    bookmarks: entry.saved ?? EMPTY_SAVED, next: entry.next };
}
export function useNeedsYouCount(workspaceId: string | null | undefined, refreshKey: unknown) {
  const entry = useEntry(workspaceId);
  const generation = useSyncExternalStore(subscribeClientReset, clientResetGeneration);
  const countedFor = useRef<unknown>(undefined);
  useEffect(() => {
    if (!workspaceId || refreshKey === undefined || entry.needs) return;
    if (entry.count !== null && countedFor.current === refreshKey) return;
    countedFor.current = refreshKey;
    let cancelled = false;
    void (async () => {
      const slot = slotFor(await resolveViewer(), workspaceId);
      const at = slot.clock;
      try {
        const request = slot.countRead ??= monolithPhoneOperation('countNeedsYou', { workspaceId })
          .then(({ count }) => ({ count, at })).finally(() => { slot.countRead = undefined; });
        const answer = await request;
        if (!cancelled && !slot.forgotten && slot.clock === answer.at && !slot.entry.needs)
          write(slot, { ...slot.entry, count: answer.count });
      } catch { /* Keep the previous count. */ }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey, entry.needs, entry.count, generation]);
  return entry.needs
    ? entry.needs.filter((item) => !entry.held.has(item.messageId)).length : entry.count ?? 0;
}
