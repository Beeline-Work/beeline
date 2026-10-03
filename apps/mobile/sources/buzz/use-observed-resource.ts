import { useMemo, useSyncExternalStore } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import type { ConnectorInstallState } from './workbench';

type Snapshot<T> = { data: T | undefined; loading: boolean; error: string | null; successVersion: number };
type Options<T> = {
  load(): Promise<T>;
  subscribe?: (invalidate: () => void, reconnect: () => void) => Promise<() => void>;
  /** Only resources without a live signal use completion-paced refresh. */
  refreshAfter?: (data: T | undefined) => number | false;
  missLimit?: number;
};
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
  timer?: ReturnType<typeof setTimeout>;
  stop?: () => void;
  constructor(
    readonly key: string,
    public options: Options<T>,
  ) {}
  publish(next: Snapshot<T>) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  invalidate = () => {
    if (this.snapshot.error || !this.listeners.size) return Promise.resolve();
    this.dirty = true;
    const completed = new Promise<void>((resolve) => this.waiters.push(resolve));
    void this.read();
    return completed;
  };
  retry = () => {
    this.misses = 0;
    this.publish({ ...this.snapshot, error: null });
    return this.invalidate();
  };
  async read() {
    if (this.flight || !this.listeners.size) return;
    clearTimeout(this.timer);
    this.flight = true;
    this.dirty = false;
    this.publish({ ...this.snapshot, loading: this.snapshot.data === undefined });
    try {
      const data = await this.options.load();
      if (this.listeners.size) {
        this.misses = 0;
        this.publish({ data, loading: false, error: null, successVersion: this.snapshot.successVersion + 1 });
      }
    } catch (cause) {
      if (this.listeners.size) {
        this.misses += 1;
        this.publish({
          ...this.snapshot,
          loading: false,
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
      } else if (!this.snapshot.error) {
        const delay = this.options.refreshAfter?.(this.snapshot.data);
        if (delay) this.timer = setTimeout(this.invalidate, delay);
      }
      this.waiters.splice(0).forEach((resolve) => resolve());
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      resources.set(this.key, this);
      let active = true;
      let subscriptionStop: (() => void) | undefined;
      this.stop = () => {
        active = false;
        subscriptionStop?.();
      };
      void Promise.resolve()
        .then(() => (active ? this.options.subscribe?.(this.retry, this.retry) : undefined))
        .then((stop) => {
          if (active) subscriptionStop = stop;
          else stop?.();
        })
        .catch((cause) => {
          if (active) this.publish({ ...this.snapshot, loading: false, error: String(cause) });
        });
      if (!this.flight) this.invalidate();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.timer);
        this.stop?.();
        this.dirty = false;
        if (!this.flight && resources.get(this.key) === this) resources.delete(this.key);
      }
    };
  };
  getSnapshot = () => this.snapshot;
}
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

/** Room pushes include hidden workflow/lifecycle cards; poll fallbacks do not invalidate reads. */
export function observeRoomResource(roomId: string) {
  return (invalidate: () => void, reconnect: () => void) => {
    let subscribed = false;
    return sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
      if (!('monolithLive' in event)) return;
      const live = event.monolithLive;
      if (!('roomId' in live) || live.roomId !== roomId) return;
      if (live.type === 'subscribed') {
        if (subscribed) reconnect();
        subscribed = true;
      } else if (
        live.type === 'message-delta' ||
        (live.type === 'invalidate' && live.reason !== 'poll')
      )
        invalidate();
    });
  };
}

/** Install state has no room-scoped invalidation: refresh only after a settled read. */
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
        if (!state) throw new Error('Lost track of the install — retry to reconnect');
        return state;
      },
      missLimit: 8,
      refreshAfter: (state) =>
        state?.connected || state?.steps?.some((step) => step.status === 'failed') ? false : 700,
    },
  );
}
