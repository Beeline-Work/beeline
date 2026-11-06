import { appErrorCopy } from '@/buzz/app-error-copy';
import { showVoiceJoinError } from '@/buzz/voice-update';
import { useUntaggedMessageHints } from '@/buzz/use-untagged-message-hints';
import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { useFocusEffect, router, type Href } from 'expo-router';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type RoomRepository, type ChatListItem } from '@beeline/buzz-client';
import { roomViewTranscriptMessages, type ChatDisplayMessage, workspaceRailItem } from '@/buzz/room-view-presentation';
import { buildChannelReferenceIndex, isUnavailableChannelReferenceError, resolveCornerFromList, type ChannelReferenceIndex, type ChannelReferenceTarget } from '@/buzz/channel-reference';
import { subscribeDesktopArtifact } from '@/buzz/desktop-artifact-pane';
import { subscribeDesktopComputer } from '@/buzz/desktop-computer-pane';
import { type DesktopWorkPaneEvent, type DesktopWorkPanePrimary } from '@/buzz/desktop-workbench-state';
import { useChatList } from '@/buzz/chat-list-store';
import { cornerHref, resolveMentionDirectMessageAction, roomHref } from '@/buzz/corner-navigation';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { shallowEqualRecord, useStable } from '@/buzz/use-stable';
import { useVoiceCall } from '@/buzz/use-voice-call';
import { subscribeDesktopWorkCorner } from '@/buzz/desktop-work-pane';
import { INITIAL_CORNER_MESSAGE_WINDOW, INITIAL_MESSAGE_WINDOW } from './chat-surface-values';

type Props = [
  chatListKey: { relayUrl: string; viewerPubkey: string; workspaceId: string; } | null,
  decodedId: string,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  userPubkey: string,
  isFocused: () => boolean,
  isDirectMessage: boolean,
  isArchived: boolean,
  isCorner: boolean,
  activeCommunityId: string | null,
  surfaceParentId: string | undefined,
  roomRepoAccessIssue: { fullName: string; reason: "revoked" | "not_granted"; installationId?: number; } | null,
  setCornerOpenRepoPrompt: React.Dispatch<React.SetStateAction<boolean>>,
  parentChannelId: string | undefined,
  resolvedChannelName: string | null,
  routeChannelTitle: string | undefined,
  commitDesktopWorkPane: (event: DesktopWorkPaneEvent) => import("@/buzz/desktop-workbench-state").DesktopWorkPaneTransition,
  desktopExperience: boolean,
  desktopWorkRoomId: string,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  cacheViewerPubkey: string,
  setProfileKind: React.Dispatch<React.SetStateAction<"human" | "agent">>,
  setProfileAgentId: React.Dispatch<React.SetStateAction<string | null>>,
  transport: BuzzRigTransport | null,
];

