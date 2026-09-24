import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SurfaceRefreshScheduler,
  isCornerListView,
  type CornerListView,
  type Identity,
} from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { CHANGES_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { MonoButton } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomCornersHeader } from '@/components/buzz/RoomCornersHeader';
import { RoomCornersList } from '@/components/buzz/RoomCornersList';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { NewCornerDialog } from '@/components/buzz/NewCornerDialog';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { isDraftFrame } from '@/sync/transport/live-frames';
import { cornerHref } from '@/buzz/corner-navigation';
import { archivedCornersByClosure, type ArchivedCornersState } from '@/buzz/archived-corners';
import { mineCorners, useMineCorners } from '@/buzz/mine-corners';

export default function BuzzCorners() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  const insets = useSafeAreaInsets();
  const [surface, setSurface] = useState<CornerListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createAppId, setCreateAppId] = useState<string>();
  const [archived, setArchived] = useState<ArchivedCornersState>({ status: 'idle' });
  const schedulerRef = useRef<SurfaceRefreshScheduler<CornerListView> | null>(null);
  const [mine, setMine] = useMineCorners();

  useEffect(() => {
    if (!decodedId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let scheduler: SurfaceRefreshScheduler<CornerListView> | undefined;
    void (async () => {
      const identity = (await loadBuzzIdentity()) as Identity | null;
      if (!identity) {
        router.replace('/beeline/onboarding');
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const address = surfaceAddress(relayUrl, identity.publicKey, '/room/:id/corners', {
        roomId: decodedId,
      });
      const cached = await mobileSurfaceCache.read(address, isCornerListView);
      if (cancelled) return;
      if (cached) setSurface(cached);
      const http = new RoomViewClient({ baseUrl: relayUrl, identity });
      scheduler = new SurfaceRefreshScheduler({
        fetch: () => http.corners(decodedId),
        apply: (value) => {
          setSurface(value);
          setError(null);
          setRefreshing(false);
          void mobileSurfaceCache.write(address, value, isCornerListView);
        },
        onError: (reason) => {
          setError(String(reason));
          setRefreshing(false);
        },
      });
      schedulerRef.current = scheduler;
      const transport = new BuzzRigTransport(identity);
      const relay = await transport.ensureClient();
      const filters = cached?.watchFilters ?? [
        { kinds: [9, 9000, 9001, 9007, 30078], '#h': [decodedId] },
      ];
      unsubscribe = await relay.surfaceSubscribe(filters, (event) => {
        if (!isDraftFrame(event)) scheduler?.signal();
      });
      if (cancelled) return unsubscribe();
      await scheduler.startAfter(Promise.resolve());
    })().catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      scheduler?.dispose();
      schedulerRef.current = null;
    };
  }, [decodedId, retryGeneration]);

  const viewerPubkey = surface?.viewer.identity.pubkey;
  const visibleCorners = useMemo(
    () => mineCorners(surface?.corners ?? [], viewerPubkey, mine),
    [surface, viewerPubkey, mine],
  );
  const visibleArchived = useMemo<ArchivedCornersState>(
    () =>
      archived.status === 'ready'
        ? { status: 'ready', corners: mineCorners(archived.corners, viewerPubkey, mine) }
        : archived,
    [archived, viewerPubkey, mine],
  );

  const title = useMemo(
    () => (surface ? (displayRoomIndexTitle(surface.room.name) ?? surface.room.name) : 'Room'),
    [surface],
  );

  /**
   * Closed corners are not in the live surface, so the archived footer pays
   * for its own read the first time it is tapped. A read already in flight or
   * already landed is not repeated; a failed one is, because the footer offers
   * the retry in its own label.
   */
  const loadArchived = async () => {
    if (archived.status === 'loading' || archived.status === 'ready') return;
    setArchived({ status: 'loading' });
    try {
      const identity = (await loadBuzzIdentity()) as Identity | null;
      if (!identity) throw new Error('Beeline identity is unavailable');
      const relayUrl = await getEffectiveRelayUrl();
      const view = await new RoomViewClient({ baseUrl: relayUrl, identity }).corners(decodedId, {
        archived: true,
      });
      setArchived({ status: 'ready', corners: archivedCornersByClosure(view.corners) });
    } catch (reason) {
      setArchived({ status: 'error', reason: phoneOperationFailureReason(reason) });
    }
  };

  const closeCreate = () => {
    if (creating) return;
    setCreateOpen(false);
    setCreateTitle('');
    setCreateError(null);
    setCreateAppId(undefined);
  };
  const createCorner = async () => {
    const nextTitle = createTitle.replace(/\s+/g, ' ').trim();
    if (!nextTitle || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) throw new Error('Beeline identity is unavailable');
      const cornerId = await new BuzzRigTransport(identity).createHumanCorner(
        decodedId,
        nextTitle,
        createAppId,
      );
      setCreateOpen(false);
      setCreateTitle('');
      const selectedApp = surface?.apps?.find((app) => app.id === createAppId);
      if (selectedApp?.manifest.humanUi) {
        router.push({
          pathname: '/beeline/corner-app/[slug]',
          params: { slug: selectedApp.manifest.slug, roomId: cornerId },
        } as Href);
      } else {
        router.push(cornerHref(cornerId, decodedId, nextTitle, 'corners'));
      }
    } catch (reason) {
      setCreateError(phoneOperationFailureReason(reason));
    } finally {
      setCreating(false);
    }
  };

  if (!surface && !error) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <SurfaceGlyphLoader testID="changes-loader" />
        <Text style={styles.loading}>Loading {CHANGES_LABEL}…</Text>
      </View>
    );
  }
  if (!surface) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={[styles.error, styles.errorCentered]}>{error}</Text>
        <MonoButton label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={
        surface.room.workspaceId
          ? [{ communityId: surface.room.workspaceId, name: WORKSPACE_LABEL }]
          : []
      }
      activeCommunityId={surface.room.workspaceId ?? null}
      onSelect={(communityId) =>
        communityId &&
        router.replace({ pathname: '/beeline/channels', params: { communityId } } as never)
      }
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      viewerPubkey={surface.viewer.identity.pubkey}
      viewerAvatarUrl={surface.viewer.identity.avatar}
      viewerFace={surface.viewer.identity.face}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Chrome sits on the slab: no plate, no texture, one hairline and
          type weight — the same header the Members screen carries. */}
        <RoomCornersHeader
          title={title}
          mine={mine}
          onMine={setMine}
          onBack={() => router.back()}
          onAdd={() => setCreateOpen(true)}
        />
        {!!error && (
          // F5: it is tappable, so it announces as a button. `alert` promised
          // no action, which left the retry invisible to a screen reader.
          <TouchableOpacity
            accessibilityLabel={`${error}. Retry`}
            accessibilityRole="button"
            onPress={() => schedulerRef.current?.force()}
            style={styles.errorPanel}
          >
            <Text style={styles.error}>! {error}</Text>
          </TouchableOpacity>
        )}
        <RoomCornersList
          corners={visibleCorners}
          parentRoomId={decodedId}
          parentRoomName={title}
          refreshing={refreshing}
          // The list runs to the bottom edge, so it clears the gesture bar
          // itself rather than tucking its last row under it.
          bottomInset={insets.bottom}
          archived={visibleArchived}
          hiddenByMine={surface.corners.length - visibleCorners.length}
          onShowArchived={() => void loadArchived()}
          onRefresh={() => {
            setRefreshing(true);
            schedulerRef.current?.force();
          }}
        />
        <NewCornerDialog
          visible={createOpen}
          title={createTitle}
          setTitle={(value) => {
            setCreateTitle(value);
            if (createError) setCreateError(null);
          }}
          creating={creating}
          error={createError}
          onCreate={() => void createCorner()}
          onClose={closeCreate}
          apps={surface.apps ?? []}
          selectedAppId={createAppId}
          setSelectedAppId={setCreateAppId}
        />
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.md,
      paddingHorizontal: hull.space.lg,
    },
    loading: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    errorPanel: { paddingHorizontal: hull.space.md, paddingVertical: hull.space.sm },
    // F9: one error voice; only the full-screen state centres it.
    error: { ...Typography.default(), ...hull.type.meta, color: hull.danger },
    errorCentered: { textAlign: 'center' },
  };
});
