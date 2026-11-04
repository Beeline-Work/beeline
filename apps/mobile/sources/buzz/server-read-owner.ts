import { useEffect, useSyncExternalStore, useCallback } from 'react';
import { AppState } from 'react-native';
import {
  SurfaceRefreshScheduler,
  isChatListView,
  type ChatListView,
  type SurfaceCacheAddress,
} from '@beeline/buzz-client';
import { type MessageBookmarkListResult, type MessageBookmarkView, type NeedsYouItemView, type NeedsYouListResult } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { isDraftFrame } from '@/sync/transport/live-frames';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import {
  chatWatchFiltersKey,
  withoutCornerFacts,
  withCornerFacts,
  applyChatListDelta,
  chatListDeltaNeedsRead,
  keepUnavailableChatFacts,
} from './chat-list-delta';
import { applyChatListCorners, cornerStoreClock, getRoomCornerSummary } from './room-corner-store';
import { cacheRoomMessageDelta } from './cache-room-message-delta';
import { currentSurfaceStamp } from './surface-clock';
import { markRoomOpen } from './room-open-trace';

export type ChatListKey = {
  readonly relayUrl: string;
  readonly viewerPubkey: string;
  readonly workspaceId: string;
};
export type ChatListConsumer = {
  readonly visible: () => boolean;
  readonly onRead?: () => void;
  readonly onError?: (reason: unknown) => void;
};
export interface ChatListHandle {
  current(): ChatListView | null;
  confirmed(): boolean;
  subscribe(listener: () => void): () => void;
  force(): void;
  catchUp(): void;
  release(): void;
  remove(): Promise<void>;
}

// Existing plain read stores keep the last server answer while the next read runs.
namespace ChatReads {
  type Filters = ChatListView['watchFilters'];
  type SurfaceEvent = Parameters<
    Parameters<ReturnType<typeof sharedLiveConnection>['register']>[1]
  >[0];
  const stores = new Map<string, ChatListStore>();
  const idOf = (key: ChatListKey) =>
    JSON.stringify([key.relayUrl, key.viewerPubkey, key.workspaceId]);
  const addressOf = (key: ChatListKey): SurfaceCacheAddress =>
    surfaceAddress(key.relayUrl, key.viewerPubkey, '/workspace/:id/chats', {
      workspaceId: key.workspaceId,
    });
  const roomIds = (filters: Filters) => new Set(filters.flatMap((filter) => filter['#h'] ?? []));
  const deltaContext = {
    viewing: (id: string) => sharedLiveConnection().isViewing(id),
    openCorners: (id: string) => getRoomCornerSummary(id)?.openCorners,
  };

  /** One live watch and one registry value for every viewer's Workspace list. */
  class ChatListStore {
    private readonly address: SurfaceCacheAddress;
    private readonly consumers = new Set<ChatListConsumer>();
    private readonly subscriptions = new Set<() => void>();
    private readonly scheduler: SurfaceRefreshScheduler<ChatListView>;
    private stopWatch?: () => void;
    private watchKey = '';
    private watchGeneration = 0;
    private watched = new Set<string>();
    private covered = new Set<string>();
    private reading = false;
    private readStamp = 0;
    private deltasDuringRead: Parameters<typeof applyChatListDelta>[1][] = [];
    private missed = false;
    private confirmedRead = false;
    /** The opening read failed. A later subscribe is a reconnect, not the open. */
    private openingReadFailed = false;
    private closed = false;
    private durableTimer?: ReturnType<typeof setTimeout>;
    private stopConnected?: () => void;

    constructor(
      readonly key: ChatListKey,
      private readonly onClosed: () => void,
    ) {
      this.address = addressOf(key);
      this.restore(this.current());
      this.scheduler = new SurfaceRefreshScheduler({
        fetch: async () => {
          this.missed = false;
          this.reading = true;
          this.readStamp = currentSurfaceStamp();
          this.deltasDuringRead = [];
          const cornerClock = cornerStoreClock();
          try {
            const identity = await loadBuzzIdentity();
            if (!identity || identity.publicKey !== key.viewerPubkey)
              throw new Error('The signed-in identity changed before the Room list was read.');
            const read = await new RoomViewClient({ baseUrl: key.relayUrl, identity }).chats(
              key.workspaceId,
            );
            if (!read.unavailable?.includes('corners'))
              applyChatListCorners(read.chats, cornerClock);
            return read;
          } catch (error) {
            this.openingReadFailed = true;
            throw error;
          } finally {
            this.reading = false;
          }
        },
        apply: (read) => {
          if (this.closed) return;
          const held = this.current();
          const value = this.deltasDuringRead.reduce(
            (view, delta) => applyChatListDelta(view, delta, deltaContext),
            withoutCornerFacts(keepUnavailableChatFacts(held, read)),
          );
          this.openingReadFailed = false;
          this.confirmedRead = true;
          this.covered = new Set(this.watched);
          mobileSurfaceCache.publish(this.address, value, isChatListView, this.readStamp);
          void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
          for (const consumer of this.consumers) consumer.onRead?.();
          if (chatWatchFiltersKey(value.watchFilters) !== this.watchKey)
            void this.watch(value.watchFilters);
        },
        onError: (reason) => {
          if (!this.closed) for (const consumer of this.consumers) consumer.onError?.(reason);
        },
      });
      // Stubs that only register a watch omit this. The real socket always has it.
      this.stopConnected = sharedLiveConnection().subscribeConnected?.(() => {
        if (!this.closed && this.openingReadFailed) this.force();
      });
      void this.open();
    }

