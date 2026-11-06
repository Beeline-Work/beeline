import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useCallback, useMemo } from 'react';
import { TextInput } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatListItem } from '@beeline/buzz-client';
import { directMessageTitle } from '@beeline/api-contract/phone';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { planComposerFill, type ComposerMention } from '@/buzz/composer-fill';
import { roomStarterIntro, roomStarterPrompts } from '@/buzz/starter-prompts';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { directMessageHeaderIdentity } from '@/buzz/member-display';
import { directMessageAgentHeaderMeta, directMessageHeaderPresence } from '@/buzz/direct-message-header-presence';
import { channelHeaderTitle, type ChannelKind } from '@/buzz/corner-session';
import { type EmptyLedgerVariant } from '@/components/buzz/EmptyLedgerState';
import type { ChannelHeaderKind } from '@/buzz/channel-header-title';

type Props = [
  parentChannelId: string | undefined,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  resolvedChannelName: string | null,
  isCorner: boolean,
  channelKind: ChannelKind,
  decodedId: string,
  isDirectMessage: boolean,
  userPubkey: string,
  directMessage: import("@beeline/api-contract/phone").RoomDirectMessageView | null,
  personProfileByPubkey: Map<string, { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; }>,
  directMessageListItem: ChatListItem | null,
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  presenceNow: number,
  workspaceRoster: { members: import("@beeline/api-contract/phone").RoomViewMember[]; agents: import("@beeline/api-contract/phone").WorkspaceAgentView[]; workspace: import("@beeline/api-contract/phone").ChatListWorkspace & { readonly about?: string; readonly createdAt: number; }; managerSettings?: { readonly allowFixSweep?: boolean; readonly visibility: "public" | "invite-only"; readonly rooms?: readonly import("@beeline/api-contract/phone").WorkspaceManagedRoomView[]; readonly roomsTruncated?: boolean; }; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; viewer: import("@beeline/api-contract/phone").RoomViewer; watchFilters: readonly import("@beeline/api-contract/phone").SurfaceWatchFilter[]; } | null,
  isReadOnlyDirectMessage: boolean,
  composerRef: React.RefObject<TextInput | null>,
  inputTextRef: React.RefObject<string>,
  selectedAgentMentionsRef: React.RefObject<Map<string, string>>,
  selectedMentionsRef: React.RefObject<Map<string, string>>,
  setInputText: (update: string | ((previous: string) => string)) => void,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  activeCommunityId: string | null,
  agentPairBusy: boolean,
  viewerIsAgent: boolean,
  setAgentConnectVisible: React.Dispatch<React.SetStateAction<boolean>>,
  setAgentPairCommand: React.Dispatch<React.SetStateAction<string | null>>,
  setAgentPairError: React.Dispatch<React.SetStateAction<string | null>>,
  setAgentPairBusy: React.Dispatch<React.SetStateAction<boolean>>,
  transport: BuzzRigTransport | null,
  setSessionTransport: (transport: BuzzRigTransport) => void,
  canManageWorkspace: boolean,
  setMembershipError: React.Dispatch<React.SetStateAction<string | null>>,
  setParticipantPickerKind: React.Dispatch<React.SetStateAction<"agent" | "person" | null>>,
  openWorkspaceRoster: () => void,
  setParticipantPickerVisible: React.Dispatch<React.SetStateAction<boolean>>,
];

