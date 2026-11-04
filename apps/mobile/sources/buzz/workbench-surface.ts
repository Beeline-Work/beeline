import { isWorkbenchCompanyIndex } from './workbench-company-validation';
import { useCallback } from 'react';
import type { SurfaceCacheAddress } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { getWorkbenchSource } from './workbench-source';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { useFreshWorkbenchSurface } from './use-shared-surface';
import type { ConnectionDetailView, WorkbenchView } from './workbench';
import {useRoutedResource} from './router-resource';
import {useSurfaceFocus} from './use-surface-focus';

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
    (view.companies === undefined || isWorkbenchCompanyIndex(view.companies)) &&
    (view.aiClients === undefined || (Array.isArray(view.aiClients) && view.aiClients.length <= 100 && view.aiClients.every(client =>
      client && typeof client.clientId === 'string' && client.clientId.length <= 100 &&
      typeof client.name === 'string' && client.name.length <= 120 &&
      Array.isArray(client.scopes) && client.scopes.every((scope: unknown) => scope === 'rooms:read' || scope === 'rooms:write') &&
      Number.isFinite(client.connectedAt) && (client.lastUsedAt === null || Number.isFinite(client.lastUsedAt)) &&
      (client.logo === undefined || (typeof client.logo === 'string' && client.logo.length <= 400000 && client.logo.startsWith('data:image/png;base64,'))))));
};
export function useSharedWorkbench(scope: WorkbenchScope | null) {
  const focused = useSurfaceFocus();
  const routed = useRoutedResource('owner-workbench', scope ? { family: 'owner-workbench' } : undefined,
    focused && !!scope, isWorkbenchView);
  return { value: routed.value, loading: routed.loading, error: routed.error,
    refresh: async () => { routed.retry(); return null; },
    refreshAfterChange: async () => null };
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
