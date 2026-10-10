import { isWorkspaceView, type Identity, type WorkspaceView } from '@beeline/buzz-client';
import { BuzzRigTransport } from '@/sync/transport';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { workspaceRecordScope } from './workspace-records';

type Watch = {
  readonly listeners: Set<{ signal: () => void; error?: (reason: unknown) => void }>;
  subscribed: string;
  change: Promise<void>;
  release?: () => void;
  stopEntry: () => void;
  closed: boolean;
};

const watches = new Map<string, Watch>();

/**
 * One relay watch per Workspace for every mounted roster reader (Members and
 * the human profile). Each relay signal reaches every listener, which reads
 * what it shows. The filters follow the shared `/workspace/:id` entry: the
 * indexed Workspace response names the Room-scoped presence filters that can
 * refresh the roster, which a bootstrap filter cannot know.
 */
export function watchWorkspace(
  identity: Identity,
  relayUrl: string,
  workspaceId: string,
  signal: () => void,
  error?: (reason: unknown) => void,
): { ready: Promise<void>; release: () => void } {
  const key = workspaceRecordScope(relayUrl, identity.publicKey, workspaceId);
  let watch = watches.get(key);
  if (!watch) watch = openWatch(key, identity, relayUrl, workspaceId);
  const listener = { signal, error };
  watch.listeners.add(listener);
  const opened = watch;
  return {
    ready: opened.change,
    release: () => {
      opened.listeners.delete(listener);
      if (opened.listeners.size > 0) return;
      opened.closed = true;
      watches.delete(key);
      opened.stopEntry();
      opened.release?.();
    },
  };
}

function openWatch(key: string, identity: Identity, relayUrl: string, workspaceId: string): Watch {
  const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', { workspaceId });
  const bootstrap: WorkspaceView['watchFilters'] = [{ kinds: [0, 9, 9000, 9001], '#h': [workspaceId] }];
  const relay = new BuzzRigTransport(identity).ensureClient();
  const watch: Watch = {
    listeners: new Set(),
    subscribed: '',
    change: Promise.resolve(),
    stopEntry: () => undefined,
    closed: false,
  };
  const listen = () => {
    const filters = mobileSurfaceCache.peek(address, isWorkspaceView)?.watchFilters;
    const effective = filters?.length ? filters : bootstrap;
    const filtersKey = JSON.stringify(effective);
    watch.change = watch.change.catch(() => undefined).then(async () => {
      if (watch.closed || filtersKey === watch.subscribed) return;
      const next = await (await relay).surfaceSubscribe(effective, () => {
        for (const listener of watch.listeners) listener.signal();
      });
      if (watch.closed) {
        next();
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
  watch.stopEntry = mobileSurfaceCache.subscribe(address, listen);
  watches.set(key, watch);
  listen();
  return watch;
}
