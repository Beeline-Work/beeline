import { AppState } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import {
  SurfaceRefreshScheduler,
  isChatListView,
  type ChatListView,
  type SurfaceCacheAddress,
} from '@beeline/buzz-client';
import {
  applyChatListDelta,
  chatListDeltaNeedsRead,
  chatWatchFiltersKey,
  keepUnavailableChatFacts,
  roomsMissedByLive,
  withCornerFacts,
  withoutCornerFacts,
  type ChatListDelta,
  type ChatListDeltaContext,
} from './chat-list-delta';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { currentSurfaceStamp } from './surface-clock';
import { isDraftFrame } from '@/sync/transport/live-frames';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import {
  applyChatListCorners,
  cornerStoreClock,
  getRoomCornerSummary,
} from './room-corner-store';
import { subscribeClientReset } from '@/sync/client-reset';

/**
 * How long the opening Room-list read waits for its live watch to be confirmed.
 * Reading after the confirmation misses nothing, so no second read follows;
 * the stored list paints meanwhile.
 */
const CHAT_SUBSCRIBE_WAIT_MS = 1_500;
/** Live deltas reach disk at most this often, so an eviction restores the current list. */
const DURABLE_WRITE_DELAY_MS = 1_000;

type Filters = ChatListView['watchFilters'];
type SurfaceEvent = Parameters<Parameters<ReturnType<typeof sharedLiveConnection>['register']>[1]>[0];

export type ChatListConsumer = {
  /** Whether this screen is on view; a store with no visible consumer reads nothing. */
  readonly visible: () => boolean;
  /** Fires after every covering read is applied. */
  readonly onRead?: () => void;
  readonly onError?: (reason: unknown) => void;
};

export type ChatListKey = {
  readonly relayUrl: string;
  readonly viewerPubkey: string;
  readonly workspaceId: string;
};

export interface ChatListHandle {
  current(): ChatListView | null;
  /** True once a server read has been applied while this store was live. */
  confirmed(): boolean;
  subscribe(listener: () => void): () => void;
  /** Read now, coalesced with any read in flight. */
  force(): void;
  /** Read once if a hidden period skipped a read. */
  catchUp(): void;
  release(): void;
  /** The Workspace is gone: drop the list from memory and disk. */
  remove(): Promise<void>;
}

function foreground(): boolean {
  return AppState.currentState !== 'background';
}

function storeKey(key: ChatListKey): string {
  return JSON.stringify([key.relayUrl, key.viewerPubkey, key.workspaceId]);
}

function chatListAddress(key: ChatListKey): SurfaceCacheAddress {
  return surfaceAddress(key.relayUrl, key.viewerPubkey, '/workspace/:id/chats', {
    workspaceId: key.workspaceId,
  });
}

function watchedRoomIds(filters: Filters): Set<string> {
  return new Set(filters.flatMap((filter) => filter['#h'] ?? []));
}

/**
 * The one client copy of a Workspace's Room list. It owns the live watch on
 * every Room in the list, folds deltas into one value, writes that value
 * through to disk, and makes the covering reads. The deck, the Sidebar, the
 * Room screen and the DM header all read this value. Each row's corner facts
 * go to the corner store, which owns them; only the saved copy carries them.
 */
class ChatListStore {
  private readFromServer = false;
  private readonly consumers = new Set<ChatListConsumer>();
  private readonly subscriptions = new Set<() => void>();
  private readonly address: SurfaceCacheAddress;
  private readonly scheduler: SurfaceRefreshScheduler<ChatListView>;
  private unsubscribe: (() => void) | undefined;
  private watchKey = '';
  private watchGeneration = 0;
  private closed = false;
  private missed = false;
  private readInFlight = false;
  /** The corner store clock when the running read started. */
  private readClock = 0;
  private readStamp = 0;
  private deltasDuringRead: ChatListDelta[] = [];
  // Rooms the installed watch covers. A read sees every delta for these.
  private watchedRooms = new Set<string>();
  private readWatchedRooms = new Set<string>();
  // Rooms whose deltas the last applied read either covers or replayed.
  private coveredRooms = new Set<string>();
  // Rooms the socket delivered any frame for since the last applied read.
  private readonly heardRooms = new Set<string>();
  private opened = false;
  private durableTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly deltaContext: ChatListDeltaContext = {
    viewing: (roomId) => sharedLiveConnection().isViewing(roomId),
    openCorners: (roomId) => getRoomCornerSummary(roomId)?.openCorners,
  };

  constructor(
    readonly key: ChatListKey,
    private readonly onClosed: () => void,
  ) {
    this.address = chatListAddress(key);
    // A copy another screen published paints on the first frame.
    this.restored(mobileSurfaceCache.peek(this.address, isChatListView));
    this.scheduler = new SurfaceRefreshScheduler({
      fetch: async () => {
        this.deltasDuringRead = [];
        this.readInFlight = true;
        this.readClock = cornerStoreClock();
        this.readStamp = currentSurfaceStamp();
        this.readWatchedRooms = new Set(this.watchedRooms);
        try {
          // The raw read is never published: only applyRead's reconciled value
          // reaches memory and disk.
          const identity = await loadBuzzIdentity();
          if (!identity || identity.publicKey !== key.viewerPubkey)
            throw new Error('The signed-in identity changed before the Room list was read.');
          return await new RoomViewClient({ baseUrl: key.relayUrl, identity }).chats(key.workspaceId);
        } finally {
          this.readInFlight = false;
        }
      },
      apply: (read) => this.applyRead(read),
      onError: (reason) => {
        if (this.closed) return;
        for (const consumer of this.consumers) consumer.onError?.(reason);
      },
    });
    void this.open();
  }

