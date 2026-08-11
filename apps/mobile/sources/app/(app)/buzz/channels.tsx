import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Share, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community, Identity } from '@beeline/buzz-client';
import {
  DEFAULT_RELAY_URL,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { saveLastViewedChannel } from '@/buzz/community-storage';
import { createCommunityInviteUrl } from '@/buzz/community-invite';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { latestRoomMessage } from '@/buzz/room-list-summary';
import { cornerStatusPresentation, sortCorners, type CornerSummary } from '@/buzz/corners';
import {
  CHANGES_LABEL,
  CORNER_LABEL,
  ROOM_LABEL,
  ROOMS_LABEL,
  WORKSPACE_LABEL,
} from '@/buzz/vocabulary';
import { CommunityInviteEntry } from '@/components/buzz/CommunityInviteEntry';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import type { SessionSummary } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import {
  BrittlePress,
  HullSurface,
  PixelGateReveal,
  PixelLoader,
} from '@/components/buzz/MonoHull';

type ChannelDisplayItem = SessionSummary & {
  archived?: boolean;
  parentChannelId?: string;
  corners?: CornerSummary[];
  latestMessage?: string;
  participantCount?: number;
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function channelSummary(
  transport: BuzzRigTransport,
  channelId: string,
): Promise<ChannelDisplayItem> {
  const client = await transport.ensureClient();
  const metadata = await client.getChannelMetadata(channelId);
  return {
    id: channelId,
    active: !metadata?.archived,
    title: metadata?.name ?? `${ROOM_LABEL.toLowerCase()} ${channelId.slice(0, 8)}`,
    updatedAt: metadata?.raw?.created_at,
    createdAt: metadata?.raw?.created_at,
    archived: metadata?.archived,
  };
}

async function loadDisplayChannels(
  transport: BuzzRigTransport,
  activeCommunityId: string | null,
  communities: Community[],
): Promise<ChannelDisplayItem[]> {
  const client = await transport.ensureClient();
  let list: ChannelDisplayItem[];

  if (activeCommunityId) {
    const ids = await client.communityChannels(activeCommunityId);
    list = await Promise.all(ids.map((id) => channelSummary(transport, id)));
  } else {
    const all = await transport.sessionsRead();
    const communityIds = new Set(communities.map((community) => community.communityId));
    const memberships = await Promise.all(
      all.map(async (channel) => ({
        channel,
        communityId: await client.getChannelCommunityId(channel.id),
      })),
    );
    list = memberships
      .filter(({ channel, communityId }) => !communityId && !communityIds.has(channel.id))
      .map(({ channel }) => ({ ...channel }));
  }

  const allItems: ChannelDisplayItem[] = [];

  await Promise.all(
    list.map(async (channel) => {
      try {
        const parentId = await transport.getParentChannelId(channel.id);
        const archived = channel.archived ?? (await transport.isChannelArchived(channel.id));
        const item = { ...channel, archived, parentChannelId: parentId ?? undefined };
        allItems.push(item);
      } catch {
        allItems.push(channel);
      }
    }),
  );

  const rooms = allItems.filter((item) => !item.parentChannelId);
  await Promise.all(
    rooms.map(async (room) => {
      const [corners, events, members] = await Promise.allSettled([
        transport.listSubchannelLifecycle(room.id),
        transport.sessionEventsBackfill(room.id, { limit: 30 }),
        client.listMembers(room.id),
      ]);
      room.corners = corners.status === 'fulfilled' ? sortCorners(corners.value) : [];
      room.latestMessage =
        events.status === 'fulfilled' ? (latestRoomMessage(events.value) ?? undefined) : undefined;
      room.participantCount = members.status === 'fulfilled' ? members.value.length : 0;
    }),
  );

  return rooms.sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
}

export default function BuzzChannels() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    inviteUrl?: string | string[];
  }>();
  const requestedCommunity = firstParam(params.communityId);
  const inviteUrl = firstParam(params.inviteUrl);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(null);
  const [personalWorkspaceId, setPersonalWorkspaceId] = useState<string | null>(null);
  const [displayChannels, setDisplayChannels] = useState<ChannelDisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | undefined>();
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [readyInviteUrl, setReadyInviteUrl] = useState<string | undefined>(inviteUrl);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);

  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === activeCommunityId) ?? null,
    [communities, activeCommunityId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const url = await getEffectiveRelayUrl();
        const nextTransport = new BuzzRigTransport(currentIdentity, url);
        const client = await nextTransport.ensureClient();
        const [workspaceContext, identityIsAgent] = await Promise.all([
          prepareWorkspaceContext(client, currentIdentity.publicKey, requestedCommunity),
          client.isAgentIdentity(currentIdentity.publicKey),
        ]);
        const {
          workspaces: available,
          activeWorkspaceId: active,
          personalWorkspaceId: personal,
        } = workspaceContext;
        const viewerProfile = active
          ? await client.getPersonProfile(active, currentIdentity.publicKey)
          : null;
        const channels = await loadDisplayChannels(nextTransport, active, available);
        if (!cancelled) {
          setIdentity(currentIdentity);
          setRelayUrl(url);
          setTransport(nextTransport);
          setCommunities(available);
          setActiveCommunityId(active);
          setPersonalWorkspaceId(personal);
          setDisplayChannels(channels);
          setViewerIsAgent(identityIsAgent);
          setViewerAvatarUrl(viewerProfile?.avatar);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestedCommunity]);

  const handleSelectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    setReadyInviteUrl(undefined);
    setExpandedRoomId(null);
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!transport || !identity) return;
    setRefreshing(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const {
        workspaces: available,
        activeWorkspaceId: active,
        personalWorkspaceId: personal,
      } = await prepareWorkspaceContext(client, identity.publicKey, activeCommunityId ?? undefined);
      setCommunities(available);
      setActiveCommunityId(active);
      setPersonalWorkspaceId(personal);
      setDisplayChannels(await loadDisplayChannels(transport, active, available));
      setViewerAvatarUrl(
        active ? (await client.getPersonProfile(active, identity.publicKey))?.avatar : undefined,
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshing(false);
    }
  }, [activeCommunityId, identity, transport]);

  // A newly-created Workspace is already relay-backed, but device Back can reveal
  // an older mounted home screen. Refresh on focus so its switcher is never stale.
  useFocusEffect(
    useCallback(() => {
      if (!transport || !identity) return;
      void handleRefresh();
    }, [handleRefresh, identity, transport]),
  );

  const handleRoomPress = useCallback(
    async (channel: ChannelDisplayItem) => {
      if (identity) {
        await saveLastViewedChannel(identity.publicKey, activeCommunityId, channel.id);
      }
      router.push(`/buzz/chat/${encodeURIComponent(channel.id)}` as Href);
    },
    [activeCommunityId, identity],
  );

  const handleCreateChannel = useCallback(async () => {
    const name = channelName.trim();
    if (!name || !transport || viewerIsAgent) return;
    setCreatingChannel(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const channelId = await client.createChannel(name, {
        ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
      });
      await client.waitUntilMember(channelId, client.identity.publicKey);
      setChannelName('');
      setShowCreateChannel(false);
      setDisplayChannels(await loadDisplayChannels(transport, activeCommunityId, communities));
    } catch (err) {
      setError(`Could not create ${ROOM_LABEL}: ${String(err)}`);
    } finally {
      setCreatingChannel(false);
    }
  }, [activeCommunityId, channelName, communities, transport, viewerIsAgent]);

  const handleInvitePeople = useCallback(async () => {
    if (!transport || !activeCommunityId || creatingInvite) return;
    setCreatingInvite(true);
    setError(null);
    try {
      const url =
        readyInviteUrl ??
        (await createCommunityInviteUrl(
          await transport.ensureClient(),
          activeCommunityId,
          relayUrl,
        ));
      setReadyInviteUrl(url);
      await Share.share({ message: url });
    } catch (err) {
      setError(`Could not create invite: ${String(err)}`);
    } finally {
      setCreatingInvite(false);
    }
  }, [activeCommunityId, creatingInvite, readyInviteUrl, relayUrl, transport]);

  if (loading && !transport) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loadingText}>CONNECTING TO RELAY</Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleSelectCommunity}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={viewerAvatarUrl}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
          <CommunityDrawerTrigger community={activeCommunity} />
          <View style={styles.headerIdentity}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {activeCommunity?.name ?? WORKSPACE_LABEL}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {activeCommunityId && (
              <TouchableOpacity
                accessibilityLabel={`${WORKSPACE_LABEL} Agents`}
                onPress={() =>
                  router.push(
                    `/buzz/agents?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                  )
                }
                style={styles.iconButton}
              >
                <Text style={styles.iconButtonText}>⌬</Text>
              </TouchableOpacity>
            )}
            {!viewerIsAgent && (
              <TouchableOpacity
                accessibilityLabel={`Create ${ROOM_LABEL}`}
                onPress={() => setShowCreateChannel((value) => !value)}
                style={styles.iconButton}
              >
                <Text style={styles.iconButtonText}>＋</Text>
              </TouchableOpacity>
            )}
          </View>
        </HullSurface>

        {showCreateChannel && !viewerIsAgent && (
          <PixelGateReveal style={styles.actionPanel}>
            <Text style={styles.panelTitle}>
              New {ROOM_LABEL} in {activeCommunity?.name ?? WORKSPACE_LABEL}
            </Text>
            <View style={styles.inlineForm}>
              <TextInput
                autoFocus
                style={styles.input}
                value={channelName}
                onChangeText={setChannelName}
                onSubmitEditing={() => void handleCreateChannel()}
                placeholder={`${ROOM_LABEL.toLowerCase()} name`}
                placeholderTextColor={groknight.dim}
                editable={!creatingChannel}
              />
              <TouchableOpacity
                style={[styles.primarySmallButton, !channelName.trim() && styles.disabled]}
                disabled={!channelName.trim() || creatingChannel}
                onPress={() => void handleCreateChannel()}
              >
                <Text style={styles.primarySmallButtonText}>
                  {creatingChannel ? 'Creating…' : `Create ${ROOM_LABEL}`}
                </Text>
              </TouchableOpacity>
            </View>
          </PixelGateReveal>
        )}

        {error && (
          <View accessibilityRole="alert" style={styles.errorPanel}>
            <Text style={styles.errorLabel}>! ERROR</Text>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <TouchableOpacity onPress={() => void handleRefresh()}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={displayChannels}
          keyExtractor={(item) => item.id}
          contentContainerStyle={
            displayChannels.length === 0 ? styles.emptyContainer : styles.listContent
          }
          ListHeaderComponent={
            displayChannels.length > 0 ? (
              <CommunityInviteEntry
                community={activeCommunity}
                creatingInvite={creatingInvite}
                allowPeopleInvites={activeCommunityId !== personalWorkspaceId}
                onInvitePeople={() => void handleInvitePeople()}
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyGlyph}>⌁</Text>
              <Text style={styles.emptyTitle}>No {ROOMS_LABEL.toLowerCase()} yet</Text>
              <Text style={styles.emptySubtitle}>
                {activeCommunity
                  ? `Start a focused place for steering and review.`
                  : `${WORKSPACE_LABEL} setup is still finishing.`}
              </Text>
              {!viewerIsAgent && !showCreateChannel && (
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => setShowCreateChannel(true)}
                >
                  <Text style={styles.primaryButtonText}>New {ROOM_LABEL.toLowerCase()}</Text>
                </TouchableOpacity>
              )}
              <CommunityInviteEntry
                community={activeCommunity}
                creatingInvite={creatingInvite}
                allowPeopleInvites={activeCommunityId !== personalWorkspaceId}
                showManageAgents
                onInvitePeople={() => void handleInvitePeople()}
                onManageAgents={() =>
                  activeCommunityId &&
                  router.push(
                    `/buzz/agents?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                  )
                }
              />
            </View>
          }
          renderItem={({ item }) => {
            const corners = item.corners ?? [];
            const hasLiveCorner = corners.some((corner) => corner.status === 'live');
            const title = item.title ?? `${ROOM_LABEL.toLowerCase()} ${item.id.slice(0, 8)}`;
            const expanded = expandedRoomId === item.id;
            return (
              <View style={[styles.roomCell, expanded && styles.roomCellExpanded]}>
                <View style={styles.roomRow}>
                  <BrittlePress
                    accessibilityHint={`Long press to reveal ${CORNER_LABEL.toLowerCase()}s`}
                    accessibilityLabel={`Open ${title} chat`}
                    contentStyle={styles.channelItem}
                    delayLongPress={350}
                    onLongPress={() =>
                      setExpandedRoomId((current) => (current === item.id ? null : item.id))
                    }
                    onPress={() => void handleRoomPress(item)}
                    style={styles.roomPrimary}
                  >
                    <Text style={styles.channelIcon}>{item.archived ? '□' : '#'}</Text>
                    <View style={styles.channelInfo}>
                      <View style={styles.channelTitleRow}>
                        <Text
                          numberOfLines={1}
                          style={[styles.channelTitle, item.archived && styles.archivedTitle]}
                        >
                          {title}
                        </Text>
                        {item.archived && <Text style={styles.metaTag}>archived</Text>}
                      </View>
                      <View style={styles.roomMetaRow}>
                        <Text numberOfLines={1} style={styles.latestMessage}>
                          {item.latestMessage ?? 'No messages yet'}
                        </Text>
                        <Text style={styles.participantCount}>◇ {item.participantCount ?? 0}</Text>
                      </View>
                    </View>
                  </BrittlePress>
                  <TouchableOpacity
                    accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${corners.length} ${
                      corners.length === 1 ? CORNER_LABEL : CHANGES_LABEL
                    } in ${title}${hasLiveCorner ? ', live corner present' : ''}`}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() =>
                      setExpandedRoomId((current) => (current === item.id ? null : item.id))
                    }
                    style={styles.cornerPeekButton}
                    testID={`room-corners-toggle-${item.id}`}
                  >
                    <Text style={[styles.cornerPeekCount, hasLiveCorner && styles.liveMarker]}>
                      {hasLiveCorner ? '◆' : '◇'} {corners.length}
                    </Text>
                    <Text style={styles.cornerPeekChevron}>{expanded ? '⌃' : '⌄'}</Text>
                  </TouchableOpacity>
                </View>
                {expanded && (
                  <PixelGateReveal style={styles.cornerDropdown}>
                    {corners.length === 0 ? (
                      <Text style={styles.noCorners}>No corners in this room</Text>
                    ) : (
                      corners.map((corner) => {
                        const status = cornerStatusPresentation(corner.status);
                        return (
                          <TouchableOpacity
                            accessibilityLabel={`Open #${corner.name}, ${status.label}`}
                            key={corner.id}
                            onPress={() =>
                              router.push(`/buzz/chat/${encodeURIComponent(corner.id)}` as Href)
                            }
                            style={styles.cornerRow}
                          >
                            <Text numberOfLines={1} style={styles.cornerName}>
                              └ #{corner.name}
                            </Text>
                            <Text style={styles.cornerStatus}>
                              {status.glyph} {status.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })
                    )}
                    <TouchableOpacity
                      accessibilityLabel={`Browse all corners in ${title}`}
                      onPress={() =>
                        router.push(`/buzz/corners/${encodeURIComponent(item.id)}` as Href)
                      }
                      style={styles.allCornersRow}
                    >
                      <Text style={styles.allCornersText}>All corners ›</Text>
                    </TouchableOpacity>
                  </PixelGateReveal>
                )}
              </View>
            );
          }}
          onRefresh={() => void handleRefresh()}
          refreshing={refreshing}
        />
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0, backgroundColor: groknight.bgTerminal },
  center: { alignItems: 'center', justifyContent: 'center' },
  loadingText: {
    ...Typography.mono('semiBold'),
    marginTop: 12,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: groknight.bgBase,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  headerIdentity: { flex: 1, minWidth: 0 },
  headerTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  headerActions: { flexDirection: 'row', gap: 2, marginLeft: 8 },
  iconButton: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonText: { ...Typography.default(), color: groknight.steel, fontSize: 17 },
  actionPanel: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  panelTitle: {
    ...Typography.default('semiBold'),
    marginBottom: 9,
    color: groknight.textPrimary,
    fontSize: 15,
  },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.border,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 13,
  },
  panelActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  primarySmallButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.actionFill,
  },
  primarySmallButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textInverted,
    fontSize: 13,
  },
  disabled: { backgroundColor: groknight.bgBase, borderWidth: 1, borderColor: groknight.border },
  errorPanel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: groknight.bgHighlight,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderStrong,
  },
  errorLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  errorText: { ...Typography.default(), color: groknight.chrome, fontSize: 11, lineHeight: 16 },
  retryText: {
    ...Typography.default('semiBold'),
    marginTop: 5,
    color: groknight.textSecondary,
    fontSize: 11,
  },
  listContent: { paddingVertical: 4 },
  roomCell: {
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  roomCellExpanded: { backgroundColor: groknight.bgBase },
  roomRow: { minWidth: 0, flexDirection: 'row', alignItems: 'stretch' },
  roomPrimary: { flex: 1, minWidth: 0 },
  channelItem: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  channelIcon: {
    ...Typography.default('semiBold'),
    width: 25,
    color: groknight.steel,
    fontSize: 15,
  },
  channelInfo: { flex: 1, minWidth: 0 },
  channelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  channelTitle: {
    ...Typography.default('semiBold'),
    flexShrink: 1,
    color: groknight.textPrimary,
    fontSize: 14,
  },
  archivedTitle: { color: groknight.muted },
  metaTag: {
    ...Typography.default(),
    paddingHorizontal: 5,
    paddingVertical: 2,
    color: groknight.steel,
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    fontSize: 11,
    lineHeight: 15,
  },
  roomMetaRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  latestMessage: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  participantCount: {
    ...Typography.mono('semiBold'),
    color: groknight.steel,
    fontSize: 10,
    lineHeight: 14,
  },
  liveMarker: {
    color: groknight.signalMid,
  },
  cornerPeekButton: {
    width: 58,
    minHeight: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: groknight.border,
  },
  cornerPeekCount: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  cornerPeekChevron: {
    ...Typography.default('semiBold'),
    marginTop: 1,
    color: groknight.steel,
    fontSize: 15,
    lineHeight: 18,
  },
  cornerDropdown: {
    paddingLeft: 40,
    paddingRight: 12,
    paddingBottom: 7,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  cornerRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cornerName: {
    ...Typography.default('semiBold'),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 12,
  },
  cornerStatus: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  noCorners: {
    ...Typography.default(),
    minHeight: 42,
    paddingTop: 13,
    color: groknight.textMuted,
    fontSize: 12,
  },
  allCornersRow: { minHeight: 42, alignItems: 'flex-start', justifyContent: 'center' },
  allCornersText: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 12,
  },
  emptyContainer: { flexGrow: 1 },
  emptyState: { flex: 1, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  emptyGlyph: {
    ...Typography.default(),
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 12,
    color: groknight.steel,
    fontSize: 26,
    lineHeight: 42,
    textAlign: 'center',
  },
  emptyTitle: {
    ...Typography.default('semiBold'),
    marginTop: 12,
    color: groknight.textPrimary,
    fontSize: 16,
    textAlign: 'center',
  },
  emptySubtitle: {
    ...Typography.default(),
    marginTop: 7,
    color: groknight.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 18,
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.actionFill,
  },
  primaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textInverted,
    fontSize: 13,
  },
});
