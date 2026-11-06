import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo, type MutableRefObject } from 'react';
import { router } from 'expo-router';
import { type WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { conversationIdentityByPubkey, displayRoomMessages, mergeDisplayPages, type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { cornerObjectiveItems } from '@/buzz/corner-context';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { useRoomSendFrame } from '@/buzz/room-send-frame';
import { liveDraftMessages } from '@/buzz/live-turn-stream';
import { requestMessageJump } from '@/buzz/transcript-scroll-controller';
import { createTranscriptRowFolder, foldTranscriptRows } from '@/buzz/room-message-store';
import { useRoomMessageRecords } from '@/buzz/room-message-records';
import { type RoomSurfaceSessionBindings } from './useRoomSurfaceSession';
import { visibleTranscriptWindow } from '@/buzz/transcript-presentation';
import { EMPTY_TRANSCRIPT_ARRIVAL_STATE, observeTranscriptArrivals } from '@/buzz/transcript-motion';
import { messageBoundaryIds } from '@/buzz/room-new-message-boundary';
import { useUnreadLineControl } from '@/buzz/use-new-message-control';
import { createTranscriptCardMotionStore } from '@/components/buzz/transcript-card-motion-context';
import { sameRecordValueMap, sameStringSet, useStable } from '@/buzz/use-stable';
import { useRoomWorkflowRun } from '@/buzz/use-room-workflow-run';
import { workflowRunHref } from '@/buzz/workflow-run-copy';
import { openCornerBriefViewer } from '@/components/buzz/corner-brief-viewer';
import { LedgerHistoryLine } from '@/components/buzz/Ledger';

type Props = [
  messageRecordScope: string | null,
  decodedId: string,
  serverTailRows: import("@beeline/api-contract/phone").RoomViewMessage[],
  serverHistoryRows: readonly import("@beeline/api-contract/phone").RoomViewMessage[],
  cacheViewerPubkey: string,
  roomMessageProjector: import("@/buzz/room-view-presentation").RoomMessageProjector,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  liveOverlays: readonly import("@beeline/buzz-client").LiveOverlay[],
  transcriptWindowIdRef: React.RefObject<number>,
  transcriptWindowId: number,
  historyAttached: boolean,
  bindingsRef: React.MutableRefObject<RoomSurfaceSessionBindings>,
  resetTranscriptHistory: () => void,
  outbox: import("@/app/(app)/beeline/chat/useRoomSurfaceSession").RoomSurfaceOutboxHandle,
  userPubkey: string,
  isCorner: boolean,
  firstUnreadMessageId: string | null,
  visibleMessageCount: number,
  cornerTask: string | undefined,
  resolvedChannelName: string | null,
  loadOlderHistory: (residentRowCount: number) => void,
  allowOlderHistoryRef: React.RefObject<boolean>,
  retryOlderHistory: (residentRowCount: number) => void,
  transcriptJump: import("@/buzz/room-message-store").RoomJump | null,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  jumpToTranscriptMessage: (messageId: string) => void,
  transcriptNewerStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
  retryNewerTranscriptMessages: () => void,
  transcriptHistoryStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
];

export function useChatTranscriptHistory([
  messageRecordScope, decodedId, serverTailRows, serverHistoryRows, cacheViewerPubkey,
  roomMessageProjector, roomSurface, liveOverlays, transcriptWindowIdRef, transcriptWindowId,
  historyAttached, bindingsRef, resetTranscriptHistory, outbox, userPubkey, isCorner,
  firstUnreadMessageId, visibleMessageCount, cornerTask, resolvedChannelName, loadOlderHistory,
  allowOlderHistoryRef, retryOlderHistory, transcriptJump, scrollController,
  jumpToTranscriptMessage, transcriptNewerStatus, retryNewerTranscriptMessages,
  transcriptHistoryStatus,
]: Props): [
  transcriptHostIdsRef: React.RefObject<ReadonlyMap<string, string>>,
  foldedMessages: ChatDisplayMessage[],
  loadOlderTranscriptMessages: () => void,
  anchoredSegmentActive: boolean,
  conversationIdentities: Map<string, import("@beeline/api-contract/phone").RoomViewIdentity>,
  durableMessages: ChatDisplayMessage[],
  unprojectedMessages: ChatDisplayMessage[],
  combinedMessages: ChatDisplayMessage[],
  arrivalMessages: ChatDisplayMessage[],
  unreadLine: { dividerMessageId: string | null; retire: () => void; },
  transcriptArrivalObservation: import("@/buzz/transcript-motion").TranscriptArrivalObservation,
  addMessages: (incoming: readonly ChatDisplayMessage[]) => void,
  removeOptimistic: (optimisticId: string) => void,
  reconcileOptimistic: (optimisticId: string, eventId: string) => void,
  openCurrentBrief: (() => void) | undefined,
  arrivingCardIds: ReadonlySet<string>,
  transcriptCardMotionStore: import("@/components/buzz/transcript-card-motion-context").TranscriptCardMotionStore,
  firstNewMessageId: string | null,
  cornerObjectiveText: string,
  openRoomWorkflowRun: (run: WorkflowRunSummaryView) => void,
  roomWorkflowRun: WorkflowRunSummaryView | undefined,
  roomOtherLiveRuns: readonly WorkflowRunSummaryView[] | WorkflowRunSummaryView[],
  transcriptHistoryLine: import("react/jsx-runtime").JSX.Element | null,
  transcriptForwardLine: import("react/jsx-runtime").JSX.Element | null,
  loadOlderTranscriptIfReaderAsked: () => void,
] {

  const [tailRows, historyRows] = useRoomMessageRecords(messageRecordScope, decodedId, [
    serverTailRows, serverHistoryRows,
  ]);

  const cachedMessages = useMemo(
    () => (cacheViewerPubkey ? roomMessageProjector.project(tailRows, cacheViewerPubkey) : []),
    [cacheViewerPubkey, roomMessageProjector, tailRows],
  );

  const committedMessageIds = useMemo(
    () => new Set(cachedMessages.map((message) => message.id)),
    [cachedMessages],
  );

  const liveMessages = useMemo<ChatDisplayMessage[]>(
    () =>
      roomSurface
        ? liveDraftMessages(liveOverlays, [...tailRows, ...historyRows], roomSurface.latestAgentTurns)
        : [],
    [historyRows, liveOverlays, roomSurface, tailRows],
  );

  // A detached window (a jump target far from the newest rows) shows only its
  // own rows until `loadNewer` walks it back to the live tail.
  transcriptWindowIdRef.current = transcriptWindowId;

  const anchoredSegmentActive = !historyAttached;

  const olderMessages = useMemo(
    () => (cacheViewerPubkey ? displayRoomMessages(historyRows, cacheViewerPubkey) : []),
    [cacheViewerPubkey, historyRows],
  );

  const durableMessages = useMemo(
    () =>
      anchoredSegmentActive
        ? olderMessages
        : mergeDisplayPages(olderMessages, cachedMessages, liveMessages),
    [anchoredSegmentActive, cachedMessages, liveMessages, olderMessages],
  );

  const {
    frame: roomSendFrame,
    append: addMessages,
    reconcile: reconcileOptimistic,
    remove: removeOptimistic,
    clear: clearOptimistic,
  } = useRoomSendFrame(durableMessages, committedMessageIds);

  bindingsRef.current = {
    resetTranscript: () => {
      roomMessageProjector.reset();
      resetTranscriptHistory();
      clearOptimistic();
    },
    restoreOutboxMessages: addMessages,
    dismissOptimisticMessage: removeOptimistic,
    // A newly indexed working lease can be newer than the screen's prior
    // clock. Re-evaluate it at RoomView application time, as this screen did
    // before the surface lifecycle moved into useRoomSurfaceSession.
    observeRoomSurface: () => undefined,
  };

  useLayoutEffect(() => {
    const records = outbox.current()?.list() ?? [];
    if (records.length === 0 || !userPubkey) return;
    addMessages(records.map((record) => displayRoomMessages([record.row], userPubkey)[0]!));
  }, [addMessages, outbox, userPubkey]);

  // All four display partitions share the same chronological merge. A durable
  // outbox row may be older than the current server tail after an interrupted
  // publish, so it must never claim the inverted list's newest slot.
  const combinedMessages = useMemo(
    () =>
      anchoredSegmentActive
        ? durableMessages
        : mergeDisplayPages(durableMessages, roomSendFrame.optimistic),
    [anchoredSegmentActive, durableMessages, roomSendFrame.optimistic],
  );

  // Current server message authors refresh the same membership roster that
  // drives Room and corner bylines, mention suggestions, and mention glossing.
  // Rebuilt from every live message, so keep the previous map while no
  // identity changed: the agent/person lookups and the row renderer hang off it.
  const conversationIdentities = useStable(
    useMemo(
      () => conversationIdentityByPubkey(roomSurface?.members ?? [], combinedMessages),
      [combinedMessages, roomSurface?.members],
    ),
    sameRecordValueMap,
  );

  // Open on the tail; older history reveals from what's already resident here
  // first, then pages in from the server once that's exhausted.
  // A corner turn's per-call activity rows read back as one collapsed group
  // per turn; the window and paging count those groups, not the raw rows.
  // Same-verb system lines and adjacent GitHub lifecycle rows fold into one.
  const unreadLine = useUnreadLineControl({
    roomId: decodedId,
    firstUnreadMessageId: isCorner ? null : firstUnreadMessageId,
    enabled: !isCorner,
  });

  const { dividerMessageId: firstNewMessageId } = unreadLine;

  const foldRoomRows = useMemo(createTranscriptRowFolder, [decodedId, messageRecordScope]);

  const foldedTranscript = useMemo(
    () => foldRoomRows(combinedMessages, firstNewMessageId),
    [combinedMessages, firstNewMessageId, foldRoomRows],
  );

  const foldedMessages = foldedTranscript.rows;

  // Every message id, folded ones included, to the id of the row that shows it.
  const transcriptHostIdsRef = useRef(foldedTranscript.hostIds);

  transcriptHostIdsRef.current = foldedTranscript.hostIds;

  const arrivalMessages = useMemo(() => {
    if (!anchoredSegmentActive) return foldedMessages;
    const tail = mergeDisplayPages(cachedMessages, liveMessages, roomSendFrame.optimistic);
    return foldTranscriptRows(tail, null).rows;
  }, [
    anchoredSegmentActive,
    cachedMessages,
    foldedMessages,
    liveMessages,
    roomSendFrame.optimistic,
  ]);

  const transcriptArrivalStateRef = useRef(EMPTY_TRANSCRIPT_ARRIVAL_STATE);

  const transcriptCardMotionStore = useMemo(createTranscriptCardMotionStore, [decodedId]);

  const transcriptArrivalObservation = useMemo(() => {
    return observeTranscriptArrivals(transcriptArrivalStateRef.current, {
      surfaceId: decodedId,
      hydrated: Boolean(roomSurface),
      // A fold can gain a new durable fact without changing its host row id.
      // Observe every represented id so that arrival still joins the queue.
      ids: arrivalMessages.flatMap(messageBoundaryIds),
    });
  }, [arrivalMessages, decodedId, roomSurface]);

  const arrivingCardIds = useStable(transcriptArrivalObservation.arrivingIds, sameStringSet);

  useEffect(() => {
    // Keep the comparison anchored to the last committed transcript. Mutating
    // this ref during render makes React's development double-render consume a
    // live arrival before the card ever reaches the screen.
    transcriptArrivalStateRef.current = transcriptArrivalObservation.state;
  }, [transcriptArrivalObservation.state]);

  const unprojectedMessages = useMemo(
    () => visibleTranscriptWindow(foldedMessages, visibleMessageCount),
    [foldedMessages, visibleMessageCount],
  );

  // The immutable summary stored on the corner Room is the objective for its
  // entire lifecycle; it names the empty transcript. Mutable plans never rewrite it.
  const cornerObjective = useMemo(
    () =>
      cornerObjectiveItems({
        ...(cornerTask ? { task: cornerTask } : {}),
        ...(resolvedChannelName ? { cornerName: resolvedChannelName } : {}),
      }),
    [cornerTask, resolvedChannelName],
  );

  // The same objective as one line, for the inscription under the header and
  // for the empty state's steering copy — derived once so the two never drift.
  const cornerObjectiveText = useMemo(() => cornerObjective.join(' '), [cornerObjective]);

  // The brief's latest revision opens full-screen in the artifact viewer, from
  // the objective line and from a "revised the corner brief" system line. No
  // brief, no link.
  const cornerBrief = roomSurface?.cornerBrief;

  const openCurrentBrief = useMemo(
    () => (cornerBrief ? () => openCornerBriefViewer(cornerBrief) : undefined),
    [cornerBrief],
  );

  // A live workflow run in this corner: one line under the objective, → its run page.
  const {
    workflow: roomWorkflowRun,
    otherLiveRuns: roomOtherLiveRuns,
  } = useRoomWorkflowRun(isCorner ? decodedId : undefined);

  const openRoomWorkflowRun = useCallback((run: WorkflowRunSummaryView) => {
    router.push(workflowRunHref(run));
  }, []);


  const loadOlderTranscriptMessages = useCallback(() => {
    const visibleRowCount = visibleTranscriptWindow(foldedMessages, Number.MAX_SAFE_INTEGER).length;
    loadOlderHistory(visibleRowCount);
  }, [foldedMessages, loadOlderHistory]);

  const loadOlderTranscriptIfReaderAsked = useCallback(() => {
    if (!allowOlderHistoryRef.current) return;
    loadOlderTranscriptMessages();
  }, [loadOlderTranscriptMessages]);

  const retryOlderTranscriptMessages = useCallback(() => {
    retryOlderHistory(visibleTranscriptWindow(foldedMessages, Number.MAX_SAFE_INTEGER).length);
  }, [foldedMessages, retryOlderHistory]);

  const retryTranscriptJump = useCallback(() => {
    if (!transcriptJump) return;
    requestMessageJump(scrollController, transcriptJump.messageId, jumpToTranscriptMessage);
  }, [jumpToTranscriptMessage, scrollController, transcriptJump]);

  // Lines at the newest end of the transcript, beside the composer, where the
  // reader of a notification is looking. A jump never covers the room.
  const transcriptForwardLine =
    transcriptJump?.status === 'error' ? (
      <LedgerHistoryLine
        text="Couldn't locate message · tap to retry"
        onPress={retryTranscriptJump}
      />
    ) : transcriptJump?.status === 'missing' ? (
      <LedgerHistoryLine text="That message is no longer available" />
    ) : transcriptNewerStatus === 'error' ? (
      <LedgerHistoryLine
        text="Couldn't load later messages · tap to retry"
        onPress={retryNewerTranscriptMessages}
      />
    ) : transcriptNewerStatus === 'loading' ? (
      <LedgerHistoryLine text="Loading later messages…" />
    ) : null;

  const transcriptHistoryLine =
    transcriptHistoryStatus === 'loading' ? (
      <LedgerHistoryLine text="Loading earlier messages…" />
    ) : transcriptHistoryStatus === 'error' ? (
      <LedgerHistoryLine
        text="Couldn't load earlier messages · tap to retry"
        onPress={retryOlderTranscriptMessages}
      />
    ) : transcriptHistoryStatus === 'complete' ? (
      <LedgerHistoryLine text={isCorner ? 'Beginning of corner' : `Beginning of ${ROOM_LABEL}`} />
    ) : null;
  return [
    transcriptHostIdsRef, foldedMessages, loadOlderTranscriptMessages, anchoredSegmentActive,
    conversationIdentities, durableMessages, unprojectedMessages, combinedMessages, arrivalMessages,
    unreadLine, transcriptArrivalObservation, addMessages, removeOptimistic, reconcileOptimistic,
    openCurrentBrief, arrivingCardIds, transcriptCardMotionStore, firstNewMessageId,
    cornerObjectiveText, openRoomWorkflowRun, roomWorkflowRun, roomOtherLiveRuns,
    transcriptHistoryLine, transcriptForwardLine, loadOlderTranscriptIfReaderAsked,
  ];
}
