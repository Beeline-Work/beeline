import { useCallback } from 'react';
import type { WalletHistoryResult, WalletView } from '@beeline/api-contract/wallet';
import { getWalletSource } from './wallet-source';
import { useSharedSurface } from './use-shared-surface';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

const isWalletView = (value: unknown): value is WalletView => {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<WalletView>;
  return typeof view.address === 'string' && Array.isArray(view.coins);
};
const isWalletHistory = (value: unknown): value is WalletHistoryResult =>
  Boolean(value && typeof value === 'object' &&
    Array.isArray((value as Partial<WalletHistoryResult>).entries));

export function useSharedWallet(workspaceId: string | null | undefined) {
  const request = useCallback(() => getWalletSource().readWallet({ workspaceId: workspaceId! }),
    [workspaceId]);
  return useSharedSurface('/workspace/:id/wallet', workspaceId ? { workspaceId } : undefined,
    isWalletView, request, Boolean(workspaceId));
}

/** A successful connect publishes its returned wallet into the held owner. */
export async function publishSharedWallet(workspaceId: string, wallet: WalletView) {
  const [identity, relay] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity) return;
  await mobileSurfaceCache.write(surfaceAddress(relay, identity.publicKey,
    '/workspace/:id/wallet', { workspaceId }), wallet, isWalletView);
}

export function useSharedWalletHistory(workspaceId: string | null | undefined) {
  const request = useCallback(() => getWalletSource().readHistory({ workspaceId: workspaceId!, limit: 30 }),
    [workspaceId]);
  return useSharedSurface('/workspace/:id/wallet-history', workspaceId ? { workspaceId } : undefined,
    isWalletHistory, request, Boolean(workspaceId));
}
