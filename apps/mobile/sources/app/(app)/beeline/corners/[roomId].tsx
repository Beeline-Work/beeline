import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Identity } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { CHANGES_LABEL, CORNER_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Button } from '@/components/buzz/Button';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomCornersHeader } from '@/components/buzz/RoomCornersHeader';
import { RoomCornersList } from '@/components/buzz/RoomCornersList';
import { CornerOpenRow } from '@/components/buzz/CornerOpenToast';
import { BuzzRigTransport } from '@/sync/transport';
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
import { useRoomCorners } from '@/buzz/use-room-corners';
import { roomOpenCornerRows } from '@/buzz/room-corner-store';

/** The footer's read status; the archived rows themselves live in the corner record. */
type ArchivedFooter =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly more?:
        | { readonly status: 'loading' }
        | { readonly status: 'error'; readonly reason: string };
    }
  | { readonly status: 'error'; readonly reason: string };

export default function BuzzCorners() {
  useLatencyRouteFrame('/beeline/corners/[roomId]');
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  const insets = useSafeAreaInsets();
  // The Room's one corner record: rows the Room lane already heard paint with
  // no read, whichever screen held the lane when they arrived.
  const corners = useRoomCorners(decodedId || undefined);
  const surface = corners.view ?? null;
  useLatencyRouteFrame('/beeline/corners/[roomId]', surface !== null, true);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? corners.error;
  const [refreshing, setRefreshing] = useState(false);
  const loadingOpen = useRef(false);
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [archivedStatus, setArchivedStatus] = useState<ArchivedFooter>({ status: 'idle' });
  const desktop = useIsDesktop();
  // Desktop cells name each corner's live workflow; one read covers the Room.
  const workflows = useRoomWorkflowRuns(desktop && decodedId ? decodedId : undefined);
  useEffect(() => {
    void loadBuzzIdentity().then((identity) => {
      if (!identity) router.replace('/beeline/onboarding');
    });
  }, []);
  const archivedRows = corners.record?.archived;
  const archived = useMemo<ArchivedCornersState>(
    () =>
      archivedStatus.status === 'ready' && archivedRows
        ? {
            status: 'ready',
            corners: archivedCornersByClosure(archivedRows.corners),
            ...(archivedRows.next ? { next: archivedRows.next } : {}),
            ...(archivedStatus.more ? { more: archivedStatus.more } : {}),
          }
        : archivedStatus.status === 'ready'
          ? { status: 'loading' }
          : archivedStatus,
    [archivedRows, archivedStatus],
  );

  const title = useMemo(
    () => (surface ? (displayRoomIndexTitle(surface.room.name) ?? surface.room.name) : 'Room'),
    [surface],
  );
  const refresh = async () => {
    setActionError(null);
    await corners.refresh();
  };
  const loadMoreOpen = async () => {
    if (loadingOpen.current) return;
    loadingOpen.current = true;
    try {
      await corners.loadMoreOpen();
    } catch (reason) {
      setActionError(phoneOperationFailureReason(reason));
    } finally {
      loadingOpen.current = false;
    }
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
  /**
   * Closed corners are not in the live surface, so the archived footer pays
   * for its own read the first time it is tapped. A read already in flight or
   * already landed is not repeated; a failed one is, because the footer offers
   * the retry in its own label. The server sends ten at a time. The rows live
   * in the Room's corner record, which re-reads them when a corner closes.
   */
  const loadArchived = async () => {
    if (archivedStatus.status === 'loading' || archivedStatus.status === 'ready') return;
    setArchivedStatus({ status: 'loading' });
    try {
      await corners.loadArchived(false);
      setArchivedStatus({ status: 'ready' });
    } catch (reason) {
      setArchivedStatus({ status: 'error', reason: phoneOperationFailureReason(reason) });
    }
  };
  const loadMoreArchived = async () => {
    if (archived.status !== 'ready' || !archived.next || archived.more?.status === 'loading') {
      return;
    }
    setArchivedStatus({ status: 'ready', more: { status: 'loading' } });
    try {
      await corners.loadArchived(true);
      setArchivedStatus({ status: 'ready' });
    } catch (reason) {
      setArchivedStatus({
        status: 'ready',
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
        <Button label="RETRY" onPress={() => void refresh()} />
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
            onPress={() => void refresh()}
            style={styles.errorPanel}
          >
            <Text style={styles.error}>! {error}</Text>
          </TouchableOpacity>
        )}
        <CornerOpenRow roomId={decodedId} />
        <RoomCornersList
          corners={corners.record ? roomOpenCornerRows(corners.record) : surface.corners}
          onMoreOpen={() => void loadMoreOpen()}
          moreOpen={!!corners.record?.nextOpen}
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
            void refresh().finally(() => setRefreshing(false));
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
