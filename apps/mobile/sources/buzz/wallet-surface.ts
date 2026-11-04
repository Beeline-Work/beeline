import { useCallback } from 'react';
import type { WalletHistoryResult, WalletView } from '@beeline/api-contract/wallet';
import { getWalletSource } from './wallet-source';
import { useFreshWorkbenchSurface } from './use-shared-surface';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import {useRoutedResource} from './router-resource';
import {useSurfaceFocus} from './use-surface-focus';
import type {RouterValues} from '@beeline/api-contract/router-protocol';
import {appErrorCopy} from './app-error-copy';

const isWalletView = (value: unknown): value is WalletView => {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<WalletView>;
  return typeof view.address === 'string' && Array.isArray(view.coins);
};
export function isOwnerWallet(value:unknown):value is RouterValues['owner-wallet']{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const block=value as RouterValues['owner-wallet'];
  return (block.wallet===null||isWalletView(block.wallet))&&(block.observedAt===null||Number.isFinite(block.observedAt))&&
    (block.summary===null||!!block.summary&&typeof block.summary.delegationActive==='boolean'&&Number.isFinite(block.summary.createdAt)&&
      (block.summary.delegationExpiresAt===null||Number.isFinite(block.summary.delegationExpiresAt)));
}
const isWalletHistory = (value: unknown): value is WalletHistoryResult =>
  Boolean(value && typeof value === 'object' &&
    Array.isArray((value as Partial<WalletHistoryResult>).entries));

export function useSharedWallet(workspaceId: string | null | undefined) {
  const focused=useSurfaceFocus();
  const routed=useRoutedResource('owner-wallet',workspaceId?{family:'owner-wallet'}:undefined,focused&&!!workspaceId,isOwnerWallet);
  const request = useCallback(() => getWalletSource().readWallet({ workspaceId: workspaceId! }),
    [workspaceId]);
  const resource=useFreshWorkbenchSurface('/workspace/:id/wallet', workspaceId ? { workspaceId } : undefined,
    isWalletView, request, Boolean(workspaceId)&&focused&&routed.mode==='legacy');
  const refresh=useCallback(async()=>{
    if(routed.mode!=='router')return resource.refresh();
    const refreshWallet=getWalletSource().refreshWallet;
    if(!refreshWallet){routed.retry();return null;}
    try{const value=await refreshWallet.call(getWalletSource());resource.setError(null);return value;}
    catch(error){resource.setError(appErrorCopy(error));return null;}
  },[routed.mode,resource.refresh,resource.setError,routed.retry]);
  if(routed.mode==='legacy')return resource;
  return {...resource,value:routed.value?.wallet??null,loading:routed.loading,error:routed.error??resource.error??
    (routed.value?.summary&&!routed.value.wallet?'Balance has not been read. Refresh to load it.':null),refresh};
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
  return useFreshWorkbenchSurface('/workspace/:id/wallet-history', workspaceId ? { workspaceId } : undefined,
    isWalletHistory, request, Boolean(workspaceId));
}
