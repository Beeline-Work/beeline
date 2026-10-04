import React, { useCallback, useEffect, useRef, useState } from 'react';
import { router, useGlobalSearchParams } from 'expo-router';
import { isWorkspaceListView, type Identity, type WorkspaceListView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  subscribeActiveCommunityId,
} from '@/buzz/community-storage';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { useIsDesktop } from '@/utils/responsive';
import { BuzzCommunityShell } from './CommunityRail';

/** Share the existing mobile drawer across the whole signed-in page stack. */
export function WorkspaceNavigationShell({ children }: { children: React.ReactNode }) {
  const isDesktop = useIsDesktop();
  return isDesktop ? (
    <>{children}</>
  ) : (
    <MobileWorkspaceNavigationShell>{children}</MobileWorkspaceNavigationShell>
  );
}

function MobileWorkspaceNavigationShell({ children }: { children: React.ReactNode }) {
  const params = useGlobalSearchParams<{ communityId?: string | string[] }>();
  const requestedId = Array.isArray(params.communityId)
    ? params.communityId[0]
    : params.communityId;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceListView | null>(null);
  const [storedId, setStoredId] = useState<string | null>(null);
  const readRevision = useRef(0);

  const refresh = useCallback(async () => {
    const revision = ++readRevision.current;
    const current = await loadBuzzIdentity();
    if (revision !== readRevision.current) return;
    setIdentity(current);
    if (!current) {
      setWorkspaces(null);
      return;
    }
    setWorkspaces((held) => (held?.viewer.pubkey === current.publicKey ? held : null));
    const baseUrl = await getEffectiveRelayUrl();
    const address = surfaceAddress(baseUrl, current.publicKey, '/workspaces');
    const cached = await mobileSurfaceCache.read(address, isWorkspaceListView);
    if (revision !== readRevision.current) return;
    if (cached) setWorkspaces(cached);
    const fresh = await new RoomViewClient({ baseUrl, identity: current }).workspaces();
    if (revision !== readRevision.current) return;
    setWorkspaces(fresh);
    await mobileSurfaceCache.write(address, fresh, isWorkspaceListView);
  }, []);
  const refreshDrawer = useCallback(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = monolithSession.subscribeIdentityChange(() => {
      setIdentity(null);
      setWorkspaces(null);
      refreshDrawer();
    });
    refreshDrawer();
    return () => {
      unsubscribe();
      readRevision.current += 1;
    };
  }, [refreshDrawer]);

  useEffect(() => {
    setStoredId(null);
    if (!identity) return;
    let current = true;
    let changed = false;
    const unsubscribe = subscribeActiveCommunityId(identity.publicKey, (id) => {
      changed = true;
      setStoredId(id);
    });
    void loadActiveCommunityId(identity.publicKey)
      .then((id) => {
        if (current && !changed) setStoredId(id);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [identity?.publicKey]);

  const communities = workspaces?.workspaces.map(workspaceRailItem) ?? [];
  const activeId = requestedId ?? storedId;
  const selectedId = communities.some((item) => item.communityId === activeId)
    ? activeId
    : (communities[0]?.communityId ?? null);

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={selectedId}
      onDrawerOpen={refreshDrawer}
      swipeEnabled={Boolean(identity)}
      onSelect={(communityId) => {
        if (!communityId) return;
        setStoredId(communityId);
        if (identity) void saveActiveCommunityId(identity.publicKey, communityId);
        router.replace({ pathname: '/beeline/channels', params: { communityId } });
      }}
      onAdd={() => router.push('/beeline/community')}
      onSettings={() => router.push('/beeline/settings')}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={workspaces?.viewer.avatar}
      viewerFace={workspaces?.viewer.face}
    >
      {children}
    </BuzzCommunityShell>
  );
}