export function useChatHeader([
  parentChannelId, roomSurface, resolvedChannelName, isCorner, channelKind, decodedId,
  isDirectMessage, userPubkey, directMessage, personProfileByPubkey, directMessageListItem,
  agentByPubkey, presenceNow, workspaceRoster, isReadOnlyDirectMessage, composerRef, inputTextRef,
  selectedAgentMentionsRef, selectedMentionsRef, setInputText, setInputSelection, activeCommunityId,
  agentPairBusy, viewerIsAgent, setAgentConnectVisible, setAgentPairCommand, setAgentPairError,
  setAgentPairBusy, transport, setSessionTransport, canManageWorkspace, setMembershipError,
  setParticipantPickerKind, openWorkspaceRoster, setParticipantPickerVisible,
]: Props): [
  emptyLedgerVariant: EmptyLedgerVariant,
  displayRoomName: string,
  roomName: string,
  firstRoomAgent: import("@beeline/api-contract/phone").RoomViewIdentity | undefined,
  startCornerMessage: () => void,
  focusComposer: () => void,
  starterPrompts: { lead: string; detail: string; testID: string; onPress: () => void; }[] | undefined,
  starterIntro: string | undefined,
  storedRoomName: string,
  headerTitleKind: ChannelHeaderKind,
  displayHeaderTitle: string | null,
  dmPeerPubkey: string | undefined,
  dmPeerIdentity: import("@beeline/api-contract/phone").RoomViewIdentity | undefined,
  dmPeerAgentDisplay: import("@/buzz/agent-display").AgentDisplayIdentity | undefined,
  dmPeerProfile: { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; } | undefined,
  dmHeaderPresence: string,
  headerTitle: string | null,
  closeAgentConnect: () => void,
  connectAgent: () => Promise<void>,
  copyPairCommand: (command: string) => Promise<void>,
] {

  // `null` means "show a skeleton": the channel kind or its name is still
  // resolving and no honest word exists yet. A corner never renders the Room
  // label as a stand-in for its own slug.
  // The parent Room's STORED name, for a corner's `#<room>/<corner>` header.
  // Read from the same Room-list cache the reference resolver uses — never a
  // second index. `undefined` = not a corner; `null` = corner whose parent
  // name has not landed yet (the header degrades to `#<corner>`, it does not
  // block on another read).
  const parentRoomName = useMemo(() => {
    if (!parentChannelId) return undefined;
    const parent = roomSurface?.parent;
    return parent?.name?.trim() ? parent.name : null;
  }, [parentChannelId, roomSurface?.parent]);

  const headerTitle = channelHeaderTitle(
    resolvedChannelName,
    isCorner ? 'corner' : channelKind,
    decodedId,
    {
      directMessage: isDirectMessage,
      parentRoomName,
    },
  );

  // Room-lifecycle copy ("Delete <name>?"), rename drafts, and cache writes
  // use the STORED name — the `#` mark is display-only and must never leak
  // into a mutation path. The header renders through `headerTitle` instead.
  const roomName = headerTitle ?? ROOM_LABEL;

  const storedRoomName = resolvedChannelName?.trim() || ROOM_LABEL;

  // A DM's title is its peer's identity. Derived from cached state rather
  // than resolved inside the enter-room fetch chain, so it is right on the
  // first painted frame of a warm cache instead of several server reads later.
  // Deliberately not `directMessagePeer`, which throws when the viewer is not
  // a participant — a throw here would be a render-time crash, not a bad title.
  const dmPeerPubkey = userPubkey
    ? directMessage?.participants.find((pubkey) => pubkey !== userPubkey)
    : undefined;

  const dmPeerProfile = dmPeerPubkey ? personProfileByPubkey.get(dmPeerPubkey) : undefined;

  const dmPeerIdentity = dmPeerPubkey
    ? (roomSurface?.members.find((member) => member.identity.pubkey === dmPeerPubkey)?.identity ??
      directMessageListItem?.directMessage?.peer)
    : undefined;

  const dmPeerAgent = dmPeerPubkey ? agentByPubkey.get(dmPeerPubkey) : undefined;

  const dmPeerAgentDisplay =
    dmPeerPubkey && dmPeerAgent
      ? resolveAgentDisplayIdentity(dmPeerPubkey, dmPeerAgent)
      : undefined;

  const dmPeerPresence = directMessageHeaderPresence(
    directMessageListItem?.room.id === decodedId ? directMessageListItem : null,
    presenceNow,
  );

  const dmPeerWorkspaceAgent = dmPeerPubkey
    ? workspaceRoster?.agents.find((agent) => agent.identity.pubkey === dmPeerPubkey)
    : undefined;

  const dmHeaderPresence =
    dmPeerAgent || dmPeerWorkspaceAgent
      ? directMessageAgentHeaderMeta(
          {
            model: dmPeerWorkspaceAgent?.model,
            ownerHandle: dmPeerWorkspaceAgent?.owner?.handle,
          },
          dmPeerPresence,
        )
      : dmPeerPresence;

  const dmAnnouncementAuthor = dmPeerPubkey
    ? roomSurface?.messages.find((message) => message.author.pubkey === dmPeerPubkey)?.author
    : undefined;

  const displayRoomName = useMemo(() => {
    if (!dmPeerPubkey) return roomName;
    // One title rule with the Room list row: `@<handle>` from the peer.
    if (dmPeerAgentDisplay) return directMessageTitle(dmPeerIdentity ?? dmPeerAgentDisplay);
    return directMessageTitle(
      directMessageHeaderIdentity(
        dmPeerIdentity,
        dmPeerProfile,
        dmPeerPubkey,
        isReadOnlyDirectMessage,
        dmAnnouncementAuthor,
      ),
    );
  }, [
    dmAnnouncementAuthor,
    dmPeerAgentDisplay,
    dmPeerIdentity,
    dmPeerProfile,
    dmPeerPubkey,
    isReadOnlyDirectMessage,
    roomName,
  ]);

  // The header's own title still distinguishes "not resolved yet" (`null` —
  // render the skeleton) from a resolved name. A DM is resolved as soon as its
  // peer is known, which the cached roster usually already answers.
  const displayHeaderTitle = dmPeerPubkey ? displayRoomName : headerTitle;

  const headerTitleKind: ChannelHeaderKind = isCorner ? 'corner' : dmPeerPubkey ? 'dm' : 'room';

  const emptyLedgerVariant: EmptyLedgerVariant = isCorner
    ? 'corner'
    : isDirectMessage
      ? 'dm'
      : 'room';

  const focusComposer = useCallback(() => {
    scheduleAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // The first Room teaches by doing: each starter fills the live composer
  // (tagging the Room's first agent when there is one) or opens the invite.
  const firstRoomAgent = useMemo(
    () =>
      roomSurface?.members.find(
        (member) => member.identity.kind === 'agent' && Boolean(member.identity.handle),
      )?.identity,
    [roomSurface?.members],
  );

  // The one way anything but typing puts words in the composer: a starter
  // Starter prompts go through here, and `planComposerFill`
  // owns what that does to a draft somebody already started.
  const fillComposer = useCallback(
    (text: string, options: { mention?: ComposerMention; focusOnRefusal?: boolean } = {}) => {
      const plan = planComposerFill({ draft: inputTextRef.current, text, ...options });
      if (plan.focus) scheduleAnimationFrame(() => composerRef.current?.focus());
      if (!plan.fill) return false;
      if (plan.fill.mention) {
        selectedAgentMentionsRef.current.set(plan.fill.mention.handle, plan.fill.mention.pubkey);
        selectedMentionsRef.current.set(plan.fill.mention.handle, plan.fill.mention.pubkey);
      }
      inputTextRef.current = plan.fill.text;
      setInputText(plan.fill.text);
      setInputSelection(plan.fill.selection);
      return true;
    },
    [],
  );

  const startCornerMessage = useCallback(() => {
    const handle = firstRoomAgent?.handle?.replace(/^@/, '');
    if (!handle || !firstRoomAgent) return focusComposer();
    fillComposer(`@${handle} `, {
      mention: { handle, pubkey: firstRoomAgent.pubkey },
      focusOnRefusal: true,
    });
  }, [fillComposer, firstRoomAgent, focusComposer]);

  // The same minted pairing command the Room deck and the create wizard show,
  // in the same sheet: a Room with no agent has nobody to ask yet.
  const connectAgent = useCallback(async () => {
    if (!activeCommunityId || agentPairBusy || viewerIsAgent) return;
    setAgentConnectVisible(true);
    setAgentPairCommand(null);
    setAgentPairError(null);
    setAgentPairBusy(true);
    try {
      let pairingTransport = transport;
      if (!pairingTransport) {
        const identity = await loadBuzzIdentity();
        if (!identity) throw new Error('Beeline identity is unavailable');
        pairingTransport = new BuzzRigTransport(identity);
        setSessionTransport(pairingTransport);
      }
      const pairing = await (
        await pairingTransport.ensureClient()
      ).createAgentPairingCode(activeCommunityId);
      setAgentPairCommand(agentPairingCommand(pairing.code));
    } catch (reason) {
      setAgentPairError(appErrorCopy(reason, `Could not create agent invite.`));
    } finally {
      setAgentPairBusy(false);
    }
  }, [activeCommunityId, agentPairBusy, setSessionTransport, transport, viewerIsAgent]);

  const closeAgentConnect = useCallback(() => {
    setAgentConnectVisible(false);
    setAgentPairCommand(null);
    setAgentPairError(null);
  }, []);

  const copyPairCommand = useCallback(async (command: string) => {
    await Clipboard.setStringAsync(command);
  }, []);

  const starterPromptDefs = useMemo(() => {
    if (emptyLedgerVariant !== 'room' || viewerIsAgent || !roomSurface?.viewer.permissions.send)
      return undefined;
    return roomStarterPrompts({
      roomAgent: firstRoomAgent,
      workspaceAgentCount: workspaceRoster ? workspaceRoster.agents.length : null,
      canManageWorkspace,
      workspaceName: workspaceRoster?.workspace.name,
    });
  }, [
    canManageWorkspace,
    emptyLedgerVariant,
    firstRoomAgent,
    roomSurface?.viewer.permissions.send,
    viewerIsAgent,
    workspaceRoster,
  ]);

  const starterIntro = starterPromptDefs ? roomStarterIntro(starterPromptDefs) : undefined;

  const starterPrompts = useMemo(() => {
    if (!starterPromptDefs) return undefined;
    return starterPromptDefs.map((prompt) => ({
      lead: prompt.lead,
      detail: prompt.detail,
      testID: prompt.testID,
      onPress: () => {
        if (prompt.action.kind === 'fill')
          fillComposer(prompt.action.text, {
            mention: prompt.action.mention,
            focusOnRefusal: true,
          });
        else if (prompt.action.kind === 'add-room-agent') {
          setMembershipError(null);
          setParticipantPickerKind('agent');
          openWorkspaceRoster();setParticipantPickerVisible(true);
        } else if (prompt.action.kind === 'connect-agent') void connectAgent();
        else
          router.push({
            pathname: '/beeline/members',
            params: {
              ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
              action: 'invite',
            },
          } as never);
      },
    }));
  }, [activeCommunityId, connectAgent, fillComposer, starterPromptDefs,openWorkspaceRoster]);
  return [
    emptyLedgerVariant, displayRoomName, roomName, firstRoomAgent, startCornerMessage,
    focusComposer, starterPrompts, starterIntro, storedRoomName, headerTitleKind,
    displayHeaderTitle, dmPeerPubkey, dmPeerIdentity, dmPeerAgentDisplay, dmPeerProfile,
    dmHeaderPresence, headerTitle, closeAgentConnect, connectAgent, copyPairCommand,
  ];
}
