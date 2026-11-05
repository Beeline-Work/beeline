import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { transcriptBylineOpeners } from '@/buzz/message-dates';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useAnimatedStyle } from 'react-native-reanimated';
import { Modal } from '@/modal';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { cornerProposalDecision } from '@/buzz/corner-proposal';
import { COMPOSER_ACK_BOUND_MS, STEER_RECEIVED_VISIBLE_MS, hasComposerAckReceipt, selectComposerAckPresentation, type ComposerAckPresentation } from '@/buzz/room-indicators';
import { formatTerminalTurnOverlay, type TurnVerb } from '@/buzz/turn-clock';
import { useScrollFollowOnLayoutChange } from '@/buzz/room-scroll-follow';
import { composerBottomPadding } from '@/buzz/composer-keyboard';
import { monolithPhoneOperation, phoneOperationFailureReason } from '@/sync/transport/monolith-operation';
import { nextAgentPresenceTransitionAt, nextAgentTurnExpiryAt } from '@/buzz/agent-presence';
import { sameMessageRefMap, sameRecordValueMap, sameStringSet, useStable } from '@/buzz/use-stable';

type Props = [
  visibleMessages: ChatDisplayMessage[],
  pendingAck: { sentAt: number; requestId?: string; } | null,
  agentTurnMarkers: readonly import("@beeline/api-contract/phone").RoomViewAgentTurn[],
  setPendingAck: React.Dispatch<React.SetStateAction<{ sentAt: number; requestId?: string; } | null>>,
  receivedSteer: { agentPubkey: string; turnRequestId: string; receivedAt: number; } | null,
  activeAgentTurn: import("@beeline/api-contract/phone").RoomViewAgentTurn,
  setReceivedSteer: React.Dispatch<React.SetStateAction<{ agentPubkey: string; turnRequestId: string; receivedAt: number; } | null>>,
  isCorner: boolean,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  viewerPubkey: string | undefined,
  conversationIdentities: Map<string, import("@beeline/api-contract/phone").RoomViewIdentity>,
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  insets: import("react-native-safe-area-context/lib/typescript/src/SafeArea.types").EdgeInsets,
  composerHeight: number,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  decodedId: string,
  readRoom: () => void,
  desktopExperience: boolean,
  setDesktopDeliveryState: React.Dispatch<React.SetStateAction<"failed" | "sending" | "delivered" | null>>,
  agentPresences: Record<string, import("@/buzz/agent-presence").RoomAgentPresence>,
  setPresenceNow: (now: number) => void,
  presenceNow: number,
];

