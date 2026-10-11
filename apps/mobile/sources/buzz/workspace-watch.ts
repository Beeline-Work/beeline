import { isWorkspaceView, type Identity, type WorkspaceView } from '@beeline/buzz-client';
import { BuzzRigTransport } from '@/sync/transport';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { workspaceRecordScope } from './workspace-records';

type Listener = { signal: () => void; error?: (reason: unknown) => void };

type Watch = {
  readonly listeners: Set<Listener>;
  /** Room ids each reader needs signals from, such as its grants' Rooms. */
  readonly rooms: Map<Listener, readonly string[]>;
  listen: () => void;
  subscribed: string;
  change: Promise<void>;
  release?: () => void;
  globalRelease?: () => void;
  stopEntry: () => void;
  closed: boolean;
};

const watches = new Map<string, Watch>();

/**
 * One watch per Workspace for mounted roster readers (Members and profiles).
 * Room filters cover grants and other Room activity; an empty filter hears
 * identity-wide membership invalidations and socket reconnects. Every signal
 * makes each reader refresh what it shows. A Workspace id is not a Room id.
 */
export function watchWorkspace(
  identity: Identity,
  relayUrl: string,
  workspaceId: string,
  signal: () => void,
  error?: (reason: unknown) => void,
): { ready: Promise<void>; release: () => void; rooms: (roomIds: readonly string[]) => void } {
  const key = workspaceRecordScope(relayUrl, identity.publicKey, workspaceId);
  let watch = watches.get(key);
  if (!watch) watch = openWatch(key, identity, relayUrl, workspaceId);
  const listener: Listener = { signal, error };
  watch.listeners.add(listener);
  const opened = watch;
  return {
    ready: opened.change,
    rooms: (roomIds) => {
      if (opened.closed) return;
      opened.rooms.set(listener, [...roomIds]);
      opened.listen();
    },
    release: () => {
      opened.listeners.delete(listener);
      if (opened.rooms.delete(listener) && opened.listeners.size > 0) opened.listen();
      if (opened.listeners.size > 0) return;
      opened.closed = true;
      watches.delete(key);
      opened.stopEntry();
      opened.release?.();
      opened.globalRelease?.();
    },
  };
}

function openWatch(key: string, identity: Identity, relayUrl: string, workspaceId: string): Watch {
  const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', { workspaceId });
  const relay = new BuzzRigTransport(identity).ensureClient();
  const watch: Watch = {
    listeners: new Set(),
    rooms: new Map(),
    listen: () => undefined,
    subscribed: '',
    change: Promise.resolve(),
    stopEntry: () => undefined,
    closed: false,
  };
  watch.change = relay.then(async (client) => {
    const release = await client.surfaceSubscribe([], (event) => {
      const live = event && typeof event === 'object' && 'monolithLive' in event
        ? event.monolithLive as { type?: string; reason?: string }
        : undefined;
      if (live?.type !== 'invalidate' || (live.reason !== 'postgres:memberships' && live.reason !== 'reconnect')) return;
      for (const listener of watch.listeners) listener.signal();
    });
    if (watch.closed) release();
    else watch.globalRelease = release;
  });
  const listen = () => {
    const view = mobileSurfaceCache.peek(address, isWorkspaceView);
    // A manager's Rooms carry the membership changes Members shows.
    const managed = view?.managerSettings?.rooms?.map((room) => room.id) ?? [];
    const roomIds = [...new Set([...managed, ...[...watch.rooms.values()].flat()])].sort();
    const effective: WorkspaceView['watchFilters'] = [
      ...(view?.watchFilters ?? []),
      ...(roomIds.length ? [{ kinds: [0, 9, 9000, 9001], '#h': roomIds }] : []),
    ];
    const filtersKey = JSON.stringify(effective);
    watch.change = watch.change.catch(() => undefined).then(async () => {
      if (watch.closed || filtersKey === watch.subscribed) return;
      // No Room to hear: a filter without Rooms would register for every
      // identity-wide event instead.
      const next = effective.length
        ? await (await relay).surfaceSubscribe(effective, () => {
          for (const listener of watch.listeners) listener.signal();
        })
        : undefined;
      if (watch.closed) {
        next?.();
        return;
      }
      const previous = watch.release;
      watch.release = next;
      watch.subscribed = filtersKey;
      previous?.();
    });
    watch.change.catch((reason) => {
      for (const listener of watch.listeners) listener.error?.(reason);
    });
  };
  watch.listen = listen;
  watch.stopEntry = mobileSurfaceCache.subscribe(address, listen);
  watches.set(key, watch);
  listen();
  return watch;
}
