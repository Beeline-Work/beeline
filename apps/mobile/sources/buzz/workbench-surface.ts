import { useCallback, useEffect, useState } from 'react';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';
import type { WorkbenchAppSearchResult } from '@beeline/api-contract/workbench';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { getWorkbenchSource } from './workbench-source';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { useSharedSurface, useSurfaceSnapshot } from './use-shared-surface';
import type { ConnectionDetailView, WorkbenchView } from './workbench';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';

export type WorkbenchScope = { workspaceId: string; viewerId: string };
export const isWorkbenchView = (value: unknown): value is WorkbenchView => {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<WorkbenchView>;
  return Array.isArray(view.apps) && Array.isArray(view.helpers) &&
    Array.isArray(view.connectors) && Array.isArray(view.connections);
};
const isSuggestions = (value: unknown): value is WorkbenchAppSearchResult => Array.isArray(value);
const connectReads = new Map<string, Promise<string | null>>();
const heldWorkbench = new Map<string, { address: SurfaceCacheAddress; scope: WorkbenchScope }>();
const ownerErrors = new Map<string, Set<(error: string | null) => void>>();
let workbenchStop: (() => void) | undefined;
let workbenchStarting = false;
subscribeClientReset(() => { heldWorkbench.clear(); workbenchStop?.(); workbenchStop = undefined; });
function reportOwnerError(key: string, error: string | null) {
  for (const listener of ownerErrors.get(key) ?? []) listener(error);
}
export function holdSharedWorkbench(address: SurfaceCacheAddress, scope: WorkbenchScope) {
  const key = JSON.stringify(address);
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

/** The Connect App envelope writes the Workbench and catalog to their own keyed entries. */
export function useSharedConnectApp(scope: WorkbenchScope) {
  const [addresses, setAddresses] = useState<{
    workbench: SurfaceCacheAddress; suggestions: SurfaceCacheAddress;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(async ([identity, relay]) => {
      if (!identity || cancelled) return;
      const workbench = surfaceAddress(relay, identity.publicKey, '/workspace/:id/workbench', scope);
      const suggestions = surfaceAddress(relay, identity.publicKey,
        '/workspace/:id/workbench-suggestions', scope);
      holdSharedWorkbench(workbench, scope);
      setAddresses({ workbench, suggestions });
      const [heldView, heldSuggestions] = await Promise.all([
        mobileSurfaceCache.read(workbench, isWorkbenchView),
        mobileSurfaceCache.read(suggestions, isSuggestions),
      ]);
      if (cancelled || (heldView && heldSuggestions)) return;
      try {
        if (!heldView && !heldSuggestions) {
          const key = `${relay}\u0000${identity.publicKey}\u0000${scope.workspaceId}`;
          let reading = connectReads.get(key);
          if (!reading) {
            reading = getWorkbenchSource().readConnectApp(scope).then(async (response) => {
              await Promise.all([
                response.view ? mobileSurfaceCache.write(workbench, response.view, isWorkbenchView) : undefined,
                response.suggestions ? mobileSurfaceCache.write(suggestions, response.suggestions, isSuggestions) : undefined,
              ]);
              return response.workbenchError ?? response.suggestionsError ?? null;
            }).finally(() => { connectReads.delete(key); });
            connectReads.set(key, reading);
          }
          const partialError = await reading;
          if (partialError && !cancelled) setError(partialError);
        } else if (!heldView) {
          await readSharedWorkbench(scope);
        } else {
          await mobileSurfaceCache.fetch(suggestions, isSuggestions,
            () => getWorkbenchSource().searchApps({ query: '' }));
        }
      } catch (cause) { if (!cancelled) setError(String(cause)); }
    }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [scope.workspaceId, scope.viewerId]);
  const view = useSurfaceSnapshot(addresses?.workbench ?? null, isWorkbenchView);
  const suggestions = useSurfaceSnapshot(addresses?.suggestions ?? null, isSuggestions);
  return { view, suggestions, error };
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
  return useSharedSurface('/workspace/:id/connections/:connectionId',
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
