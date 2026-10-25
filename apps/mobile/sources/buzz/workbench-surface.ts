import { isWorkbenchCompanyIndex } from './workbench-company-validation';
import { useCallback, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { getWorkbenchSource } from './workbench-source';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { useFreshWorkbenchSurface, useSharedSurface } from './use-shared-surface';
import type { ConnectionDetailView, WorkbenchView } from './workbench';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';

export type WorkbenchScope = { workspaceId: string; viewerId: string };
/** Bound every foreground and live read, including the cache's shared flight. */
async function readWorkbenchWithTimeout(scope: WorkbenchScope & { refreshVault?: boolean }) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([getWorkbenchSource().readWorkbench(scope), new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Connections did not answer. Try again.')), 15_000);
  })]).finally(() => clearTimeout(timeout));
}
export const isWorkbenchView = (value: unknown): value is WorkbenchView => {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<WorkbenchView>;
  return Array.isArray(view.apps) && Array.isArray(view.helpers) &&
    Array.isArray(view.connectors) && Array.isArray(view.connections) &&
    (view.companies === undefined || isWorkbenchCompanyIndex(view.companies));
};
const heldWorkbench = new Map<string, { address: SurfaceCacheAddress; scope: WorkbenchScope; consumers: number; dirty: boolean }>();
/** Workbench views the server answered this session; a stored view outside it may be stale. */
const answeredWorkbench = new Set<string>();
const ownerErrors = new Map<string, Set<(error: string | null) => void>>();
let workbenchStop: (() => void) | undefined;
let workbenchStarting = false;
subscribeClientReset(() => {
  heldWorkbench.clear(); answeredWorkbench.clear(); workbenchStop?.(); workbenchStop = undefined;
  workbenchStarting = false;
});
/** A server answer written outside this module, such as the one inside the Settings read. */
export function noteWorkbenchAnswer(address: SurfaceCacheAddress) {
  answeredWorkbench.add(JSON.stringify(address));
}
function reportOwnerError(key: string, error: string | null) {
  for (const listener of ownerErrors.get(key) ?? []) listener(error);
}
export function holdSharedWorkbench(address: SurfaceCacheAddress, scope: WorkbenchScope) {
  const key = JSON.stringify(address);
  const owner = heldWorkbench.get(key) ?? { address, scope, consumers: 0, dirty: false };
  owner.consumers++;
  heldWorkbench.set(key, owner);
  const release = () => {
    owner.consumers = Math.max(0, owner.consumers - 1);
    if (!owner.consumers) owner.dirty = true;
    for (const [heldKey, held] of heldWorkbench) {
      if (heldWorkbench.size <= 8) break;
      if (held.consumers) continue;
      heldWorkbench.delete(heldKey);
      answeredWorkbench.delete(heldKey);
    }
  };
  // Focus reconciles changes missed while hidden, including a disconnected socket.
  if (!answeredWorkbench.has(key) || owner.dirty) {
    answeredWorkbench.add(key);
    owner.dirty = false;
    void mobileSurfaceCache.read(address, isWorkbenchView).then((stored) => {
      if (!owner.consumers) { owner.dirty = true; return; }
      if (stored) return mobileSurfaceCache.fetch(address, isWorkbenchView, () => readWorkbenchWithTimeout(scope))
        .then(() => reportOwnerError(key, null), (cause) => reportOwnerError(key, String(cause)));
    });
  }
  if (workbenchStop || workbenchStarting) return release;
  workbenchStarting = true;
  const generation = clientResetGeneration();
  void sharedLiveConnection().register([], (event) => {
    if (!('monolithLive' in event)) return;
    const live = event.monolithLive;
    if ((live.type === 'resource-change' &&
        ['workbench', 'install', 'agent'].includes(live.resource)) ||
        (live.type === 'invalidate' && live.roomId === '' && live.reason === 'reconnect')) {
      for (const [key, owner] of heldWorkbench) {
        owner.dirty = true;
        if (!owner.consumers) continue;
        owner.dirty = false;
        void mobileSurfaceCache.fetch(owner.address, isWorkbenchView,
          () => readWorkbenchWithTimeout(owner.scope))
          .then(() => reportOwnerError(key, null), (cause) => reportOwnerError(key, String(cause)));
      }
    }
  }).then((stop) => { if (generation !== clientResetGeneration()) stop();
    else { workbenchStarting = false; workbenchStop = stop; } },
    () => { if (generation === clientResetGeneration()) workbenchStarting = false; });
  return release;
}

export function useSharedWorkbench(scope: WorkbenchScope | null) {
  const request = useCallback(() => readWorkbenchWithTimeout(scope!),
    [scope?.workspaceId, scope?.viewerId]);
  const resource = useSharedSurface('/workspace/:id/workbench', scope ?? undefined,
    isWorkbenchView, request, Boolean(scope?.viewerId));
  useFocusEffect(useCallback(() => {
    if (scope && resource.address) return holdSharedWorkbench(resource.address, scope);
  }, [resource.address, scope?.workspaceId, scope?.viewerId]));
  useEffect(() => {
    if (!resource.address) return;
    const key = JSON.stringify(resource.address);
    const listeners = ownerErrors.get(key) ?? new Set<(error: string | null) => void>();
    listeners.add(resource.setError);
    ownerErrors.set(key, listeners);
    return () => { listeners.delete(resource.setError); if (!listeners.size) ownerErrors.delete(key); };
  }, [resource.address, resource.setError]);
  return resource;
}

const isConnectionDetail = (value: unknown): value is ConnectionDetailView => Boolean(
  value && typeof value === 'object' &&
  typeof (value as ConnectionDetailView).connection?.ref === 'string' &&
  Array.isArray((value as ConnectionDetailView).grants));

export function useSharedConnectionDetail(scope: WorkbenchScope, connectionId: string) {
  const request = useCallback(async () => {
    const result = await getWorkbenchSource().readConnectionDetail({ ...scope, connectionId });
    if (!result) throw new Error('Key not found — it belongs to another member or no longer exists');
    return result;
  }, [scope.workspaceId, scope.viewerId, connectionId]);
  return useFreshWorkbenchSurface('/workspace/:id/connections/:connectionId',
    { ...scope, connectionId }, isConnectionDetail, request, Boolean(connectionId));
}

export async function publishConnectionDetail(address: SurfaceCacheAddress | null,
  value: ConnectionDetailView): Promise<void> {
  if (address) await mobileSurfaceCache.write(address, value, isConnectionDetail);
}

export async function readSharedWorkbench(scope: WorkbenchScope, options?: {
  refresh?: boolean; refreshVault?: boolean;
}): Promise<WorkbenchView> {
  const [identity, relay] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity) throw new Error('Identity unavailable');
  const address = surfaceAddress(relay, identity.publicKey, '/workspace/:id/workbench', scope);
  // Imperative reads do not keep a hidden screen subscribed.
  const owner = heldWorkbench.get(JSON.stringify(address));
  if (owner) owner.dirty = true;
  if (!options?.refresh) {
    const held = await mobileSurfaceCache.read(address, isWorkbenchView);
    if (held) return held;
  }
  const next = await mobileSurfaceCache.fetch(address, isWorkbenchView, () =>
    readWorkbenchWithTimeout({ ...scope,
      ...(options?.refreshVault ? { refreshVault: true } : {}) }));
  if (!next) {
    const held = mobileSurfaceCache.peek(address, isWorkbenchView);
    if (held) return held;
    throw new Error('Workbench response was superseded');
  }
  return next;
}
