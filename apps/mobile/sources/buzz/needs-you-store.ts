import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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
export const NEEDS_YOU_GAP_REASONS: ReadonlySet<string> =
  new Set(['needs-you-gap', 'reconnect', 'postgres:memberships']);

type Entry = { needs: readonly NeedsYouItemView[] | null; count: number | null;
  saved: readonly MessageBookmarkView[] | null; next?: string; held: ReadonlySet<string> };
/** A read replays changes after its start; unsettled edits remain until the server answers. */
type Change = { at: number; needs?: NeedsYouLiveDelta; bookmark?: BookmarkDelta;
  clear?: ReadonlySet<string>;
  savedEdit?: { apply: (items: readonly MessageBookmarkView[]) => readonly MessageBookmarkView[];
    next?: string | null }; settled?: number };
type Slot = { key: string; relay: string; pubkey: string; workspaceId: string;
  /** One order for both sections, count reads, and local edits. */
  entry: Entry; clock: number; needsRead: number; savedRead: number;
  reads: Set<number>; changes: Change[]; forgotten: Set<string> };
const EMPTY: Entry = { needs: null, count: null, saved: null, held: new Set() };
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
const holders = new Map<string, number>();
const counts = new Map<string, Promise<number>>();
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
    entry: EMPTY, clock: 0, needsRead: 0, savedRead: 0, reads: new Set(), changes: [], forgotten: new Set() };
  if (owner === viewer) slots.set(key, slot);
  return slot;
}
const current = (workspaceId: string) => viewer && slotFor(viewer, workspaceId);
function write(slot: Slot, entry: Entry, persist = true): void {
  if (!active(slot) || entry === slot.entry) return;
  const before = slot.entry;
  slot.entry = entry;
  if (persist && slot.pubkey) {
    if (entry.needs && entry.needs !== before.needs && !slot.forgotten.has('needs-you'))
      void mobileSurfaceCache.write(address(slot, 'needs-you'), { items: [...entry.needs] }, needsList).catch(() => undefined);
    if (entry.saved && !slot.forgotten.has('bookmarks') &&
        (entry.saved !== before.saved || entry.next !== before.next))
      void mobileSurfaceCache.write(address(slot, 'bookmarks'),
        { bookmarks: [...entry.saved], next: entry.next }, savedList).catch(() => undefined);
  }
  notify();
}
function trim(slot: Slot): void {
  const oldest = Math.min(...slot.reads);
  slot.changes = slot.changes.filter((change) =>
    change.clear || change.savedEdit
      ? change.settled === undefined || change.settled > oldest : change.at > oldest);
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
  slots.clear(); counts.clear(); viewer = undefined; resolving = undefined;
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
    else if (signal.type === 'invalidate' && NEEDS_YOU_GAP_REASONS.has(signal.reason)) {
      for (const slot of slots.values()) if (!holders.get(slot.workspaceId)) {
        slot.clock += 1;
        write(slot, { ...slot.entry, needs: null, count: null }, false);
      }
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
  if (slot.reads.size || change.clear || change.savedEdit) slot.changes.push(change);
}
export function applyNeedsYouLiveDelta(delta: NeedsYouLiveDelta): void {
  const slot = current(delta.workspaceId);
  if (!slot || slot.forgotten.has('needs-you')) return;
  changed(slot, { at: 0, needs: delta });
  write(slot, slot.entry.needs
    ? { ...slot.entry, needs: needsSlice(slot.entry.needs, delta) }
    : { ...slot.entry, count: delta.count });
}
export function applyBookmarkDelta(delta: BookmarkDelta & { readonly workspaceId: string }): void {
  const slot = current(delta.workspaceId);
  if (!slot || slot.forgotten.has('bookmarks')) return;
  changed(slot, { at: 0, bookmark: delta });
  if (slot.entry.saved) write(slot, { ...slot.entry, saved: savedSlice(slot.entry.saved, delta) });
}
export async function loadNeedsYouList(workspaceId: string): Promise<readonly NeedsYouItemView[]> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  const at = ++slot.clock;
  slot.reads.add(at);
  try {
    const result = await monolithPhoneOperation('readNeedsYou', { workspaceId });
    let items = orderedNeeds([...result.items]);
    for (const change of slot.changes)
      if (change.needs && change.at > at) items = needsSlice(items, change.needs);
    for (const change of slot.changes)
      if (change.clear && (change.settled ?? Infinity) > at)
        items = items.filter((item) => !change.clear!.has(item.messageId));
    if (active(slot) && at > slot.needsRead) {
      slot.needsRead = at;
      slot.forgotten.delete('needs-you');
      write(slot, { ...slot.entry, needs: items, count: null });
    }
    return items;
  } finally { slot.reads.delete(at); trim(slot); }
}
export async function loadSavedList(workspaceId: string, before?: string): Promise<void> {
  const slot = slotFor(await resolveViewer(), workspaceId);
  const at = ++slot.clock;
  slot.reads.add(at);
  try {
    const result = await monolithPhoneOperation('listMessageBookmarks', { workspaceId, ...(before ? { before } : {}) });
    if (!active(slot) || at <= slot.savedRead) return;
    let items: readonly MessageBookmarkView[] = before
      ? [...slot.entry.saved ?? [], ...result.bookmarks.filter((item) =>
        !slot.entry.saved?.some((known) => known.messageId === item.messageId))]
      : [...result.bookmarks];
    for (const change of slot.changes)
      if (change.bookmark && change.at > at) items = savedSlice(items, change.bookmark);
    let next = result.next;
    for (const change of slot.changes) if (change.savedEdit && (change.settled ?? Infinity) > at) {
      items = change.savedEdit.apply(items);
      if (change.savedEdit.next !== undefined) next = change.savedEdit.next ?? undefined;
    }
    slot.savedRead = at;
    slot.forgotten.delete('bookmarks');
    write(slot, { ...slot.entry, saved: items, next });
  } finally { slot.reads.delete(at); trim(slot); }
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
function forget(workspaceId: string, kind: 'needs-you' | 'bookmarks'): void {
  const slot = current(workspaceId);
  if (!slot) return;
  slot.clock += 1;
  slot.forgotten.add(kind);
  slot.changes = slot.changes.filter((change) => kind === 'needs-you'
    ? !change.needs && !change.clear : !change.bookmark && !change.savedEdit);
  if (kind === 'needs-you') slot.needsRead = slot.clock;
  else slot.savedRead = slot.clock;
  write(slot, kind === 'needs-you' ? { ...slot.entry, needs: [], count: null }
    : { ...slot.entry, saved: [], next: undefined }, false);
  if (slot.pubkey) void mobileSurfaceCache.remove(address(slot, kind)).catch(() => undefined);
}
export const forgetNeedsYouList = (workspaceId: string) => forget(workspaceId, 'needs-you');
export const forgetSavedList = (workspaceId: string) => forget(workspaceId, 'bookmarks');
export function updateSavedList(workspaceId: string,
  change: (items: readonly MessageBookmarkView[]) => readonly MessageBookmarkView[], next?: string | null) {
  const slot = current(workspaceId);
  if (!slot || slot.forgotten.has('bookmarks'))
    return { settle: () => undefined, cancel: () => undefined };
  const edit: Change = { at: 0, savedEdit: { apply: change, next } };
  changed(slot, edit);
  write(slot, { ...slot.entry, saved: change(slot.entry.saved ?? []),
    next: next === undefined ? slot.entry.next : next ?? undefined });
  return {
    settle: () => { if (active(slot)) { edit.settled = ++slot.clock; trim(slot); } },
    cancel: () => { if (active(slot)) { slot.clock += 1;
      slot.changes = slot.changes.filter((item) => item !== edit); } },
  };
}
export function removeNeedsYou(workspaceId: string, messageIds: Iterable<string>) {
  const slot = current(workspaceId);
  if (!slot || slot.forgotten.has('needs-you'))
    return { settle: () => undefined, restore: () => false };
  const ids = new Set(messageIds);
  const original = slot.entry.needs?.filter((item) => ids.has(item.messageId)) ?? [];
  const change: Change = { at: 0, clear: ids };
  changed(slot, change);
  if (slot.entry.needs)
    write(slot, { ...slot.entry, needs: slot.entry.needs.filter((item) => !ids.has(item.messageId)) });
  let done = false;
  return {
    settle: () => {
      if (done || !active(slot)) return;
      done = true; change.settled = ++slot.clock; trim(slot);
    },
    restore: () => {
      if (done || !active(slot) || slot.forgotten.has('needs-you')) return false;
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
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function useEntry(workspaceId: string | null | undefined): Entry {
  useEffect(() => { void resolveViewer(); }, []);
  return useSyncExternalStore(subscribe, () =>
    workspaceId && viewer ? slots.get(`${viewer.key}\u0000${workspaceId}`)?.entry ?? EMPTY : EMPTY);
}
export function useNeedsYouList(workspaceId: string | null | undefined) {
  const entry = useEntry(workspaceId);
  useEffect(() => {
    if (!workspaceId) return;
    holders.set(workspaceId, (holders.get(workspaceId) ?? 0) + 1);
    return () => { const left = (holders.get(workspaceId) ?? 1) - 1;
      if (left) holders.set(workspaceId, left); else holders.delete(workspaceId); };
  }, [workspaceId]);
  return useMemo(() => ({ all: entry.needs,
    items: entry.needs && entry.held.size
      ? entry.needs.filter((item) => !entry.held.has(item.messageId)) : entry.needs }), [entry]);
}
const EMPTY_SAVED: readonly MessageBookmarkView[] = [];
export function useSavedList(workspaceId: string | null | undefined) {
  const entry = useEntry(workspaceId);
  return useMemo(() => ({ bookmarks: entry.saved ?? EMPTY_SAVED, next: entry.next }), [entry]);
}
function countNeedsYou(key: string, workspaceId: string): Promise<number> {
  const pending = counts.get(key);
  if (pending) return pending;
  const request = monolithPhoneOperation('countNeedsYou', { workspaceId })
    .then((result) => result.count)
    .finally(() => { if (counts.get(key) === request) counts.delete(key); });
  counts.set(key, request);
  return request;
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
        const count = await countNeedsYou(slot.key, workspaceId);
        if (!cancelled && slot.clock === at && !slot.entry.needs)
          write(slot, { ...slot.entry, count });
      } catch { /* Keep the previous count. */ }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, refreshKey, entry.needs, entry.count, generation]);
  return entry.needs
    ? entry.needs.filter((item) => !entry.held.has(item.messageId)).length : entry.count ?? 0;
}
