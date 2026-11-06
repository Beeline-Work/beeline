import React, { useRef, useCallback, useMemo } from 'react';
import { View, Keyboard } from 'react-native';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { continuedSpeakerIds, ledgerSpeakerKey } from '@/buzz/ledger-attribution';
import { useCornerHeaderItem } from '@/buzz/use-room-corners';
import { projectActiveTurnStream } from '@/buzz/live-turn-stream';
import { resolvePendingAgentDisplay } from '@/buzz/agent-display';
import { cornerDisplayState, cornerHeaderAgent } from '@/buzz/corner-display-state';
import { selectWorkingAgents } from '@/buzz/room-indicators';
import { resolveCornerViewAgentPubkey } from '@/buzz/corner-session';
import { sameStringSet, shallowEqualRecord, useStable } from '@/buzz/use-stable';
import { EmptyLedgerState, cornerNeedsStarter, type EmptyLedgerVariant } from '@/components/buzz/EmptyLedgerState';
import { knownAgentPubkeysFor } from './chat-surface-values';
import { styles } from './chat-surface-styles';

type Props = [
  isCorner: boolean,
  parentChannelId: string | undefined,
  decodedId: string,
  isArchived: boolean,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  messages: ChatDisplayMessage[],
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  activeAgentTurns: import("@beeline/api-contract/phone").RoomViewAgentTurn[],
  participantsHydrated: boolean,
  optimisticDeletes: Record<string, true>,
  optimisticReactions: Record<string, readonly import("@beeline/api-contract/phone").MessageReactionView[] | undefined>,
  desktopExperience: boolean,
  viewerIsAgent: boolean,
  emptyLedgerVariant: EmptyLedgerVariant,
  isDirectMessage: boolean,
  displayRoomName: string,
  roomName: string,
  firstRoomAgent: import("@beeline/api-contract/phone").RoomViewIdentity | undefined,
  startCornerMessage: () => void,
  focusComposer: () => void,
  starterPrompts: { lead: string; detail: string; testID: string; onPress: () => void; }[] | undefined,
  starterIntro: string | undefined,
];

