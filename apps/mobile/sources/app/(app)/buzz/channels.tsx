import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  RoomViewClient,
  SurfaceRefreshScheduler,
  isChatListView,
  isWorkspaceListView,
  isWorkspaceView,
  type ChatListItem,
  type ChatListView,
  type Identity,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import { workspaceRailItem, type WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { compactRelativeTime } from '@/buzz/relative-time';
import { displayRoomIndexTitle } from '@/buzz/room-list-row';
import { formatRoomParticipantTotal } from '@/buzz/room-participants';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import {
  MEMBERS_GLYPH,
  MEMBERS_LABEL,
  ROOM_LABEL,
  WORKSPACE_LABEL,
  ROOMS_LABEL,
} from '@/buzz/vocabulary';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { DirectMessagePickerSheet } from '@/components/buzz/DirectMessagePickerSheet';
import { HullDialog, HullDialogInput } from '@/components/buzz/HullDialog';
import { HullDeckMark, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import {
  RoomDeckComposeMenu,
  type RoomDeckComposeAction,
} from '@/components/buzz/RoomDeckComposeMenu';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';

const AGE_TICK_MS = 60_000;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function workspaceMembers(view: WorkspaceView | null): WorkspaceMemberDisplayItem[] {
  if (!view) return [];
  return [...view.members, ...view.agents]
    .filter((member) => member.identity.pubkey !== view.viewer.identity.pubkey)
    .map((member) => ({
      peerPubkey: member.identity.pubkey,
      peerName: member.identity.name,
      peerKind: member.identity.kind === 'agent' ? 'agent' : 'person',
      ...(member.identity.avatar ? { avatarUrl: member.identity.avatar } : {}),
      ...(member.identity.kind === 'human' ? { role: member.role } : {}),
    }));
}

export default function BuzzChannels() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const requestedWorkspaceId = firstParam(params.communityId);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [workspaceList, setWorkspaceList] = useState<WorkspaceListView | null>(null);
  const [chatList, setChatList] = useState<ChatListView | null>(null);
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [memberPickerVisible, setMemberPickerVisible] = useState(false);
  const [messagingPubkey, setMessagingPubkey] = useState<string | null>(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const chatScheduler = useRef<SurfaceRefreshScheduler<ChatListView> | null>(null);
  const workspaceScheduler = useRef<SurfaceRefreshScheduler<WorkspaceListView> | null>(null);

  const communities = useMemo(
    () => workspaceList?.workspaces.map(workspaceRailItem) ?? [],
    [workspaceList],
  );
  const activeCommunityId =
    requestedWorkspaceId ?? chatList?.workspace.id ?? communities[0]?.communityId ?? null;
  const activeCommunity =
    communities.find((entry) => entry.communityId === activeCommunityId) ?? null;
  const viewerIsAgent = chatList?.viewer.kind === 'agent';
  const canManageWorkspace =
    chatList?.workspace.role === 'owner' || chatList?.workspace.role === 'admin';

  const refreshNow = useCallback(() => {
    workspaceScheduler.current?.force();
    chatScheduler.current?.force();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeWorkspaces: (() => void) | undefined;
    let unsubscribeChats: (() => void) | undefined;
    let workspaceRefresh: SurfaceRefreshScheduler<WorkspaceListView> | undefined;
    let chatsRefresh: SurfaceRefreshScheduler<ChatListView> | undefined;
    void (async () => {
      setError(null);
      const nextIdentity = await loadBuzzIdentity();
      if (!nextIdentity) {
        router.replace('/buzz/onboarding');
        return;
      }
      const nextRelayUrl = await getEffectiveRelayUrl();
      if (cancelled) return;
      const nextTransport = new BuzzRigTransport(nextIdentity, nextRelayUrl);
      const http = new RoomViewClient({ baseUrl: nextRelayUrl, identity: nextIdentity });
      const relay = await nextTransport.ensureClient();
      if (cancelled) return;
      setIdentity(nextIdentity);
      setRelayUrl(nextRelayUrl);
      setTransport(nextTransport);

      const workspaceCacheAddress = surfaceAddress(
        nextRelayUrl,
        nextIdentity.publicKey,
        '/workspaces',
      );
      const storedWorkspaceId = await loadActiveCommunityId(nextIdentity.publicKey);
      const cachedWorkspaces = await mobileSurfaceCache.read(
        workspaceCacheAddress,
        isWorkspaceListView,
      );
      if (cancelled) return;
      if (cachedWorkspaces) setWorkspaceList(cachedWorkspaces);
      const selectedId =
        requestedWorkspaceId ?? storedWorkspaceId ?? cachedWorkspaces?.workspaces[0]?.id;
      const chatCacheAddress = selectedId
        ? surfaceAddress(nextRelayUrl, nextIdentity.publicKey, '/workspace/:id/chats', {
            workspaceId: selectedId,
          })
        : null;
      const cachedChats = chatCacheAddress
        ? await mobileSurfaceCache.read(chatCacheAddress, isChatListView)
        : null;
      if (cancelled) return;
      if (cachedChats) setChatList(cachedChats);

      workspaceRefresh = new SurfaceRefreshScheduler({
        fetch: () => http.workspaces(),
        apply: (value) => {
          setWorkspaceList(value);
          void mobileSurfaceCache.write(workspaceCacheAddress, value, isWorkspaceListView);
          if (
            value.workspaces[0]?.id &&
            (!selectedId || !value.workspaces.some((workspace) => workspace.id === selectedId))
          ) {
            router.replace({
              pathname: '/buzz/channels',
              params: { communityId: value.workspaces[0].id },
            } as never);
          }
        },
        onError: (reason) => setError(String(reason)),
      });
      workspaceScheduler.current = workspaceRefresh;

      if (selectedId && chatCacheAddress) {
        chatsRefresh = new SurfaceRefreshScheduler({
          fetch: () => http.chats(selectedId),
          apply: (value) => {
            setChatList(value);
            setRefreshing(false);
            setError(null);
            void mobileSurfaceCache.write(chatCacheAddress, value, isChatListView);
          },
          onError: (reason) => {
            setRefreshing(false);
            setError(String(reason));
          },
        });
        chatScheduler.current = chatsRefresh;
      }

      const workspaceListenReady = relay
        .surfaceSubscribe(
          cachedWorkspaces?.watchFilters ?? [
            { kinds: [9000, 9001, 9007], '#p': [nextIdentity.publicKey] },
          ],
          () => workspaceRefresh?.signal(),
        )
        .then((stop) => {
          if (cancelled) stop();
          else unsubscribeWorkspaces = stop;
        });
      const chatListenReady =
        chatsRefresh && selectedId
          ? relay
              .surfaceSubscribe(
                cachedChats?.watchFilters ?? [{ kinds: [9, 9000, 9001, 9007], '#h': [selectedId] }],
                () => chatsRefresh?.signal(),
              )
              .then((stop) => {
                if (cancelled) stop();
                else unsubscribeChats = stop;
              })
          : Promise.resolve();
      await Promise.all([
        workspaceRefresh.startAfter(workspaceListenReady),
        chatsRefresh?.startAfter(chatListenReady),
      ]);
    })().catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => {
      cancelled = true;
      unsubscribeWorkspaces?.();
      unsubscribeChats?.();
      workspaceRefresh?.dispose();
      chatsRefresh?.dispose();
      workspaceScheduler.current = null;
      chatScheduler.current = null;
    };
  }, [requestedWorkspaceId, retryGeneration]);

  useFocusEffect(
    useCallback(() => {
      refreshNow();
      setAgeNow(Date.now());
      const timer = setInterval(() => setAgeNow(Date.now()), AGE_TICK_MS);
      return () => clearInterval(timer);
    }, [refreshNow]),
  );

  useEffect(() => {
    if (!memberPickerVisible || !identity || !relayUrl || !activeCommunityId) return;
    let cancelled = false;
    const http = new RoomViewClient({ baseUrl: relayUrl, identity });
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', {
      workspaceId: activeCommunityId,
    });
    void mobileSurfaceCache
      .read(address, isWorkspaceView)
      .then((cached) => {
        if (!cancelled && cached) setWorkspaceDetail(cached);
        return http.workspace(activeCommunityId);
      })
      .then((value) => {
        if (cancelled) return;
        setWorkspaceDetail(value);
        return mobileSurfaceCache.write(address, value, isWorkspaceView);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [activeCommunityId, identity, memberPickerVisible, relayUrl]);

  const openRoom = useCallback(
    (roomId: string) => {
      if (identity) void saveLastViewedChannel(identity.publicKey, activeCommunityId, roomId);
      router.push(`/buzz/chat/${encodeURIComponent(roomId)}` as Href);
    },
    [activeCommunityId, identity],
  );

  const selectWorkspace = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId) return;
      if (identity) void saveActiveCommunityId(identity.publicKey, workspaceId);
      router.replace({ pathname: '/buzz/channels', params: { communityId: workspaceId } });
    },
    [identity],
  );

  const handleStartDirectMessage = useCallback(
    async (member: WorkspaceMemberDisplayItem) => {
      if (!transport || !activeCommunityId || messagingPubkey) return;
      setMessagingPubkey(member.peerPubkey);
      try {
        const room = await transport.resolveDirectMessage(activeCommunityId, member.peerPubkey);
        setMemberPickerVisible(false);
        openRoom(room.channelId);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setMessagingPubkey(null);
      }
    },
    [activeCommunityId, messagingPubkey, openRoom, transport],
  );

  const createRoom = useCallback(async () => {
    const name = roomName.trim();
    if (!name || !transport || !activeCommunityId || creatingRoom) return;
    setCreatingRoom(true);
    setError(null);
    let publishAcknowledged = false;
    try {
      const client = await transport.ensureClient();
      await client.createChannel(name, {
        communityId: activeCommunityId,
        mirrorCommunityMembers: true,
        onPublished: () => {
          publishAcknowledged = true;
          setRoomName('');
          setShowCreateRoom(false);
          chatScheduler.current?.force();
        },
      });
      if (!publishAcknowledged) {
        setRoomName('');
        setShowCreateRoom(false);
      }
      chatScheduler.current?.force();
    } catch (reason) {
      setError(
        publishAcknowledged
          ? `${ROOM_LABEL} created, but membership is still syncing: ${String(reason)}`
          : `Could not create ${ROOM_LABEL}: ${String(reason)}`,
      );
    } finally {
      setCreatingRoom(false);
    }
  }, [activeCommunityId, creatingRoom, roomName, transport]);

  const compose = useCallback(
    (action: RoomDeckComposeAction) => {
      runRoomDeckComposeAction(action, {
        communityId: activeCommunityId,
        openMessagePicker: () => setMemberPickerVisible(true),
        openRoomCreator: () => setShowCreateRoom(true),
        invitePerson: () =>
          router.push({
            pathname: '/buzz/members',
            params: {
              ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
              action: 'invite',
            },
          } as never),
        navigate: (target) => router.push(target as Href),
      });
    },
    [activeCommunityId],
  );

  if (!chatList && !error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loading}>LOADING ROOMS</Text>
      </View>
    );
  }
  if (!chatList) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{error}</Text>
        <MonoButton label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={selectWorkspace}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({ pathname: '/buzz/settings/workspace', params: { communityId } } as never)
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={chatList.viewer.avatar}
    >
      <View
        style={[styles.container, { paddingTop: insets.top }]}
        testID={refreshing ? 'room-list-refreshing' : 'room-list-idle'}
      >
        <View style={styles.header}>
          <CommunityDrawerTrigger community={activeCommunity} />
          {activeCommunityId && (
            <TouchableOpacity
              accessibilityLabel={`${WORKSPACE_LABEL} members`}
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: '/buzz/members',
                  params: { communityId: activeCommunityId },
                } as never)
              }
              style={styles.headerAction}
              testID="workspace-members"
            >
              <Text style={styles.headerActionText}>
                {MEMBERS_GLYPH} {MEMBERS_LABEL.toUpperCase()}
              </Text>
            </TouchableOpacity>
          )}
        </View>
        <HullDialog
          actions={[
            { label: 'Cancel', onPress: () => setShowCreateRoom(false), variant: 'quiet' },
            {
              label: creatingRoom ? 'Creating' : 'Create',
              onPress: () => void createRoom(),
              disabled: !roomName.trim() || creatingRoom,
              busy: creatingRoom,
              variant: 'primary',
              testID: 'create-room-submit',
            },
          ]}
          body={`In ${activeCommunity?.name ?? WORKSPACE_LABEL}.`}
          onRequestClose={() => setShowCreateRoom(false)}
          testID="new-room-dialog"
          title={`New ${ROOM_LABEL}`}
          visible={showCreateRoom}
        >
          <HullDialogInput
            accessibilityLabel={`${ROOM_LABEL} name`}
            autoFocus
            editable={!creatingRoom}
            onChangeText={setRoomName}
            onSubmitEditing={() => void createRoom()}
            placeholder="#room-name"
            testID="create-room-name"
            value={roomName}
          />
        </HullDialog>
        {!!error && (
          <TouchableOpacity onPress={refreshNow} style={styles.errorBar}>
            <Text style={styles.error}>{error}</Text>
          </TouchableOpacity>
        )}
        <FlatList
          testID="room-list"
          data={chatList.chats}
          keyExtractor={(item) => item.room.id}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            refreshNow();
          }}
          contentContainerStyle={chatList.chats.length ? styles.list : styles.emptyList}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No rooms yet</Text>
              <Text style={styles.emptyCopy}>Start a Room to begin.</Text>
            </View>
          }
          renderItem={({ item }: { item: ChatListItem }) => {
            const title = displayRoomIndexTitle(item.room.name) ?? item.room.name;
            const age = compactRelativeTime(
              item.latestMessage?.createdAt ?? item.room.updatedAt,
              ageNow,
            );
            return (
              <TouchableOpacity
                testID={`room-${item.room.id}`}
                onPress={() => openRoom(item.room.id)}
                style={[styles.row, item.unread && styles.rowUnread]}
              >
                <HullDeckMark state="idle" />
                <View style={styles.rowCopy}>
                  <View style={styles.rowHeading}>
                    <Text
                      numberOfLines={1}
                      style={[styles.title, item.unread && styles.titleUnread]}
                    >
                      {title}
                    </Text>
                    {!!item.repositoryName && (
                      <Text numberOfLines={1} style={styles.repo}>
                        {item.repositoryName}
                      </Text>
                    )}
                  </View>
                  <Text numberOfLines={1} style={styles.preview}>
                    {item.latestMessage?.text ?? 'No activity yet'}
                  </Text>
                  <Text style={styles.meta}>
                    {formatRoomParticipantTotal(item.memberCount)} · {item.cornerCount} changes
                  </Text>
                </View>
                <View style={styles.gutter}>
                  {item.unread ? (
                    <View style={styles.unread}>
                      <Text style={styles.unreadText}>NEW</Text>
                    </View>
                  ) : (
                    <Text style={styles.age}>{age}</Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
        <View style={[styles.footer, { paddingBottom: 16 + insets.bottom }]}>
          {!viewerIsAgent && <RoomDeckComposeMenu onSelect={compose} />}
        </View>
        <DirectMessagePickerSheet
          busyPubkey={messagingPubkey}
          members={workspaceMembers(workspaceDetail)}
          onClose={() => setMemberPickerVisible(false)}
          onMessage={(member) => void handleStartDirectMessage(member)}
          visible={memberPickerVisible}
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
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
      backgroundColor: hull.bgTerminal,
      paddingHorizontal: 28,
    },
    loading: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 10,
      letterSpacing: 1.2,
    },
    header: {
      minHeight: 62,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    headerAction: {
      minHeight: 44,
      minWidth: 44,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 8,
    },
    headerActionText: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 9,
      letterSpacing: 0.6,
    },
    errorBar: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.danger,
    },
    error: { ...Typography.default(), color: hull.danger, fontSize: 12, textAlign: 'center' },
    list: { paddingBottom: 20 },
    emptyList: { flexGrow: 1, justifyContent: 'center' },
    empty: { alignItems: 'center', gap: 8, padding: 24 },
    emptyTitle: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 18 },
    emptyCopy: { ...Typography.default(), color: hull.textMuted, fontSize: 12 },
    row: {
      minHeight: 92,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    rowUnread: { backgroundColor: hull.bgUnread },
    rowCopy: { flex: 1, minWidth: 0, gap: 4 },
    rowHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    title: {
      ...Typography.default('semiBold'),
      color: hull.textSecondary,
      fontSize: 15,
      flexShrink: 1,
    },
    titleUnread: { color: hull.textPrimary },
    repo: { ...Typography.mono(), color: hull.chrome, fontSize: 9, flexShrink: 1 },
    preview: { ...Typography.default(), color: hull.textMuted, fontSize: 12 },
    meta: { ...Typography.mono(), color: hull.steel, fontSize: 9 },
    gutter: { width: 42, alignItems: 'flex-end' },
    age: { ...Typography.mono(), color: hull.steel, fontSize: 9 },
    unread: { borderWidth: 1, borderColor: hull.chrome, paddingHorizontal: 5, paddingVertical: 2 },
    unreadText: { ...Typography.mono('semiBold'), color: hull.chrome, fontSize: 8 },
    footer: {
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
  };
});
