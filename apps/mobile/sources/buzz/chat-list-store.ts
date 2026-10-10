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
  type ChatListDelta,
  type ChatListDeltaContext,
} from './chat-list-delta';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { isDraftFrame } from '@/sync/transport/live-frames';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { sharedLiveConnection } from '@/sync/transport/live-connection';

/**
 * How long the opening Room-list read waits for its live watch to be confirmed.
 * Reading after the confirmation misses nothing, so no second read follows;
 * the stored list paints meanwhile.
 */
export const CHAT_SUBSCRIBE_WAIT_MS = 1_500;
/** Live deltas reach disk at most this often, so an eviction restores the current list. */
const DURABLE_WRITE_DELAY_MS = 1_000;

type Filters = ChatListView['watchFilters'];
type SurfaceEvent = Parameters<Parameters<ReturnType<typeof sharedLiveConnection>['register']>[1]>[0];

export type ChatListSource = {
  readonly chats: () => Promise<ChatListView>;
  readonly subscribe?: (
    filters: Filters,
    listener: (event: SurfaceEvent) => void,
  ) => Promise<() => void>;
  readonly reconnect?: () => void;
  /** Whether a Room is on screen. Defaults to the shared live connection's views. */
  readonly viewing?: (roomId: string) => boolean;
};

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

/**
 * The one client copy of a Workspace's Room list. It owns the live watch on
 * every Room in the list, folds deltas into one value, writes that value
 * through to disk, and makes the covering reads. The deck, the Sidebar, the
 * Room screen and the DM header all read this value.
 */
class ChatListStore {
  private value: ChatListView | null = null;
  private readFromServer = false;
  private readonly listeners = new Set<() => void>();
  private readonly consumers = new Set<ChatListConsumer>();
  private readonly address: SurfaceCacheAddress;
  private readonly scheduler: SurfaceRefreshScheduler<ChatListView>;
  private unsubscribe: (() => void) | undefined;
  private watchKey = '';
  private watchGeneration = 0;
  private closed = false;
  private missed = false;
  private readInFlight = false;
  private deltasDuringRead: ChatListDelta[] = [];
  // Rooms the socket delivered any frame for since the last applied read.
  private readonly heardRooms = new Set<string>();
  private readonly cornerStatusSequence = new Map<string, number>();
  private opened = false;
  private durableTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly deltaContext: ChatListDeltaContext = {
    viewing: (roomId) =>
      this.source.viewing ? this.source.viewing(roomId) : sharedLiveConnection().isViewing(roomId),
  };

