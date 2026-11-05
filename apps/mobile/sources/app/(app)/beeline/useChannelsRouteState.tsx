import { useNeedsYouCount } from '@/buzz/needs-you-store';
import { type ChatListHandle } from '@/buzz/chat-list-store';
import { useCornerDropdowns } from '@/buzz/corner-dropdowns';
import { type RepoCandidate } from '@/buzz/room-repo-picker';
import { mobileSurfaceCache, surfaceAddress, restoreStoredSurface } from '@/buzz/surface-storage';
import { useGitHubAccess } from '@/buzz/github-access-surface';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { BuzzRigTransport } from '@/sync/transport';
import { useIsDesktop } from '@/utils/responsive';
import { isChatListView, isWorkspaceListView, type ChatListView, type Identity, type WorkspaceListView } from '@beeline/buzz-client';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { afterFirstFrame, FirstContentDrawContext } from '@/navigation/initial-landing';
import { firstParam, DeckSession } from './channels';

type Props = [
  session: DeckSession,
];
export function useChannelsRouteState([
  session,
]: Props): [
  workspaceList: WorkspaceListView | null,
  requestedWorkspaceId: string | undefined,
  chatList: ChatListView | null,
  identity: Identity,
  relayUrl: string,
  isDesktop: boolean,
  requestedNewRoom: string | undefined,
  handledNewRoomRequest: import("react/index").RefObject<string | null>,
  setShowCreateRoom: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  requestedNewDirectMessage: string | undefined,
  setMemberPickerVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  readWorkspaceRef: import("react/index").RefObject<(() => Promise<void>) | null>,
  chatStore: import("react/index").RefObject<ChatListHandle | null>,
  deckMissedRef: import("react/index").RefObject<{ workspaces: boolean; }>,
  transport: BuzzRigTransport,
  setError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  drawn: boolean,
  setConfirmedWorkspaceCount: import("react/index").Dispatch<import("react/index").SetStateAction<number | null>>,
  deckVisible: () => boolean,
  deckFocusedRef: import("react/index").RefObject<boolean>,
  setDeletedWorkspaceNotice: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  selectedId: string | undefined,
  setChatList: import("react/index").Dispatch<import("react/index").SetStateAction<ChatListView | null>>,
  setRefreshing: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setNeedsYouSignal: import("react/index").Dispatch<import("react/index").SetStateAction<number>>,
  retryGeneration: number,
  setAgeNow: import("react/index").Dispatch<import("react/index").SetStateAction<number>>,
  memberPickerVisible: boolean,
  cornerDropdowns: { expanded: ReadonlySet<string>; setExpanded: import("react/index").Dispatch<import("react/index").SetStateAction<ReadonlySet<string>>>; toggle: (roomId: string) => void; },
  messagingPubkey: string | null,
  setMessagingPubkey: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  githubScope: { relay: string; viewer: string; } | null,
  setRepoPickerError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setRepoAccessLoading: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setShowRepoPicker: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setPendingRepo: import("react/index").Dispatch<import("react/index").SetStateAction<RepoCandidate | null>>,
  setInviteOnly: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setRepoPickerNotice: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setCreatingRepository: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  creatingRoom: boolean,
  creatingRepository: boolean,
  setCreatingRoom: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  inviteOnly: boolean,
  confirmedWorkspaceCount: number | null,
  error: string | null,
  pairingBusy: boolean,
  setAgentConnectVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setPairCommand: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setPairingError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setPairingBusy: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  insets: import("react-native-safe-area-context/lib/typescript/src/SafeArea.types").EdgeInsets,
  setRetryGeneration: import("react/index").Dispatch<import("react/index").SetStateAction<number>>,
  onLayout: () => void,
  refreshing: boolean,
  needsYouCount: number,
  showCreateRoom: boolean,
  pendingRepo: RepoCandidate | null,
  showRepoPicker: boolean,
  repoAccessLoading: boolean,
  repoCandidates: RepoCandidate[],
  repoInstallations: import("@beeline/buzz-client").GitHubInstallationAccess[],
  repoPickerError: string | null,
  repoPickerNotice: string | null,
  agentConnectVisible: boolean,
  pairingError: string | null,
  pairCommand: string | null,
  deletedWorkspaceNotice: string | null,
  ageNow: number,
] {

  const [retryGeneration, setRetryGeneration] = useState(0);
  const insets = useSafeAreaInsets();
  const isDesktop = useIsDesktop();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    newRoom?: string | string[];
    newDirectMessage?: string | string[];
  }>();
  const requestedWorkspaceId = firstParam(params.communityId);
  // The route's Workspace wins; without one the deck follows the current Workspace.
  const deckWorkspaceId = requestedWorkspaceId ?? session.workspaceId;
  const requestedNewRoom = firstParam(params.newRoom);
  const requestedNewDirectMessage = firstParam(params.newDirectMessage);
  const { identity, relayUrl } = session;
  const transport = useMemo(() => new BuzzRigTransport(identity), [identity]);
  const workspaceListAddress = useMemo(
    () => surfaceAddress(relayUrl, identity.publicKey, '/workspaces'),
    [identity.publicKey, relayUrl],
  );
  const workspaceList = useSurfaceSnapshot(workspaceListAddress, isWorkspaceListView);
  // Only a live read (never a cached one) may say "you have no Workspace".
  const [confirmedWorkspaceCount, setConfirmedWorkspaceCount] = useState<number | null>(null);

  const [selectedId] = useState(() => deckWorkspaceId ?? mobileSurfaceCache.peek(workspaceListAddress, isWorkspaceListView)?.workspaces[0]?.id);
  const [chatList, setChatList] = useState<ChatListView | null>(() => selectedId
    ? restoreStoredSurface(surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/chats', { workspaceId: selectedId }), isChatListView)
    : null);
  const notifyDraw = useContext(FirstContentDrawContext);
  const [drawn, setDrawn] = useState(false);
  const firstLayout = useRef<(() => void) | null>(null);
  const onLayout = useCallback(() => {
    if (firstLayout.current) return;
    notifyDraw();
    firstLayout.current = afterFirstFrame(() => setDrawn(true));
  }, [notifyDraw]);
  useEffect(() => () => { firstLayout.current?.(); firstLayout.current = null; }, []);
  useLatencyRouteFrame('/beeline/channels', chatList !== null, true);
  // A covering list read seeds the Needs-you rows behind the badge;
  // ordinary changes carry typed row deltas on the live socket.
  const [needsYouSignal, setNeedsYouSignal] = useState(0);
  const needsYouCount = useNeedsYouCount(
    chatList?.workspace.id,
    needsYouSignal === 0 ? undefined : needsYouSignal,
    () => deckVisible(),
  );
  const cornerDropdowns = useCornerDropdowns(chatList?.chats);
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
  const [inviteOnly, setInviteOnly] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [creatingRepository, setCreatingRepository] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const githubScope = relayUrl && identity ? { relay: relayUrl, viewer: identity.publicKey } : null;
  const githubAccess = useGitHubAccess(githubScope);
  const repoCandidates = githubAccess?.candidates ?? [];
  const repoInstallations = githubAccess?.installations ?? [];
  const [repoAccessLoading, setRepoAccessLoading] = useState(false);
  const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
  const [repoPickerNotice, setRepoPickerNotice] = useState<string | null>(null);
  const handledNewRoomRequest = useRef<string | null>(null);
  const chatStore = useRef<ChatListHandle | null>(null);
  const readWorkspaceRef = useRef<(() => Promise<void>) | null>(null);
  const deckFocusedRef = useRef(true);
  const deckVisible = useCallback(
    () => deckFocusedRef.current && AppState.currentState === 'active',
    [],
  );
  /** Reads the hidden deck skipped; returning to it makes exactly those. */
  const deckMissedRef = useRef({ workspaces: false });
return [
    workspaceList, requestedWorkspaceId, chatList, identity, relayUrl, isDesktop, requestedNewRoom,
    handledNewRoomRequest, setShowCreateRoom, requestedNewDirectMessage, setMemberPickerVisible,
    readWorkspaceRef, chatStore, deckMissedRef, transport, setError, drawn,
    setConfirmedWorkspaceCount, deckVisible, deckFocusedRef, setDeletedWorkspaceNotice, selectedId,
    setChatList, setRefreshing, setNeedsYouSignal, retryGeneration, setAgeNow, memberPickerVisible,
    cornerDropdowns, messagingPubkey, setMessagingPubkey, githubScope, setRepoPickerError,
    setRepoAccessLoading, setShowRepoPicker, setPendingRepo, setInviteOnly, setRepoPickerNotice,
    setCreatingRepository, creatingRoom, creatingRepository, setCreatingRoom, inviteOnly,
    confirmedWorkspaceCount, error, pairingBusy, setAgentConnectVisible, setPairCommand,
    setPairingError, setPairingBusy, insets, setRetryGeneration, onLayout, refreshing,
    needsYouCount, showCreateRoom, pendingRepo, showRepoPicker, repoAccessLoading, repoCandidates,
    repoInstallations, repoPickerError, repoPickerNotice, agentConnectVisible, pairingError,
    pairCommand, deletedWorkspaceNotice, ageNow,
  ];
}
