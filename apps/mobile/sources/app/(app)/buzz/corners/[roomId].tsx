import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  RoomViewClient,
  SurfaceRefreshScheduler,
  isCornerListView,
  type CornerListView,
  type Identity,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { displayCornerTitle, displayRoomIndexTitle } from '@/buzz/room-list-row';
import { CHANGES_LABEL, CORNER_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { CornerGlyph, HullSurface, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';

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
        router.replace('/buzz/onboarding');
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const address = surfaceAddress(relayUrl, identity.publicKey, '/room/:id/corners', {
        roomId: decodedId,
      });
      const cached = await mobileSurfaceCache.read(address, isCornerListView);
      if (cancelled) return;
      if (cached) setSurface(cached);
      let current = cached;
      const http = new RoomViewClient({ baseUrl: relayUrl, identity });
      scheduler = new SurfaceRefreshScheduler({
        fetch: () => http.corners(decodedId),
        apply: (value) => {
          current = value;
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
      const transport = new BuzzRigTransport(identity, relayUrl);
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
        <PixelLoader />
        <Text style={styles.loading}>LOADING CHANGES</Text>
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
        router.replace({ pathname: '/buzz/channels', params: { communityId } } as never)
      }
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({ pathname: '/buzz/settings/workspace', params: { communityId } } as never)
      }
      canManageActiveCommunity={surface.viewer.permissions.manage}
      viewerPubkey={surface.viewer.identity.pubkey}
      viewerAvatarUrl={surface.viewer.identity.avatar}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{title}</Text>
            <Text style={styles.title}>All {CHANGES_LABEL}</Text>
          </View>
          <Text style={styles.count}>{surface.corners.length}</Text>
        </HullSurface>
        <HullSurface strength="raised" style={styles.modelPanel}>
          <Text style={styles.modelTitle}>YOLO INSIDE · GITHUB IS THE LIFECYCLE</Text>
          <Text style={styles.modelText}>
            Agents iterate inside their own {CORNER_LABEL}, push a branch, and open a pull request.
            A merged or deleted branch closes the work automatically.
          </Text>
        </HullSurface>
        {!!error && (
          <TouchableOpacity
            accessibilityRole="alert"
            onPress={() => schedulerRef.current?.force()}
            style={styles.errorPanel}
          >
            <Text style={styles.error}>! {error}</Text>
          </TouchableOpacity>
        )}
        <FlatList
          data={surface.corners}
          keyExtractor={(item) => item.corner.id}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            schedulerRef.current?.force();
          }}
          contentContainerStyle={surface.corners.length ? undefined : styles.emptyContainer}
          renderItem={({ item }) => {
            const label = displayCornerTitle(surface.room.name, item.corner.name, item.corner.id);
            return (
              <TouchableOpacity
                testID={`corner-${item.corner.id}`}
                style={styles.row}
                onPress={() => router.push(cornerHref(item.corner.id, decodedId, item.corner.name))}
              >
                <IdentityMark
                  kind={item.agent?.kind === 'agent' ? 'agent' : 'human'}
                  seed={item.agent?.pubkey ?? item.corner.id}
                  avatarUrl={item.agent?.avatar}
                  name={item.agent?.name ?? 'Corner'}
                  size={34}
                />
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {label}
                  </Text>
                  <Text numberOfLines={1} style={styles.agent}>
                    {item.agent
                      ? `Opened by ${item.agent.name}`
                      : (item.latestMessage?.text ?? 'No activity yet')}
                  </Text>
                </View>
                <CornerGlyph
                  status={
                    item.lifecycle.lifecycle === 'in-review'
                      ? 'open'
                      : item.lifecycle.lifecycle === 'done'
                        ? 'archived'
                        : null
                  }
                />
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No {CHANGES_LABEL} yet</Text>
              <Text style={styles.emptyText}>
                Go back to {title} and ask an Agent to start work.
              </Text>
            </View>
          }
        />
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28 },
    loading: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 10,
      letterSpacing: 1,
    },
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { ...Typography.default(), color: hull.textPrimary, fontSize: 30 },
    headerCopy: { flex: 1, minWidth: 0 },
    eyebrow: { ...Typography.mono(), color: hull.textMuted, fontSize: 9 },
    title: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 18 },
    count: { ...Typography.mono('semiBold'), color: hull.chrome, fontSize: 12 },
    modelPanel: { margin: 12, padding: 12, gap: 5 },
    modelTitle: { ...Typography.mono('semiBold'), color: hull.chrome, fontSize: 9 },
    modelText: { ...Typography.default(), color: hull.textMuted, fontSize: 11, lineHeight: 16 },
    errorPanel: { paddingHorizontal: 16, paddingVertical: 8 },
    error: { ...Typography.default(), color: hull.danger, fontSize: 11, textAlign: 'center' },
    row: {
      minHeight: 70,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 14 },
    agent: { ...Typography.default(), color: hull.textMuted, fontSize: 11, marginTop: 3 },
    chevron: { ...Typography.default(), color: hull.textMuted, fontSize: 22 },
    emptyContainer: { flexGrow: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    emptyTitle: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 17 },
    emptyText: {
      ...Typography.default(),
      color: hull.textMuted,
      fontSize: 12,
      textAlign: 'center',
    },
  };
});