    current(): ChatListView | null {
      return this.closed ? null : mobileSurfaceCache.peek(this.address, isChatListView);
    }
    confirmed(): boolean {
      return this.confirmedRead;
    }
    attach(consumer: ChatListConsumer): void {
      this.consumers.add(consumer);
    }
    detach(consumer: ChatListConsumer): void {
      this.consumers.delete(consumer);
      if (!this.consumers.size) this.close();
    }
    subscribe(listener: () => void): () => void {
      const stop = mobileSurfaceCache.subscribe(this.address, listener);
      this.subscriptions.add(stop);
      return () => {
        stop();
        this.subscriptions.delete(stop);
      };
    }
    force(): void {
      this.missed = false;
      this.scheduler.force();
    }
    catchUp(): void {
      if (this.missed) this.force();
    }
    async remove(): Promise<void> {
      const removal = mobileSurfaceCache.remove(this.address);
      this.close(false);
      await removal;
    }
    reset(): void {
      this.close(false);
    }

    private saved(value: ChatListView): ChatListView {
      return withCornerFacts(value, (roomId) => {
        const summary = getRoomCornerSummary(roomId);
        return summary && { cornerCount: summary.cornerCount, openCorners: summary.openCorners };
      });
    }
    private restore(value: ChatListView | null): void {
      if (!value || !value.chats.some((row) => 'cornerCount' in row || 'openCorners' in row))
        return;
      applyChatListCorners(value.chats, -1);
      mobileSurfaceCache.publish(
        this.address,
        withoutCornerFacts(value),
        isChatListView,
        0,
      );
    }
    private persistSoon(): void {
      if (this.durableTimer) return;
      this.durableTimer = setTimeout(() => {
        this.durableTimer = undefined;
        const value = this.current();
        if (value) void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
      }, 1_000);
    }
    private requestRead(): void {
      if (
        AppState.currentState !== 'background' &&
        [...this.consumers].some((consumer) => consumer.visible())
      )
        this.scheduler.signal();
      else this.missed = true;
    }
    private async open(): Promise<void> {
      this.restore(await mobileSurfaceCache.read(this.address, isChatListView));
      if (this.closed) return;
      const filters = this.current()?.watchFilters ?? [];
      await this.watch(filters);
      await sharedLiveConnection().whenSubscribed(filters, 1_500);
      if (!this.closed) await this.scheduler.startAfter(Promise.resolve());
    }
    private async watch(filters: Filters): Promise<void> {
      const generation = ++this.watchGeneration;
      this.watchKey = chatWatchFiltersKey(filters);
      const previous = this.stopWatch;
      if (!filters.length) {
        previous?.();
        this.stopWatch = undefined;
        this.watched.clear();
        return;
      }
      const stop = await sharedLiveConnection().register(filters, (event) => this.onFrame(event));
      previous?.();
      if (this.closed || generation !== this.watchGeneration) {
        stop();
        return;
      }
      this.stopWatch = stop;
      this.watched = roomIds(filters);
    }
    private onFrame(event: SurfaceEvent): void {
      if (this.closed) return;
      const live =
        'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
      if (live?.type === 'room-commands') return;
      if (live?.type === 'sidebar-preview') {
        // A projection cannot establish a complete transcript, including edits
        // and deletions whose missing body is not detectable from the newest id.
        const address = surfaceAddress(
          this.key.relayUrl,
          this.key.viewerPubkey,
          `/room/${live.roomId}`,
        );
        void mobileSurfaceCache.remove(address).catch(() => undefined);
      }
      if (live?.type === 'message-delta') {
        markRoomOpen('list-message-delta', live.message.id);
        const address = surfaceAddress(
          this.key.relayUrl,
          this.key.viewerPubkey,
          `/room/${live.roomId}`,
        );
        cacheRoomMessageDelta(mobileSurfaceCache, address, live);
      }
      if (
        live?.type === 'read-state' ||
        live?.type === 'sidebar-preview' ||
        live?.type === 'message-delta' ||
        live?.type === 'turn-delta' ||
        live?.type === 'corner-status'
      ) {
        if (this.reading) this.deltasDuringRead.push(live);
        const held = this.current();
        if (!held) {
          this.requestRead();
          return;
        }
        const needsRead = chatListDeltaNeedsRead(held, live);
        const next = applyChatListDelta(held, live, deltaContext);
        if (next !== held) {
          mobileSurfaceCache.publish(this.address, next, isChatListView);
          this.persistSoon();
        }
        if (needsRead) this.requestRead();
        return;
      }
      if (
        live?.type === 'presence' ||
        isDraftFrame(event) ||
        (live?.type === 'invalidate' && live.deliveryId)
      )
        return;
      // The opening subscribe arrives before that read finishes. Ignore it.
      // After the read fails, the next subscribe is the reconnect: read again
      // so Retry is not the only way off the error screen.
      if (live?.type === 'subscribed' && !this.confirmedRead && !this.openingReadFailed) return;
      if (live?.type === 'subscribed' && !this.confirmedRead && this.reading) return;
      if (
        live?.type === 'subscribed' &&
        this.confirmedRead &&
        live.resumed &&
        this.covered.has(live.roomId)
      )
        return;
      this.requestRead();
    }
    private close(persist = true): void {
      if (this.closed) return;
      if (this.durableTimer) {
        clearTimeout(this.durableTimer);
        this.durableTimer = undefined;
        const value = this.current();
        if (persist && value)
          void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
      }
      this.closed = true;
      this.scheduler.dispose();
      this.stopConnected?.();
      this.stopWatch?.();
      for (const stop of this.subscriptions) stop();
      this.subscriptions.clear();
      this.onClosed();
    }
  }

