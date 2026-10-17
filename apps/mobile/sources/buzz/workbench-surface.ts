import { isWorkbenchCompanyIndex } from './workbench-company-validation';
import { useCallback, useEffect } from 'react';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { getWorkbenchSource } from './workbench-source';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { useFreshWorkbenchSurface, useSharedSurface } from './use-shared-surface';
import type { ConnectionDetailView, WorkbenchView } from './workbench';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';

export type WorkbenchScope = { workspaceId: string; viewerId: string };
export const isWorkbenchView = (value: unknown): value is WorkbenchView => {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<WorkbenchView>;
  return Array.isArray(view.apps) && Array.isArray(view.helpers) &&
    Array.isArray(view.connectors) && Array.isArray(view.connections) &&
    (view.companies === undefined || isWorkbenchCompanyIndex(view.companies));
};
const heldWorkbench = new Map<string, { address: SurfaceCacheAddress; scope: WorkbenchScope }>();
/** Workbench views the server answered this session; a stored view outside it may be stale. */
const answeredWorkbench = new Set<string>();
const ownerErrors = new Map<string, Set<(error: string | null) => void>>();
let workbenchStop: (() => void) | undefined;
let workbenchStarting = false;
subscribeClientReset(() => {
  heldWorkbench.clear(); answeredWorkbench.clear(); workbenchStop?.(); workbenchStop = undefined;
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
  // A stored view can predate live changes this device never heard, such as a
  // machine's Squire report. Read it again once per session; with no stored
  // view, the route's own first read covers it.
  if (!answeredWorkbench.has(key)) {
    answeredWorkbench.add(key);
    void mobileSurfaceCache.read(address, isWorkbenchView).then((stored) => stored &&
      mobileSurfaceCache.fetch(address, isWorkbenchView, () => getWorkbenchSource().readWorkbench(scope))
        .then(() => reportOwnerError(key, null), (cause) => reportOwnerError(key, String(cause))));
  }
  heldWorkbench.set(key, { address, scope });
  if (heldWorkbench.size > 8) heldWorkbench.delete(heldWorkbench.keys().next().value!);
  if (workbenchStop || workbenchStarting) return;
  workbenchStarting = true;
  const generation = clientResetGeneration();
  void sharedLiveConnection().register([], (event) => {
    if (!('monolithLive' in event)) return;
    const live = event.monolithLive;
    if ((live.type === 'resource-change' &&
        ['workbench', 'install', 'agent'].includes(live.resource)) ||
        (live.type === 'invalidate' && live.roomId === '' && live.reason === 'reconnect')) {
      for (const [key, owner] of heldWorkbench)
        void mobileSurfaceCache.fetch(owner.address, isWorkbenchView,
          () => getWorkbenchSource().readWorkbench(owner.scope))
          .then(() => reportOwnerError(key, null), (cause) => reportOwnerError(key, String(cause)));
    }
  }).then((stop) => { if (generation !== clientResetGeneration()) stop();
    else { workbenchStarting = false; workbenchStop = stop; } },
    () => { if (generation === clientResetGeneration()) workbenchStarting = false; });
}

export function useSharedWorkbench(scope: WorkbenchScope | null) {
  const request = useCallback(() => getWorkbenchSource().readWorkbench(scope!),
    [scope?.workspaceId, scope?.viewerId]);
  const resource = useSharedSurface('/workspace/:id/workbench', scope ?? undefined,
    isWorkbenchView, request, Boolean(scope?.viewerId));
  useEffect(() => { if (scope && resource.address) holdSharedWorkbench(resource.address, scope); },
    [resource.address, scope?.workspaceId, scope?.viewerId]);
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
  holdSharedWorkbench(address, scope);
  if (!options?.refresh) {
    const held = await mobileSurfaceCache.read(address, isWorkbenchView);
    if (held) return held;
  }
  const next = await mobileSurfaceCache.fetch(address, isWorkbenchView, () =>
    getWorkbenchSource().readWorkbench({ ...scope,
      ...(options?.refreshVault ? { refreshVault: true } : {}) }));
  if (!next) {
    const held = mobileSurfaceCache.peek(address, isWorkbenchView);
    if (held) return held;
    throw new Error('Workbench response was superseded');
  }
  return next;
}