export function useChatTranscriptProjection([
  isCorner, parentChannelId, decodedId, isArchived, roomClient, messages, agentByPubkey,
  roomSurface, activeAgentTurns, participantsHydrated, optimisticDeletes, optimisticReactions,
  desktopExperience, viewerIsAgent, emptyLedgerVariant, isDirectMessage, displayRoomName, roomName,
  firstRoomAgent, startCornerMessage, focusComposer, starterPrompts, starterIntro,
]: Props): [
  desktopTranscript: boolean,
  transcriptMessagesRef: React.RefObject<ChatDisplayMessage[]>,
  transcriptMessages: ChatDisplayMessage[],
  visibleMessages: ChatDisplayMessage[],
  cornerAgentPubkey: string | undefined,
  dismissComposerKeyboard: () => void,
  speakerWorking: Readonly<Record<string, true>>,
  continuedAttributionIds: Set<string>,
  cornerOwnerPubkey: string | undefined,
  cornerOwnerDisplay: import("@/buzz/agent-display").AgentDisplayIdentity | null | undefined,
  cornerOwnerWorking: boolean,
  cornerHeaderWord: string | undefined,
  cornerHeaderDisplay: import("@/buzz/corner-display-state").CornerDisplayState | undefined,
  cornerHeaderSource: import("@/buzz/corner-display-state").CornerDisplayItem | undefined,
  emptyLedger: import("react/jsx-runtime").JSX.Element | null,
] {

  // The transcript is the composer's "outside": a tap on it puts the keyboard
  // away, the same as a drag (keyboardDismissMode on the list below). Kept
  // dependency-free so it never re-creates renderItem — see the memo note on
  // renderMessage.
  const dismissComposerKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  // The header reads this corner's row from the parent Room's corner record,
  // the same row the Corners screen and Room list paint. Live turns pick the
  // name and ring below; they never pick the state.
  const cornerHeaderSource = useCornerHeaderItem(
    isCorner ? (parentChannelId ?? undefined) : undefined,
    decodedId,
    isArchived,
    roomClient,
  );

  const cornerHeaderDisplay = cornerHeaderSource ? cornerDisplayState(cornerHeaderSource) : undefined;

  const cornerAgentPubkey = useMemo(
    () =>
      resolveCornerViewAgentPubkey(
        messages,
        (pubkey) => agentByPubkey.has(pubkey),
        roomSurface?.cornerOpenerAgentId,
      ),
    [agentByPubkey, messages, roomSurface?.cornerOpenerAgentId],
  );

  const rawSpeakerWorking = useMemo(
    () =>
      selectWorkingAgents({
        activeTurnPubkeys: activeAgentTurns.map((turn) => turn.agentPubkey),
      }),
    [activeAgentTurns],
  );

  const speakerWorking = useStable(rawSpeakerWorking, shallowEqualRecord);

  // The corner header names the opener from `corner_facts.owner_agent_id`, never
  // whichever agent currently holds a live turn. While a reviewer works in
  // the corner the transcript attribution is the reviewer's and stays there;
  // the corner does not change hands. The transcript-derived identity fills
  // in only before the server projection has landed. The gold ring on a
  // byline still names the actual worker (C77).
  const cornerHeaderAgentView = cornerHeaderAgent({
    ownerPubkey: cornerAgentPubkey,
    ...(cornerHeaderDisplay ? { status: cornerHeaderDisplay.status } : {}),
    ...(cornerHeaderDisplay?.headerSuffix ? { headerSuffix: cornerHeaderDisplay.headerSuffix } : {}),
    activeTurnPubkeys: activeAgentTurns.map((turn) => turn.agentPubkey),
  });

  const cornerOwnerPubkey = cornerHeaderAgentView.pubkey;

  const cornerOwnerDisplay = cornerOwnerPubkey
    ? resolvePendingAgentDisplay(
        cornerOwnerPubkey,
        agentByPubkey.get(cornerOwnerPubkey),
        participantsHydrated,
      )
    : undefined;

  const cornerHeaderWord = cornerHeaderAgentView.stateWord;

  const cornerOwnerWorking = cornerHeaderAgentView.ownerWorking;

  const visibleMessages = useMemo(
    () => projectActiveTurnStream(messages, activeAgentTurns, isArchived).map((message) => {
      const id = message.relayId ?? message.id;
      if (optimisticDeletes[id])
        return { ...message, text: 'Deleting message…', deleted: true, isSystemNotice: true };
      const reactions = optimisticReactions[id];
      return reactions ? { ...message, reactions } : message;
    }),
    [activeAgentTurns, isArchived, messages, optimisticDeletes, optimisticReactions],
  );

  // Run boundaries still control compact continuation spacing and machine-row
  // folding. Ordinary prose always renders its own byline, even inside a run,
  // so every message remains independently attributable.
  const rawContinuedAttributionIds = useMemo(
    () =>
      new Set(
        continuedSpeakerIds(
          visibleMessages.map((message) => ({
            id: message.id,
            speaker: ledgerSpeakerKey(message, knownAgentPubkeysFor(agentByPubkey)),
            // A collapsed tool/thought run is mechanism, not prose: it may fold
            // into the voice above it, but the prose below it must re-announce
            // (its byline was never allowed to be spent on the tool block).
            isMachine: message.isAgentActivity,
            // A reply always re-announces its own speaker; see
            // `continuedSpeakerIds`'s `hasReplyReference` doc.
            hasReplyReference: Boolean(message.replyToId),
          })),
        ),
      ),
    [agentByPubkey, visibleMessages],
  );

  // renderItem consumes this set; preserve its identity across commits that
  // did not change any run boundary so rows are not rebuilt for nothing.
  const continuedAttributionIds = useStable(rawContinuedAttributionIds, sameStringSet);

  // Native keeps the established inverted list. React Native Web implements
  // `inverted` with scale transforms, which can leave variable-height rows at
  // stale coordinates after a send. Every desktop-platform transcript uses
  // ordinary chronological flow, including a packaged Windows window resized
  // below the persistent-sidebar breakpoint.
  const desktopTranscript = desktopExperience;

  const invertedMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);

  const transcriptMessages = desktopTranscript ? visibleMessages : invertedMessages;

  const showEmptyLedger = isCorner
    ? !viewerIsAgent && cornerNeedsStarter(transcriptMessages)
    : transcriptMessages.length === 0;

  const emptyLedger = showEmptyLedger ? (
    <View style={styles.emptyState}>
      <EmptyLedgerState
        variant={emptyLedgerVariant}
        name={isDirectMessage ? displayRoomName : isCorner ? undefined : roomName}
        agentHandle={isCorner ? firstRoomAgent?.handle : undefined}
        onPress={isCorner ? startCornerMessage : focusComposer}
        starterPrompts={starterPrompts}
        starterIntro={starterIntro}
      />
    </View>
  ) : null;

  // Landing retries can outlive the render that scheduled them. Read the
  // current inverted order so arrivals during measurement cannot shift the
  // durable boundary away from the numeric index we retry.
  const transcriptMessagesRef = useRef(transcriptMessages);

  transcriptMessagesRef.current = transcriptMessages;
  return [
    desktopTranscript, transcriptMessagesRef, transcriptMessages, visibleMessages,
    cornerAgentPubkey, dismissComposerKeyboard, speakerWorking, continuedAttributionIds,
    cornerOwnerPubkey, cornerOwnerDisplay, cornerOwnerWorking, cornerHeaderWord,
    cornerHeaderDisplay, cornerHeaderSource, emptyLedger,
  ];
}
