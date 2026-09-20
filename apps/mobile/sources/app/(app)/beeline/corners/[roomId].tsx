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
import { MonoButton } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { RoomCornersList } from '@/components/buzz/RoomCornersList';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';

/** 44 of chrome already; the slop only clears Android's 48dp floor. */
const BACK_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

/**
 * The screen's title: the same noun the product uses everywhere else, as a
 * title rather than as prose. `CORNER_LABEL`/`CHANGES_LABEL` stay lowercase
 * because they are written into sentences; `MEMBERS_LABEL` is the capitalized
 * shape a page title takes, and this is its pair.
 */
const SCREEN_TITLE = `${CHANGES_LABEL.charAt(0).toUpperCase()}${CHANGES_LABEL.slice(1)}`;

export default function BuzzCorners() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  const insets = useSafeAreaInsets();
  const [surface, setSurface] = useState<CornerListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const schedulerRef = useRef<SurfaceRefreshScheduler<CornerListView> | null>(null);

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
      unsubscribe = await relay.surfaceSubscribe(filters, () => scheduler?.signal());
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

  const title = useMemo(
    () => (surface ? (displayRoomIndexTitle(surface.room.name) ?? surface.room.name) : 'Room'),
    [surface],
  );

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
        <Text style={styles.error}>{error}</Text>
        <MonoButton label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={[{ communityId: surface.room.workspaceId, name: WORKSPACE_LABEL }]}
      activeCommunityId={surface.room.workspaceId}
      onSelect={(communityId) =>
        communityId &&
        router.replace({ pathname: '/beeline/channels', params: { communityId } } as never)
      }
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({ pathname: '/beeline/settings/workspace', params: { communityId } } as never)
      }
      canManageActiveCommunity={surface.viewer.permissions.manage}
      viewerPubkey={surface.viewer.identity.pubkey}
      viewerAvatarUrl={surface.viewer.identity.avatar}
      viewerFace={surface.viewer.identity.face}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Chrome sits on the slab: no plate, no texture, one hairline and
          type weight — the same header the Members screen carries. */}
        <View style={styles.header}>
          <TouchableOpacity
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={BACK_HIT_SLOP}
            onPress={() => router.back()}
            style={styles.back}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text numberOfLines={1} style={styles.eyebrow}>
              {title}
            </Text>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
              {SCREEN_TITLE}
            </Text>
          </View>
          {/* The index's one gutter fact, spoken as a sentence rather than a
            bare numeral. */}
          <Text
            accessibilityLabel={`${surface.corners.length} ${
              surface.corners.length === 1 ? CORNER_LABEL : CHANGES_LABEL
            }`}
            style={styles.count}
          >
            {surface.corners.length}
          </Text>
        </View>
        {!!error && (
          <TouchableOpacity
            accessibilityHint="Retries the read"
            accessibilityRole="alert"
            onPress={() => schedulerRef.current?.force()}
            style={styles.errorPanel}
          >
            <Text style={styles.errorInline}>! {error}</Text>
          </TouchableOpacity>
        )}
        <RoomCornersList
          corners={surface.corners}
          parentRoomId={decodedId}
          parentRoomName={title}
          refreshing={refreshing}
          // The list runs to the bottom edge, so it clears the gesture bar
          // itself rather than tucking its last row under it.
          bottomInset={insets.bottom}
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
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    backText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    headerCopy: { flex: 1, minWidth: 0 },
    eyebrow: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    count: {
      ...Typography.default(),
      ...hull.type.meta,
      paddingHorizontal: hull.space.sm,
      color: hull.textMuted,
    },
    errorPanel: { paddingHorizontal: hull.space.md, paddingVertical: hull.space.sm },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.danger,
      textAlign: 'center',
    },
    errorInline: { ...Typography.default(), ...hull.type.meta, color: hull.danger },
  };
});