  function resetStores(): void {
    mobileSurfaceCache.clear();
    for (const store of [...stores.values()]) store.reset();
    stores.clear();
  }
  subscribeClientReset(resetStores);

  export function acquireChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
    return acquireWireChatList(key, consumer);
  }
  export function liveChatList(key: ChatListKey): ChatListView | null {

    const store = stores.get(idOf(key));
    return store?.confirmed() ? store.current() : null;
  }
  export function chatListSnapshot(key: ChatListKey): ChatListView | null {

    return mobileSurfaceCache.peek(addressOf(key), isChatListView);
  }
  export function refreshChatList(key: ChatListKey): void {
    stores.get(idOf(key))?.force();
  }

  function acquireWireChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
    const id = idOf(key);
    let store = stores.get(id);
    if (!store) {
      const created = new ChatListStore(key, () => {
        if (stores.get(id) === created) stores.delete(id);
      });
      store = created;
      stores.set(id, store);
    }
    const held = store;
    const member = { ...consumer };
    held.attach(member);
    let released = false;
    return {
      current: () => held.current(),
      confirmed: () => held.confirmed(),
      subscribe: (listener) => held.subscribe(listener),
      force: () => held.force(),
      catchUp: () => held.catchUp(),
      release: () => {
        if (!released) {
          released = true;
          held.detach(member);
        }
      },
      remove: () => {
        released = true;
        return held.remove();
      },
    };
  }

  export const reset = resetStores;
}
namespace TrayReads {
  export type NeedsYouLiveDelta = {
    readonly workspaceId: string;
    readonly sourceRoomId: string;
    readonly count: number;
    readonly items: readonly NeedsYouItemView[];
  };
  export type BookmarkDelta = {
    readonly messageId: string;
    readonly bookmark: MessageBookmarkView | null;
  };
  const GAP_REASONS = new Set([
    'needs-you-gap',
    'bookmark-gap',
    'reconnect',
    'postgres:memberships',
  ]);