  current(): ChatListView | null {
    return this.closed ? null : mobileSurfaceCache.peek(this.address, isChatListView);
  }

  confirmed(): boolean {
    return this.readFromServer;
  }

  attach(consumer: ChatListConsumer): void {
    this.consumers.add(consumer);
  }

  detach(consumer: ChatListConsumer): void {
    this.consumers.delete(consumer);
    if (this.consumers.size === 0) this.close();
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
    if (!this.missed) return;
    this.force();
  }

  async remove(): Promise<void> {
    // The pending live write must not land after the removal.
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    const removal = mobileSurfaceCache.remove(this.address);
    this.close();
    await removal;
  }

  /** The account changed: drop the list and its watch, and write nothing to disk. */
  reset(): void {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    this.close();
    this.readFromServer = false;
  }

  private visible(): boolean {
    if (!foreground()) return false;
    for (const consumer of this.consumers) if (consumer.visible()) return true;
    return false;
  }

  /** A change the list must read for: now when on view, else on return. */
  private requestRead(): void {
    if (this.visible()) this.scheduler.signal();
    else this.missed = true;
  }

  private paint(value: ChatListView): void {
    if (this.closed) return;
    mobileSurfaceCache.publish(this.address, value, isChatListView);
    this.scheduleDurableWrite();
  }

  private scheduleDurableWrite(): void {
    if (this.durableTimer) return;
    this.durableTimer = setTimeout(() => this.flushDurableWrite(), DURABLE_WRITE_DELAY_MS);
  }

  private flushDurableWrite(): void {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    const value = this.current();
    if (value) void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
  }

  /** A saved copy hands its corner facts to the corner store, never over a newer summary. */
  private restored(saved: ChatListView | null): void {
    if (!saved || !saved.chats.some((item) => 'cornerCount' in item || 'openCorners' in item)) return;
    applyChatListCorners(saved.chats, -1);
    mobileSurfaceCache.publish(this.address, withoutCornerFacts(saved), isChatListView, 0);
  }

  /** The saved copy carries each Room's corner summary, so a cold start paints it. */
  private saved(value: ChatListView): ChatListView {
    return withCornerFacts(value, (roomId) => {
      const summary = getRoomCornerSummary(roomId);
      return summary && { cornerCount: summary.cornerCount, openCorners: summary.openCorners };
    });
  }

  private applyRead(read: ChatListView): void {
    if (this.closed) return;
    this.missed = false;
    const held = this.current();
    const missedLive =
      this.readFromServer && held !== null && roomsMissedByLive(held, read, this.heardRooms).length > 0;
    this.heardRooms.clear();
    this.coveredRooms = this.readWatchedRooms;
    if (!read.unavailable?.includes('corners')) applyChatListCorners(read.chats, this.readClock);
    const value = this.deltasDuringRead.reduce(
      (view, delta) => applyChatListDelta(view, delta, this.deltaContext),
      withoutCornerFacts(keepUnavailableChatFacts(held, read)),
    );
    this.readFromServer = true;
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    mobileSurfaceCache.publish(this.address, value, isChatListView, this.readStamp);
    void mobileSurfaceCache.persist(this.address, this.saved(value), isChatListView);
    for (const consumer of this.consumers) consumer.onRead?.();
    if (missedLive) sharedLiveConnection().reconnect();
    if (chatWatchFiltersKey(value.watchFilters) !== this.watchKey)
      void this.installWatch(value.watchFilters);
  }

  private async open(): Promise<void> {
    const stored = await mobileSurfaceCache.read(this.address, isChatListView);
    if (this.closed) return;
    // A server read or delta can land before storage answers.
    this.restored(stored);
    const filters = this.current()?.watchFilters ?? [];
    await this.installWatch(filters);
    await sharedLiveConnection().whenSubscribed(filters, CHAT_SUBSCRIBE_WAIT_MS);
    if (this.closed) return;
    this.opened = true;
    // A resumed lane proves the lane is continuous, not that a stored copy is
    // current: every open makes one covering read.
    await this.scheduler.startAfter(Promise.resolve());
  }

  private async installWatch(filters: Filters): Promise<void> {
    const generation = ++this.watchGeneration;
    this.watchKey = chatWatchFiltersKey(filters);
    // The previous watch stays live until its replacement is installed, so a
    // frame for a Room in both sets is never dropped in between.
    const previous = this.unsubscribe;
    this.unsubscribe = undefined;
    // A cold list without Room ids must not subscribe the Workspace UUID as
    // #h — canReadRoom refuses it and live invalidation never lands.
    if (filters.length === 0) {
      previous?.();
      this.watchedRooms = new Set();
      return;
    }
    const stop = await sharedLiveConnection().register(filters, (event) => this.onFrame(event));
    previous?.();
    if (this.closed || generation !== this.watchGeneration) {
      stop();
      return;
    }
    this.unsubscribe = stop;
    this.watchedRooms = watchedRoomIds(filters);
  }

