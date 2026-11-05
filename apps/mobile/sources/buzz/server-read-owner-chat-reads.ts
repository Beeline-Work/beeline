import { AppState } from 'react-native';

import { isChatListView, type ChatListView, type SurfaceCacheAddress } from '@beeline/buzz-client';

import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';

import { subscribeClientReset } from '@/sync/client-reset';

import { sharedLiveConnection } from '@/sync/transport/live-connection';

import { isDraftFrame } from '@/sync/transport/live-frames';

import { RoomViewClient } from '@/sync/transport/room-view-client';

import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

import { chatWatchFiltersKey, withoutCornerFacts, withCornerFacts, applyChatListDelta, chatListDeltaNeedsRead, keepUnavailableChatFacts } from './chat-list-delta';

import { applyChatListCorners, cornerStoreClock, getRoomCornerSummary } from './room-corner-store';

import { cacheRoomMessageDelta } from './cache-room-message-delta';

import { currentSurfaceStamp } from './surface-clock';

import { markRoomOpen } from './room-open-trace';
import type { ChatListKey, ChatListConsumer, ChatListHandle } from './server-read-owner';



// Existing plain read stores keep the last server answer while the next read runs.
export namespace ChatReads {
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
    private stopWatch?: () => void;
    private watchKey = '';
    private watchGeneration = 0;
    private watched = new Set<string>();
    private reading = false;
    private readStamp = 0;
    private deltasDuringRead: Parameters<typeof applyChatListDelta>[1][] = [];
    private missed = false;
    private confirmedRead = false;
    private closed = false;
    private durableTimer?: ReturnType<typeof setTimeout>;

    constructor(
      readonly key: ChatListKey,
      private readonly onClosed: () => void,
    ) {
      this.address = addressOf(key);
      this.restore(this.current());

      void this.open();
    }

    private async read(): Promise<void> {
      if (this.closed) return;

      this.missed = false;
      this.reading = true;
      this.readStamp = currentSurfaceStamp();
      this.deltasDuringRead = [];
      const cornerClock = cornerStoreClock();

      try {
        const identity = await loadBuzzIdentity();
        if (!identity || identity.publicKey !== this.key.viewerPubkey)
          throw new Error('The signed-in identity changed before the Room list was read.');
        const read = await new RoomViewClient({ baseUrl: this.key.relayUrl, identity }).chats(
          this.key.workspaceId,
        );
        if (!read.unavailable?.includes('corners')) applyChatListCorners(read.chats, cornerClock);

        if (this.closed) return;
        const held = this.current();
        const value = this.deltasDuringRead.reduce(
          (view, delta) => applyChatListDelta(view, delta, deltaContext),
          withoutCornerFacts(keepUnavailableChatFacts(held, read)),
        );
        this.confirmedRead = true;
        mobileSurfaceCache.publish(this.address, value, isChatListView, this.readStamp);
        void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
        for (const consumer of this.consumers) consumer.onRead?.();
        if (chatWatchFiltersKey(value.watchFilters) !== this.watchKey)
          void this.watch(value.watchFilters);
      } catch (reason) {
        if (!this.closed) for (const consumer of this.consumers) consumer.onError?.(reason);
      } finally {
        this.reading = false;
      }
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
      void this.read();
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
        void this.read();
      else this.missed = true;
    }
    private async open(): Promise<void> {
      this.restore(await mobileSurfaceCache.read(this.address, isChatListView));
      if (this.closed) return;
      const filters = this.current()?.watchFilters ?? [];
      await this.watch(filters);
      if (!this.closed) await this.read();
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
      if (live?.type === 'subscribed' || live?.type === 'sync-ok') return;
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
