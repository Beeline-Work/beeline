import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SurfaceRefreshScheduler,
  isChatListView,
  isWorkspaceListView,
  isWorkspaceView,
  type ChatListItem,
  type ChatListView,
  type CornerListItem,
  type GitHubInstallationAccess,
  type Identity,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import { workspaceRailItem, type WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { compactRelativeTime } from '@/buzz/relative-time';
import { cornerHref } from '@/buzz/corner-navigation';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { claimFirstLaunchLanding, welcomeRoomHref } from '@/buzz/welcome-landing';
import {
  displayCornerTitle,
  expandedCornerRefreshAction,
  roomRowName,
  roomRowNeedsAttention,
  roomRowPreview,
} from '@/buzz/room-list-row';
import { formatRoomCornerCount } from '@/buzz/vocabulary';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import {
  MEMBERS_LABEL,
  ROOM_LABEL,
  WORKSPACE_LABEL,
  ROOMS_LABEL,
} from '@/buzz/vocabulary';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { DirectMessagePickerSheet } from '@/components/buzz/DirectMessagePickerSheet';
import { HullDialog, HullDialogInput } from '@/components/buzz/HullDialog';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import { RepoPicker } from '@/components/buzz/RepoPicker';
import {
  RoomDeckComposeMenu,
  type RoomDeckComposeAction,
} from '@/components/buzz/RoomDeckComposeMenu';
import { BuzzRigTransport } from '@/sync/transport';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';

const AGE_TICK_MS = 60_000;
const COMPOSE_FAB_CLEARANCE = 80;
/** The empty deck's one primary: the same 44pt touch height as the FAB. */
const EMPTY_PRIMARY_HEIGHT = 44;
/** Speakeasy index row: 64 tall, a 40px leading unit. A DM row fills it with
 *  the peer's identity tile; a Room row leaves it empty (C71: a Room is many
 *  voices, its `#name` sigil is the mark) so every row's copy hangs off ONE
 *  straight edge. */
const ROW_HEIGHT = 64;
const ROW_TILE_SIZE = 40;
/** The trailing brass unread/attention square — lit or reserved, never absent. */
const ATTENTION_SQUARE = 7;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function openCornerItems(corners: readonly CornerListItem[]): CornerListItem[] {
  return corners.filter((item) => item.lifecycle.lifecycle !== 'done');
}

function cornerStatusWord(item: CornerListItem): string {
  return item.lifecycle.lifecycle;
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
      ...(member.identity.face ? { face: member.identity.face } : {}),
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
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const [repoCandidates, setRepoCandidates] = useState<RepoCandidate[]>([]);
  const [repoInstallations, setRepoInstallations] = useState<GitHubInstallationAccess[]>([]);
  const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [cornersByRoom, setCornersByRoom] = useState<Record<string, readonly CornerListItem[]>>({});
  const [cornerLoadingRoomId, setCornerLoadingRoomId] = useState<string | null>(null);
  const [cornerLoadErrors, setCornerLoadErrors] = useState<Record<string, string>>({});
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
        router.replace('/beeline/onboarding');
        return;
      }
      if (getBuzzRuntimeConfig().monolithEnabled) {
        // An identity's first launch opens #welcome in Beeline Welcome above
        // the deck; the deck keeps loading underneath so Back lands on it.
        const landing = await claimFirstLaunchLanding(nextIdentity.publicKey);
        if (landing && !cancelled) {
          await saveActiveCommunityId(nextIdentity.publicKey, landing.workspaceId);
          router.push(welcomeRoomHref(landing) as Href);
        }
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
              pathname: '/beeline/channels',
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
      router.push(`/beeline/chat/${encodeURIComponent(roomId)}` as Href);
    },
    [activeCommunityId, identity],
  );

  const loadRoomCorners = useCallback(
    async (roomId: string) => {
      if (!identity || !relayUrl) {
        setCornerLoadErrors((current) => ({
          ...current,
          [roomId]: 'Corner navigation is still connecting. Try again.',
        }));
        return;
      }
      setCornerLoadingRoomId(roomId);
      setCornerLoadErrors((current) => {
        const next = { ...current };
        delete next[roomId];
        return next;
      });
      try {
        const view = await new RoomViewClient({ baseUrl: relayUrl, identity }).corners(roomId);
        setCornersByRoom((current) => ({ ...current, [roomId]: openCornerItems(view.corners) }));
      } catch (reason) {
        setCornerLoadErrors((current) => ({
          ...current,
          [roomId]: `Could not load corners: ${String(reason)}`,
        }));
      } finally {
        setCornerLoadingRoomId((current) => (current === roomId ? null : current));
      }
    },
    [identity, relayUrl],
  );

  const toggleRoomCorners = useCallback((roomId: string) => {
    setExpandedRoomId((current) => (current === roomId ? null : roomId));
  }, []);

  useEffect(() => {
    const action = expandedCornerRefreshAction(expandedRoomId, chatList?.chats ?? []);
    if (action.kind === 'reload') {
      void loadRoomCorners(action.roomId);
      return;
    }
    if (action.kind === 'drop') {
      setExpandedRoomId(null);
      setCornersByRoom((current) => {
        const next = { ...current };
        delete next[action.roomId];
        return next;
      });
    }
  }, [chatList, expandedRoomId, loadRoomCorners]);

  const selectWorkspace = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId) return;
      if (identity) void saveActiveCommunityId(identity.publicKey, workspaceId);
      router.replace({ pathname: '/beeline/channels', params: { communityId: workspaceId } });
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

  const loadRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId) return;
      const access = await transport.workspaceGitHubAccess({ refresh });
      setRepoCandidates(access.candidates);
      setRepoInstallations(access.installations);
      setRepoPickerError(
        access.githubReconnectNeeded
          ? 'GitHub sign-in expired — reconnect GitHub in Settings to see new repositories.'
          : null,
      );
    },
    [activeCommunityId, transport],
  );

  const handleToggleRepoPicker = useCallback(async () => {
    setShowRepoPicker((value) => !value);
    if (showRepoPicker || !transport || !activeCommunityId) return;
    setRepoPickerError(null);
    try {
      await loadRepoPicker(true);
    } catch (reason) {
      setRepoPickerError('Could not load repos. Check your connection and try again.');
    }
  }, [activeCommunityId, loadRepoPicker, showRepoPicker, transport]);

  const handleSelectRepoCandidate = useCallback((candidate: RepoCandidate) => {
    setPendingRepo(candidate);
    setShowRepoPicker(false);
    setRepoPickerError(null);
  }, []);

  const createRoom = useCallback(async () => {
    const name = roomName.trim();
    if (!name || !transport || !activeCommunityId || !pendingRepo || creatingRoom) return;
    setCreatingRoom(true);
    setError(null);
    let publishAcknowledged = false;
    try {
      await transport.createRoom(name, {
        communityId: activeCommunityId,
        repository: pendingRepo,
        onPublished: () => {
          publishAcknowledged = true;
          setRoomName('');
          setPendingRepo(null);
          setShowRepoPicker(false);
          setShowCreateRoom(false);
          chatScheduler.current?.force();
        },
      });
      if (!publishAcknowledged) {
        setRoomName('');
        setPendingRepo(null);
        setShowRepoPicker(false);
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
  }, [activeCommunityId, creatingRoom, pendingRepo, roomName, transport]);

  const compose = useCallback(
    (action: RoomDeckComposeAction) => {
      runRoomDeckComposeAction(action, {
        communityId: activeCommunityId,
        openMessagePicker: () => setMemberPickerVisible(true),
        openRoomCreator: () => setShowCreateRoom(true),
        invitePerson: () =>
          router.push({
            pathname: '/beeline/members',
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

  if (workspaceList?.workspaces.length === 0) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]} testID="workspace-list-empty">
        <Text style={styles.emptyTitle}>No Rooms yet</Text>
        <Text style={styles.emptyCopy}>Create a Workspace to start adding Rooms.</Text>
        <MonoButton
          label="CREATE WORKSPACE"
          onPress={() => router.push('/beeline/community' as Href)}
          testID="empty-create-workspace"
        />
      </View>
    );
  }
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
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({ pathname: '/beeline/settings/workspace', params: { communityId } } as never)
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={chatList.viewer.avatar}
      viewerFace={chatList.viewer.face}
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
                  pathname: '/beeline/members',
                  params: { communityId: activeCommunityId },
                } as never)
              }
              style={styles.headerAction}
              testID="workspace-members"
            >
              <Text style={styles.headerActionText}>
                {MEMBERS_LABEL.toUpperCase()}
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
              disabled: !roomName.trim() || !pendingRepo || creatingRoom,
              busy: creatingRoom,
              variant: 'primary',
              testID: 'create-room-submit',
            },
          ]}
          body={`In ${activeCommunity?.name ?? WORKSPACE_LABEL}. One Room, one repo.`}
          onRequestClose={() => setShowCreateRoom(false)}
          surfaceStyle={styles.createRoomDialog}
          testID="new-room-dialog"
          title={`New ${ROOM_LABEL}`}
          visible={showCreateRoom}
        >
          <View style={styles.createRoomContent}>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={creatingRoom}
              onPress={() => void handleToggleRepoPicker()}
              style={styles.repoRow}
              testID="create-room-repo-row"
            >
              <Text style={styles.repoRowLabel}>REPO</Text>
              <Text numberOfLines={1} style={styles.repoRowValue}>
                {pendingRepo ? `▢ ${pendingRepo.name}` : 'Choose a repository'}
              </Text>
              <Text style={styles.repoRowChevron}>{showRepoPicker ? '⌄' : '›'}</Text>
            </TouchableOpacity>
            {showRepoPicker && (
              <RepoPicker
                candidates={repoCandidates}
                currentKey={pendingRepo?.key ?? null}
                error={repoPickerError}
                installations={repoInstallations}
                onSelect={handleSelectRepoCandidate}
                testIDPrefix="create-room-repo-picker"
              />
            )}
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
          </View>
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
            // One quiet block in the upper third of the deck, not a hero in
            // the void: the FAB already anchors the bottom. Exactly one
            // obviously tappable primary (a 44pt content-width brass button,
            // sentence case) and a quiet brass text link beside it — never a
            // second box, never a tracked-uppercase label (those are section
            // heads only).
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No Rooms yet</Text>
              <Text style={styles.emptyCopy}>Start a Room to begin.</Text>
              {!viewerIsAgent && (
                <View style={styles.emptyActions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => setShowCreateRoom(true)}
                    style={styles.emptyPrimary}
                    testID="empty-add-room"
                  >
                    <Text style={styles.emptyPrimaryLabel}>Start a Room</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="link"
                    onPress={() => compose('agent')}
                    style={styles.emptyLink}
                    testID="empty-invite-agent"
                  >
                    <Text style={styles.emptyLinkLabel}>Invite an agent</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          }
          renderItem={({ item }: { item: ChatListItem }) => {
            // Every row-level fact is derived once in room-list-row.ts: the
            // sigil and name (`@peer` for a DM, `#room` for a Room), the tile
            // seed, the preview attribution, and whether the trailing brass
            // square is lit. `unread` is server-owned and cross-device; a
            // corner waiting on a human (`agentState === 'needs-you'`) lights
            // the same square. The screen renders answers, never re-derives.
            const heading = roomRowName(item);
            const preview = roomRowPreview(item, chatList.viewer.pubkey);
            const attention = roomRowNeedsAttention(item);
            const title = `${heading.sigil}${heading.name}`;
            const age = compactRelativeTime(
              item.latestMessage?.createdAt ?? item.room.updatedAt,
              ageNow,
            );
            const cornerCount = formatRoomCornerCount(item.cornerCount);
            const expanded = expandedRoomId === item.room.id;
            const corners = cornersByRoom[item.room.id];
            return (
              <View style={styles.roomCell}>
                <View style={styles.row}>
                  <TouchableOpacity
                    accessibilityLabel={`${title}${attention ? ', needs you' : ''}`}
                    testID={`room-${item.room.id}`}
                    onPress={() => openRoom(item.room.id)}
                    style={styles.rowMain}
                  >
                    {heading.tile && (
                      <IdentityMark
                        kind={heading.tile.kind}
                        seed={heading.tile.seed}
                        name={heading.name}
                        size={ROW_TILE_SIZE}
                        testID={`room-tile-${item.room.id}`}
                      />
                    )}
                    <View style={styles.rowCopy}>
                      <Text numberOfLines={1} style={styles.title}>
                        <Text style={styles.sigil} testID={`room-sigil-${item.room.id}`}>
                          {heading.sigil}
                        </Text>
                        {heading.name}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={styles.preview}
                        testID={`room-preview-${item.room.id}`}
                      >
                        {preview.attribution === 'self' && (
                          <Text style={styles.previewSelf}>you: </Text>
                        )}
                        {preview.attribution === 'other' && (
                          <Text style={styles.previewAuthor}>@{preview.handle}: </Text>
                        )}
                        {preview.text}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <View style={styles.gutter}>
                    <Text style={styles.age}>{age}</Text>
                    <View style={styles.attentionSlot} accessibilityElementsHidden>
                      {attention && (
                        <View
                          style={styles.attentionSquare}
                          testID={`room-attention-${item.room.id}`}
                        />
                      )}
                    </View>
                  </View>
                  <View style={styles.cornerToggleSlot}>
                    {item.cornerCount > 0 && (
                      <TouchableOpacity
                        accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${cornerCount} in ${title}`}
                        accessibilityRole="button"
                        accessibilityState={{ expanded }}
                        onPress={() => toggleRoomCorners(item.room.id)}
                        style={styles.cornerToggle}
                        testID={`room-corners-toggle-${item.room.id}`}
                      >
                        <Text style={styles.cornerToggleText}>{expanded ? '⌃' : '⌄'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
                {expanded && (
                  <View style={styles.cornerDropdown} testID={`room-corners-${item.room.id}`}>
                    {cornerLoadingRoomId === item.room.id && !corners ? (
                      <View style={styles.cornerLoading}>
                        <PixelLoader compact />
                        <Text style={styles.cornerLoadingText}>LOADING CORNERS</Text>
                      </View>
                    ) : cornerLoadErrors[item.room.id] ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() => void loadRoomCorners(item.room.id)}
                        style={styles.cornerNotice}
                        testID={`room-corners-retry-${item.room.id}`}
                      >
                        <Text style={styles.cornerNoticeText}>
                          {cornerLoadErrors[item.room.id]}
                        </Text>
                        <Text style={styles.cornerRetryText}>RETRY</Text>
                      </TouchableOpacity>
                    ) : corners?.length ? (
                      corners.map((corner) => {
                        const label = displayCornerTitle(
                          item.room.name,
                          corner.corner.name,
                          corner.corner.id,
                        );
                        const status = cornerStatusWord(corner);
                        return (
                          <TouchableOpacity
                            accessibilityLabel={`Open ${label}, ${status}`}
                            accessibilityRole="button"
                            key={corner.corner.id}
                            onPress={() =>
                              router.push(
                                cornerHref(
                                  corner.corner.id,
                                  item.room.id,
                                  corner.corner.name,
                                  'room-list',
                                ),
                              )
                            }
                            style={styles.cornerRow}
                            testID={`room-corner-${corner.corner.id}`}
                          >
                            <Text style={styles.cornerName}>└ {label}</Text>
                            <Text style={styles.cornerStatus}>{status}</Text>
                            <Text style={styles.cornerChevron}>›</Text>
                          </TouchableOpacity>
                        );
                      })
                    ) : (
                      <Text style={styles.cornerNoticeText}>No open corners now.</Text>
                    )}
                  </View>
                )}
              </View>
            );
          }}
        />
        {!viewerIsAgent && (
          <View
            pointerEvents="box-none"
            style={[styles.composeOverlay, { bottom: 16 + insets.bottom }]}
          >
            <RoomDeckComposeMenu onSelect={compose} />
          </View>
        )}
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
    createRoomDialog: { maxHeight: '88%' },
    createRoomContent: { flexShrink: 1, maxHeight: 520 },
    repoRow: {
      marginTop: 10,
      // A fixed height: on some devices a minimum height collapses until first tap.
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    repoRowLabel: { ...Typography.mono(), color: hull.textMuted, fontSize: 11 },
    repoRowValue: {
      ...Typography.mono(),
      flex: 1,
      minWidth: 0,
      textAlign: 'right',
      color: hull.textSecondary,
      fontSize: 12,
    },
    repoRowChevron: { ...Typography.default(), color: hull.chrome, fontSize: 18 },
    errorBar: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.danger,
    },
    error: { ...Typography.default(), color: hull.danger, fontSize: 12, textAlign: 'center' },
    // The list owns the whole deck. Its bottom inset lets the final row scroll
    // clear of the floating compose control without turning that control into
    // a visually separate footer cell.
    list: { paddingBottom: COMPOSE_FAB_CLEARANCE },
    emptyList: {
      flexGrow: 1,
      justifyContent: 'flex-start',
      paddingTop: hull.space.xxl,
      paddingBottom: COMPOSE_FAB_CLEARANCE,
    },
    empty: { alignItems: 'flex-start', gap: hull.space.sm, paddingHorizontal: hull.space.md },
    emptyTitle: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    emptyCopy: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    emptyActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      marginTop: hull.space.sm,
    },
    emptyPrimary: {
      height: EMPTY_PRIMARY_HEIGHT,
      alignSelf: 'flex-start',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
      backgroundColor: hull.accent,
      borderRadius: hull.radius,
    },
    emptyPrimaryLabel: {
      ...Typography.default('semiBold'),
      ...hull.type.bodyStrong,
      color: hull.textInverted,
    },
    emptyLink: { height: EMPTY_PRIMARY_HEIGHT, justifyContent: 'center' },
    emptyLinkLabel: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    roomCell: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    row: {
      minHeight: ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowMain: {
      flex: 1,
      minWidth: 0,
      minHeight: ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingLeft: 16,
      paddingVertical: 10,
    },
    rowCopy: { flex: 1, minWidth: 0, gap: 3 },
    // The row leads with the name: one size, one weight, the brightest thing
    // on the row. Ownership and unread never bold or enlarge it.
    title: {
      ...Typography.default('semiBold'),
      color: hull.textPrimary,
      fontSize: 18,
      lineHeight: 22,
    },
    // The sigil is the name's first glyph in brass: `@` for a DM, `#` for a Room.
    sigil: { ...Typography.default('semiBold'), color: hull.accent },
    preview: { ...Typography.default(), color: hull.ledgerQuiet, fontSize: 13, lineHeight: 17 },
    previewSelf: { ...Typography.default(), color: hull.textMuted },
    previewAuthor: { ...Typography.default(), color: hull.accent },
    // Age on top, the attention square under it; the square's slot is
    // reserved on every row so read-state changes never shift the column.
    gutter: {
      width: 46,
      minHeight: ROW_HEIGHT,
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 8,
      paddingRight: 4,
    },
    age: { ...Typography.mono(), color: hull.ledgerGhost, fontSize: 11 },
    // Reserved whether or not the row is lit, so the age stamp above never
    // shifts; the square itself only renders when the row wants the viewer.
    attentionSlot: { width: ATTENTION_SQUARE, height: ATTENTION_SQUARE },
    attentionSquare: {
      width: ATTENTION_SQUARE,
      height: ATTENTION_SQUARE,
      backgroundColor: hull.accent,
    },
    // Reserved whether or not the Room has corners, so the age column keeps
    // one straight right edge down the whole index.
    cornerToggleSlot: {
      width: 32,
      minHeight: ROW_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 8,
    },
    cornerToggle: {
      minWidth: 32,
      minHeight: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cornerToggleText: {
      ...Typography.mono('semiBold'),
      color: hull.chrome,
      fontSize: 16,
      lineHeight: 18,
    },
    cornerDropdown: {
      paddingLeft: 68,
      paddingRight: 16,
      paddingBottom: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    cornerLoading: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    cornerLoadingText: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 9,
      letterSpacing: 0.6,
    },
    cornerNotice: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    cornerNoticeText: {
      ...Typography.default(),
      flex: 1,
      color: hull.textMuted,
      fontSize: 11,
    },
    cornerRetryText: {
      ...Typography.mono('semiBold'),
      color: hull.chrome,
      fontSize: 9,
    },
    cornerRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    cornerName: {
      ...Typography.default('semiBold'),
      flex: 1,
      minWidth: 0,
      color: hull.textSecondary,
      fontSize: 12,
    },
    cornerStatus: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 8,
      letterSpacing: 0.35,
    },
    cornerChevron: {
      ...Typography.default('semiBold'),
      color: hull.steel,
      fontSize: 18,
    },
    composeOverlay: {
      position: 'absolute',
      right: 16,
    },
  };
});
