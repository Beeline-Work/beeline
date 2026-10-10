import { useMemo, useSyncExternalStore } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { subscribeClientReset } from '@/sync/client-reset';
import type { RoomViewMessage } from '@beeline/buzz-client';
import type { ConnectorInstallState } from './workbench';

type Snapshot<T> = { data: T | undefined; loading: boolean; error: string | null; installMissing?: boolean; successVersion: number };
type Options<T> = {
  load(): Promise<T>;
  subscribe?: (invalidate: () => void, reconnect: () => void,
    replace: (data: T) => void) => Promise<() => void>;
  missLimit?: number;
};
class InstallMissingError extends Error {}
const resources = new Map<string, Resource<any>>();
const empty: Snapshot<never> = { data: undefined, loading: false, error: null, successVersion: 0 };

/** Shared by key, including when installer and sign-in are mounted together. */
class Resource<T> {
  snapshot: Snapshot<T> = { data: undefined, loading: true, error: null, successVersion: 0 };
  listeners = new Set<() => void>();
  flight = false;
  dirty = false;
  waiters: Array<() => void> = [];
  misses = 0;
  version = 0;
  stop?: () => void;
  constructor(
    readonly key: string,
    public options: Options<T>,
  ) {}
  publish(next: Snapshot<T>) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  replace = (data: T) => {
    if (!this.listeners.size) return;
    this.version += 1;
    this.dirty = false;
    this.publish({ data, loading: false, error: null,
      successVersion: this.snapshot.successVersion + 1 });
  };
  invalidate = () => {
    if (this.snapshot.error || !this.listeners.size) return Promise.resolve();
    this.dirty = true;
    const completed = new Promise<void>((resolve) => this.waiters.push(resolve));
    void this.read();
    return completed;
  };
  retry = () => {
    this.misses = 0;
    this.publish({ ...this.snapshot, error: null, installMissing: false });
    if (!this.stop) this.attach();
    return this.invalidate();
  };
  async read() {
    if (this.flight || !this.listeners.size) return;
    this.flight = true;
    const version = this.version;
    this.dirty = false;
    this.publish({ ...this.snapshot, loading: this.snapshot.data === undefined });
    try {
      const data = await this.options.load();
      if (this.listeners.size && version === this.version) {
        this.misses = 0;
        this.publish({ data, loading: false, error: null, successVersion: this.snapshot.successVersion + 1 });
      }
    } catch (cause) {
      if (this.listeners.size && version === this.version) {
        this.misses += 1;
        this.publish({
          ...this.snapshot,
          loading: false,
          installMissing: cause instanceof InstallMissingError,
          error:
            this.misses >= (this.options.missLimit ?? 1)
              ? String(cause instanceof Error ? cause.message : cause)
              : null,
        });
      }
    } finally {
      this.flight = false;
      if (!this.listeners.size) {
        if (resources.get(this.key) === this) resources.delete(this.key);
      } else if (this.dirty && (!this.snapshot.error || this.options.subscribe)) {
        this.publish({ ...this.snapshot, error: null });
        void this.read();
        return;
      }
      this.waiters.splice(0).forEach((resolve) => resolve());
    }
  }
  attach() {
    if (!this.options.subscribe || !this.listeners.size || this.stop) return;
    let active = true;
    let subscriptionStop: (() => void) | undefined;
    this.stop = () => {
      active = false;
      subscriptionStop?.();
    };
    void Promise.resolve()
      .then(() => (active ? this.options.subscribe?.(this.retry, this.retry, this.replace) : undefined))
      .then((stop) => {
        if (active) subscriptionStop = stop;
        else stop?.();
      })
      .catch((cause) => {
        if (active) {
          this.stop = undefined;
          this.publish({ ...this.snapshot, loading: false, error: String(cause) });
        }
      });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      resources.set(this.key, this);
      this.attach();
      if (!this.flight) this.invalidate();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stop?.();
        this.stop = undefined;
        this.dirty = false;
        if (!this.flight && resources.get(this.key) === this) resources.delete(this.key);
      }
    };
  };
  getSnapshot = () => this.snapshot;
  /** Drop the old account's data at once and read again as the new one. */
  reset() {
    this.version += 1;
    this.misses = 0;
    this.publish({ data: undefined, loading: true, error: null, successVersion: this.snapshot.successVersion });
    void this.invalidate();
  }
}

subscribeClientReset(() => {
  for (const [key, resource] of resources) {
    if (resource.listeners.size) resource.reset();
    else resources.delete(key);
  }
});
const idleSubscribe = () => () => undefined;
const idleSnapshot = () => empty;

export function useObservedResource<T>(key: string | undefined, options: Options<T>) {
  const resource = useMemo(() => {
    if (!key) return undefined;
    let entry = resources.get(key) as Resource<T> | undefined;
    if (!entry) {
      entry = new Resource(key, options);
      resources.set(key, entry);
    }
    return entry;
  }, [key]);
  if (resource) resource.options = options;
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? idleSubscribe,
    resource?.getSnapshot ?? idleSnapshot,
  );
  return { ...snapshot, retry: resource?.retry ?? (() => Promise.resolve()) };
}

/** Workflow runs, gates and their lifecycle move only through system lines and cards. */
export function isSystemOrCardMessage(message: RoomViewMessage): boolean {
  return message.presentation === 'system' || message.presentation === 'card';
}

/**
 * Re-read a Room-derived resource when the Room changes in a way it reads:
 * a committed message `changes` accepts, a change no delta describes, or a
 * socket that reconnected and may have missed either. Prose, tool rows,
 * turn progress and an invalidation whose delta follows read nothing.
 */
export function observeRoomResource(
  roomId: string,
  changes: (message: RoomViewMessage) => boolean = isSystemOrCardMessage,
) {
  return (invalidate: () => void, reconnect: () => void) => {
    let subscribed = false;
    return sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
      if (!('monolithLive' in event)) return;
      const live = event.monolithLive;
      if (!('roomId' in live) || live.roomId !== roomId) return;
      if (live.type === 'subscribed') {
        if (subscribed && !live.resumed) reconnect();
        subscribed = true;
      } else if (live.type === 'message-delta') {
        if (changes(live.message)) invalidate();
      } else if (live.type === 'invalidate' && !live.deliveryId) {
        invalidate();
      }
    });
  };
}

/** Owner-scoped commit notices refresh an install; reconnect covers any missed notice. */
export function useInstallObserver(workspaceId: string, connectorId: string | undefined) {
  return useObservedResource<ConnectorInstallState>(
    connectorId ? `install:${workspaceId}:${connectorId}` : undefined,
    {
      load: async () => {
        const state = await getWorkbenchSource()
          .readInstallState({ workspaceId, connectorId: connectorId! })
          .catch(() => {
            throw new Error('Lost contact while installing — retry to reconnect');
          });
        if (!state) throw new InstallMissingError('Lost track of the install — retry to reconnect');
        return state;
      },
      subscribe: async (invalidate, reconnect) =>
        sharedLiveConnection().register([], (event) => {
          if (!('monolithLive' in event)) return;
          const live = event.monolithLive;
          if (live.type === 'resource-change' && live.resource === 'install' &&
              live.resourceId === connectorId) void invalidate();
          else if (live.type === 'invalidate' && live.roomId === '' &&
              live.reason === 'reconnect') void reconnect();
        }),
    },
  );
}
