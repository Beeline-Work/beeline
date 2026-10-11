import { AppState } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import { SurfaceRefreshScheduler, isChatListView, type ChatListView, type SurfaceCacheAddress } from '@beeline/buzz-client';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { subscribeClientReset } from '@/sync/client-reset';
import { isDraftFrame } from '@/sync/transport/live-frames';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { applyChatListDelta, chatListDeltaNeedsRead, chatWatchFiltersKey, keepUnavailableChatFacts, roomsMissedByLive, withCornerFacts, withoutCornerFacts } from './chat-list-delta';
import { applyChatListCorners, cornerStoreClock, getRoomCornerSummary } from './room-corner-store';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { currentSurfaceStamp } from './surface-clock';

export type ChatListKey = { readonly relayUrl: string; readonly viewerPubkey: string; readonly workspaceId: string };
export type ChatListConsumer = { readonly visible: () => boolean; readonly onRead?: () => void; readonly onError?: (reason: unknown) => void };
export interface ChatListHandle {
  current(): ChatListView | null;
  confirmed(): boolean;
  subscribe(listener: () => void): () => void;
  force(): void;
  catchUp(): void;
  release(): void;
  remove(): Promise<void>;
}

type Filters = ChatListView['watchFilters'];
type SurfaceEvent = Parameters<Parameters<ReturnType<typeof sharedLiveConnection>['register']>[1]>[0];
const stores = new Map<string, ChatListStore>();
const idOf = (key: ChatListKey) => JSON.stringify([key.relayUrl, key.viewerPubkey, key.workspaceId]);
const addressOf = (key: ChatListKey): SurfaceCacheAddress => surfaceAddress(key.relayUrl, key.viewerPubkey, '/workspace/:id/chats', { workspaceId: key.workspaceId });
const roomIds = (filters: Filters) => new Set(filters.flatMap((filter) => filter['#h'] ?? []));

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
  private readonly heard = new Set<string>();
  private reading = false;
  private readStamp = 0;
  private deltasDuringRead: Parameters<typeof applyChatListDelta>[1][] = [];
  private missed = false;
  private confirmedRead = false;
  private closed = false;
  private durableTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly key: ChatListKey, private readonly onClosed: () => void) {
    this.address = addressOf(key);
    this.restore(this.current());
    this.scheduler = new SurfaceRefreshScheduler({
      fetch: async () => {
        this.reading = true;
        this.readStamp = currentSurfaceStamp();
        this.deltasDuringRead = [];
        const cornerClock = cornerStoreClock();
        try {
          const identity = await loadBuzzIdentity();
          if (!identity || identity.publicKey !== key.viewerPubkey)
            throw new Error('The signed-in identity changed before the Room list was read.');
          const read = await new RoomViewClient({ baseUrl: key.relayUrl, identity }).chats(key.workspaceId);
          if (!read.unavailable?.includes('corners')) applyChatListCorners(read.chats, cornerClock);
          return read;
        } finally {
          this.reading = false;
        }
      },
      apply: (read) => {
        if (this.closed) return;
        const held = this.current();
        const value = this.deltasDuringRead.reduce((view, delta) => applyChatListDelta(view, delta, {
          viewing: (id) => sharedLiveConnection().isViewing(id),
          openCorners: (id) => getRoomCornerSummary(id)?.openCorners,
        }), withoutCornerFacts(keepUnavailableChatFacts(held, read)));
        const missedLive = this.confirmedRead && held !== null &&
          roomsMissedByLive(held, read, this.heard).length > 0;
        this.confirmedRead = true;
        this.missed = false;
        this.heard.clear();
        this.covered = new Set(this.watched);
        mobileSurfaceCache.publish(this.address, value, isChatListView, this.readStamp);
        void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
        for (const consumer of this.consumers) consumer.onRead?.();
        if (missedLive) sharedLiveConnection().reconnect();
        if (chatWatchFiltersKey(value.watchFilters) !== this.watchKey) void this.watch(value.watchFilters);
      },
      onError: (reason) => {
        if (!this.closed) for (const consumer of this.consumers) consumer.onError?.(reason);
      },
    });
    void this.open();
  }

  current(): ChatListView | null {
    return this.closed ? null : mobileSurfaceCache.peek(this.address, isChatListView);
  }
  confirmed(): boolean { return this.confirmedRead; }
  attach(consumer: ChatListConsumer): void { this.consumers.add(consumer); }
  detach(consumer: ChatListConsumer): void {
    this.consumers.delete(consumer);
    if (!this.consumers.size) this.close();
  }
  subscribe(listener: () => void): () => void {
    const stop = mobileSurfaceCache.subscribe(this.address, listener);
    this.subscriptions.add(stop);
    return () => { stop(); this.subscriptions.delete(stop); };
  }
  force(): void { this.missed = false; this.scheduler.force(); }
  catchUp(): void { if (this.missed) this.force(); }
  async remove(): Promise<void> {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    const removal = mobileSurfaceCache.remove(this.address);
    this.close();
    await removal;
  }
  reset(): void {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    this.close();
  }

  private saved(value: ChatListView): ChatListView {
    return withCornerFacts(value, (roomId) => {
      const summary = getRoomCornerSummary(roomId);
      return summary && { cornerCount: summary.cornerCount, openCorners: summary.openCorners };
    });
  }
  private restore(value: ChatListView | null): void {
    if (!value || !value.chats.some((row) => 'cornerCount' in row || 'openCorners' in row)) return;
    applyChatListCorners(value.chats, -1);
    mobileSurfaceCache.publish(this.address, withoutCornerFacts(value), isChatListView, 0);
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
    if (AppState.currentState !== 'background' && [...this.consumers].some((consumer) => consumer.visible()))
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
    if (!filters.length) { previous?.(); this.stopWatch = undefined; this.watched.clear(); return; }
    const stop = await sharedLiveConnection().register(filters, (event) => this.onFrame(event));
    previous?.();
    if (this.closed || generation !== this.watchGeneration) { stop(); return; }
    this.stopWatch = stop;
    this.watched = roomIds(filters);
  }
  private onFrame(event: SurfaceEvent): void {
    if (this.closed) return;
    const live = 'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
    if (live && 'roomId' in live) this.heard.add(live.roomId);
    if (live?.type === 'message-delta' || live?.type === 'turn-delta' || live?.type === 'corner-status') {
      if (this.reading) this.deltasDuringRead.push(live);
      const held = this.current();
      if (!held) { this.requestRead(); return; }
      const needsRead = chatListDeltaNeedsRead(held, live);
      const next = applyChatListDelta(held, live, {
        viewing: (id) => sharedLiveConnection().isViewing(id),
        openCorners: (id) => getRoomCornerSummary(id)?.openCorners,
      });
      if (next !== held) { mobileSurfaceCache.publish(this.address, next, isChatListView); this.persistSoon(); }
      if (needsRead) this.requestRead();
      return;
    }
    if (isDraftFrame(event) || (live?.type === 'invalidate' && live.deliveryId)) return;
    if (live?.type === 'subscribed' && (!this.confirmedRead || (live.resumed && this.covered.has(live.roomId)))) return;
    this.requestRead();
  }
  private close(): void {
    if (this.closed) return;
    if (this.durableTimer) { clearTimeout(this.durableTimer); this.durableTimer = undefined;
      const value = this.current(); if (value) void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView); }
    this.closed = true;
    this.scheduler.dispose();
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
  const id = idOf(key);
  let store = stores.get(id);
  if (!store) {
    const created = new ChatListStore(key, () => { if (stores.get(id) === created) stores.delete(id); });
    store = created;
    stores.set(id, store);
  }
  const held = store;
  const member = { ...consumer };
  held.attach(member);
  let released = false;
  return {
    current: () => held.current(), confirmed: () => held.confirmed(),
    subscribe: (listener) => held.subscribe(listener), force: () => held.force(), catchUp: () => held.catchUp(),
    release: () => { if (!released) { released = true; held.detach(member); } },
    remove: () => { released = true; return held.remove(); },
  };
}
export function liveChatList(key: ChatListKey): ChatListView | null {
  const store = stores.get(idOf(key));
  return store?.confirmed() ? store.current() : null;
}
export function chatListSnapshot(key: ChatListKey): ChatListView | null {
  return mobileSurfaceCache.peek(addressOf(key), isChatListView);
}
export function refreshChatList(key: ChatListKey): void { stores.get(idOf(key))?.force(); }
export type UseChatListOptions = { readonly visible?: () => boolean; readonly onError?: (reason: unknown) => void };
export function useChatList(key: ChatListKey | null, options: UseChatListOptions = {}): ChatListView | null {
  const [value, setValue] = useState<ChatListView | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const id = key ? idOf(key) : null;
  useEffect(() => {
    if (!key) { setValue(null); return; }
    const handle = acquireChatList(key, {
      visible: () => optionsRef.current.visible?.() ?? true,
      onError: (reason) => optionsRef.current.onError?.(reason),
    });
    setValue(handle.current());
    const stop = handle.subscribe(() => setValue(handle.current()));
    handle.catchUp();
    return () => { stop(); handle.release(); };
  }, [id]);
  return value;
}
export const resetChatListStoresForTest = resetStores;
