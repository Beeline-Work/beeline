import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { cancelScheduledAnimationFrame, scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { availableSlashVerbs } from '@/buzz/slash-verbs';
import { answerPrefillCandidate, planAnswerPrefill, type ComposerPrefill, type ComposerPrefillPlan } from '@/buzz/composer-prefill';
import { visibleTranscriptWindow } from '@/buzz/transcript-presentation';
import { newestTranscriptRowId } from '@/buzz/room-new-message-boundary';
import { useNewMessageControl } from '@/buzz/use-new-message-control';
import { usePhoneUnderfillHistory } from '@/buzz/phone-underfill-history';
import { TAIL_PIN_THRESHOLD } from './chat-surface-values';

type Props = [
  anchoredSegmentActive: boolean,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  fillTranscript: (residentRowCount: number) => void,
  foldedMessages: ChatDisplayMessage[],
  desktopTranscript: boolean,
  transcriptMessages: ChatDisplayMessage[],
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  cacheViewerPubkey: string,
  transcriptFillStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
  visibleMessageCount: number,
  visibleMessages: ChatDisplayMessage[],
  viewerIsAgent: boolean,
  userPubkey: string,
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  isDirectMessage: boolean,
  decodedId: string,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  selectedAgentMentionsRef: React.RefObject<Map<string, string>>,
  selectedMentionsRef: React.RefObject<Map<string, string>>,
  inputTextRef: React.RefObject<string>,
  setInputText: (update: string | ((previous: string) => string)) => void,
  setInputSelection: React.Dispatch<React.SetStateAction<{ start: number; end: number; }>>,
  arrivalMessages: ChatDisplayMessage[],
  unreadLine: { dividerMessageId: string | null; retire: () => void; },
  transcriptArrivalObservation: import("@/buzz/transcript-motion").TranscriptArrivalObservation,
  isCorner: boolean,
  canManageWorkspace: boolean,
  pendingCornerRequest: ChatDisplayMessage | undefined,
  pendingTargetBranchProposal: ChatDisplayMessage | undefined,
  targetBranchActionId: string | null,
  currentSlashQuery: string | null,
  mentionSlash: import("@/buzz/slash-verbs").AgentMentionSlash | null,
  composerFocused: boolean,
  mentionSlashAgentPubkey: string | null,
  dismissedSlashText: string | null,
  inputText: string,
  mentionAgentCommands: import("@/buzz/slash-verbs").AgentPaletteCommand[],
  setHighlightedSlashVerbIndex: React.Dispatch<React.SetStateAction<number>>,
];

export function useChatTranscriptWindow([
  anchoredSegmentActive, scrollController, fillTranscript, foldedMessages, desktopTranscript,
  transcriptMessages, roomClient, cacheViewerPubkey, transcriptFillStatus, visibleMessageCount,
  visibleMessages, viewerIsAgent, userPubkey, agentByPubkey, isDirectMessage, decodedId,
  roomSurface, selectedAgentMentionsRef, selectedMentionsRef, inputTextRef, setInputText,
  setInputSelection, arrivalMessages, unreadLine, transcriptArrivalObservation, isCorner,
  canManageWorkspace, pendingCornerRequest, pendingTargetBranchProposal, targetBranchActionId,
  currentSlashQuery, mentionSlash, composerFocused, mentionSlashAgentPubkey, dismissedSlashText,
  inputText, mentionAgentCommands, setHighlightedSlashVerbIndex,
]: Props): [
  desktopScrollNodeRef: React.RefObject<HTMLElement | null>,
  heldLandingFromOldestRef: React.RefObject<number>,
  phoneContentHeightRef: React.RefObject<number>,
  phoneScrollOffsetRef: React.RefObject<number>,
  heldLandingShortRef: React.RefObject<boolean>,
  phoneListHeightRef: React.RefObject<number>,
  observeVisibleMessages: (visible: readonly ChatDisplayMessage[]) => void,
  chronologicalMessagesRef: React.RefObject<ChatDisplayMessage[]>,
  newMessageHasObservedVisibility: boolean,
  newestTranscriptMessageId: string | null,
  desktopContentObserverRef: React.RefObject<ResizeObserver | null>,
  desktopContentNodeRef: React.RefObject<HTMLElement | null>,
  observeTailPinned: (pinned: boolean) => void,
  applyComposerPrefill: (plan: ComposerPrefillPlan, agent?: { handle: string; pubkey: string; }) => void,
  composerPrefillRef: React.RefObject<ComposerPrefill | null>,
  slashVerbs: import("@/buzz/slash-verbs").BuiltInSlashVerb[],
  phoneUnderfill: { observeListHeight: (height: number) => void; observeContentHeight: (height: number) => void; },
  detachedFillMeasuredRef: React.RefObject<boolean>,
  holdPhoneLanding: (height: number) => void,
  newMessageBadgeCount: number,
  newestJumpDiscShown: boolean,
  slashMenuVisible: boolean,
  paletteItemCount: number,
] {

  // A detached window fills with newer rows only once a pending landing has
  // landed, so the rows it measured stay where they are. It fills one page
  // per content size the list reports: the window turns idle before the list
  // measures the page it added, and a check in between reads the old short
  // height and would walk the window to the tail.
  const detachedFillMeasuredRef = useRef(true);

  const fillShortTranscript = useCallback(() => {
    if (anchoredSegmentActive) {
      if (scrollController.isLanding() || !detachedFillMeasuredRef.current) return;
      detachedFillMeasuredRef.current = false;
    }
    fillTranscript(visibleTranscriptWindow(foldedMessages, Number.MAX_SAFE_INTEGER).length);
  }, [anchoredSegmentActive, fillTranscript, foldedMessages, scrollController]);

  // A held jump landing keeps its distance from the oldest end of the phone
  // content while newer rows grow it at the newest end (native offset 0).
  // Native lists keep a visible row in place, but not while the content is
  // shorter than the list; React Native Web never does.
  const phoneContentHeightRef = useRef(0);

  const phoneScrollOffsetRef = useRef(0);

  const heldLandingFromOldestRef = useRef(0);

  // Only a window shorter than the list grows by newer rows after its
  // landing (the short-list fill). A window that fills the list grows only
  // at its oldest end, as the list draws rows above the target, and the
  // native offset keeps the target in place by itself.
  const phoneListHeightRef = useRef(0);

  const heldLandingShortRef = useRef(false);

  const holdPhoneLanding = (height: number) => {
    phoneContentHeightRef.current = height;
    if (!scrollController.isHoldingLanding() || !heldLandingShortRef.current) return;
    const offset = Math.max(0, height - heldLandingFromOldestRef.current);
    if (Math.abs(offset - phoneScrollOffsetRef.current) > 1) scrollController.holdLanding(offset);
  };

  // The fill waits for the Room connection: the store drops a page request
  // made without one, and nothing else would re-check a short saved copy.
  const phoneUnderfill = usePhoneUnderfillHistory({
    enabled:
      !desktopTranscript &&
      transcriptMessages.length > 0 &&
      Boolean(roomClient) &&
      Boolean(cacheViewerPubkey),
    status: transcriptFillStatus,
    historyRevision: visibleMessageCount,
    threshold: TAIL_PIN_THRESHOLD,
    fill: fillShortTranscript,
  });

  // A page that folds into rows already shown changes no height, so no size
  // report reopens the detached fill. Two frames after the window's rows
  // change, the list has reported any new height; without one, the height it
  // holds is current, so the fill checks it again.
  const observeUnderfillContentHeight = phoneUnderfill.observeContentHeight;

  useEffect(() => {
    if (desktopTranscript || !anchoredSegmentActive || detachedFillMeasuredRef.current) return;
    let second: number | false = false;
    const first = scheduleAnimationFrame(() => {
      second = scheduleAnimationFrame(() => {
        if (detachedFillMeasuredRef.current || phoneContentHeightRef.current <= 0) return;
        detachedFillMeasuredRef.current = true;
        observeUnderfillContentHeight(phoneContentHeightRef.current);
      });
    });
    return () => {
      if (first !== false) cancelScheduledAnimationFrame(first);
      if (second !== false) cancelScheduledAnimationFrame(second);
    };
  }, [anchoredSegmentActive, desktopTranscript, observeUnderfillContentHeight, transcriptMessages]);

  // The read cursor ranks rows by index to decide which is newest, so it reads
  // the chronological order for the same reason the jump control does: on the
  // phone `transcriptMessages` IS the reversed list, and ranking that array
  // picks the oldest visible row and reads a scroll back up as progress.
  const chronologicalMessagesRef = useRef(visibleMessages);

  chronologicalMessagesRef.current = visibleMessages;

  // The composer offers an agent's handle as visible, deletable text: on a
  // quote-reply, and when the newest message is that agent's answer to the
  // viewer, or before a first message to a sole agent member. Each candidate
  // is offered once (`buzz/composer-prefill.ts`).
  const composerPrefillRef = useRef<ComposerPrefill | null>(null);

  const offeredPrefillsRef = useRef(new Set<string>());

  const answerPrefill = useMemo(
    () =>
      viewerIsAgent || anchoredSegmentActive
        ? undefined
        : answerPrefillCandidate(
            visibleMessages,
            userPubkey,
            (message) =>
              message.authorIdentity?.handle ??
              (message.pubkey ? agentByPubkey.get(message.pubkey)?.handle : undefined),
            isDirectMessage ? undefined : {
              roomId: decodedId,
              agents: roomSurface?.members
                .filter((member) => member.identity.kind === 'agent')
                .map((member) => member.identity) ?? [],
              viewerIsAgent,
              humanCount: roomSurface?.members.filter((member) => member.identity.kind === 'human').length ?? 0,
            },
          ),
    [agentByPubkey, anchoredSegmentActive, decodedId, isDirectMessage, roomSurface?.members, userPubkey, viewerIsAgent, visibleMessages],
  );

  const answerPrefillRef = useRef(answerPrefill);

  answerPrefillRef.current = answerPrefill;

  const applyComposerPrefill = useCallback(
    (plan: ComposerPrefillPlan, agent?: { handle: string; pubkey: string }) => {
      if (plan.kind === 'keep') return;
      const text = plan.kind === 'fill' ? plan.text : '';
      composerPrefillRef.current = plan.kind === 'fill' ? plan.prefill : null;
      if (plan.kind === 'fill' && agent) {
        const handle = agent.handle.replace(/^@/, '');
        selectedAgentMentionsRef.current.set(handle, agent.pubkey);
        selectedMentionsRef.current.set(handle, agent.pubkey);
      }
      inputTextRef.current = text;
      setInputText(text);
      setInputSelection({ start: text.length, end: text.length });
    },
    [setInputText],
  );

  useEffect(() => {
    const candidate = answerPrefillRef.current;
    const plan = planAnswerPrefill({
      draft: inputTextRef.current,
      prefill: composerPrefillRef.current,
      candidate,
      offered: offeredPrefillsRef.current,
    });
    if (plan.kind === 'fill' && candidate) offeredPrefillsRef.current.add(candidate.sourceMessageId);
    applyComposerPrefill(plan, candidate);
  }, [answerPrefill?.sourceMessageId, applyComposerPrefill]);

  // The row the jump control exists to reach. Read from the chronological
  // order so the inverted phone list and the desktop list name the same row.
  const newestTranscriptMessageId = newestTranscriptRowId(visibleMessages);

  const newestArrivalMessageId = anchoredSegmentActive
    ? newestTranscriptRowId(arrivalMessages)
    : newestTranscriptMessageId;

  // Rooms use the unread divider and queue; corners use only the viewport-
  // driven jump control (`buzz/use-new-message-control.ts`).
  // The divider answers one question: where the reader's unread run began when
  // they opened this Room. The server's cursor owns that line until the newest
  // row is visible; a message arriving while the reader is in history belongs
  // to the control, not to that line. Binding the divider to the live queue
  // instead dragged it off the unread run and pinned it to whichever row had
  // just landed, which is the divider readers watched appear at the newest
  // message out of nowhere.
  const {
    discVisible: newestJumpDiscShown,
    badgeCount: newMessageBadgeCount,
    hasObservedVisibility: newMessageHasObservedVisibility,
    observeVisibleMessages,
    observeTailPinned,
  } = useNewMessageControl({
    unreadLine,
    roomId: decodedId,
    queueableMessages: arrivalMessages,
    arrivingIds: transcriptArrivalObservation.arrivingIds,
    newestMessageId: newestArrivalMessageId,
    isPinnedToTail: () => !anchoredSegmentActive && scrollController.isPinnedToTail(),
    enabled: !isCorner,
  });

  const slashVerbs = useMemo(
    () =>
      availableSlashVerbs(
        {
          canBuild: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && roomSurface?.viewer.permissions.send,
          ),
          canCreatePoll: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && roomSurface?.viewer.permissions.send,
          ),
          canManageSchedules: Boolean(
            !isCorner &&
            !viewerIsAgent &&
            (isDirectMessage ? Boolean(roomSurface?.viewer.permissions.send) : canManageWorkspace),
          ),
          canRunWorkflows: Boolean(
            !isCorner &&
            !isDirectMessage &&
            !viewerIsAgent &&
            canManageWorkspace &&
            roomSurface?.repositoryResolution === 'repository',
          ),
          canOpenCorner: Boolean(!isCorner && !viewerIsAgent && pendingCornerRequest),
          canRename: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent && canManageWorkspace),
          canCloseCorner: isCorner && !viewerIsAgent,
          canChangeTargetBranch: Boolean(
            !isCorner &&
            !viewerIsAgent &&
            canManageWorkspace &&
            pendingTargetBranchProposal &&
            !targetBranchActionId,
          ),
          canAddAgent: Boolean(!isCorner && !isDirectMessage && !viewerIsAgent),
          canInvitePerson: Boolean(
            !isCorner && !isDirectMessage && !viewerIsAgent && canManageWorkspace,
          ),
        },
        currentSlashQuery ?? mentionSlash?.query ?? '',
      ),
    [
      currentSlashQuery,
      mentionSlash?.query,
      canManageWorkspace,
      isCorner,
      isDirectMessage,
      pendingCornerRequest,
      pendingTargetBranchProposal,
      targetBranchActionId,
      viewerIsAgent,
      roomSurface?.repositoryResolution,
      roomSurface?.viewer.permissions.send,
    ],
  );

  const slashMenuVisible = Boolean(
    composerFocused &&
    (currentSlashQuery !== null || (mentionSlash !== null && mentionSlashAgentPubkey !== null)) &&
    dismissedSlashText !== inputText,
  );

  const paletteItemCount =
    mentionAgentCommands.length + slashVerbs.length;

  useEffect(() => {
    setHighlightedSlashVerbIndex(0);
  }, [currentSlashQuery, mentionSlash?.query, paletteItemCount]);

  // The desktop transcript's real scroll container and content node — a
  // plain scrollable View over real DOM (`shouldFollowDesktopTail` in
  // `buzz/room-scroll-follow.ts`), not React Native Web's FlatList/
  // VirtualizedList, whose own provisional layout accounting is the root
  // cause proof/desktop-append-overlap/NOTES.md traces eight prior scroll-
  // timing patches back to.
  const desktopScrollNodeRef = useRef<HTMLElement | null>(null);

  const desktopContentNodeRef = useRef<HTMLElement | null>(null);

  const desktopContentObserverRef = useRef<ResizeObserver | null>(null);
  return [
    desktopScrollNodeRef, heldLandingFromOldestRef, phoneContentHeightRef, phoneScrollOffsetRef,
    heldLandingShortRef, phoneListHeightRef, observeVisibleMessages, chronologicalMessagesRef,
    newMessageHasObservedVisibility, newestTranscriptMessageId, desktopContentObserverRef,
    desktopContentNodeRef, observeTailPinned, applyComposerPrefill, composerPrefillRef, slashVerbs,
    phoneUnderfill, detachedFillMeasuredRef, holdPhoneLanding, newMessageBadgeCount,
    newestJumpDiscShown, slashMenuVisible, paletteItemCount,
  ];
}
