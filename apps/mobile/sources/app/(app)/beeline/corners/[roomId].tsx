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
import { CHANGES_LABEL, CORNER_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Button } from '@/components/buzz/Button';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomCornersHeader } from '@/components/buzz/RoomCornersHeader';
import { RoomCornersList } from '@/components/buzz/RoomCornersList';
import { CornerOpenRow } from '@/components/buzz/CornerOpenToast';
import { BuzzRigTransport } from '@/sync/transport';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { cornerHref } from '@/buzz/corner-navigation';
import { openRoomListCorner } from '@/buzz/room-list-new-corner';
import type { CornerOpenAttempt } from '@/buzz/open-random-corner';
import { phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal';
import { archivedCornersByClosure, type ArchivedCornersState } from '@/buzz/archived-corners';
import { useIsDesktop } from '@/utils/responsive';
import { liveRoomRuns, useRoomWorkflowRuns } from '@/buzz/use-room-workflow-run';
import { workflowRunHref } from '@/buzz/workflow-run-copy';
import { openCornerBriefViewer } from '@/components/buzz/corner-brief-viewer';

/** Parent-Room hints that change this list: a corner's status, a corner
 *  opened, renamed, or closed, and the server's own resync. */
const CORNER_LIST_REASONS = new Set(['corner-status', 'corner', 'resync']);

export default function BuzzCorners() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  const insets = useSafeAreaInsets();
  const [surface, setSurface] = useState<CornerListView | null>(null);
  const [openMore, setOpenMore] = useState<CornerListView['corners']>([]);
  const [nextOpen, setNextOpen] = useState<string | undefined>();
  const loadingOpen = useRef(false);
  const openPageGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState<ArchivedCornersState>({ status: 'idle' });
  const schedulerRef = useRef<SurfaceRefreshScheduler<CornerListView> | null>(null);
  const desktop = useIsDesktop();
  // Desktop cells name each corner's live workflow; one read covers the Room.
  const workflows = useRoomWorkflowRuns(desktop && decodedId ? decodedId : undefined);

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
      const hadCached = Boolean(cached);
      if (cancelled) return;
      if (cached) {
        setSurface(cached);
        setNextOpen(cached.nextOpen);
      }
      const http = new RoomViewClient({ baseUrl: relayUrl, identity });
      scheduler = new SurfaceRefreshScheduler({
        fetch: () => http.corners(decodedId),
        apply: (value) => {
          openPageGeneration.current += 1;
          setSurface(value);
          setOpenMore([]);
          setNextOpen(value.nextOpen);
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
      // The corner list payload carries no watch filters, so the parent Room is
      // always the lane: the server nudges it whenever a corner's status
      // inputs change. Chat traffic in the parent does not touch this list.
      let handshakeSeen = false;
      unsubscribe = await relay.surfaceSubscribe([{ '#h': [decodedId] }], (event) => {
        if (!('monolithLive' in event)) return;
        const live = (event as MonolithSurfaceEvent).monolithLive;
        if (live.type === 'subscribed') {
          // The first frame opens this watch; a later one is a reconnect, and
          // one read closes a gap. A resumed lane proves the cached list is
          // continuous, so it needs no opening HTTP request.
          if ((handshakeSeen || hadCached) && !live.resumed) scheduler?.force();
          handshakeSeen = true;
          return;
        }
        if (live.type === 'corner-status' && live.corners) {
          setNextOpen(live.nextOpen);
          setSurface((current) => {
            if (!current) return current;
            const next = { ...current, corners: live.corners!, nextOpen: live.nextOpen };
            void mobileSurfaceCache.write(address, next, isCornerListView);
            return next;
          });
          return;
        }
        if (live.type === 'corner-status') {
          scheduler?.signal();
          return;
        }
        if (live.type === 'invalidate' && CORNER_LIST_REASONS.has(live.reason)) {
          scheduler?.signal();
        }
      });
      if (cancelled) return unsubscribe();
      if (!hadCached) await scheduler.startAfter(Promise.resolve());
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

  const title = useMemo(
    () => (surface ? (displayRoomIndexTitle(surface.room.name) ?? surface.room.name) : 'Room'),
    [surface],
  );
  const loadMoreOpen = async () => {
    if (!nextOpen || loadingOpen.current) return;
    loadingOpen.current = true;
    const cursor = nextOpen;
    const generation = openPageGeneration.current;
    try {
      const identity = (await loadBuzzIdentity()) as Identity | null;
      if (!identity) return;
      const relayUrl = await getEffectiveRelayUrl();
      const page = await new RoomViewClient({ baseUrl: relayUrl, identity }).corners(decodedId, {
        openBefore: cursor,
      });
      if (generation !== openPageGeneration.current) return;
      setOpenMore((current) => {
        const seen = new Set([...(surface?.corners ?? []), ...current].map((item) => item.corner.id));
        return [...current, ...page.corners.filter((item) => !seen.has(item.corner.id))];
      });
      setNextOpen(page.nextOpen);
    } catch (reason) {
      setError(phoneOperationFailureReason(reason));
    } finally {
      loadingOpen.current = false;
    }
  };

  /**
   * Closed corners are not in the live surface, so the archived footer pays
   * for its own read the first time it is tapped. A read already in flight or
   * already landed is not repeated; a failed one is, because the footer offers
   * the retry in its own label. The server sends ten at a time; `before` reads
   * the page after the one ending at that cursor.
   */
  const readArchived = async (before?: string) => {
    const identity = (await loadBuzzIdentity()) as Identity | null;
    if (!identity) throw new Error('Beeline identity is unavailable');
    const relayUrl = await getEffectiveRelayUrl();
    return new RoomViewClient({ baseUrl: relayUrl, identity }).corners(decodedId, {
      archived: true,
      ...(before ? { before } : {}),
    });
  };
  /** The list knows only that a brief exists; its text comes with the corner's own view. */
  const openBrief = async (cornerId: string) => {
    try {
      const identity = (await loadBuzzIdentity()) as Identity | null;
      if (!identity) throw new Error('Beeline identity is unavailable');
      const relayUrl = await getEffectiveRelayUrl();
      const view = await new RoomViewClient({ baseUrl: relayUrl, identity }).room(cornerId);
      if (!view.cornerBrief) throw new Error('This corner has no brief yet');
      openCornerBriefViewer(view.cornerBrief);
    } catch (reason) {
      Modal.alert('Could not open the brief', phoneOperationFailureReason(reason));
    }
  };
  const loadArchived = async () => {
    if (archived.status === 'loading' || archived.status === 'ready') return;
    setArchived({ status: 'loading' });
    try {
      const view = await readArchived();
      setArchived({
        status: 'ready',
        corners: archivedCornersByClosure(view.corners),
        ...(view.nextArchived ? { next: view.nextArchived } : {}),
      });
    } catch (reason) {
      setArchived({ status: 'error', reason: phoneOperationFailureReason(reason) });
    }
  };
  const loadMoreArchived = async () => {
    if (archived.status !== 'ready' || !archived.next || archived.more?.status === 'loading') {
      return;
    }
    const landed = archived;
    setArchived({ ...landed, more: { status: 'loading' } });
    try {
      const view = await readArchived(landed.next);
      setArchived({
        status: 'ready',
        corners: archivedCornersByClosure([...landed.corners, ...view.corners]),
        ...(view.nextArchived ? { next: view.nextArchived } : {}),
      });
    } catch (reason) {
      setArchived({
        ...landed,
        more: { status: 'error', reason: phoneOperationFailureReason(reason) },
      });
    }
  };

  const createCorner = async (attempt?: CornerOpenAttempt) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const identity = await loadBuzzIdentity();
      if (!identity) throw new Error('Beeline identity is unavailable');
      await openRoomListCorner({
        roomId: decodedId,
        attempt,
        createCorner: (roomId, title, cornerId) =>
          new BuzzRigTransport(identity).createHumanCorner(
            roomId,
            title,
            undefined,
            undefined,
            true,
            cornerId,
          ),
        openCorner: (cornerId, title) =>
          router.push(cornerHref(cornerId, decodedId, title, 'corners')),
        retry: (failed) => void createCorner(failed),
      });
    } catch (reason) {
      Modal.alert(`Could not open ${CORNER_LABEL}`, phoneOperationFailureReason(reason));
    } finally {
      creatingRef.current = false;
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
        <Button label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
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
          onBack={() => router.back()}
          busy={creating}
          onAdd={() => void createCorner()}
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
        <CornerOpenRow roomId={decodedId} />
        <RoomCornersList
          corners={[...surface.corners, ...openMore]}
          onMoreOpen={() => void loadMoreOpen()}
          moreOpen={!!nextOpen}
          parentRoomId={decodedId}
          parentRoomName={title}
          refreshing={refreshing}
          // The list runs to the bottom edge, so it clears the gesture bar
          // itself rather than tucking its last row under it.
          bottomInset={insets.bottom}
          archived={archived}
          onShowArchived={() => void loadArchived()}
          onMoreArchived={() => void loadMoreArchived()}
          viewerPubkey={surface.viewer.identity.pubkey}
          desktop={desktop}
          liveRuns={(cornerId) => liveRoomRuns(cornerId, workflows)}
          onOpenWorkflow={(run) => router.push(workflowRunHref(run))}
          onOpenBrief={(item) => void openBrief(item.corner.id)}
          onRefresh={() => {
            setRefreshing(true);
            schedulerRef.current?.force();
          }}
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
