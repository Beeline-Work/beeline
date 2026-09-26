import { useNeedsYouCount } from '@/buzz/needs-you';
import { PinnedConversationsEmpty } from '@/components/buzz/PinnedConversationsEmpty';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { useGitHubInstallationSession } from '@/auth/github-installation-host';
import {
  applyChatListDelta,
  chatListDeltaNeedsRead,
  roomsMissedByLive,
  type ChatListDelta,
} from '@/buzz/chat-list-delta';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import { cornerHref, navigateToRoom } from '@/buzz/corner-navigation';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { loadPendingInvite } from '@/buzz/pending-invite';
import { deckLanding } from '@/buzz/deck-landing';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import {
  filterConversations,
  roomListCounts,
  useRoomPins,
  useRoomListFilter,
} from '@/buzz/room-list-preferences';
import { openRoomListCorner } from '@/buzz/room-list-new-corner';
import { roomListSections, roomRowName } from '@/buzz/room-list-row';
import { validRoomSlug } from '@/buzz/room-name';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { workspaceRailItem, type WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { ConversationRow } from '@/components/buzz/ConversationRow';
import { DirectMessagePickerSheet } from '@/components/buzz/DirectMessagePickerSheet';
import { ExitGlyph } from '@/components/buzz/ExitGlyph';
import { MemberPickerSheet } from '@/components/buzz/MemberPickerSheet';
import { MonoButton } from '@/components/buzz/MonoHull';
import { NoMatchingConversationsEmpty } from '@/components/buzz/NoMatchingConversationsEmpty';
import { NewRoomDialog } from '@/components/buzz/NewRoomDialog';
import {
  RoomDeckComposeMenu,
  type RoomDeckComposeAction,
} from '@/components/buzz/RoomDeckComposeMenu';
import { RoomDeckLoadingView } from '@/components/buzz/RoomDeckLoadingView';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { RoomListToolbar } from '@/components/buzz/RoomListToolbar';
import { MaybeTourTarget } from '@/components/buzz/tour/TourTarget';
import { WorkspaceActionsMenu } from '@/components/buzz/WorkspaceActionsMenu';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { isDraftFrame } from '@/sync/transport/live-frames';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { useIsDesktop } from '@/utils/responsive';
import {
  SurfaceRefreshScheduler,
  isChatListView,
  isWorkspaceListView,
  isWorkspaceView,
  type ChatListItem,
  type ChatListView,
  type GitHubInstallationAccess,
  type Identity,
  type WorkspaceListView,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { useFocusEffect } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  Pressable,
  SectionList,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

const AGE_TICK_MS = 60_000;
const COMPOSE_FAB_CLEARANCE = 80;
const LOBBY_LIST_BOTTOM_SPACING = 24;
const ROW_HEIGHT = 64;
const LEAVE_TILE_HIT_SLOP = { top: 18, bottom: 18, left: 8, right: 8 };
/** Match the fixed trailing inset used by Room and corner conversation headers. */
const HEADER_RIGHT_SPACING = 12;

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
  // Only a live read (never a cached one) may say "you have no Workspace".
  const [workspacesConfirmed, setWorkspacesConfirmed] = useState(false);
  const [chatList, setChatList] = useState<ChatListView | null>(null);
  const needsYouCount = useNeedsYouCount(chatList?.workspace.id, chatList);
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
  const [inviteOnly, setInviteOnly] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [creatingRepository, setCreatingRepository] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const [repoCandidates, setRepoCandidates] = useState<RepoCandidate[]>([]);
  const [repoInstallations, setRepoInstallations] = useState<GitHubInstallationAccess[]>([]);
  const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
  const [repoPickerNotice, setRepoPickerNotice] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const handledNewRoomRequest = useRef<string | null>(null);
  const chatScheduler = useRef<SurfaceRefreshScheduler<ChatListView> | null>(null);
  const workspaceScheduler = useRef<SurfaceRefreshScheduler<WorkspaceListView> | null>(null);
  // A deck under a pushed Room, or in a backgrounded app, reads nothing; its
  // focus and the foreground socket's resubscribe are the covering reads.
  const deckFocusedRef = useRef(true);
  const deckVisible = useCallback(
    () => deckFocusedRef.current && AppState.currentState !== 'background',
    [],
  );

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
  const [query, setQuery] = useState('');
  const { pinned, pinsLoaded, togglePin, pinError } = useRoomPins(
    identity?.publicKey,
    activeCommunityId,
  );
  const counts = useMemo(
    () => roomListCounts(chatList?.chats ?? [], pinned),
    [chatList?.chats, pinned],
  );
  const [filter, setFilter] = useRoomListFilter(
    activeCommunityId,
    pinsLoaded && Boolean(chatList),
    Boolean(
      chatList?.chats.some(
        (item) => !item.closed && !item.directMessage && pinned.includes(item.room.id),
      ),
    ),
  );
  const chatSections = useMemo(
    () => roomListSections(filterConversations(chatList?.chats ?? [], query, filter, pinned)),
    [chatList?.chats, query, filter, pinned],
  );
  useEffect(() => {
    setQuery('');
  }, [activeCommunityId]);

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

  const handleCloseChat = useCallback(
    async (item: ChatListItem) => {
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
    },
    [transport],
  );

  const handleLeaveRoom = useCallback(
    async (item: ChatListItem) => {
      swipeableRefs.current.get(item.room.id)?.close();
      if (!transport) {
        Modal.alert('Cannot leave yet', 'Connection is still starting. Try again.');
        return;
      }
      const heading = roomRowName(item);
      const title = `${heading.sigil}${heading.name}`;
      const confirmed = await Modal.confirm(`Leave ${title}?`, 'Other members keep their access.', {
        cancelText: 'No',
        confirmText: 'Yes',
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await transport.leaveRoom(item.room.id);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatScheduler.current?.force();
      } catch (reason) {
        setError(`Could not leave ${ROOM_LABEL}: ${String(reason)}`);
      }
    },
    [transport],
  );

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
      // An invite opened before sign-in outranks every other landing.
      const pendingInvite = await loadPendingInvite();
      if (pendingInvite) {
        if (!cancelled)
          router.replace({ pathname: '/join/[token]', params: { token: pendingInvite } });
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
      let heldChats = cachedChats;
      const paintChats = (value: ChatListView) => {
        heldChats = value;
        setChatList(value);
      };

      workspaceRefresh = new SurfaceRefreshScheduler({
        fetch: () => http.workspaces(),
        apply: (value) => {
          setWorkspaceList(value);
          setWorkspacesConfirmed(true);
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
        // Deltas that landed while a chats read was in flight: the read may
        // predate them, and no later read comes to correct it.
        let readInFlight = false;
        let deltasDuringRead: ChatListDelta[] = [];
        // Rooms the socket delivered any frame for since the last applied read.
        const heardRooms = new Set<string>();
        let liveReadApplied = false;
        const installChatWatch = async (filters: ChatListView['watchFilters']): Promise<void> => {
          const generation = ++chatWatchGeneration;
          chatWatchKey = JSON.stringify(filters);
          unsubscribeChats?.();
          unsubscribeChats = undefined;
          // Cold deck without Room ids must not subscribe the Workspace UUID as
          // #h — canReadRoom refuses it and live invalidation never lands.
          if (filters.length === 0) return;
          const stop = await relay.surfaceSubscribe(filters, (event) => {
            const live =
              'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
            if (live && 'roomId' in live) heardRooms.add(live.roomId);
            if (live?.type === 'message-delta' || live?.type === 'turn-delta') {
              if (readInFlight) deltasDuringRead.push(live);
              const needsRead = !heldChats || chatListDeltaNeedsRead(heldChats, live);
              if (heldChats) paintChats(applyChatListDelta(heldChats, live));
              if (needsRead && deckVisible()) chatsRefresh?.signal();
              return;
            }
            if (isDraftFrame(event)) return;
            // A committed-row invalidation announces the delta that follows it.
            if (live?.type === 'invalidate' && live.deliveryId) return;
            if (deckVisible()) chatsRefresh?.signal();
          });
          if (cancelled || generation !== chatWatchGeneration) {
            stop();
            return;
          }
          unsubscribeChats = stop;
        };
        chatsRefresh = new SurfaceRefreshScheduler({
          fetch: async () => {
            deltasDuringRead = [];
            readInFlight = true;
            try {
              return await http.chats(selectedId);
            } finally {
              readInFlight = false;
            }
          },
          apply: (read) => {
            const missedLive =
              liveReadApplied &&
              heldChats !== null &&
              roomsMissedByLive(heldChats, read, heardRooms).length > 0;
            heardRooms.clear();
            liveReadApplied = true;
            const value = deltasDuringRead.reduce(applyChatListDelta, read);
            paintChats(value);
            if (missedLive) nextTransport.reconnectLive();
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
          () => {
            if (deckVisible()) workspaceRefresh?.signal();
          },
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
  }, [deckVisible, requestedWorkspaceId, retryGeneration]);

  useFocusEffect(
    useCallback(() => {
      deckFocusedRef.current = true;
      refreshNow();
      setAgeNow(Date.now());
      const timer = setInterval(() => setAgeNow(Date.now()), AGE_TICK_MS);
      return () => {
        deckFocusedRef.current = false;
        clearInterval(timer);
      };
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

  const openRoom = useCallback(
    (roomId: string) => {
      dispatchRoomOpenTap(roomId, {
        navigate: (id) => {
          if (identity) void saveLastViewedChannel(identity.publicKey, activeCommunityId, id);
          navigateToRoom(router, id);
        },
      });
    },
    [activeCommunityId, identity],
  );

  const openingCornerRef = useRef(false);
  const openNewCorner = useCallback(
    async (roomId: string) => {
      if (openingCornerRef.current) return;
      openingCornerRef.current = true;
      try {
        await openRoomListCorner({
          roomId,
          createCorner: transport ? (id, title) => transport.createHumanCorner(id, title) : null,
          openCorner: (cornerId, title) =>
            router.push(cornerHref(cornerId, roomId, title, 'room-list')),
        });
      } finally {
        openingCornerRef.current = false;
      }
    },
    [transport],
  );

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

  const handleCreateRepository = useCallback(
    async (installationId: number, name: string) => {
      if (!transport) throw new Error('Connection is still starting. Try again.');
      setRepoPickerError(null);
      setCreatingRepository(true);
      try {
        const repository = await transport.githubRepositoryCreate({
          installationId,
          name,
          private: true,
        });
        setRepoCandidates((current) => [...current, repository]);
        setPendingRepo(repository);
        setShowRepoPicker(false);
      } catch (reason) {
        setRepoPickerError(`Could not create repository: ${String(reason)}`);
        throw reason;
      } finally {
        setCreatingRepository(false);
      }
    },
    [transport],
  );

  const createRoom = useCallback(async () => {
    const name = roomName.trim();
    if (
      !validRoomSlug(name) ||
      !transport ||
      !activeCommunityId ||
      creatingRoom ||
      creatingRepository ||
      !canManageWorkspace
    )
      return;
    setCreatingRoom(true);
    setError(null);
    let publishAcknowledged = false;
    try {
      await transport.createRoom(name, {
        communityId: activeCommunityId,
        visibility: inviteOnly ? 'invite-only' : 'public',
        repository: pendingRepo ?? undefined,
        onPublished: () => {
          publishAcknowledged = true;
          setRoomName('');
          setInviteOnly(false);
          setPendingRepo(null);
          setShowRepoPicker(false);
          setShowCreateRoom(false);
          chatScheduler.current?.force();
        },
      });
      if (!publishAcknowledged) {
        setRoomName('');
        setInviteOnly(false);
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
  }, [
    activeCommunityId,
    canManageWorkspace,
    creatingRoom,
    creatingRepository,
    inviteOnly,
    pendingRepo,
    roomName,
    transport,
  ]);

  const landing = deckLanding({
    workspaces: workspacesConfirmed
      ? { status: 'ready', count: workspaceList?.workspaces.length ?? 0 }
      : error
        ? { status: 'failed' }
        : { status: 'pending' },
    chats: chatList ? 'ready' : error ? 'failed' : 'pending',
  });
  const noWorkspace = landing.kind === 'choice';
  useEffect(() => {
    if (noWorkspace) router.replace('/beeline/community');
  }, [noWorkspace]);

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
      setPairCommand(agentPairingCommand(pairing.code));
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

  if (landing.kind === 'error') {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{error}</Text>
        <MonoButton label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
      </View>
    );
  }
  if (landing.kind !== 'deck' || !chatList) {
    // Choice: the create-or-join screen is the landing and the effect above
    // is replacing this one; loader: nothing has answered yet.
    return <RoomDeckLoadingView style={{ paddingTop: insets.top }} />;
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={selectWorkspace}
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
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
              <WorkspaceActionsMenu
                onMembers={() =>
                  router.push({
                    pathname: '/beeline/members',
                    params: { communityId: activeCommunityId },
                  } as never)
                }
                onSettings={
                  canManageWorkspace
                    ? () =>
                        router.push({
                          pathname: '/beeline/settings/workspace',
                          params: { communityId: activeCommunityId },
                        } as never)
                    : undefined
                }
              />
              {!viewerIsAgent && (
                <RoomDeckComposeMenu
                  header
                  canManageWorkspace={canManageWorkspace}
                  onSelect={compose}
                />
              )}
            </View>
          )}
        </View>
        {!isDesktop && (
          <RoomListToolbar
            filter={filter}
            onFilter={setFilter}
            query={query}
            onQuery={setQuery}
            counts={counts}
            needsYouCount={needsYouCount}
            onTray={
              activeCommunityId
                ? () =>
                    router.push({
                      pathname: '/beeline/tray',
                      params: { communityId: activeCommunityId },
                    } as never)
                : undefined
            }
          />
        )}
        {pinError && (
          <Text accessibilityRole="alert" style={styles.error}>
            {pinError}
          </Text>
        )}
        <NewRoomDialog
          visible={showCreateRoom}
          roomName={roomName}
          setRoomName={setRoomName}
          inviteOnly={inviteOnly}
          setInviteOnly={setInviteOnly}
          creatingRoom={creatingRoom}
          creatingRepository={creatingRepository}
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
          handleCreateRepository={handleCreateRepository}
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
              canAddRoom={!viewerIsAgent && canManageWorkspace}
              canConnectAgent={!viewerIsAgent}
              desktop
              onAddRoom={() => setShowCreateRoom(true)}
              onConnectAgent={() => void connectAgent()}
              testID="desktop-room-list-empty"
            />
          ) : (
            <View style={styles.center} testID="desktop-room-selection-empty">
              <Text style={styles.emptyTitle}>Select a Room</Text>
              <Text style={styles.emptyCopy}>
                Choose a Room or direct message from the sidebar.
              </Text>
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
            contentContainerStyle={
              chatList.chats.length
                ? [styles.list, { paddingBottom: LOBBY_LIST_BOTTOM_SPACING + insets.bottom }]
                : styles.emptyList
            }
            renderSectionHeader={({ section }) =>
              section.title ? <RoomListSectionHeader title={section.title} /> : null
            }
            ListEmptyComponent={
              filter === 'pinned' && !query.trim() ? (
                <PinnedConversationsEmpty onShowAll={() => setFilter('all')} />
              ) : query || filter !== 'all' ? (
                <NoMatchingConversationsEmpty
                  onShowAll={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                />
              ) : (
                <EmptyRoomActions
                  canAddRoom={!viewerIsAgent && canManageWorkspace}
                  canConnectAgent={!viewerIsAgent}
                  onAddRoom={() => setShowCreateRoom(true)}
                  onConnectAgent={() => void connectAgent()}
                />
              )
            }
            renderItem={({ item, index, section }) => {
              const heading = roomRowName(item);
              const title = `${heading.sigil}${heading.name}`;
              const first = index === 0;
              const last = index === section.data.length - 1;
              const openCorners = () =>
                router.push({
                  pathname: '/beeline/corners/[roomId]',
                  params: { roomId: item.room.id },
                } as never);
              const tourTarget = first && section === chatSections[0] && !viewerIsAgent;
              const row = (
                <MaybeTourTarget enabled={tourTarget} tip="rooms">
                  <View
                    style={[
                      styles.rowSurface,
                      first && styles.rowSurfaceFirst,
                      last && styles.rowSurfaceLast,
                    ]}
                  >
                    <ConversationRow
                      item={item}
                      viewer={chatList.viewer.pubkey}
                      now={ageNow}
                      onPress={() => {
                        swipeableRefs.current.get(item.room.id)?.close();
                        openRoom(item.room.id);
                      }}
                      pinned={pinned.includes(item.room.id)}
                      onPin={() => void togglePin(item.room.id)}
                      onToggleCorners={openCorners}
                      onLongPressCorners={
                        viewerIsAgent ? undefined : () => void openNewCorner(item.room.id)
                      }
                      testID={`room-${item.room.id}`}
                    />
                  </View>
                </MaybeTourTarget>
              );
              return (
                <View style={[styles.roomCell, last && styles.roomCellLast]}>
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
                  ) : (
                    row
                  )}
                </View>
              );
            }}
          />
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
      // Fixed target spacing matches the Room and corner conversation headers;
      // action centres stay aligned even when their drawn marks differ in size.
      paddingRight: HEADER_RIGHT_SPACING,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    // Target edge to target edge, not ink to ink: the boxes ARE the targets,
    // and they touch, so their centres stay one complete touch target apart.
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 0,
    },
    errorBar: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.danger,
    },
    error: { ...Typography.default(), color: hull.danger, fontSize: 12, textAlign: 'center' },
    list: { paddingTop: hull.roomCard.gap },
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
    rowSurface: {
      backgroundColor: hull.bgBase,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      overflow: 'hidden',
    },
    rowSurfaceFirst: {
      borderTopWidth: 1,
      borderTopLeftRadius: hull.roomCard.cornerRadius,
      borderTopRightRadius: hull.roomCard.cornerRadius,
    },
    rowSurfaceLast: {
      borderBottomWidth: 1,
      borderBottomLeftRadius: hull.roomCard.cornerRadius,
      borderBottomRightRadius: hull.roomCard.cornerRadius,
    },
    roomCell: {
      paddingHorizontal: hull.roomCard.inset,
    },
    roomCellLast: { paddingBottom: hull.roomCard.gap },
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
  };
});