  constructor(
    readonly key: ChatListKey,
    private readonly source: ChatListSource,
    private readonly onClosed: () => void,
  ) {
    this.address = surfaceAddress(key.relayUrl, key.viewerPubkey, '/workspace/:id/chats', {
      workspaceId: key.workspaceId,
    });
    // A copy another screen published paints on the first frame.
    this.value = mobileSurfaceCache.peek(this.address, isChatListView);
    this.scheduler = new SurfaceRefreshScheduler({
      fetch: async () => {
        this.deltasDuringRead = [];
        this.readInFlight = true;
        try {
          return await mobileSurfaceCache.fetch(this.address, isChatListView, this.source.chats);
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
    return this.value;
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
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    this.close();
    this.value = null;
    this.notify();
    await mobileSurfaceCache.remove(this.address);
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

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private paint(value: ChatListView): void {
    if (this.closed) return;
    this.value = value;
    mobileSurfaceCache.publish(this.address, value, isChatListView);
    this.notify();
    this.scheduleDurableWrite();
  }

  private scheduleDurableWrite(): void {
    if (this.durableTimer) return;
    this.durableTimer = setTimeout(() => this.flushDurableWrite(), DURABLE_WRITE_DELAY_MS);
  }

  private flushDurableWrite(): void {
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    if (this.value) void mobileSurfaceCache.write(this.address, this.value, isChatListView);
  }

  private applyRead(read: ChatListView): void {
    if (this.closed) return;
    this.missed = false;
    const held = this.value;
    const missedLive =
      this.readFromServer && held !== null && roomsMissedByLive(held, read, this.heardRooms).length > 0;
    this.heardRooms.clear();
    const value = this.deltasDuringRead.reduce(
      (view, delta) => applyChatListDelta(view, delta, this.deltaContext),
      keepUnavailableChatFacts(held, read),
    );
    this.readFromServer = true;
    this.value = value;
    if (this.durableTimer) clearTimeout(this.durableTimer);
    this.durableTimer = undefined;
    void mobileSurfaceCache.write(this.address, value, isChatListView);
    this.notify();
    for (const consumer of this.consumers) consumer.onRead?.();
    if (missedLive) (this.source.reconnect ?? (() => sharedLiveConnection().reconnect()))();
    if (chatWatchFiltersKey(value.watchFilters) !== this.watchKey)
      void this.installWatch(value.watchFilters);
  }

  private async open(): Promise<void> {
    const stored = await mobileSurfaceCache.read(this.address, isChatListView);
    if (this.closed) return;
    // A server read or delta can land before storage answers.
    if (stored && !this.value) {
      this.value = stored;
      this.notify();
    }
    const filters = this.value?.watchFilters ?? [];
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
      return;
    }
    const subscribe = this.source.subscribe ??
      ((next: Filters, listener: (event: SurfaceEvent) => void) =>
        sharedLiveConnection().register(next, listener));
    const stop = await subscribe(filters, (event) => this.onFrame(event));
    previous?.();
    if (this.closed || generation !== this.watchGeneration) {
      stop();
      return;
    }
    this.unsubscribe = stop;
  }

  private onFrame(event: SurfaceEvent): void {
    if (this.closed) return;
    const live = 'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
    if (live && 'roomId' in live) this.heardRooms.add(live.roomId);
    if (live?.type === 'subscribed' && !live.resumed) this.cornerStatusSequence.delete(live.roomId);
    if (live?.type === 'corner-status' && live.sequence !== undefined) {
      if (live.sequence <= (this.cornerStatusSequence.get(live.roomId) ?? -1)) return;
      this.cornerStatusSequence.set(live.roomId, live.sequence);
    }
    if (live?.type === 'message-delta' || live?.type === 'turn-delta' || live?.type === 'corner-status') {
      // Deltas that land while a read is in flight: the read may predate them,
      // and no later read comes to correct it.
      if (this.readInFlight) this.deltasDuringRead.push(live);
      const held = this.value;
      const needsRead = !held || chatListDeltaNeedsRead(held, live);
      if (held) this.paint(applyChatListDelta(held, live, this.deltaContext));
      if (needsRead) this.requestRead();
      return;
    }
    if (isDraftFrame(event)) return;
    // The opening read covers the first subscription; a resumed one replays
    // the lane this live list already folded.
    if (live?.type === 'subscribed' && (live.resumed || !this.opened)) return;
    // A committed-row invalidation announces the delta that follows it.
    if (live?.type === 'invalidate' && live.deliveryId) return;
    this.requestRead();
  }

  private close(): void {
    if (this.closed) return;
    if (this.durableTimer) this.flushDurableWrite();
    this.closed = true;
    this.scheduler.dispose();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.onClosed();
  }
}

const stores = new Map<string, ChatListStore>();

/**
 * Join the Workspace's Room list. The first consumer opens it with its source;
 * later consumers share that store and its one live watch.
 */
export function acquireChatList(
  key: ChatListKey,
  source: ChatListSource,
  consumer: ChatListConsumer,
): ChatListHandle {
  const id = storeKey(key);
  let store = stores.get(id);
  if (!store) {
    const created: ChatListStore = new ChatListStore(key, source, () => {
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

/** Force a read of the live list, if a screen holds it open. */
export function refreshChatList(key: ChatListKey): void {
  stores.get(storeKey(key))?.force();
}

export type UseChatListOptions = {
  /** Defaults to on view whenever the app is in the foreground. */
  readonly visible?: () => boolean;
  readonly onError?: (reason: unknown) => void;
};

/** Read the Workspace's Room list from the shared store. A null key or source holds nothing. */
export function useChatList(
  key: ChatListKey | null,
  source: ChatListSource | null,
  options: UseChatListOptions = {},
): ChatListView | null {
  const [value, setValue] = useState<ChatListView | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const id = key ? storeKey(key) : null;
  const ready = source !== null;
  useEffect(() => {
    if (!key || !sourceRef.current) {
      setValue(null);
      return;
    }
    const handle = acquireChatList(key, sourceRef.current, {
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
  }, [id, ready]);
  return value;
}

/** Test seam: drop every store between cases. */
export function resetChatListStoresForTest(): void {
  stores.clear();
}
