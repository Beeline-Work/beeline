import { canonicalRouterFixture } from './canonical-router-fixture';

/** Reuse the existing mock server data producers at the canonical boundary.
 * Dependencies are loaded by Vitest's mock factory before mounting React. */
export async function createCanonicalWorkbenchFixture() {
  const [{ getWorkbenchSource }, { useLocalSearchParams }, { loadBuzzIdentity }] = await Promise.all([
    import('@/buzz/workbench-source'), import('expo-router'), import('@/auth/buzz-identity-storage'),
  ]);
  return canonicalRouterFixture(async input => {
    if (input.family !== 'owner-workbench') throw new Error(`Unexpected fixture family ${input.family}`);
    const params = useLocalSearchParams() as Record<string, string>;
    return getWorkbenchSource().readWorkbench({ workspaceId: params.workspaceId ?? '',
      viewerId: params.viewerId ?? (await loadBuzzIdentity())?.publicKey ?? '' });
  });
}
export async function createCanonicalScheduledFixture() {
  const { monolithPhoneOperation } = await import('@/sync/transport/monolith-operation');
  return canonicalRouterFixture(input => monolithPhoneOperation('readScheduledWork', { roomId: input.roomId }));
}
export async function createCanonicalWalletFixture() {
  const { getWalletSource } = await import('@/buzz/wallet-source');
  return canonicalRouterFixture(async input => {
    if (input.family !== 'owner-wallet') return null;
    return { wallet: await getWalletSource().readWallet({workspaceId: 'workspace-1'}), summary: null, observedAt: Date.now() };
  });
}