export function useChatRoomPresentation([
  chatListKey, decodedId, roomSurface, userPubkey, isFocused, isDirectMessage, isArchived, isCorner,
  activeCommunityId, surfaceParentId, roomRepoAccessIssue, setCornerOpenRepoPrompt, parentChannelId,
  resolvedChannelName, routeChannelTitle, commitDesktopWorkPane, desktopExperience,
  desktopWorkRoomId, roomClient, cacheViewerPubkey, setProfileKind, setProfileAgentId, transport,
]: Props): [
  revealTranscriptThrough: (count: number) => void,
  transcriptHistoryStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
  transcriptJump: import("@/buzz/room-message-store").RoomJump | null,
  endTranscriptJump: () => void,
  serverTailRows: import("@beeline/api-contract/phone").RoomViewMessage[],
  serverHistoryRows: readonly import("@beeline/api-contract/phone").RoomViewMessage[],
  transcriptWindowId: number,
  historyAttached: boolean,
  resetTranscriptHistory: () => void,
  visibleMessageCount: number,
  cornerTask: string | undefined,
  loadOlderHistory: (residentRowCount: number) => void,
  retryOlderHistory: (residentRowCount: number) => void,
  jumpToTranscriptMessage: (messageId: string) => void,
  transcriptNewerStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
  retryNewerTranscriptMessages: () => void,
  workspaceChats: readonly ChatListItem[],
  viewerPubkey: string | undefined,
  roomRepository: RoomRepository | null,
  viewerIsAgent: boolean,
  canManageWorkspace: boolean,
  fillTranscript: (residentRowCount: number) => void,
  transcriptFillStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
  transcriptPositions: { getSnapshot: () => import("@/buzz/use-transcript-scrubber").TranscriptScrubberSnapshot; subscribe(listener: () => void): () => void; reveal: () => void; observeScroll(event: { contentOffset: { y: number; }; contentSize: { height: number; }; layoutMeasurement: { height: number; }; }): void; observeContentSize(contentHeight: number): void; observeVisibleRows(rows: readonly ChatDisplayMessage[]): void; reset(): void; dispose(): void; },
  loadNewerTranscriptMessages: () => void,
  loadLatestTranscriptMessages: () => void,
  voice: import("@/buzz/use-voice-call").VoiceCallState,
  workspaceChatList: import("@beeline/api-contract/phone").ChatListView | null,
  captureUntaggedSend: (hasMentions: boolean) => (messageId: string) => void,
  roomRepositoryResolved: boolean,
  canRenameTitle: boolean,
  openDesktopCorner: (roomId: string, cornerId: string) => void,
  handleOpenChannelReference: (target: ChannelReferenceTarget, text?: string) => Promise<void>,
  handleOpenMention: (participantId: string) => Promise<void>,
  channelReferenceIndex: ChannelReferenceIndex,
  handleOpenProfile: (agentId: string, kind?: "human" | "agent") => void,
  hintMessageIds: ReadonlySet<string>,
  channelReferenceKey: string,
  communities: { avatar?: string | undefined; communityId: string; name: string; }[],
] {

  const workspaceChatList = useChatList(chatListKey, { transcriptRoomId: decodedId });

  const workspaceChats = useMemo<readonly ChatListItem[]>(
    () => workspaceChatList?.chats ?? [],
    [workspaceChatList],
  );

  const viewerIsAgent = roomSurface?.viewer.identity.kind === 'agent';

  const { captureSend: captureUntaggedSend, hintMessageIds, endVisit: endUntaggedHintVisit } = useUntaggedMessageHints({
    roomId: decodedId,
    viewerPubkey: userPubkey,
    active: isFocused,
    viewerKind: roomSurface?.viewer.identity.kind,
    isDirectMessage,
    hasAgentMembers: Boolean(roomSurface?.members.some(member => member.identity.kind === 'agent')),
  });

  useFocusEffect(useCallback(() => () => endUntaggedHintVisit(), [endUntaggedHintVisit]));

  const roomVoiceAgents = useMemo(() => roomSurface?.members
    .filter(member => member.identity.kind === 'agent').map(member => member.identity) ?? [], [roomSurface?.members]);

  const voice = useVoiceCall(decodedId, Boolean(roomSurface?.viewer.permissions.send && !viewerIsAgent && !isArchived && !isCorner), roomVoiceAgents);

  useEffect(() => { if (voice.error && !voice.quotaExhausted && !voice.error.startsWith('Calls resume at ')) showVoiceJoinError(voice.error, () => { void voice.join(); }); }, [voice.error, voice.quotaExhausted, voice.join]);

  // The SERVER's statement of who is reading, so the phone's requester test and
  // the server's own are the same comparison over the same namespace.
  const viewerPubkey = roomSurface?.viewer.identity.pubkey;

  const canManageWorkspace = roomSurface?.viewer.permissions.manage ?? false;

  const canRenameTitle = isCorner
    ? !viewerIsAgent && !isArchived
    : Boolean(!isDirectMessage && !viewerIsAgent && canManageWorkspace);

  const communities = useMemo(
    () =>
      roomSurface && activeCommunityId
        ? [
            workspaceRailItem({
              id: activeCommunityId,
              name: roomSurface.parent?.name ?? roomSurface.room.name,
              visibility: 'invite-only',
              role: roomSurface.viewer.role,
              updatedAt: roomSurface.room.updatedAt ?? 0,
            }),
          ]
        : [],
    [activeCommunityId, roomSurface?.parent, roomSurface?.room, roomSurface?.viewer.role],
  );

  const cornerTask = surfaceParentId ? roomSurface?.room.about : undefined;

  const roomRepository = useMemo<RoomRepository | null>(() => {
    if (isCorner || !roomSurface?.repository || !activeCommunityId) return null;
    const repository = roomSurface.repository;
    return {
      channelId: decodedId,
      communityId: activeCommunityId,
      binding: {
        key: repository.key,
        name: repository.name,
        remote: repository.remote,
        localOnly: false,
        ...(repository.githubInstallationId
          ? { githubInstallationId: repository.githubInstallationId }
          : {}),
      },
      targetBranch: repository.targetBranch,
      githubEventsEnabled: repository.githubEventsEnabled,
      allowAutoMerge: repository.allowAutoMerge,
      source: 'config',
    };
  }, [activeCommunityId, decodedId, isCorner, roomSurface?.repository]);

  const roomRepositoryState = roomSurface?.repositoryResolution;

  // A loaded surface with no repository field is not enough to prompt. The
  // indexer distinguishes a proven empty Room from an unverified binding,
  // including bindings authored by a predecessor key.
  const roomRepositoryResolved = roomRepositoryState === 'none';

  useEffect(() => {
    // A stale cached `none` response can briefly open the lazy prompt before a
    // fresh server read discovers a binding it cannot verify. Do not leave the
    // stronger, fresh fact painted as the false "not linked" banner.
    if (roomRepositoryState !== 'none' && !roomRepoAccessIssue) {
      setCornerOpenRepoPrompt(false);
    }
  }, [roomRepoAccessIssue, roomRepositoryState]);

  const serverTailRows = useMemo(
    () => (roomSurface ? roomViewTranscriptMessages(roomSurface) : []),
    [roomSurface?.messages, roomSurface?.toolRows],
  );

  // Resolve references only within the Room family returned by this surface.
  const rawChannelReferenceIndex = useMemo<ChannelReferenceIndex>(() => {
    return buildChannelReferenceIndex(
      [
        ...workspaceChats
          .filter((item) => !item.directMessage)
          .map((item) => ({ channelId: item.room.id, name: item.room.name }))
          .sort((left, right) => left.channelId.localeCompare(right.channelId)),
        ...(roomSurface?.parent
          ? [{ channelId: roomSurface.parent.id, name: roomSurface.parent.name }]
          : []),
        ...(parentChannelId
          ? []
          : [{ channelId: decodedId, name: resolvedChannelName || routeChannelTitle || '' }]),
      ].filter((room): room is { channelId: string; name: string } => room !== null),
      [
        ...(parentChannelId
          ? [
              {
                channelId: decodedId,
                parentChannelId,
                name: resolvedChannelName || routeChannelTitle || '',
              },
            ]
          : []),
      ],
    );
  }, [
    decodedId,
    parentChannelId,
    resolvedChannelName,
    roomSurface?.parent,
    routeChannelTitle,
    workspaceChats,
  ]);

  // Room previews change on each arrival; links depend only on ids and names.
  const channelReferenceIndex = useStable(rawChannelReferenceIndex, (previous, next) =>
    previous.rooms.length === next.rooms.length &&
    previous.corners.length === next.corners.length &&
    previous.rooms.every((room, index) => shallowEqualRecord(room, next.rooms[index]!)) &&
    previous.corners.every((corner, index) => shallowEqualRecord(corner, next.corners[index]!)),
  );

  const channelReferenceKey = useMemo(
    () =>
      [
        ...channelReferenceIndex.rooms.map((room) => `${room.channelId}\0${room.name}`),
        ...channelReferenceIndex.corners.map(
          (corner) => `${corner.channelId}\0${corner.parentChannelId}\0${corner.name}`,
        ),
      ].join('\n'),
    [channelReferenceIndex],
  );

  const desktopWorkPanePrimary: DesktopWorkPanePrimary = isDirectMessage
    ? 'direct-message'
    : isCorner
      ? 'corner'
      : 'room';

  // A corner always opens in the primary view; the second pane is for artifacts.
  const openDesktopCorner = useCallback(
    (roomId: string, cornerId: string) => {
      const transition = commitDesktopWorkPane({
        type: 'open-corner',
        cornerId,
        primary: desktopWorkPanePrimary,
      });
      if (transition.placement === 'primary') router.push(cornerHref(cornerId, roomId));
    },
    [commitDesktopWorkPane, desktopWorkPanePrimary],
  );

  // Background stack screens stay mounted, so only the focused one listens.
  useFocusEffect(useCallback(() => {
    if (!desktopExperience || !isFocused()) return;
    return subscribeDesktopWorkCorner(({ roomId, cornerId }) => {
      if (roomId !== desktopWorkRoomId) return false;
      openDesktopCorner(roomId, cornerId);
      return true;
    });
  }, [desktopExperience, desktopWorkRoomId, isFocused, openDesktopCorner]));

  // The work pane and the Room route are siblings, so an artifact Open press
  // arrives as a module event. It replaces whatever the pane showed. When the
  // pane cannot take it, the card opens the full-screen viewer instead.
  useFocusEffect(useCallback(() => {
    if (!desktopExperience || !isFocused()) return;
    return subscribeDesktopArtifact(
      (artifact) =>
        commitDesktopWorkPane({ type: 'open-artifact', artifact, primary: desktopWorkPanePrimary })
          .placement === 'pane',
    );
  }, [commitDesktopWorkPane, desktopExperience, desktopWorkPanePrimary, isFocused]));

  useFocusEffect(useCallback(() => {
    if (!desktopExperience || !isFocused()) return;
    return subscribeDesktopComputer((session) =>
      commitDesktopWorkPane({ type: 'open-computer', session, primary: desktopWorkPanePrimary })
        .placement === 'pane',
    );
  }, [commitDesktopWorkPane, desktopExperience, desktopWorkPanePrimary, isFocused]));

  /** Navigate to exactly the referenced Room/Corner through the existing
   * conventions; a reference to the transcript you are already in is a no-op. */
  const openingChannelReferenceRef = useRef<string | null>(null);

  const handleOpenChannelReference = useCallback(
    async (target: ChannelReferenceTarget, text?: string) => {
      if (target.kind === 'room' && (!target.channelId || target.channelId === decodedId)) return;
      if (target.kind === 'corner' && target.channelId === decodedId) return;
      if (openingChannelReferenceRef.current) return;
      const referenceLabel = text ?? 'this destination';
      if (!roomClient) {
        Modal.alert(
          'Destination unavailable',
          `Beeline is still connecting. Try ${referenceLabel} again in a moment.`,
        );
        return;
      }
      const lock =
        target.kind === 'corner'
          ? (target.channelId ?? `pending:${target.parentChannelId}:${target.name ?? text ?? ''}`)
          : target.channelId;
      openingChannelReferenceRef.current = lock;
      try {
        let resolved = target;
        if (resolved.kind === 'corner' && !resolved.channelId) {
          const list = await roomClient.corners(resolved.parentChannelId);
          const found = resolveCornerFromList(
            text ?? '',
            { id: list.room.id, name: list.room.name },
            list.corners.map((item) => ({ id: item.corner.id, name: item.corner.name })),
          );
          if (!found) {
            Modal.alert(
              'Access denied',
              `${referenceLabel} is unavailable or you no longer have access.`,
            );
            return;
          }
          resolved = found;
        }
        if (!resolved.channelId || resolved.channelId === decodedId) return;
        // The destination's own Room read is the authorization verdict. A
        // preflight here doubled the request for every successful open.
        if (resolved.kind === 'corner')
          openDesktopCorner(resolved.parentChannelId, resolved.channelId);
        else router.push(roomHref(resolved.channelId));
      } catch (error) {
        if (isUnavailableChannelReferenceError(error)) {
          Modal.alert(
            'Access denied',
            `${referenceLabel} is unavailable or you no longer have access.`,
          );
        } else {
          Modal.alert(
            'Could not open destination',
            `Beeline could not verify access to ${referenceLabel}. Try again.`,
          );
        }
      } finally {
        openingChannelReferenceRef.current = null;
      }
    },
    [decodedId, openDesktopCorner, roomClient],
  );

  const handleOpenProfile = useCallback(
    (agentId: string, kind: 'human' | 'agent' = 'agent') => {
      if (agentId === cacheViewerPubkey) {
        router.push('/beeline/settings' as Href);
        return;
      }
      setProfileKind(kind);
      if (!activeCommunityId) return;
      if (desktopExperience) setProfileAgentId(agentId);
      else
        router.push(
          kind === 'human'
            ? ({
                pathname: '/beeline/human-profile',
                params: { communityId: activeCommunityId, memberId: agentId },
              } as Href)
            : ({
                pathname: '/beeline/agent-profile',
                params: { communityId: activeCommunityId, agentId, roomId:decodedId },
              } as Href),
        );
    },
    [activeCommunityId, desktopExperience, cacheViewerPubkey,decodedId],
  );

  const openingMentionRef = useRef<string | null>(null);

  const handleOpenMention = useCallback(
    async (participantId: string) => {
      if (participantId === cacheViewerPubkey || openingMentionRef.current) return;
      if (!transport || !activeCommunityId) {
        Modal.alert(
          'Could not open direct message',
          'Beeline is still connecting. Try the mention again in a moment.',
        );
        return;
      }
      openingMentionRef.current = participantId;
      try {
        const action = await resolveMentionDirectMessageAction(
          (workspaceId, memberId) => transport.resolveDirectMessage(workspaceId, memberId),
          activeCommunityId,
          participantId,
          decodedId,
        );
        if (action.type === 'open-room') router.push(roomHref(action.channelId));
      } catch (reason) {
        Modal.alert(
          'Could not open direct message',
          appErrorCopy(reason),
        );
      } finally {
        openingMentionRef.current = null;
      }
    },
    [activeCommunityId, cacheViewerPubkey, decodedId, transport],
  );

  // The cold-open deadline bounds the single authenticated Room request.
  // A rejected request surfaces through `onStepFailed('transcript')` below.
  // Older pages loaded on demand via "scroll up" pagination. Kept out of the
  // shared cache (which bounds to the recent tail) and merged in only here.
  // History stays as verbatim server rows in page-lifetime partitions. It is
  // converted to render props only below, never persisted as a derived
  // transcript or folded into the current Room response.
  const {
    rows: serverHistoryRows,
    positions: transcriptPositions,
    attached: historyAttached,
    windowId: transcriptWindowId,
    jump: transcriptJump,
    newerStatus: transcriptNewerStatus,
    loadNewer: loadNewerTranscriptMessages,
    fill: fillTranscript,
    fillStatus: transcriptFillStatus,
    retryNewer: retryNewerTranscriptMessages,
    endJump: endTranscriptJump,
    loadLatest: loadLatestTranscriptMessages,
    jumpTo: jumpToTranscriptMessage,
    visibleMessageCount,
    status: transcriptHistoryStatus,
    loadOlder: loadOlderHistory,
    retryOlder: retryOlderHistory,
    revealThrough: revealTranscriptThrough,
    reset: resetTranscriptHistory,
  } = useRoomMessageStore({
    roomId: decodedId,
    tailMessages: roomSurface?.room.id === decodedId ? roomSurface.messages : undefined,
    roomClient,
    enabled: Boolean(cacheViewerPubkey),
    initialVisibleCount: isCorner ? INITIAL_CORNER_MESSAGE_WINDOW : INITIAL_MESSAGE_WINDOW,
  });
  return [
    revealTranscriptThrough, transcriptHistoryStatus, transcriptJump, endTranscriptJump,
    serverTailRows, serverHistoryRows, transcriptWindowId, historyAttached, resetTranscriptHistory,
    visibleMessageCount, cornerTask, loadOlderHistory, retryOlderHistory, jumpToTranscriptMessage,
    transcriptNewerStatus, retryNewerTranscriptMessages, workspaceChats, viewerPubkey,
    roomRepository, viewerIsAgent, canManageWorkspace, fillTranscript, transcriptFillStatus,
    transcriptPositions, loadNewerTranscriptMessages, loadLatestTranscriptMessages, voice,
    workspaceChatList, captureUntaggedSend, roomRepositoryResolved, canRenameTitle,
    openDesktopCorner, handleOpenChannelReference, handleOpenMention, channelReferenceIndex,
    handleOpenProfile, hintMessageIds, channelReferenceKey, communities,
  ];
}
