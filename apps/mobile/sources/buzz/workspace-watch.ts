import { isWorkspaceView, type Identity, type WorkspaceView } from '@beeline/buzz-client';
import { BuzzRigTransport } from '@/sync/transport';
import { subscribeClientReset } from '@/sync/client-reset';
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
  stopEntry: () => void;
  closed: boolean;
};

const watches = new Map<string, Watch>();

function closeWatch(watch: Watch): void {
  watch.closed = true;
  watch.stopEntry();
  watch.release?.();
}

/** An identity or relay change closes every watch; a later release is a no-op. */
subscribeClientReset(() => {
  for (const watch of watches.values()) closeWatch(watch);
  watches.clear();
});

/**
 * One relay watch per Workspace for every mounted roster reader (Members and
 * the human profile). Each relay signal reaches every listener, which reads
 * what it shows. The live socket only serves Room ids, so the filters are the
 * shared `/workspace/:id` entry's watch filters and managed Rooms, plus the
 * Rooms each reader names with `rooms` (the profile names its grants' Rooms). A Workspace id is
 * not a Room id; the server drops it, so it never joins the filters.
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
      if (opened.closed) return;
      opened.listeners.delete(listener);
      if (opened.rooms.delete(listener) && opened.listeners.size > 0) opened.listen();
      if (opened.listeners.size > 0) return;
      watches.delete(key);
      closeWatch(opened);
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
