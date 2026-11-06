import { appErrorCopy } from '@/buzz/app-error-copy';
import { useMemo, useSyncExternalStore } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { subscribeClientReset } from '@/sync/client-reset';
import type { RoomViewAgentTurn, RoomViewMessage } from '@beeline/buzz-client';
import type { ConnectorInstallState } from './workbench';

type Snapshot<T> = { data: T | undefined; loading: boolean; error: string | null; installMissing?: boolean; successVersion: number };
type Options<T> = {
  load(): Promise<T>;
  subscribe?: (invalidate: () => void, refresh: () => void,
    replace: (data: T) => void, recover: () => void) => Promise<() => void>;
  onError?: (cause: unknown) => void;
};
class InstallMissingError extends Error {}
const resources = new Map<string, Resource<any>>();
const empty: Snapshot<never> = { data: undefined, loading: false, error: null, successVersion: 0 };

/** Cache the displayed answer by key; every change calls the same read directly. */
class Resource<T> {
  snapshot: Snapshot<T> = { data: undefined, loading: true, error: null, successVersion: 0 };
  listeners = new Set<() => void>();
  version = 0;
  stop?: () => void;
  constructor(readonly key: string, public options: Options<T>) {}
  publish(next: Snapshot<T>) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  replace = (data: T) => {
    if (!this.listeners.size) return;
    this.version++;
    this.publish({ data, loading: false, error: null, successVersion: this.snapshot.successVersion + 1 });
  };
  read = async () => {
    if (!this.listeners.size) return;
    const version = this.version;
    this.publish({ ...this.snapshot, loading: this.snapshot.data === undefined, error: null });
    try {
      const data = await this.options.load();
      if (this.listeners.size && version === this.version)
        this.publish({ data, loading: false, error: null, successVersion: this.snapshot.successVersion + 1 });
    } catch (cause) {
      if (this.listeners.size && version === this.version) {
        this.options.onError?.(cause);
        this.publish({ ...this.snapshot, loading: false,
          installMissing: cause instanceof InstallMissingError, error: appErrorCopy(cause) });
      }
    }
  };
  retry = async () => { if (!this.stop) this.attach(); await this.read(); };
  recover = this.read;
  attach() {
    if (!this.options.subscribe || !this.listeners.size || this.stop) return;
    let active = true;
    let stop: (() => void) | undefined;
    this.stop = () => { active = false; stop?.(); };
    void this.options.subscribe(this.read, this.read, this.replace, this.read).then(release => {
      if (active) stop = release;
      else release();
    }).catch(cause => {
      if (!active) return;
      this.stop = undefined;
      this.options.onError?.(cause);
      this.publish({ ...this.snapshot, loading: false, error: appErrorCopy(cause) });
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) { resources.set(this.key, this); this.attach(); void this.read(); }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stop?.();
        this.stop = undefined;
        if (resources.get(this.key) === this) resources.delete(this.key);
      }
    };
  };
  getSnapshot = () => this.snapshot;
  reset() {
    this.version++;
    this.publish({ data: undefined, loading: true, error: null, successVersion: this.snapshot.successVersion });
    void this.read();
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
const idleRead = () => Promise.resolve();

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
  return { ...snapshot, retry: resource?.retry ?? idleRead, recover: resource?.recover ?? idleRead };
}

/** Workflow runs, gates and their lifecycle move only through system lines and cards. */
export function isSystemOrCardMessage(message: RoomViewMessage): boolean {
  return message.presentation === 'system' || message.presentation === 'card';
}

/**
 * Re-read a Room-derived resource when the Room changes in a way it reads:
 * a committed message `changes` accepts, a change no delta describes, or a
 * socket that reconnected and may have missed either. Prose, tool rows,
 * turn progress and an invalidation whose delta follows read nothing; the
 * live connection already wrote each committed row to the Room's message
 * records, and `onTurn` hears turn progress without a read.
 */
export function observeRoomResource(
  roomId: string,
  changes: (message: RoomViewMessage) => boolean = isSystemOrCardMessage,
  onTurn?: (turn: RoomViewAgentTurn) => void,
) {
  return (invalidate: () => void, refresh: () => void) => {
    return sharedLiveConnection().register([{ '#h': [roomId] }], (event) => {
      if (!('monolithLive' in event)) return;
      const live = event.monolithLive;
      if (!('roomId' in live) || live.roomId !== roomId) return;
      if (live.type === 'message-delta') {
        if (changes(live.message)) invalidate();
      } else if (live.type === 'turn-delta') {
        onTurn?.(live.turn);
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
      subscribe: async (invalidate, refresh) =>
        sharedLiveConnection().register([], (event) => {
          if (!('monolithLive' in event)) return;
          const live = event.monolithLive;
          if (live.type === 'resource-change' && live.resource === 'install' &&
              live.resourceId === connectorId) void invalidate();
          else if (live.type === 'invalidate' && live.roomId === '' &&
              live.reason === 'reconnect') void refresh();
        }),
    },
  );
}
