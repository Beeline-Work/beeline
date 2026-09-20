import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, SectionList, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  SurfaceRefreshScheduler,
  isChatListView,
  isRoomView,
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
import { beginRoomOpenPrefetch, dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import { workspaceRailItem, type WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { compactRelativeTime } from '@/buzz/relative-time';
import { cornerHref, navigateToRoom } from '@/buzz/corner-navigation';
import { cornerDisplayItems, cornerDisplayState } from '@/buzz/corner-display-state';
import {
  displayGroupedCornerTitle,
  expandedCornerRefreshAction,
  roomRowName,
  roomRowNeedsAttention,
  roomRowPreview,
  roomListSections,
  NO_ACTIVITY_PREVIEW,
} from '@/buzz/room-list-row';
import { formatRoomCornerCount } from '@/buzz/vocabulary';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import { MEMBERS_LABEL, ROOM_LABEL, WORKSPACE_LABEL, ROOMS_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { DirectMessagePickerSheet } from '@/components/buzz/DirectMessagePickerSheet';
import { ExitGlyph } from '@/components/buzz/ExitGlyph';
import { MembersGlyph } from '@/components/buzz/MembersGlyph';
import { BookmarksGlyph } from '@/components/buzz/BookmarksGlyph';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { MemberPickerSheet } from '@/components/buzz/MemberPickerSheet';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { NewRoomDialog } from '@/components/buzz/NewRoomDialog';
import { CornerWorkingPulse } from '@/components/buzz/CornerWorkingPulse';
import { MonoButton } from '@/components/buzz/MonoHull';
import { RoomDeckLoadingView } from '@/components/buzz/RoomDeckLoadingView';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import {
  RoomDeckComposeMenu,
  type RoomDeckComposeAction,
} from '@/components/buzz/RoomDeckComposeMenu';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useIsDesktop } from '@/utils/responsive';

const AGE_TICK_MS = 60_000;
const COMPOSE_FAB_CLEARANCE = 80;
const CONNECT_AGENT_COMMAND = 'npx usebeeline connect';
/** Speakeasy index row: 64 tall. Room and DM copy share one leading edge;
 *  the brass `#`/`@` sigil states the row kind without a separate tile. */
const ROW_HEIGHT = 64;
/** The trailing brass unread/attention square — lit or reserved, never absent. */
const ATTENTION_SQUARE = 7;
/** The row's leading gutter, in order: slab padding, state column, gap. */
const ROW_PADDING_LEFT = 16;
const ROW_COPY_GAP = 12;
/** Where a Room's copy starts. The corner tray indents to the same number so
 *  its `└` sits on the Room title's left margin and the tree reads as one
 *  stem under the name rather than a block floating off to its right. */
const ROW_TEXT_INSET = ROW_PADDING_LEFT + ATTENTION_SQUARE + ROW_COPY_GAP;
const LEAVE_TILE_HIT_SLOP = { top: 18, bottom: 18, left: 8, right: 8 };
/**
 * A 16px mark centred in its own 44pt box. Hit slop was carrying the target
 * instead, so two marks a spacing step apart had targets that overlapped by
 * 20pt while the ink looked cramped. Real boxes parted by `space.sm` give
 * 44pt targets with 8pt of slab between their edges.
 */
const HEADER_MARK_SIZE = 16;
const HEADER_TARGET_SIZE = 44;
/**
 * The trailing edge the Members mark shares with the compose FAB (`right: 16`)
 * and the expanded-corner tray. A 44pt box round a 16pt mark holds 14pt of its
 * own air on each side, so the header's own padding takes that off rather than
 * letting the box push the ink off the shared edge. Targets are spaced; ink is
 * aligned; neither pays for the other.
 */
const HEADER_EDGE_INSET = 16;
const HEADER_TARGET_AIR = (HEADER_TARGET_SIZE - HEADER_MARK_SIZE) / 2;

type EmptyRoomActionsProps = {
  canAddRoom: boolean;
  canConnectAgent: boolean;
  onAddRoom: () => void;
  onConnectAgent: () => void;
  desktop?: boolean;
  testID?: string;
};

/** The first Workspace view: quiet orientation, then two restrained actions. */
function EmptyRoomActions({
  canAddRoom,
  canConnectAgent,
  desktop = false,
  onAddRoom,
  onConnectAgent,
  testID = 'room-list-empty',
}: EmptyRoomActionsProps) {
  return (
    <View style={[styles.empty, desktop && styles.desktopEmpty]} testID={testID}>
      <Text style={styles.emptyTitle}>No Rooms yet</Text>
      <Text style={styles.emptyCopy}>
        A Room holds one repository and the people and agents working on it.
      </Text>
      <View style={styles.emptyActionList}>
        {canAddRoom && (
          <Pressable
            accessibilityLabel="Add a Room"
            accessibilityRole="button"
            onPress={onAddRoom}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.emptyButtonPressed]}
            testID="empty-add-room"
          >
            <Text style={styles.emptyPrimaryLabel}>Start a Room</Text>
          </Pressable>
        )}
        {canConnectAgent && (
          <Pressable
            accessibilityLabel="Connect an agent"
            accessibilityRole="button"
            onPress={onConnectAgent}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.emptyButtonPressed]}
            testID="empty-connect-agent"
          >
            <Text style={styles.emptySecondaryLabel}>Connect an agent</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The dropdown lists what the row's count promised. Both now read the daemon
 * state through `resolveCornerDisplayState`; filtering on `lifecycle` alone
 * used to leave a daemon-concluded corner listed under a count that had
 * already dropped it.
 */
function openCornerItems(corners: readonly CornerListItem[]): CornerListItem[] {
  return cornerDisplayItems(corners).map((entry) => entry.item);
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
  const isDesktop = useIsDesktop();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    newRoom?: string | string[];
    newDirectMessage?: string | string[];
  }>();
  const requestedWorkspaceId = firstParam(params.communityId);
  const requestedNewRoom = firstParam(params.newRoom);
  const requestedNewDirectMessage = firstParam(params.newDirectMessage);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [workspaceList, setWorkspaceList] = useState<WorkspaceListView | null>(null);
  const [chatList, setChatList] = useState<ChatListView | null>(null);
  const [workspaceDetail, setWorkspaceDetail] = useState<WorkspaceView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedWorkspaceNotice, setDeletedWorkspaceNotice] = useState<string | null>(null);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [memberPickerVisible, setMemberPickerVisible] = useState(false);
  const [agentConnectVisible, setAgentConnectVisible] = useState(false);
  const [pairCommand, setPairCommand] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [messagingPubkey, setMessagingPubkey] = useState<string | null>(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const [repoCandidates, setRepoCandidates] = useState<RepoCandidate[]>([]);
  const [repoInstallations, setRepoInstallations] = useState<GitHubInstallationAccess[]>([]);
  const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
  const [repoPickerNotice, setRepoPickerNotice] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [cornersByRoom, setCornersByRoom] = useState<Record<string, readonly CornerListItem[]>>({});
  const [cornerLoadingRoomId, setCornerLoadingRoomId] = useState<string | null>(null);
  const [cornerLoadErrors, setCornerLoadErrors] = useState<Record<string, string>>({});
  const handledNewRoomRequest = useRef<string | null>(null);
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
  const canLeaveRooms = chatList?.workspace.role === 'member';
  const chatSections = useMemo(() => roomListSections(chatList?.chats ?? []), [chatList?.chats]);

  useEffect(() => {
    if (
      !isDesktop ||
      !requestedNewRoom ||
      requestedNewRoom === handledNewRoomRequest.current ||
      !chatList ||
      viewerIsAgent ||
      !canManageWorkspace
    ) {
      return;
    }
    handledNewRoomRequest.current = requestedNewRoom;
    setShowCreateRoom(true);
  }, [canManageWorkspace, chatList, isDesktop, requestedNewRoom, viewerIsAgent]);

  // Desktop's one door into the shared direct-message picker: the sidebar's
  // DIRECT MESSAGES `+` arrives as a one-shot route param, same pattern as
  // `newRoom` above. The picker itself (and `handleStartDirectMessage`) are
  // unchanged components.
  const handledNewDirectMessageRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      !isDesktop ||
      !requestedNewDirectMessage ||
      requestedNewDirectMessage === handledNewDirectMessageRequest.current ||
      viewerIsAgent
    ) {
      return;
    }
    handledNewDirectMessageRequest.current = requestedNewDirectMessage;
    setMemberPickerVisible(true);
  }, [isDesktop, requestedNewDirectMessage, viewerIsAgent]);

  const refreshNow = useCallback(() => {
    workspaceScheduler.current?.force();
    chatScheduler.current?.force();
  }, []);

  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());

  const handleCloseChat = useCallback(async (item: ChatListItem) => {
    swipeableRefs.current.get(item.room.id)?.close();
    if (!transport) {
      Modal.alert('Cannot close yet', 'Connection is still starting. Try again.');
      return;
    }
    try {
      await transport.closeChat(item.room.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      chatScheduler.current?.force();
    } catch (reason) {
      setError(`Could not close chat: ${String(reason)}`);
    }
  }, [transport]);

  const handleLeaveRoom = useCallback(async (item: ChatListItem) => {
    swipeableRefs.current.get(item.room.id)?.close();
    if (!transport) {
      Modal.alert('Cannot leave yet', 'Connection is still starting. Try again.');
      return;
    }
    const heading = roomRowName(item);
    const title = `${heading.sigil}${heading.name}`;
    const confirmed = await Modal.confirm(
      `Leave ${title}?`,
      'Other members keep their access.',
      { cancelText: 'No', confirmText: 'Yes', destructive: true },
    );
    if (!confirmed) return;
    try {
      await transport.leaveRoom(item.room.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      chatScheduler.current?.force();
    } catch (reason) {
      setError(`Could not leave ${ROOM_LABEL}: ${String(reason)}`);
    }
  }, [transport]);

  const explainRoomLeaveConstraint = useCallback((item: ChatListItem) => {
    const heading = roomRowName(item);
    const title = `${heading.sigil}${heading.name}`;
    Modal.alert(
      `Cannot leave ${title}`,
      'Workspace owners and admins cannot leave Rooms. Change your Workspace role first.',
    );
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
      const nextRelayUrl = await getEffectiveRelayUrl();
      if (cancelled) return;
      const nextTransport = new BuzzRigTransport(nextIdentity);
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
          if (value.deletedNotices?.length) {
            setDeletedWorkspaceNotice('This workspace was deleted by its owner');
          }
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

      let chatListenReady: Promise<void> = Promise.resolve();
      if (selectedId && chatCacheAddress) {
        let chatWatchKey = '';
        let chatWatchGeneration = 0;
        const installChatWatch = async (
          filters: ChatListView['watchFilters'],
        ): Promise<void> => {
          const generation = ++chatWatchGeneration;
          chatWatchKey = JSON.stringify(filters);
          unsubscribeChats?.();
          unsubscribeChats = undefined;
          // Cold deck without Room ids must not subscribe the Workspace UUID as
          // #h — canReadRoom refuses it and live invalidation never lands.
          if (filters.length === 0) return;
          const stop = await relay.surfaceSubscribe(filters, () => chatsRefresh?.signal());
          if (cancelled || generation !== chatWatchGeneration) {
            stop();
            return;
          }
          unsubscribeChats = stop;
        };
        chatsRefresh = new SurfaceRefreshScheduler({
          fetch: () => http.chats(selectedId),
          apply: (value) => {
            setChatList(value);
            setRefreshing(false);
            setError(null);
            void mobileSurfaceCache.write(chatCacheAddress, value, isChatListView);
            const nextWatchKey = JSON.stringify(value.watchFilters);
            if (nextWatchKey !== chatWatchKey) void installChatWatch(value.watchFilters);
          },
          onError: (reason) => {
            setRefreshing(false);
            setError(String(reason));
          },
        });
        chatScheduler.current = chatsRefresh;
        // Seed from cache when present; otherwise the first chats GET apply
        // reinstalls so the deck never watches a Workspace id.
        chatListenReady = installChatWatch(cachedChats?.watchFilters ?? []);
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
    }, [activeCommunityId, refreshNow]),
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

  const prefetchRoom = useCallback(
    (roomId: string) => {
      if (!identity || !relayUrl) return;
      const address = surfaceAddress(relayUrl, identity.publicKey, `/room/${roomId}`);
      void mobileSurfaceCache.read(address, isRoomView);
      const http = new RoomViewClient({ baseUrl: relayUrl, identity });
      beginRoomOpenPrefetch(
        roomId,
        () => http.room(roomId),
        (view) => mobileSurfaceCache.write(address, view, isRoomView),
      );
    },
    [identity, relayUrl],
  );

  const openRoom = useCallback(
    (roomId: string) => {
      dispatchRoomOpenTap(roomId, {
        prefetch: prefetchRoom,
        navigate: (id) => {
          if (identity) void saveLastViewedChannel(identity.publicKey, activeCommunityId, id);
          navigateToRoom(router, id);
        },
      });
    },
    [activeCommunityId, identity, prefetchRoom],
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
    Keyboard.dismiss();
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

  const startGitHubInstallation = useCallback(
    async (installationId?: number) => {
      if (!transport) throw new Error('GitHub transport is unavailable');
      return transport.githubInstallationStart(githubInstallationRedirectUri(), installationId);
    },
    [transport],
  );
  const refreshGitHubRepositories = useCallback(() => loadRepoPicker(true), [loadRepoPicker]);
  const resumeRepoPicker = useCallback(async () => {
    setShowCreateRoom(true);
    setShowRepoPicker(true);
  }, []);
  const { handleAddGitHubAccount, handleManageGitHubInstallation } = useGitHubInstallationSession({
    ready: Boolean(transport && activeCommunityId),
    returnPath: '/beeline/channels',
    startInstallation: startGitHubInstallation,
    refreshRepositories: refreshGitHubRepositories,
    onError: setRepoPickerError,
    onNotice: setRepoPickerNotice,
    onColdResume: resumeRepoPicker,
  });

  const handleSelectNoRepository = useCallback(() => {
    setPendingRepo(null);
    setShowRepoPicker(false);
    setRepoPickerError(null);
  }, []);

  const createRoom = useCallback(async () => {
    const name = roomName.trim();
    if (!name || !transport || !activeCommunityId || creatingRoom || !canManageWorkspace) return;
    setCreatingRoom(true);
    setError(null);
    let publishAcknowledged = false;
    try {
      await transport.createRoom(name, {
        communityId: activeCommunityId,
        repository: pendingRepo ?? undefined,
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
  }, [activeCommunityId, canManageWorkspace, creatingRoom, pendingRepo, roomName, transport]);

  const connectAgent = useCallback(async () => {
    if (!transport || !activeCommunityId || pairingBusy || viewerIsAgent) return;
    setAgentConnectVisible(true);
    setPairCommand(null);
    setPairingError(null);
    setPairingBusy(true);
    try {
      const pairing = await (
        await transport.ensureClient()
      ).createAgentPairingCode(activeCommunityId);
      setPairCommand(`${CONNECT_AGENT_COMMAND} ${pairing.code}`);
    } catch (reason) {
      setPairingError(`Could not create agent invite: ${String(reason)}`);
    } finally {
      setPairingBusy(false);
    }
  }, [activeCommunityId, pairingBusy, transport, viewerIsAgent]);

  const closeAgentConnect = useCallback(() => {
    setAgentConnectVisible(false);
    setPairCommand(null);
    setPairingError(null);
  }, []);

  const copyPairCommand = useCallback(async (command: string) => {
    await (await import('expo-clipboard')).setStringAsync(command);
  }, []);

  const compose = useCallback(
    (action: RoomDeckComposeAction) => {
      if (!canManageWorkspace && (action === 'room' || action === 'invite')) return;
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
    [activeCommunityId, canManageWorkspace],
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
      <RoomDeckLoadingView style={{ paddingTop: insets.top }} />
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
          {!isDesktop && <CommunityDrawerTrigger community={activeCommunity} />}
          {!isDesktop && activeCommunityId && (
            <View style={styles.headerActions}>
              <TouchableOpacity
                accessibilityLabel="Bookmarks"
                accessibilityRole="button"
                onPress={() =>
                  router.push({
                    pathname: '/beeline/bookmarks',
                    params: { communityId: activeCommunityId },
                  } as never)
                }
                style={styles.headerAction}
                testID="workspace-bookmarks"
              >
                <BookmarksGlyph
                  color={styles.headerActionGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="workspace-bookmarks-glyph"
                />
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}
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
                <MembersGlyph
                  color={styles.headerActionGlyph.color}
                  size={HEADER_MARK_SIZE}
                  testID="workspace-members-glyph"
                />
              </TouchableOpacity>
            </View>
          )}
        </View>
        <NewRoomDialog
          visible={showCreateRoom}
          workspaceName={activeCommunity?.name ?? WORKSPACE_LABEL}
          roomName={roomName}
          setRoomName={setRoomName}
          creatingRoom={creatingRoom}
          createRoom={createRoom}
          onClose={() => setShowCreateRoom(false)}
          pendingRepo={pendingRepo}
          showRepoPicker={showRepoPicker}
          handleToggleRepoPicker={handleToggleRepoPicker}
          handleSelectNoRepository={handleSelectNoRepository}
          handleSelectRepoCandidate={handleSelectRepoCandidate}
          repoCandidates={repoCandidates}
          repoInstallations={repoInstallations}
          repoPickerError={repoPickerError}
          repoPickerNotice={repoPickerNotice}
          handleAddGitHubAccount={() => void handleAddGitHubAccount()}
          handleManageGitHubInstallation={(installation) =>
            void handleManageGitHubInstallation(installation)
          }
        />
        <MemberPickerSheet
          agentConnectOnly
          busy={pairingBusy}
          canManage={canManageWorkspace}
          canConnectAgent={!viewerIsAgent}
          candidates={undefined}
          error={agentConnectVisible ? pairingError : null}
          onAdd={() => undefined}
          onClose={closeAgentConnect}
          onConnectAgent={() => void connectAgent()}
          onCopyPairCommand={(command) => void copyPairCommand(command)}
          onInvitePerson={() => undefined}
          pairCommand={pairCommand}
          testID="empty-agent-connect-sheet"
          visible={agentConnectVisible}
        />
        {!!deletedWorkspaceNotice && (
          <TouchableOpacity
            onPress={() => setDeletedWorkspaceNotice(null)}
            style={styles.errorBar}
            testID="workspace-deleted-notice"
          >
            <Text style={styles.error}>{deletedWorkspaceNotice}</Text>
          </TouchableOpacity>
        )}
        {!!error && (
          <TouchableOpacity onPress={refreshNow} style={styles.errorBar}>
            <Text style={styles.error}>{error}</Text>
          </TouchableOpacity>
        )}
        {isDesktop ? (
          chatList.chats.length === 0 ? (
            <EmptyRoomActions
              canAddRoom={canManageWorkspace}
              canConnectAgent={!viewerIsAgent}
              desktop
              onAddRoom={() => setShowCreateRoom(true)}
              onConnectAgent={() => void connectAgent()}
              testID="desktop-room-list-empty"
            />
          ) : (
            <View style={styles.center} testID="desktop-room-selection-empty">
              <Text style={styles.emptyTitle}>Select a Room</Text>
              <Text style={styles.emptyCopy}>Choose a Room or direct message from the sidebar.</Text>
            </View>
          )
        ) : (
          <SectionList
          testID="room-list"
          sections={chatSections}
          keyExtractor={(item) => item.room.id}
          stickySectionHeadersEnabled={false}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            refreshNow();
          }}
          contentContainerStyle={chatList.chats.length ? styles.list : styles.emptyList}
          renderSectionHeader={({ section }) =>
            section.title ? <RoomListSectionHeader title={section.title} /> : null
          }
          ListEmptyComponent={
            <EmptyRoomActions
              canAddRoom={!viewerIsAgent && canManageWorkspace}
              canConnectAgent={!viewerIsAgent}
              onAddRoom={() => setShowCreateRoom(true)}
              onConnectAgent={() => void connectAgent()}
            />
          }
          renderItem={({ item }: { item: ChatListItem }) => {
            // Every row-level fact is derived once in room-list-row.ts: the
            // sigil and name (`@peer` for a DM, `#room` for a Room), the
            // preview attribution, and whether the trailing brass
            // square is lit. `unread` is server-owned and cross-device; a
            // corner waiting on a human (`agentState === 'needs-you'`) lights
            // the same square. The screen renders answers, never re-derives.
            const heading = roomRowName(item);
            const preview = roomRowPreview(item, chatList.viewer.pubkey);
            const hasPreview = preview.text !== NO_ACTIVITY_PREVIEW;
            const attention = roomRowNeedsAttention(item);
            const title = `${heading.sigil}${heading.name}`;
            const age = compactRelativeTime(
              item.latestMessage?.createdAt ?? item.room.updatedAt,
              ageNow,
            );
            const cornerCount = formatRoomCornerCount(item.cornerCount);
            const expanded = expandedRoomId === item.room.id;
            const corners = cornersByRoom[item.room.id];
            const row = (
              <View style={styles.row}>
                <TouchableOpacity
                  accessibilityLabel={`${title}${attention ? ', needs you' : ''}`}
                  testID={`room-${item.room.id}`}
                  onPressIn={() => {
                    prefetchRoom(item.room.id);
                  }}
                  onPress={() => {
                    swipeableRefs.current.get(item.room.id)?.close();
                    openRoom(item.room.id);
                  }}
                  style={styles.rowMain}
                >
                  <View style={styles.rowStateSlot} accessibilityElementsHidden>
                    {attention && (
                      <View style={styles.rowStateMark} testID={`room-attention-${item.room.id}`} />
                    )}
                  </View>
                  <View style={styles.rowCopy}>
                    <View style={styles.titleLine}>
                      <Text numberOfLines={1} style={styles.title}>
                        <Text style={styles.sigil} testID={`room-sigil-${item.room.id}`}>
                          {heading.sigil}
                        </Text>
                        {heading.name}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.preview} testID={`room-preview-${item.room.id}`}>
                      {hasPreview && preview.attribution === 'self' && (
                        <Text style={styles.previewSelf}>you: </Text>
                      )}
                      {hasPreview && preview.attribution === 'other' && (
                        <Text style={styles.previewAuthor}>@{preview.handle}: </Text>
                      )}
                      {preview.text}
                    </Text>
                  </View>
                </TouchableOpacity>
                <View style={styles.gutter}>
                  <Text style={styles.age}>{age}</Text>
                </View>
                <View style={styles.cornerToggleSlot}>
                  {(item.cornerCount ?? 0) > 0 && (
                    <TouchableOpacity
                      accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${cornerCount} in ${title}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      onPress={() => toggleRoomCorners(item.room.id)}
                      style={styles.cornerToggle}
                      testID={`room-corners-toggle-${item.room.id}`}
                    >
                        <ChevronGlyph
                          color={styles.cornerToggleText.color}
                          direction={expanded ? 'up' : 'down'}
                          size={HEADER_MARK_SIZE}
                          testID={`room-corners-toggle-glyph-${item.room.id}`}
                        />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
            return (
              <View style={styles.roomCell}>
                {!viewerIsAgent ? (
                  <Swipeable
                    ref={(ref) => {
                      if (ref) swipeableRefs.current.set(item.room.id, ref);
                      else swipeableRefs.current.delete(item.room.id);
                    }}
                    friction={1}
                    overshootRight={false}
                    rightThreshold={ROW_HEIGHT}
                    renderRightActions={() => (
                      <View style={styles.chatActions}>
                        {!item.directMessage && canLeaveRooms && (
                          <View style={styles.swipeAction}>
                            <TouchableOpacity
                              accessibilityLabel={`Leave ${title}`}
                              accessibilityRole="button"
                              hitSlop={LEAVE_TILE_HIT_SLOP}
                              onPress={() => handleLeaveRoom(item)}
                              style={styles.swipeActionButton}
                              testID={`room-leave-action-${item.room.id}`}
                            >
                              <ExitGlyph testID={`room-exit-glyph-${item.room.id}`} />
                            </TouchableOpacity>
                          </View>
                        )}
                        {!item.directMessage && canManageWorkspace && (
                          <View style={styles.swipeAction}>
                            <TouchableOpacity
                              accessibilityLabel={`Cannot leave ${title}`}
                              accessibilityRole="button"
                              hitSlop={LEAVE_TILE_HIT_SLOP}
                              onPress={() => explainRoomLeaveConstraint(item)}
                              style={styles.swipeActionButton}
                              testID={`room-leave-constraint-${item.room.id}`}
                            >
                              <ExitGlyph testID={`room-exit-glyph-${item.room.id}`} />
                            </TouchableOpacity>
                          </View>
                        )}
                        {item.directMessage && (
                          <View style={styles.swipeAction}>
                            <TouchableOpacity
                              accessibilityLabel={`Close ${title}`}
                              accessibilityRole="button"
                              hitSlop={LEAVE_TILE_HIT_SLOP}
                              onPress={() => handleCloseChat(item)}
                              style={styles.swipeActionButton}
                              testID={`chat-close-action-${item.room.id}`}
                            >
                              <ExitGlyph testID={`dm-exit-glyph-${item.room.id}`} />
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    )}
                    testID={`chat-close-swipe-${item.room.id}`}
                  >
                    {row}
                  </Swipeable>
                ) : row}
                {expanded && (
                  <View style={styles.cornerDropdown} testID={`room-corners-${item.room.id}`}>
                    {cornerLoadingRoomId === item.room.id && !corners ? (
                      <View style={styles.cornerLoading}>
                        <SurfaceGlyphLoader compact testID="corners-loader" />
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
                        const label = displayGroupedCornerTitle(
                          item.room.name,
                          corner.corner.name,
                          corner.corner.id,
                        );
                        // The server owns the state; this maps it only to the
                        // shared visual tokens and optional PR narration.
                        const display = cornerDisplayState(corner);
                        return (
                          <TouchableOpacity
                            accessibilityLabel={`Open ${label}, ${display.word.toLowerCase()}${
                              display.needsYou ? ', needs you' : ''
                            }`}
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
                            <Text
                              style={[
                                styles.cornerName,
                                display.needsYou && styles.cornerNameNeedsYou,
                              ]}
                            >
                              └ {label}
                            </Text>
                            <View style={styles.cornerTrail}>
                              <CornerWorkingPulse state={display.status}>
                                <Text
                                  style={[
                                    styles.cornerStatus,
                                    display.status === 'working'
                                      ? styles.cornerStatusWorking
                                      : display.status === 'review'
                                        ? styles.cornerStatusReview
                                        : display.status === 'archived'
                                          ? styles.cornerStatusArchived
                                          : styles.cornerStatusWaiting,
                                  ]}
                                  testID={`room-corner-status-${corner.corner.id}`}
                                >
                                  {display.word}
                                </Text>
                              </CornerWorkingPulse>
                                <ChevronGlyph
                                  color={styles.cornerChevron.color}
                                  direction="right"
                                  size={CHEVRON_ROW_SIZE}
                                />
                            </View>
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
        )}
        {!isDesktop && !viewerIsAgent && (
          <View
            pointerEvents="box-none"
            style={[styles.composeOverlay, { bottom: 16 + insets.bottom }]}
          >
            <RoomDeckComposeMenu canManageWorkspace={canManageWorkspace} onSelect={compose} />
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
    header: {
      minHeight: 62,
      paddingLeft: hull.space.lg,
      // Match the compose FAB (`right: 16`) and the expanded-corner tray
      // (`paddingRight: 16`) so the Members mark sits on that shared trailing
      // edge rather than inset by the header's left gutter.
      paddingRight: HEADER_EDGE_INSET - HEADER_TARGET_AIR,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    // One box for both header marks. They were two identically-defined names,
    // which is how a pair meant to stay siblings drifts apart.
    headerAction: {
      minHeight: HEADER_TARGET_SIZE,
      minWidth: HEADER_TARGET_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Target edge to target edge, not ink to ink: the boxes ARE the targets,
    // so one spacing step between them is one spacing step of real slab.
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
    },
    headerActionGlyph: { color: hull.textMuted },
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
    empty: {
      alignItems: 'flex-start',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.lg,
      width: '100%',
    },
    desktopEmpty: { paddingTop: hull.space.xxl },
    emptyTitle: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    emptyCopy: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      maxWidth: 330,
    },
    emptyActionList: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: hull.space.md,
    },
    emptyButton: {
      height: 44,
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      borderRadius: 10,
    },
    emptyButtonPressed: { backgroundColor: hull.bgPressed },
    emptyPrimaryLabel: {
      ...Typography.ledger('medium'),
      color: hull.accent,
      fontSize: hull.type.body.fontSize - 1,
      lineHeight: hull.type.body.lineHeight,
    },
    emptySecondaryLabel: {
      ...Typography.ledger(),
      color: hull.ledgerQuiet,
      fontSize: hull.type.body.fontSize - 1,
      lineHeight: hull.type.body.lineHeight,
    },
    roomCell: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    row: {
      minHeight: ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      // The shifted row stays on the slab and lifts just enough for its
      // trailing edge to separate from the recessed swipe action beneath it.
      backgroundColor: hull.bgBase,
      shadowColor: hull.bgVoid,
      shadowOffset: { width: 6, height: 0 },
      shadowOpacity: 0.28,
      shadowRadius: 8,
      elevation: 4,
      boxShadow: `6px 0 8px color-mix(in srgb, ${hull.bgVoid} 28%, transparent)`,
    },
    rowMain: {
      flex: 1,
      minWidth: 0,
      minHeight: ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: ROW_COPY_GAP,
      paddingLeft: ROW_PADDING_LEFT,
      paddingVertical: 10,
    },
    // The row's leading unit: the STATE column, on every row. Its width is
    // reserved whether or not the row is lit, so the tile (a DM) or the copy
    // (a Room) that follows starts at the same edge either way.
    rowStateSlot: { width: ATTENTION_SQUARE, height: ATTENTION_SQUARE },
    rowStateMark: {
      width: ATTENTION_SQUARE,
      height: ATTENTION_SQUARE,
      backgroundColor: hull.accent,
    },
    rowCopy: { flex: 1, minWidth: 0, gap: 3 },
    titleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    // The row leads with the name: one size, one weight, the brightest thing
    // on the row. Ownership and unread never bold or enlarge it.
    title: {
      ...Typography.default('semiBold'),
      color: hull.textPrimary,
      fontSize: 18,
      lineHeight: 22,
      flexShrink: 1,
    },
    // The sigil is the name's first glyph in brass: `@` for a DM, `#` for a Room.
    sigil: { ...Typography.default('semiBold'), color: hull.accent },
    preview: { ...Typography.default(), color: hull.ledgerQuiet, fontSize: 13, lineHeight: 17 },
    previewSelf: { ...Typography.default(), color: hull.textMuted },
    previewAuthor: { ...Typography.default(), color: hull.accent },
    // The gutter carries the timestamp only now; state lives in the leading
    // column (`rowStateSlot`).
    gutter: {
      width: 46,
      minHeight: ROW_HEIGHT,
      alignItems: 'flex-end',
      justifyContent: 'center',
      paddingRight: 4,
    },
    age: { ...Typography.mono(), color: hull.ledgerGhost, fontSize: 11 },
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
    cornerToggleText: { color: hull.chrome },
    // Indented to the parent Room's text edge, not past it: the tray is the
    // Room's own continuation, so it starts where the Room's name starts.
    cornerDropdown: {
      paddingLeft: ROW_TEXT_INSET,
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
      ...theme.buzz.type.meta,
      fontFamily: theme.buzz.type.bodyStrong.fontFamily,
      flex: 1,
      minWidth: 0,
      color: hull.textSecondary,
      includeFontPadding: false,
    },
    cornerTrail: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    cornerStatus: {
      ...theme.buzz.type.sectionHead,
      color: hull.textMuted,
      includeFontPadding: false,
    },
    // Brass is reserved for the state that wants the viewer.
    cornerStatusWorking: { color: hull.ledgerBright },
    cornerStatusReview: { color: hull.ledgerQuiet },
    cornerStatusWaiting: { color: hull.accent },
    cornerStatusArchived: { color: hull.ledgerGhost },
    // The name lifts out of the secondary tone with it, so the pair reads as
    // one emphasized row rather than a loud chip beside a quiet title.
    cornerNameNeedsYou: { color: hull.textPrimary },
    cornerChevron: { color: hull.steel },
    chatActions: {
      flexDirection: 'row',
      minHeight: ROW_HEIGHT,
      backgroundColor: hull.bgHighlight,
    },
    swipeAction: {
      width: ROW_HEIGHT,
      height: ROW_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swipeActionButton: {
      width: 26,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
    composeOverlay: {
      position: 'absolute',
      right: 16,
    },
  };
});