export function useChatTurnPresentation([
  visibleMessages, pendingAck, agentTurnMarkers, setPendingAck, receivedSteer, activeAgentTurn,
  setReceivedSteer, isCorner, roomSurface, viewerPubkey, conversationIdentities, agentByPubkey,
  insets, composerHeight, scrollController, decodedId, readRoom, desktopExperience,
  setDesktopDeliveryState, agentPresences, setPresenceNow, presenceNow,
]: Props): [
  bylineOpeners: Set<string>,
  answerByMessageId: Map<string, { decision: "open" | "cancel" | null; handle: string; }>,
  visibleMessageById: Map<string, ChatDisplayMessage>,
  immediatelyPrecedingVisibleMessageById: Map<string, ChatDisplayMessage>,
  composerAck: ComposerAckPresentation | null,
  settledTurn: { line: string; } | null,
  stoppingThisTurn: boolean,
  handleStopTurn: (stop: { agentPubkey: string; requestId: string; }) => Promise<boolean>,
  composerBottomInsetStyle: import("react-native-reanimated/lib/typescript/hook/commonTypes").AnimatedStyleHandle<{ paddingBottom: number; }>,
  keyboardHeight: number,
] {

  // A reconciled draft/final bubble keeps a stable display `id` across the
  // turn, so it also needs to resolve by its real relay event id — the id
  // any NIP-10 reply on another client actually references.
  const rawVisibleMessageById = useMemo(() => {
    const map = new Map<string, ChatDisplayMessage>();
    for (const message of visibleMessages) {
      map.set(message.id, message);
      if (message.relayId) map.set(message.relayId, message);
    }
    return map;
  }, [visibleMessages]);

  const visibleMessageById = useStable(rawVisibleMessageById, sameMessageRefMap);

  // The first human reply to a message answers it; a corner proposal card shows
  // which choice that reply made and who made it.
  const rawAnswerByMessageId = useMemo(() => {
    const answers = new Map<string, { decision: 'open' | 'cancel' | null; handle: string }>();
    for (const message of visibleMessages) {
      const identity = message.authorIdentity;
      if (identity?.kind !== 'human' || !message.replyToId) continue;
      if (answers.has(message.replyToId)) continue;
      answers.set(message.replyToId, {
        decision: cornerProposalDecision(message.text),
        handle: (identity.handle || identity.name).replace(/^@/, ''),
      });
    }
    return answers;
  }, [visibleMessages]);

  const answerByMessageId = useStable(rawAnswerByMessageId, sameRecordValueMap);

  const bylineOpeners = useStable(
    useMemo(() => transcriptBylineOpeners(visibleMessages), [visibleMessages]),
    sameStringSet,
  );

  const rawImmediatelyPrecedingVisibleMessageById = useMemo(() => {
    const map = new Map<string, ChatDisplayMessage>();
    for (let index = 1; index < visibleMessages.length; index += 1) {
      map.set(visibleMessages[index].id, visibleMessages[index - 1]);
    }
    return map;
  }, [visibleMessages]);

  const immediatelyPrecedingVisibleMessageById = useStable(
    rawImmediatelyPrecedingVisibleMessageById,
    sameMessageRefMap,
  );

  // Once the matching server-indexed receipt lands there is nothing left for
  // the local ack to guess at. A terminal receipt is still confirmation: the
  // old active-only check missed the case where WORKING had already become
  // COMPLETE before this screen observed it.
  useEffect(() => {
    if (pendingAck && hasComposerAckReceipt(pendingAck.requestId, agentTurnMarkers)) {
      setPendingAck(null);
    }
  }, [agentTurnMarkers, pendingAck]);


  // A single deadline-scheduled timer (never a ticking interval — see the
  // presence clock above) clears the purely local acknowledgement. If no
  // receipt arrives, silence is not evidence that an agent is waiting; a
  // later server-indexed WORKING receipt can independently light `thinking`.
  useEffect(() => {
    if (!pendingAck) return;
    const deadline = pendingAck.sentAt + COMPOSER_ACK_BOUND_MS;
    const delay = Math.max(1, deadline - Date.now() + 1);
    const timer = setTimeout(() => setPendingAck(null), delay);
    return () => clearTimeout(timer);
  }, [pendingAck]);


  // A committed steer is a brief confirmation, not a new lifecycle. It stays
  // on the exact running turn the server accepted it into and then clears.
  useEffect(() => {
    if (!receivedSteer) return;
    if (
      !activeAgentTurn ||
      activeAgentTurn.agentPubkey !== receivedSteer.agentPubkey ||
      activeAgentTurn.requestId !== receivedSteer.turnRequestId
    ) {
      setReceivedSteer(null);
      return;
    }
    const delay = Math.max(
      1,
      receivedSteer.receivedAt + STEER_RECEIVED_VISIBLE_MS - Date.now() + 1,
    );
    const timer = setTimeout(() => setReceivedSteer(null), delay);
    return () => clearTimeout(timer);
  }, [activeAgentTurn, receivedSteer]);


  /**
   * The ordinary turn indicator, and the only thing a plain question in a Room
   * ever lights: "beebee thinking…" while the reply is being composed, gone
   * when it lands. Its input is the Room's own `#t=agent-turn` lifecycle and
   * nothing else — no corner reaches it, exactly as no turn reaches the corner
   * line above.
   *
   * A Corner uses the same signed turn proof as a Room. Its separate
   * canonical Corner lease still owns the pinned Corner bar, but cannot hide a
   * channel-local reply that is visibly streaming now.
   *
   * `pendingAck` bridges only the send round trip. After acceptance, the
   * unclaimed commands stay silent until the helper claims them.
   * Only a genuine server-indexed WORKING receipt says the agent is thinking.
   */
  const composerAck = useMemo((): ComposerAckPresentation | null => {
    return selectComposerAckPresentation({
      isCorner,
      viewerCanSend: roomSurface?.viewer.permissions.send,
      ...(activeAgentTurn?.agentPubkey ? { activeTurnPubkey: activeAgentTurn.agentPubkey } : {}),
      ...(activeAgentTurn
        ? {
            activeTurnStartedAt: activeAgentTurn.startedAt ?? activeAgentTurn.createdAt,
            activeTurnRequestId: activeAgentTurn.requestId,
            activeTurnAgentPubkey: activeAgentTurn.agentPubkey,
            ...(activeAgentTurn.requestedBy
              ? { activeTurnRequestedBy: activeAgentTurn.requestedBy }
              : {}),
          }
        : {}),
      ...(viewerPubkey ? { viewerPubkey } : {}),
      ...(pendingAck ? { pendingAckSentAt: pendingAck.sentAt } : {}),
      ...(receivedSteer ? { receivedSteer } : {}),
      now: pendingAck?.sentAt ?? Date.now(),
      conversationIdentities,
      agentsByPubkey: agentByPubkey,
    });
  }, [
    activeAgentTurn,
    roomSurface?.viewer.permissions.send,
    agentByPubkey,
    conversationIdentities,
    isCorner,
    pendingAck,
    receivedSteer,
    viewerPubkey,
  ]);


  // C97: the fixed chrome below the inverted list changes independently of
  // transcript rows. A send resets the composer's height while retaining the
  // keyboard; native layout can update the pinned ref before an effect runs,
  // preserving the old offset as an empty gap. Capture the verdict in render.
  //
  // The phone turn line is NOT part of that chrome any more. It is absolute,
  // anchored to the composer's top edge (`room-bottom-chrome`), so it takes
  // no height out of the list whether or not an agent is working and the
  // newest row never moves when it comes or goes.
  // `bottomChromeLayoutKey` still carries turn/no-turn, but that is now a
  // no-op re-pin.
  const keyboardHeight = useKeyboardState((state) => state.height);

  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();

  const composerBottomInsetStyle = useAnimatedStyle(
    () => ({
      paddingBottom: composerBottomPadding(Platform.OS, insets.bottom, keyboardProgress.value),
    }),
    [insets.bottom],
  );

  const composerFootprint = composerHeight + keyboardHeight;

  const bottomChromeLayoutKey = composerAck ? 'turn' : 'no-turn';

  const composerLayoutFollow = useScrollFollowOnLayoutChange({
    footprint: composerFootprint,
    layoutKey: bottomChromeLayoutKey,
    isPinnedToTail: scrollController.isPinnedToTail(),
    isUserDragging: scrollController.isUserDragging(),
  });

  useLayoutEffect(() => {
    if (composerLayoutFollow === 'hold') return;
    scrollController.follow();
  }, [bottomChromeLayoutKey, composerFootprint, composerLayoutFollow, scrollController]);


  /**
   * Withdraw the question this turn is answering.
   *
   * The control is offered to anyone who may act in the Room (`viewerMayStopTurn`), and the
   * server refuses anyone else, so the two agree on one rule rather than the
   * phone guessing at it. The press is acknowledged on this line immediately
   * (`stoppingTurn`); the cancelled receipt is still what settles the durable
   * "stopped" line and retires the control.
   */
  const [stoppingTurn, setStoppingTurn] = useState<{
    agentPubkey: string;
    requestId: string;
  } | null>(null);

  const handleStopTurn = useCallback(
    async (stop: { agentPubkey: string; requestId: string }) => {
      setStoppingTurn(stop);
      try {
        await monolithPhoneOperation('cancelAgentTurn', {
          roomId: decodedId,
          requestId: stop.requestId,
          agentId: stop.agentPubkey,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return true;
      } catch (err) {
        setStoppingTurn((current) =>
          current?.requestId === stop.requestId && current.agentPubkey === stop.agentPubkey
            ? null
            : current,
        );
        // A turn that settled while the press was in the air is the ordinary
        // race, not a failure worth a dialog: the line is already gone.
        if (err instanceof MonolithRequestTimeoutError) {
          readRoom();
          Modal.alert('Stop result unknown', phoneOperationFailureReason(err));
        }
        console.warn('Stopping the turn failed:', err);
        return false;
      }
    },
    [decodedId],
  );

  useEffect(() => {
    if (!stoppingTurn) return;
    if (
      !activeAgentTurn ||
      activeAgentTurn.requestId !== stoppingTurn.requestId ||
      activeAgentTurn.agentPubkey !== stoppingTurn.agentPubkey
    ) {
      setStoppingTurn(null);
    }
  }, [activeAgentTurn, stoppingTurn]);

  const stoppingThisTurn = Boolean(
    stoppingTurn &&
    composerAck?.stop &&
    stoppingTurn.requestId === composerAck.stop.requestId &&
    stoppingTurn.agentPubkey === composerAck.stop.agentPubkey,
  );


  /** The settled "<Past> for Ns · done h:MM" line a finished turn leaves briefly. */
  const [settledTurn, setSettledTurn] = useState<{
    line: string;
  } | null>(null);

  const lastActiveTurnRef = useRef<{
    requestId: string;
    agentPubkey: string;
    startedAt: number;
    verb: TurnVerb;
  } | null>(null);

  useEffect(() => {
    if (activeAgentTurn) {
      const verb = composerAck?.verb;
      if (verb) {
        lastActiveTurnRef.current = {
          requestId: activeAgentTurn.requestId,
          agentPubkey: activeAgentTurn.agentPubkey,
          startedAt: (activeAgentTurn.startedAt ?? activeAgentTurn.createdAt) * 1_000,
          verb,
        };
      }
      setSettledTurn(null);
      return;
    }
    const last = lastActiveTurnRef.current;
    if (!last) return;
    const terminal = agentTurnMarkers.find(
      (turn) =>
        turn.requestId === last.requestId &&
        turn.agentPubkey === last.agentPubkey &&
        turn.status !== 'working',
    );
    if (!terminal) return;
    const status = terminal.status;
    if (status === 'working') return;
    lastActiveTurnRef.current = null;
    const line = formatTerminalTurnOverlay(
      status,
      last.verb,
      last.startedAt,
      terminal.createdAt * 1_000,
    );
    if (!line) return;
    setSettledTurn({ line });
  }, [activeAgentTurn, agentTurnMarkers, composerAck]);

  useEffect(() => {
    if (!settledTurn) return;
    const timer = setTimeout(() => setSettledTurn(null), 6_000);
    return () => clearTimeout(timer);
  }, [settledTurn]);

  useEffect(() => {
    if (!desktopExperience || (!composerAck && !settledTurn)) return;
    setDesktopDeliveryState((state) => (state === 'delivered' ? null : state));
  }, [composerAck, desktopExperience, settledTurn]);


  useEffect(() => {
    // Only an explicit offline fact can age into dormancy. A five-second clock
    // here recreated FlatList's renderItem (and every visible message) while
    // someone was typing, which made the foreground intermittently unresponsive.
    const now = Date.now();
    const presenceDeadline = nextAgentPresenceTransitionAt(agentPresences, now);
    const turnDeadline = nextAgentTurnExpiryAt(agentTurnMarkers, now);
    const deadline =
      presenceDeadline === undefined
        ? turnDeadline
        : turnDeadline === undefined
          ? presenceDeadline
          : Math.min(presenceDeadline, turnDeadline);
    if (deadline === undefined) return;
    const delay = Math.max(1, deadline - now + 1);
    const timer = setTimeout(() => setPresenceNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [agentPresences, agentTurnMarkers, presenceNow]);
  return [
    bylineOpeners, answerByMessageId, visibleMessageById, immediatelyPrecedingVisibleMessageById,
    composerAck, settledTurn, stoppingThisTurn, handleStopTurn, composerBottomInsetStyle,
    keyboardHeight,
  ];
}