  type Entry = {
    needs: readonly NeedsYouItemView[] | null;
    saved: readonly MessageBookmarkView[] | null;
    next?: string;
  };
  /** A covering read replays only later committed live changes. */
  type Change = { at: number; kind: 'needs' | 'saved'; apply: (entry: Entry) => Entry };
  type Slot = {
    key: string;
    relay: string;
    pubkey: string;
    workspaceId: string;
    /** One order for both sections, covering reads and committed live changes. */
    entry: Entry;
    clock: number;
    needsRead: number;
    savedRead: number;
    reads: Set<number>;
    changes: Change[];
    projectionRead?: Promise<readonly NeedsYouItemView[]>;
    trayRead?: Promise<{ needsError?: string; savedError?: string }>;
    needsStale?: number;
    forgotten?: boolean;
    seen?: Set<string>;
    seeing?: Set<string>;
  };
  const EMPTY: Entry = { needs: null, saved: null };
  const slots = new Map<string, Slot>();
  const listeners = new Set<() => void>();
  const badgeReaders = new Map<string, number>();
  const trayReaders = new Map<string, Set<(reason: string) => void>>();
  let viewer: { key: string; relay: string; pubkey: string } | undefined;
  let resolving: Promise<NonNullable<typeof viewer>> | undefined;
  let liveStop: (() => void) | undefined;
  let liveStarting = false;
  let revision = 0;
  const notify = () => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };
  const active = (slot: Slot) => slots.get(slot.key) === slot;
  const address = (slot: Slot, kind: 'needs-you' | 'bookmarks') =>
    surfaceAddress(slot.relay, slot.pubkey, `/workspace/:id/${kind}`, {
      workspaceId: slot.workspaceId,
    });
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object';
  const needsList = (value: unknown): value is NeedsYouListResult =>
    record(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item: unknown) =>
        record(item) &&
        typeof item.messageId === 'string' &&
        typeof item.workspaceId === 'string' &&
        typeof item.roomId === 'string' &&
        typeof item.roomName === 'string' &&
        typeof item.text === 'string' &&
        typeof item.createdAt === 'number',
    );
  const savedList = (value: unknown): value is MessageBookmarkListResult =>
    record(value) &&
    (value.next === undefined || typeof value.next === 'string') &&
    Array.isArray(value.bookmarks) &&
    value.bookmarks.every(
      (item: unknown) =>
        record(item) &&
        typeof item.messageId === 'string' &&
        typeof item.workspaceId === 'string' &&
        typeof item.roomId === 'string' &&
        typeof item.roomName === 'string' &&
        typeof item.bookmarkedAt === 'number' &&
        typeof item.available === 'boolean',
    );

  function slotFor(owner: NonNullable<typeof viewer>, workspaceId: string): Slot {
    const key = `${owner.key}\u0000${workspaceId}`;
    const known = slots.get(key);
    if (known && owner === viewer) return known;
    const slot: Slot = {
      key,
      relay: owner.relay,
      pubkey: owner.pubkey,
      workspaceId,
      entry: EMPTY,
      clock: 0,
      needsRead: 0,
      savedRead: 0,
      reads: new Set(),
      changes: [],
    };
    if (owner === viewer) slots.set(key, slot);
    return slot;
  }
  const current = (workspaceId: string) => viewer && slots.get(`${viewer.key}\u0000${workspaceId}`);
  function write(slot: Slot, entry: Entry, persist = true): void {
    if (
      (!active(slot) ||
      entry === slot.entry)
    )
      return;
    const before = slot.entry;
    slot.entry = entry;
    reconcileIntents(slot);
    if (persist && slot.pubkey) {
      if (entry.needs && entry.needs !== before.needs)
        void mobileSurfaceCache
          .write(address(slot, 'needs-you'), { items: [...entry.needs] }, needsList)
          .catch(() => undefined);
      if (entry.saved && (entry.saved !== before.saved || entry.next !== before.next))
        void mobileSurfaceCache
          .write(
            address(slot, 'bookmarks'),
            { bookmarks: [...entry.saved], next: entry.next },
            savedList,
          )
          .catch(() => undefined);
    }
    notify();
  }
  function trim(slot: Slot): void {
    const oldest = Math.min(...slot.reads);
    slot.changes = slot.changes.filter((change) => change.at > oldest);
  }
  function replay(slot: Slot, kind: Change['kind'], at: number, entry: Entry): Entry {
    let next = entry;
    for (const change of slot.changes)
      if (change.kind === kind && change.at > at) next = change.apply(next);
    return next;
  }
  const orderedNeeds = (items: NeedsYouItemView[]) =>
    items.sort(
      (a, b) =>
        Number(!a.approval) - Number(!b.approval) ||
        (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
        a.createdAt - b.createdAt ||
        a.messageId.localeCompare(b.messageId),
    );
  const needsSlice = (items: readonly NeedsYouItemView[], delta: NeedsYouLiveDelta) =>
    orderedNeeds([...items.filter((item) => item.roomId !== delta.sourceRoomId), ...delta.items]);
  const savedSlice = (items: readonly MessageBookmarkView[], delta: BookmarkDelta) =>
    [
      ...items.filter((item) => item.messageId !== delta.messageId),
      ...(delta.bookmark ? [delta.bookmark] : []),
    ].sort((a, b) => b.bookmarkedAt - a.bookmarkedAt || a.messageId.localeCompare(b.messageId));

  subscribeClientReset(() => {
    slots.clear();
    needsIntents.clear();
    savedIntents.clear();
    heldNeeds.clear();
    viewer = undefined;
    resolving = undefined;
    liveStop?.();
    liveStop = undefined;
    liveStarting = false;
    notify();
    if (listeners.size) void resolveViewer();
  });
  function startLive(): void {
    if (liveStop || liveStarting) return;
    liveStarting = true;
    const generation = clientResetGeneration();
    void sharedLiveConnection()
      .register([], (event) => {
        if (generation !== clientResetGeneration()) return;
        if (!('monolithLive' in event)) return;
        const signal = (event as MonolithSurfaceEvent).monolithLive;
        if (signal.type === 'needs-you-delta') applyNeedsYouLiveDelta(signal);
        else if (signal.type === 'bookmark-delta') applyBookmarkDelta(signal);
        else if (signal.type === 'invalidate' && GAP_REASONS.has(signal.reason)) {
          for (const slot of slots.values())
            if (signal.reason !== 'bookmark-gap' && !trayReaders.has(slot.workspaceId)) {
              slot.clock += 1;
              slot.needsStale = slot.clock;
              if (badgeReaders.has(slot.workspaceId) && !slot.forgotten)
                void refreshProjection(slot).catch(() => undefined);
            }
          for (const readers of trayReaders.values())
            for (const read of readers) read(signal.reason);
        }
      })
      .then(
        (stop) => {
          if (generation !== clientResetGeneration()) {
            stop();
            return;
          }
          liveStarting = false;
          liveStop = stop;
        },
        () => {
          if (generation === clientResetGeneration()) liveStarting = false;
        },
      );
  }
  function resolveViewer(): Promise<NonNullable<typeof viewer>> {
    if (viewer) {
      startLive();
      return Promise.resolve(viewer);
    }
    const generation = clientResetGeneration();
    resolving ??= Promise.all([getEffectiveRelayUrl(), loadBuzzIdentity()])
      .then(([relay, identity]) => ({
        key: `${relay}\u0000${identity?.publicKey ?? ''}`,
        relay,
        pubkey: identity?.publicKey ?? '',
      }))
      .catch(() => ({ key: '', relay: '', pubkey: '' }))
      .then((owner) => {
        if (generation === clientResetGeneration()) {
          viewer = owner;
          startLive();
          notify();
        }
        return owner;
      });
    return resolving;
  }
  function changed(slot: Slot, change: Change): void {
    slot.clock += 1;
    change.at = slot.clock;
    if (slot.reads.size) slot.changes.push(change);
  }
  export function applyNeedsYouLiveDelta(delta: NeedsYouLiveDelta): void {
    const slot = current(delta.workspaceId);
    if (!slot || slot.forgotten) return;
    const apply = (entry: Entry): Entry =>
      entry.needs ? { ...entry, needs: needsSlice(entry.needs, delta) } : entry;
    changed(slot, { at: 0, kind: 'needs', apply });
    write(slot, apply(slot.entry));
  }
  export function applyBookmarkDelta(
    delta: BookmarkDelta & { readonly workspaceId: string },
  ): void {
    const slot = current(delta.workspaceId);
    if (!slot || slot.forgotten) return;
    const apply = (entry: Entry): Entry =>
      entry.saved ? { ...entry, saved: savedSlice(entry.saved, delta) } : entry;
    changed(slot, { at: 0, kind: 'saved', apply });
    write(slot, apply(slot.entry));
  }
  export async function loadNeedsYouList(
    workspaceId: string,
  ): Promise<readonly NeedsYouItemView[]> {

    const slot = slotFor(await resolveViewer(), workspaceId);

    const at = ++slot.clock;
    slot.reads.add(at);
    try {
      const result = await monolithPhoneOperation('readNeedsYou', {
        workspaceId,
        markSeen: false,
      });
      if (!needsList(result)) throw new Error('Invalid Needs you response.');
      const entry = replay(slot, 'needs', at, { ...slot.entry, needs: result.items });
      if (active(slot) && at > slot.needsRead) {
        slot.needsRead = at;
        if (at >= (slot.needsStale ?? 0)) slot.needsStale = undefined;
        slot.forgotten = false;
        write(slot, entry);
      }
      return entry.needs ?? [];
    } finally {
      slot.reads.delete(at);
      trim(slot);
    }
  }
  export async function loadSavedList(workspaceId: string, before?: string): Promise<void> {

    const slot = slotFor(await resolveViewer(), workspaceId);

    const at = ++slot.clock;
    slot.reads.add(at);
    try {
      const result = await monolithPhoneOperation('listMessageBookmarks', {
        workspaceId,
        ...(before ? { before } : {}),
      });
      if (!active(slot) || at <= slot.savedRead) return;
      if (!savedList(result)) throw new Error('Invalid Saved response.');
      const items: readonly MessageBookmarkView[] = before
        ? [
            ...(slot.entry.saved ?? []),
            ...result.bookmarks.filter(
              (item) => !slot.entry.saved?.some((known) => known.messageId === item.messageId),
            ),
          ]
        : [...result.bookmarks];
      const entry = replay(slot, 'saved', at, { ...slot.entry, saved: items, next: result.next });
      slot.savedRead = at;
      slot.forgotten = false;
      write(slot, entry);
    } finally {
      slot.reads.delete(at);
      trim(slot);
    }
  }

  /** One cold tray response seeds both sections; a held pair costs no request. */
  export async function loadTrayList(
    workspaceId: string,
    force = false,
  ): Promise<{ needsError?: string; savedError?: string }> {

    const slot = slotFor(await resolveViewer(), workspaceId);
    if (!slot.entry.needs) await seed(workspaceId, 'needs-you');
    if (!slot.entry.saved) await seed(workspaceId, 'bookmarks');

    if (!force && !slot.forgotten && !slot.needsStale && slot.entry.needs && slot.entry.saved)
      return {};
    if (slot.trayRead) return slot.trayRead;
    const at = ++slot.clock;
    slot.reads.add(at);
    const read = monolithPhoneOperation('readTray', { workspaceId, markSeen: false })
      .then((result) => {
        if (!active(slot) || (slot.forgotten && at <= Math.max(slot.needsRead, slot.savedRead)))
          return {};
        if (
          (result.needs && !needsList(result.needs)) ||
          (result.saved && !savedList(result.saved))
        )
          throw new Error('Invalid Tray response.');
        let entry = slot.entry;
        if (result.needs && at > slot.needsRead) {
          entry = replay(slot, 'needs', at, { ...entry, needs: result.needs.items });
          slot.needsRead = at;
          if (at >= (slot.needsStale ?? 0)) slot.needsStale = undefined;
        }
        if (result.saved && at > slot.savedRead) {
          entry = replay(slot, 'saved', at, {
            ...entry,
            saved: result.saved.bookmarks,
            next: result.saved.next,
          });
          slot.savedRead = at;
        }
        slot.forgotten = false;
        write(slot, entry);
        return { needsError: result.needsError, savedError: result.savedError };
      })
      .finally(() => {
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
    const saved =
      kind === 'needs-you'
        ? await mobileSurfaceCache.read(address(slot, kind), needsList).catch(() => null)
        : await mobileSurfaceCache.read(address(slot, kind), savedList).catch(() => null);
    if (!saved) return false;
    if (at === slot.clock && active(slot)) {
      if (kind === 'needs-you' && 'items' in saved && !slot.entry.needs)
        write(slot, { ...slot.entry, needs: saved.items }, false);
      if (kind === 'bookmarks' && 'bookmarks' in saved && !slot.entry.saved)
        write(slot, { ...slot.entry, saved: saved.bookmarks, next: saved.next }, false);
    }
    return true;
  }
  export const seedNeedsYouList = (workspaceId: string) => seed(workspaceId, 'needs-you');
  export function forgetTray(workspaceId: string): void {
    const slot = current(workspaceId);
    if (!slot) return;
    slot.forgotten = true;
    slot.needsStale = undefined;
    slot.needsRead = slot.savedRead = ++slot.clock;
    slot.changes = [];
    write(slot, { ...slot.entry, needs: [], saved: [], next: undefined }, false);
    if (slot.pubkey)
      for (const kind of ['needs-you', 'bookmarks'] as const)
        void mobileSurfaceCache.remove(address(slot, kind)).catch(() => undefined);
  }
  // Pending gestures contain IDs only. They never enter the response journal or disk.
  type HiddenIntent = { ids: Set<string>; settled: boolean };
  const needsIntents = new Map<string, Set<HiddenIntent>>();
  const savedIntents = new Map<string, Set<HiddenIntent>>();
  const heldNeeds = new Map<string, ReadonlySet<string>>();
  function reconcileIntents(slot: Slot): void {
    for (const [kind, map] of [
      ['needs', needsIntents],
      ['saved', savedIntents],
    ] as const) {
      const items = kind === 'needs' ? slot.entry.needs : slot.entry.saved;
      if (!items) continue;
      const present = new Set(items.map((item) => item.messageId));
      for (const intent of map.get(slot.key) ?? []) {
        if (!intent.settled) continue;
        for (const id of intent.ids) if (!present.has(id)) intent.ids.delete(id);
        if (!intent.ids.size) map.get(slot.key)?.delete(intent);
      }
    }
  }
  export function revealSavedItems(workspaceId: string, ids: Iterable<string>): void {
    const slot = current(workspaceId);
    if (!slot) return;
    const revealed = new Set(ids);
    for (const intent of savedIntents.get(slot.key) ?? []) {
      for (const id of revealed) intent.ids.delete(id);
      if (!intent.ids.size) savedIntents.get(slot.key)?.delete(intent);
    }
    notify();
  }
  function hide(slot: Slot | undefined, ids: Iterable<string>, kind: 'needs' | 'saved') {
    if (!slot || slot.forgotten)
      return { settle: () => {}, cancel: () => false, restore: () => false };
    const map = kind === 'needs' ? needsIntents : savedIntents;
    const intents = map.get(slot.key) ?? new Set<HiddenIntent>();
    const intent = { ids: new Set(ids), settled: false };
    intents.add(intent);
    map.set(slot.key, intents);
    notify();
    let done = false;
    const cancel = () => {
      if (done || !active(slot)) return false;
      done = true;
      intents.delete(intent);
      notify();
      return true;
    };
    return {
      // Success confirms the intent, not a fabricated DTO. Keep it hidden until
      // a committed read/delta proves the server removed the row.
      settle: () => {
        if (done || intent.settled || !active(slot) || slot.forgotten) return;
        intent.settled = true;
        reconcileIntents(slot);
        notify();
        void (
          kind === 'needs' ? loadNeedsYouList(slot.workspaceId) : loadSavedList(slot.workspaceId)
        ).catch(() => undefined);
      },
      cancel,
      restore: cancel,
    };
  }
  export function hideSavedItems(workspaceId: string, messageIds: Iterable<string>) {
    return hide(current(workspaceId), messageIds, 'saved');
  }
  export function removeNeedsYou(workspaceId: string, messageIds: Iterable<string>) {
    return hide(current(workspaceId), messageIds, 'needs');
  }
  export function holdNeedsYou(workspaceId: string, messageIds: readonly string[]): void {
    const slot = current(workspaceId);
    if (slot) {
      heldNeeds.set(slot.key, new Set(messageIds));
      notify();
    }
  }
  function hidden(slot: Slot | undefined, kind: 'needs' | 'saved'): ReadonlySet<string> {
    const ids = new Set<string>(kind === 'needs' && slot ? heldNeeds.get(slot.key) : []);
    if (slot)
      for (const intent of (kind === 'needs' ? needsIntents : savedIntents).get(slot.key) ?? [])
        for (const id of intent.ids) ids.add(id);
    return ids;
  }
  export function subscribeTrayGap(
    workspaceId: string,
    read: (reason: string) => void,
  ): () => void {

    const readers = trayReaders.get(workspaceId) ?? new Set<(reason: string) => void>();
    readers.add(read);
    trayReaders.set(workspaceId, readers);
    return () => {
      readers.delete(read);
      if (!readers.size) trayReaders.delete(workspaceId);
    };
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function useEntry(workspaceId: string | null | undefined, enabled = true): Entry {
    useEffect(() => {
      if (enabled) void resolveViewer();
    }, [enabled]);
    const observe = useCallback(
      (listener: () => void) => (enabled ? subscribe(listener) : () => {}),
      [enabled],
    );
    useSyncExternalStore(observe, () => revision);
    return enabled && workspaceId ? (current(workspaceId)?.entry ?? EMPTY) : EMPTY;
  }
  const EMPTY_SAVED: readonly MessageBookmarkView[] = [];
  const visibleNeeds = (entry: Entry, workspaceId: string) => {
    const ids = hidden(current(workspaceId), 'needs');
    return ids.size
      ? (entry.needs?.filter((item) => !ids.has(item.messageId)) ?? null)
      : entry.needs;
  };
  export function useTrayList(workspaceId: string | null | undefined, enabled = true) {
    const entry = useEntry(workspaceId, (enabled));
    const ids = hidden(workspaceId ? current(workspaceId) : undefined, 'saved');
    return {
      needs: workspaceId ? visibleNeeds(entry, workspaceId) : null,
      bookmarks: ids.size
        ? (entry.saved?.filter((item) => !ids.has(item.messageId)) ?? EMPTY_SAVED)
        : (entry.saved ?? EMPTY_SAVED),
      next: entry.next,
    };
  }
  function refreshProjection(slot: Slot): Promise<readonly NeedsYouItemView[]> {
    return (slot.projectionRead ??= loadNeedsYouList(slot.workspaceId).then(
      (items) => {
        slot.projectionRead = undefined;
        // A second gap during the read needs a newer read, still without blanking.
        if (
          active(slot) &&
          !slot.forgotten &&
          slot.needsStale &&
          badgeReaders.has(slot.workspaceId)
        )
          return refreshProjection(slot);
        return items;
      },
      (error) => {
        slot.projectionRead = undefined;
        throw error;
      },
    ));
  }
  export function useNeedsYouCount(
    workspaceId: string | null | undefined,
    refreshKey: unknown,
    visible?: () => boolean,
  ) {
    const subscribeCount = useCallback((listener: () => void) =>
      workspaceId && refreshKey !== undefined ? subscribe(listener) : () => {},
    [workspaceId, refreshKey === undefined]);
    const snapshot = useCallback(() => {
      if (!workspaceId) return 0;
      const entry = current(workspaceId)?.entry;
      return entry ? (visibleNeeds(entry, workspaceId)?.length ?? 0) : 0;
    }, [workspaceId]);
    const count = useSyncExternalStore(subscribeCount, snapshot, () => 0);
    const generation = useSyncExternalStore(subscribeClientReset, clientResetGeneration);
    useEffect(() => { void resolveViewer(); }, []);
    useEffect(() => {
      if (!workspaceId || refreshKey === undefined) return;
      badgeReaders.set(workspaceId, (badgeReaders.get(workspaceId) ?? 0) + 1);
      return () => {
        const remaining = (badgeReaders.get(workspaceId) ?? 1) - 1;
        if (remaining) badgeReaders.set(workspaceId, remaining);
        else badgeReaders.delete(workspaceId);
      };
    }, [workspaceId, refreshKey]);
    useEffect(() => {
      if (!workspaceId || refreshKey === undefined || visible && !visible()) return;
      let cancelled = false;
      void (async () => {
        const slot = slotFor(await resolveViewer(), workspaceId);
        if (cancelled || !active(slot) || (slot.entry.needs && !slot.needsStale)) return;
        try { await refreshProjection(slot); } catch { /* Keep the cached count. */ }
      })();
      return () => { cancelled = true; };
    }, [workspaceId, refreshKey, count, generation]);
    return count;
  }

  /** Called only for viewable question cells in the focused Tray, after paint. */
  export async function acknowledgePaintedNeedsYou(
    workspaceId: string,
    messageIds: readonly string[],
  ): Promise<void> {

    const slot = current(workspaceId);
    if (!slot || slot.forgotten) return;
    const ids = [...new Set(messageIds)].filter(
      (id) =>
        !slot.seen?.has(id) &&
        !slot.seeing?.has(id) &&
        slot.entry.needs?.some(
          (item) => item.messageId === id && !item.approval && item.expiresAt === undefined,
        ),
    );
    if (!ids.length) return;
    slot.seeing ??= new Set();
    ids.forEach((id) => slot.seeing!.add(id));
    try {
      const { seen } = await monolithPhoneOperation('markNeedsYouSeen', {
        workspaceId,
        messageIds: ids,
      });
      if (!active(slot) || slot.forgotten) return;
      slot.seen ??= new Set();
      seen.forEach((item) => slot.seen!.add(item.messageId));
      const expiry = new Map(seen.map((item) => [item.messageId, item.expiresAt]));
      const apply = (entry: Entry): Entry => ({
        ...entry,
        needs:
          entry.needs?.map((item) =>
            expiry.has(item.messageId) ? { ...item, expiresAt: expiry.get(item.messageId)! } : item,
          ) ?? null,
      });
      changed(slot, { at: 0, kind: 'needs', apply });
      write(slot, apply(slot.entry));
    } finally {
      ids.forEach((id) => slot.seeing?.delete(id));
    }
  }
}

export const acquireChatList = ChatReads.acquireChatList;
export const liveChatList = ChatReads.liveChatList;
export const chatListSnapshot = ChatReads.chatListSnapshot;
export const refreshChatList = ChatReads.refreshChatList;
export const resetChatListStoresForTest = ChatReads.reset;
export const loadNeedsYouList = TrayReads.loadNeedsYouList;
export const loadSavedList = TrayReads.loadSavedList;
export const loadTrayList = TrayReads.loadTrayList;
export const seedNeedsYouList = TrayReads.seedNeedsYouList;
export const forgetTray = TrayReads.forgetTray;
export const removeNeedsYou = TrayReads.removeNeedsYou;
export const holdNeedsYou = TrayReads.holdNeedsYou;
export const subscribeTrayGap = TrayReads.subscribeTrayGap;
export const useTrayList = TrayReads.useTrayList;
export const useNeedsYouCount = TrayReads.useNeedsYouCount;
export const acknowledgePaintedNeedsYou = TrayReads.acknowledgePaintedNeedsYou;
export const hideSavedItems = TrayReads.hideSavedItems;
export const revealSavedItems = TrayReads.revealSavedItems;

/** Existing Forward gesture only. All other consumers attach observations. */
export function readChatList(key: ChatListKey): Promise<ChatListView> {

  return new Promise((resolve, reject) => {
    let handle: ChatListHandle | undefined;
    let stop: (() => void) | undefined;
    const finish = () => {
      const value = handle?.current();
      if (!value || !handle?.confirmed()) return;
      stop?.();
      handle.release();
      resolve(value);
    };
    handle = acquireChatList(key, {
      visible: () => true,
      onRead: finish,
      onError: (reason) => {
        stop?.();
        handle?.release();
        reject(reason);
      },
    });
    stop = handle.subscribe(finish);
    finish();
  });
}