  /** Whether a read applied or in flight saw every delta for this Room. */
  private covered(roomId: string): boolean {
    return this.coveredRooms.has(roomId) || (this.readInFlight && this.readWatchedRooms.has(roomId));
  }

  private onFrame(event: SurfaceEvent): void {
    if (this.closed) return;
    const live = 'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
    if (live && 'roomId' in live) this.heardRooms.add(live.roomId);
    if (live?.type === 'message-delta' || live?.type === 'turn-delta' || live?.type === 'corner-status') {
      // Deltas that land while a read is in flight: the read may predate them,
      // and no later read comes to correct it.
      if (this.readInFlight) this.deltasDuringRead.push(live);
      const held = this.current();
      const needsRead = !held || chatListDeltaNeedsRead(held, live);
      if (held) this.paint(applyChatListDelta(held, live, this.deltaContext));
      if (needsRead) this.requestRead();
      return;
    }
    if (isDraftFrame(event)) return;
    // The opening read covers the first subscription. A resumed lane replays
    // only what this list already folded, and only for a Room a read covered:
    // a Room the watch gained after its read missed the deltas in between.
    if (live?.type === 'subscribed' && (!this.opened || (live.resumed && this.covered(live.roomId))))
      return;
    // A committed-row invalidation announces the delta that follows it.
    if (live?.type === 'invalidate' && live.deliveryId) return;
    this.requestRead();
  }

  private close(): void {
    if (this.closed) return;
    if (this.durableTimer) this.flushDurableWrite();
    this.closed = true;
    this.scheduler.dispose();
    for (const stop of this.subscriptions) stop();
    this.subscriptions.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.onClosed();
  }
}

const stores = new Map<string, ChatListStore>();

function resetChatListStores(): void {
  mobileSurfaceCache.clear();
  for (const store of [...stores.values()]) store.reset();
  stores.clear();
}

subscribeClientReset(resetChatListStores);

/**
 * Join the Workspace's Room list. The first consumer opens it; later
 * consumers share that store and its one live watch.
 */
export function acquireChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
  const id = storeKey(key);
  let store = stores.get(id);
  if (!store) {
    const created: ChatListStore = new ChatListStore(key, () => {
      if (stores.get(id) === created) stores.delete(id);
    });
    store = created;
    stores.set(id, store);
  }
  const held = store;
  // Each join is its own member, even when two screens pass the same consumer.
  const member: ChatListConsumer = {
    visible: () => consumer.visible(),
    onRead: () => consumer.onRead?.(),
    onError: (reason) => consumer.onError?.(reason),
  };
  held.attach(member);
  let released = false;
  return {
    current: () => held.current(),
    confirmed: () => held.confirmed(),
    subscribe: (listener) => held.subscribe(listener),
    force: () => held.force(),
    catchUp: () => held.catchUp(),
    release: () => {
      if (released) return;
      released = true;
      held.detach(member);
    },
    remove: () => {
      released = true;
      return held.remove();
    },
  };
}

/** The live list's current value, or null when no screen holds it open. */
export function liveChatList(key: ChatListKey): ChatListView | null {
  const store = stores.get(storeKey(key));
  return store?.confirmed() ? store.current() : null;
}

/**
 * The list a screen may paint for a Workspace it does not hold open: the open
 * store's value, else the copy that store last published this session.
 */
export function chatListSnapshot(key: ChatListKey): ChatListView | null {
  return mobileSurfaceCache.peek(chatListAddress(key), isChatListView);
}

/** Force a read of the live list, if a screen holds it open. */
export function refreshChatList(key: ChatListKey): void {
  stores.get(storeKey(key))?.force();
}

export type UseChatListOptions = {
  /** Defaults to on view whenever the app is in the foreground. */
  readonly visible?: () => boolean;
  readonly onError?: (reason: unknown) => void;
};

/** Read the Workspace's Room list from the shared store. A null key holds nothing. */
export function useChatList(
  key: ChatListKey | null,
  options: UseChatListOptions = {},
): ChatListView | null {
  const [value, setValue] = useState<ChatListView | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const id = key ? storeKey(key) : null;
  useEffect(() => {
    if (!key) {
      setValue(null);
      return;
    }
    const handle = acquireChatList(key, {
      visible: () => optionsRef.current.visible?.() ?? true,
      onError: (reason) => optionsRef.current.onError?.(reason),
    });
    setValue(handle.current());
    const stop = handle.subscribe(() => setValue(handle.current()));
    handle.catchUp();
    return () => {
      stop();
      handle.release();
    };
    // The key's fields are its identity; `id` carries them.
  }, [id]);
  return value;
}

/** Test seam: close and drop every store between cases. */
export const resetChatListStoresForTest = resetChatListStores;
