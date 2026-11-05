import React, { useEffect, useState, useMemo } from 'react';
import { type RoomRepository, type ChatListItem } from '@beeline/buzz-client';
import { type AgentComposerCommand } from '@beeline/api-contract/phone';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { activeChannelAtCursor, channelSuggestionCandidates, filterChannelSuggestions, type ChannelSuggestion } from '@/buzz/channel-suggestions';
import { useRoomCorners } from '@/buzz/use-room-corners';
import { roomOpenCornerRows } from '@/buzz/room-corner-store';
import { activeMentionAtCursor, filterMentionCandidates, mentionedAgentPubkey } from '@/buzz/room-participants';
import { useStarPrompt } from '@/components/buzz/StarPromptCard';
import { availableAgentMentionCommands, fastModeCommandState, slashVerbQuery, agentMentionSlashQuery, type FastModeCommandState } from '@/buzz/slash-verbs';
import { isAgentTurnActive, activeMentionCandidates } from '@/buzz/agent-presence';
import { sameElementRefs, useStable } from '@/buzz/use-stable';
import { roomMemberManagementState } from '@/buzz/room-member-management';
import { type RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';
import { CHANNEL_MENTION_OPTION, SYSTEM_MENTION_OPTION } from './chat-surface-values';

type Props = [
  roomParticipants: RoomRosterParticipant[],
  agentPresences: Record<string, import("@/buzz/agent-presence").RoomAgentPresence>,
  presenceNow: number,
  inputSelection: { start: number; end: number; },
  inputText: string,
  describedRoomParticipants: RoomRosterParticipant[],
  composerFocused: boolean,
  dismissedMentionKey: string | null,
  isDirectMessage: boolean,
  parentChannelId: string | undefined,
  decodedId: string,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  workspaceChats: readonly ChatListItem[],
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  presenceReconnectGrace: Record<string, number>,
  unprojectedMessages: ChatDisplayMessage[],
  participantsHydrated: boolean,
  rosterVisible: boolean,
  participantPickerVisible: boolean,
  viewerPubkey: string | undefined,
  agentCommandsByScope: Record<string, readonly AgentComposerCommand[]>,
  agentFastModeByScope: Record<string, FastModeCommandState | null>,
  agentCanLoginByScope: Record<string, boolean>,
  combinedMessages: ChatDisplayMessage[],
  roomRepository: RoomRepository | null,
  activeCommunityId: string | null,
  setAgentCommandsByScope: React.Dispatch<React.SetStateAction<Record<string, readonly AgentComposerCommand[]>>>,
  setAgentCanLoginByScope: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  setAgentFastModeByScope: React.Dispatch<React.SetStateAction<Record<string, FastModeCommandState | null>>>,
];

export function useChatComposerSuggestions([
  roomParticipants, agentPresences, presenceNow, inputSelection, inputText,
  describedRoomParticipants, composerFocused, dismissedMentionKey, isDirectMessage, parentChannelId,
  decodedId, roomClient, workspaceChats, roomSurface, presenceReconnectGrace, unprojectedMessages,
  participantsHydrated, rosterVisible, participantPickerVisible, viewerPubkey, agentCommandsByScope,
  agentFastModeByScope, agentCanLoginByScope, combinedMessages, roomRepository, activeCommunityId,
  setAgentCommandsByScope, setAgentCanLoginByScope, setAgentFastModeByScope,
]: Props): [
  directMessageListItem: ChatListItem | null,
  isReadOnlyDirectMessage: boolean,
  messages: ChatDisplayMessage[],
  activeAgentTurns: import("@beeline/api-contract/phone").RoomViewAgentTurn[],
  pendingCornerRequest: ChatDisplayMessage | undefined,
  pendingTargetBranchProposal: ChatDisplayMessage | undefined,
  currentSlashQuery: string | null,
  mentionSlash: import("@/buzz/slash-verbs").AgentMentionSlash | null,
  mentionSlashAgentPubkey: string | null,
  mentionAgentCommands: import("@/buzz/slash-verbs").AgentPaletteCommand[],
  agentTurnMarkers: readonly import("@beeline/api-contract/phone").RoomViewAgentTurn[],
  activeAgentTurn: import("@beeline/api-contract/phone").RoomViewAgentTurn,
  starPrompt: { prompt: import("@beeline/api-contract/phone").StarPrompt | null; busy: import("@beeline/api-contract/phone").StarPromptAction | null; answer: (action: import("@beeline/api-contract/phone").StarPromptAction) => Promise<void>; accept: (view: { prompt: import("@beeline/api-contract/phone").StarPrompt | null; }) => void; },
  activeMention: import("@/buzz/room-participants").ActiveMention | null,
  activeChannel: import("@/buzz/channel-suggestions").ActiveChannel | null,
  mentionAgentCommandScope: string | null,
  mentionAgentLacksCommands: boolean,
  mentionMenuVisible: boolean,
  mentionSuggestions: { matches: RoomRosterParticipant[]; overflow: number; },
  channelMenuVisible: boolean,
  channelSuggestions: { matches: ChannelSuggestion[]; overflow: number; },
  suggestionCount: number,
  mentionMenuKey: string | null,
  channelMenuKey: string | null,
  memberManagement: { canOpenRoster: boolean; rosterVisible: boolean; pickerVisible: boolean; },
] {

  const mentionableAgents = useMemo(
    () =>
      activeMentionCandidates(
        roomParticipants
          .filter((participant) => participant.kind === 'agent')
          .map((participant) => ({
            pubkey: participant.pubkey,
            name: participant.name,
            handle: participant.handle,
          })),
        agentPresences,
        presenceNow,
      ),
    [roomParticipants, agentPresences, presenceNow],
  );

  const activeMention = useMemo(
    () =>
      inputSelection.start === inputSelection.end
        ? activeMentionAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText],
  );

  const mentionMenuKey = activeMention
    ? `${inputText}:${activeMention.start}:${activeMention.end}`
    : null;

  const mentionCandidateRoster = useMemo(
    () => [CHANNEL_MENTION_OPTION, ...describedRoomParticipants, SYSTEM_MENTION_OPTION],
    [describedRoomParticipants],
  );

  const mentionSuggestions = useMemo(
    () =>
      activeMention
        ? filterMentionCandidates(
            activeMentionCandidates(mentionCandidateRoster, agentPresences, presenceNow),
            activeMention.query,
          )
        : { matches: [], overflow: 0 },
    [activeMention, mentionCandidateRoster, agentPresences, presenceNow],
  );

  const mentionMenuVisible = Boolean(
    composerFocused &&
    mentionMenuKey &&
    mentionMenuKey !== dismissedMentionKey &&
    mentionSuggestions.matches.length > 0,
  );

  const activeChannel = useMemo(
    () =>
      inputSelection.start === inputSelection.end
        ? activeChannelAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText],
  );

  const channelMenuKey = activeChannel
    ? `#${inputText}:${activeChannel.start}:${activeChannel.end}`
    : null;

  // The current Room's open corners from its corner record, held once the
  // first `#` opens the menu; frames keep it current from then on.
  const channelCornerRoomId = isDirectMessage ? null : (parentChannelId ?? decodedId);

  const [channelCornersRoomId, setChannelCornersRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (activeChannel && channelCornerRoomId && roomClient) setChannelCornersRoomId(channelCornerRoomId);
  }, [activeChannel, channelCornerRoomId, roomClient]);

  const channelCornerRecord = useRoomCorners(
    channelCornersRoomId === channelCornerRoomId ? (channelCornerRoomId ?? undefined) : undefined,
    roomClient,
  );

  const channelCorners = useMemo(() => {
    const view = channelCornerRecord.view;
    if (!view || !channelCornerRecord.record) return null;
    return {
      roomId: view.room.id,
      room: { name: view.room.name },
      corners: roomOpenCornerRows(channelCornerRecord.record).map((item) => ({
        id: item.corner.id,
        name: item.corner.name,
      })),
    };
  }, [channelCornerRecord.record, channelCornerRecord.view]);

  const channelSuggestions = useMemo(() => {
    if (!activeChannel) return { matches: [], overflow: 0 };
    const corners = channelCorners?.roomId === channelCornerRoomId ? channelCorners : null;
    return filterChannelSuggestions(
      channelSuggestionCandidates(
        workspaceChats
          .filter((item) => !item.directMessage)
          .map((item) => ({
            id: item.room.id,
            name: item.room.name,
            repositoryName: item.repositoryName,
          })),
        corners?.room ?? null,
        corners?.corners ?? [],
      ),
      activeChannel.query,
    );
  }, [activeChannel, channelCorners, channelCornerRoomId, workspaceChats]);

  const channelMenuVisible = Boolean(
    composerFocused &&
    channelMenuKey &&
    channelMenuKey !== dismissedMentionKey &&
    channelSuggestions.matches.length > 0,
  );

  const suggestionCount = mentionMenuVisible
    ? mentionSuggestions.matches.length
    : channelMenuVisible
      ? channelSuggestions.matches.length
      : 0;

  // The latest signed lifecycle receipt is server-indexed. Draft/thought
  // overlays carry content only and can neither start nor extend a turn.
  const agentTurnMarkers = useMemo(
    () => roomSurface?.latestAgentTurns ?? [],
    [roomSurface?.latestAgentTurns],
  );

  // Every agent answering right now, not just the first: two agents asked in
  // one message run two concurrent turns and each owns its own live lane.
  const rawActiveAgentTurns = useMemo(
    () =>
      agentTurnMarkers.filter((turn) =>
        isAgentTurnActive(
          turn,
          agentPresences[turn.agentPubkey],
          presenceNow,
          presenceReconnectGrace[turn.agentPubkey],
        ),
      ),
    [agentTurnMarkers, agentPresences, presenceNow, presenceReconnectGrace],
  );

  // A filter rebuilds its array on every presence tick even when it selected
  // the same receipts, and this feeds the transcript projection.
  const activeAgentTurns = useStable(rawActiveAgentTurns, sameElementRefs);

  // The composer's thinking line and its settled summary are ONE line, so they
  // read the first of them; the transcript and the gold ring take them all.
  const activeAgentTurn = activeAgentTurns[0];

  const messages = unprojectedMessages;

  const directMessageListItem = useMemo(
    () => workspaceChats.find((item) => item.room.id === decodedId && item.directMessage) ?? null,
    [decodedId, workspaceChats],
  );

  const memberManagement = roomMemberManagementState({
    isDirectMessage,
    participantsHydrated,
    rosterRequested: rosterVisible,
    pickerRequested: participantPickerVisible,
  });

  // An @system notification DM (release or Workspace lifecycle): the server
  // never lets anyone but @system post into it (viewer.permissions.send is
  // false there and only there for a direct message, since a DM can never be
  // archived).
  const isReadOnlyDirectMessage = isDirectMessage && roomSurface?.viewer.permissions.send === false;

  const starPrompt = useStarPrompt(decodedId, Boolean(roomSurface) && !isReadOnlyDirectMessage);

  const currentSlashQuery = useMemo(() => slashVerbQuery(inputText), [inputText]);

  // Mention-scoped palette: `@agent /query` addresses THAT agent's advertised
  // commands. Mutually exclusive with `currentSlashQuery` by shape — the plain
  // path requires the WHOLE composer to be one slash token.
  const mentionSlash = useMemo(() => agentMentionSlashQuery(inputText), [inputText]);

  const mentionSlashAgentPubkey = useMemo(() => {
    if (!mentionSlash) return null;
    return mentionedAgentPubkey(`@${mentionSlash.mention}`, mentionableAgents) ?? null;
  }, [mentionSlash, mentionableAgents]);

  const mentionAgentCommandScope = mentionSlashAgentPubkey
    ? `${decodedId}:${viewerPubkey}:${mentionSlashAgentPubkey}`
    : null;

  const mentionAgentCommands = useMemo(() => {
    if (!mentionSlash || !mentionAgentCommandScope) return [];
    const published = agentCommandsByScope[mentionAgentCommandScope];
    return availableAgentMentionCommands(
      published ?? [],
      mentionSlash.query,
      agentFastModeByScope[mentionAgentCommandScope],
      agentCanLoginByScope[mentionAgentCommandScope],
    );
  }, [agentCommandsByScope, agentFastModeByScope, agentCanLoginByScope, mentionAgentCommandScope, mentionSlash]);

  // True only once the read RESOLVED (absent or empty list): an in-flight or
  // failed read is unknown, never "does not advertise".
  const mentionAgentLacksCommands = Boolean(
    mentionSlash &&
    mentionSlashAgentPubkey &&
    mentionAgentCommandScope &&
    agentCommandsByScope[mentionAgentCommandScope] !== undefined &&
    (agentCommandsByScope[mentionAgentCommandScope]?.length ?? 0) === 0,
  );

  const pendingCornerRequest = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.writePermission?.status === 'pending' &&
        message.writePermission.repository &&
        message.writePermission.purpose !== 'squire-spending'
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages]);

  const pendingTargetBranchProposal = useMemo(() => {
    for (let index = combinedMessages.length - 1; index >= 0; index -= 1) {
      const message = combinedMessages[index];
      if (
        message.targetBranchProposal &&
        roomRepository?.targetBranch !== message.targetBranchProposal.to
      ) {
        return message;
      }
    }
    return undefined;
  }, [combinedMessages, roomRepository?.targetBranch]);

  // Load the addressed agent's published command list on demand — the palette
  // combines this record with server-authorized Beeline actions. A
  // failed read stays unknown and never blocks typing.
  useEffect(() => {
    const pubkey = mentionSlashAgentPubkey;
    const scope = mentionAgentCommandScope;
    if (!pubkey || !scope || !roomClient || !activeCommunityId) return;
    if (agentCommandsByScope[scope] !== undefined && agentFastModeByScope[scope] !== undefined && agentCanLoginByScope[scope] !== undefined) {
      return;
    }
    let cancelled = false;
    roomClient
      .agent(activeCommunityId, pubkey)
      .then((detail) => {
        if (!cancelled) {
          setAgentCommandsByScope((current) => ({
            ...current,
            [scope]: detail.commands ?? [],
          }));
          setAgentCanLoginByScope((current) => ({ ...current, [scope]: detail.canLogin === true }));
          setAgentFastModeByScope((current) => ({
            ...current,
            [scope]: fastModeCommandState(detail, viewerPubkey),
          }));
        }
      })
      .catch(() => {
        // A transport failure is not evidence that no record exists. Keep the
        // scope unresolved so the palette never makes a false absence claim.
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeCommunityId,
    agentCommandsByScope,
    agentFastModeByScope,
    agentCanLoginByScope,
    decodedId,
    mentionAgentCommandScope,
    mentionSlashAgentPubkey,
    roomClient,
    viewerPubkey,
  ]);

  // Re-read owner actions each time the palette opens so profile changes
  // cannot leave an earlier permission or toggle state on screen.
  useEffect(() => {
    if (mentionSlashAgentPubkey) return;
    setAgentFastModeByScope((current) => (Object.keys(current).length ? {} : current));
    setAgentCanLoginByScope((current) => (Object.keys(current).length ? {} : current));
  }, [mentionSlashAgentPubkey]);
  return [
    directMessageListItem, isReadOnlyDirectMessage, messages, activeAgentTurns,
    pendingCornerRequest, pendingTargetBranchProposal, currentSlashQuery, mentionSlash,
    mentionSlashAgentPubkey, mentionAgentCommands, agentTurnMarkers, activeAgentTurn, starPrompt,
    activeMention, activeChannel, mentionAgentCommandScope, mentionAgentLacksCommands,
    mentionMenuVisible, mentionSuggestions, channelMenuVisible, channelSuggestions, suggestionCount,
    mentionMenuKey, channelMenuKey, memberManagement,
  ];
}
