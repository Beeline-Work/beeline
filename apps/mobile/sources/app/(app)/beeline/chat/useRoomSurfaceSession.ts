import { useRoomSurfaceSubscription } from './useRoomSurfaceSubscription';
import type { MessageSendState } from '@/buzz/message-outbox';

import { appErrorCopy } from '@/buzz/app-error-copy';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import type { RoomRepositoryResult } from '@beeline/api-contract/phone';
import {
  KIND_AGENT_DRAFT,
  LiveOverlayDecoder,
  isRoomView,
  type LiveOverlay,
  type RoomView,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import {
  isRoomViewTimeoutError,
  RoomViewClient,
  RoomViewHttpError,
} from '@/sync/transport/room-view-client';

import {
  loadBuzzIdentity,
  loadBuzzViewerPubkey,
  peekBuzzViewerContext,
  getEffectiveRelayUrl,
} from '@/auth/buzz-identity-storage';
import { markRoomOpen, markRoomOpenWeight } from '@/buzz/room-open-trace';
import { issueUnreadLine, spendUnreadLine, unreadLineSpent } from '@/buzz/unread-line-ticket';
import {
  displayRoomMessages,
  reconcileRoomView,
  reconcileRoomMessageDelta,
  reconcileRoomTurnDelta,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import { offerRoomTurns, roomTurns, stampRoomMessageRows, useRoomTurnRecords, writeRoomMessage, writeRoomTurn } from '@/buzz/room-message-records';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { ReadCursorAdvancer } from '@/buzz/read-cursor-advance';
import { liveDraftRowId } from '@/buzz/draft-settle';
import {
  applyLiveOverlayStructure,
  liveDraftDrainKey,
  createLiveDraftDrainStore,
  type LiveDraftDrainStore,
} from '@/buzz/live-draft-drain';
import { createRoomOutbox, mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { IdentitySelection, identityScope, useIdentityRecords } from '@/buzz/identity-records';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { liveChatList } from '@/buzz/chat-list-store';
import { BuzzRigTransport } from '@/sync/transport';
import type { LiveWireTrace, MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import {
  mergeAgentPresence,
  mergeAgentPresenceBatch,
  type RoomAgentPresence,
} from '@/buzz/agent-presence';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';
import { takePrefetchedPushRoom } from '@/push/push-room-prefetch';

/** A socket that never answers must not hold the open's one Room read. */
export const LIVE_CACHE_WRITE_DELAY_MS = 1_000;

/**
 * Invalidations that change nothing this Room read shows, so they read
 * nothing: a child corner's list status; a stored draft, thought or presence
 * row (each arrives as its own live frame); an agent's command queue and
 * schedules; and the viewer's own read mark, which the open visit captured.
 */
export const ROOM_READ_UNCHANGED_REASONS: ReadonlySet<string> = new Set([
  'corner-status',
  'read-mark',
  'postgres:live_outputs',
  'postgres:agent_schedules',
  'postgres:room_read_marks',
  'postgres:registry_mcp_oauth_attempts',
]);

export type ReceivedLiveTrace = LiveWireTrace & {
  reason: string;
  receivedAt: number;
  acknowledgePaint?: () => void;
};
let remainingLiveTraceLogs = 32;
let liveTraceRows: unknown[] = [];
let liveTraceWrite = Promise.resolve();
export const LIVE_TRACE_STORAGE_KEY = '@beeline/live-event-trace-v1';

export function logLiveTrace(phase: string, traces: readonly ReceivedLiveTrace[], at = Date.now()): void {
  if (traces.length === 0 || remainingLiveTraceLogs <= 0) return;
  remainingLiveTraceLogs -= 1;
  const row = {
    phase,
    at,
    events: traces.map(({ id, reason, databaseAt, emittedAt, startedAt, receivedAt }) => ({
      id,
      reason,
      databaseAt,
      emittedAt,
      ...(typeof startedAt === 'number' ? { startedAt } : {}),
      receivedAt,
    })),
  };
  if (__DEV__) console.info(`[live-trace] ${JSON.stringify(row)}`);
  liveTraceRows = [...liveTraceRows.slice(-127), row];
  // One diagnostic write after the resulting paint, not one synchronous
  // storage handoff at every socket/read phase. The trace must not perturb the
  // render interval it exists to measure.
  if (phase !== 'paint' && phase !== 'room-read-error') return;
  const snapshot = JSON.stringify(liveTraceRows);
  liveTraceWrite = liveTraceWrite
    .then(() => AsyncStorage.setItem(LIVE_TRACE_STORAGE_KEY, snapshot))
    .catch(() => undefined);
}

export { markRoomOpen };

export function queueNewestFrameMark(detail?: string, roomId?: string): void {
  if (
    !scheduleAnimationFrame(() => {
      scheduleAnimationFrame(() => markRoomOpen('newest-frame', detail, roomId));
    })
  ) {
    markRoomOpen('newest-js', detail);
  }
}

/** Give React Native a turn to commit the cached (or fetched) transcript
 * before listen/GET occupy the JS thread. Tests have no frame pump, so they
 * yield a macrotask instead of hanging on a stub rAF. */
export function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (
      scheduleAnimationFrame(() => {
        scheduleAnimationFrame(() => resolve());
      })
    ) {
      return;
    }
    setTimeout(resolve, 0);
  });
}

export function logLivePaintAck(event: {
  id: string;
  databaseAt: number;
  startedAt?: number;
  serverReceivedAt?: number;
  databaseClockAt?: number;
  upperBoundMs: number;
}): void {
  if (remainingLiveTraceLogs <= 0) return;
  remainingLiveTraceLogs -= 1;
  const row = {
    phase: 'server-paint-ack',
    at: Date.now(),
    event,
  };
  if (__DEV__) console.info(`[live-trace] ${JSON.stringify(row)}`);
  liveTraceRows = [...liveTraceRows.slice(-127), row];
  const snapshot = JSON.stringify(liveTraceRows);
  liveTraceWrite = liveTraceWrite
    .then(() => AsyncStorage.setItem(LIVE_TRACE_STORAGE_KEY, snapshot))
    .catch(() => undefined);
}

export function eventTag(event: { tags: string[][] }, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

export function eventMarkers(event: { tags: string[][] }): string[] {
  return event.tags.flatMap((tag) => (tag[0] === 't' && tag[1] ? [tag[1]] : []));
}


/** A read carries a message newer than anything the painted Room held. */

type RoomOutbox = ReturnType<typeof createRoomOutbox>;

/**
 * Clear the reader's dismissal of this Room, unless the live Room list shows
 * it open. A stored copy can predate a dismissal, so without a live list the
 * server decides.
 */
export async function reopenIfDismissed(
  transport: BuzzRigTransport,
  view: RoomView,
  relayUrl: string,
  viewerPubkey: string,
): Promise<void> {
  const workspaceId = view.room.workspaceId;
  if (workspaceId) {
    const list = liveChatList({ relayUrl, viewerPubkey, workspaceId });
    const row = list?.chats.find((item) => item.room.id === view.room.id);
    if (row && !row.closed) return;
  }
  await transport.reopenChat(view.room.id);
}

export interface RoomSurfaceSessionBindings {
  resetTranscript(): void;
  restoreOutboxMessages(messages: readonly ChatDisplayMessage[]): void;
  dismissOptimisticMessage(eventId: string): void;
  /** Refresh render-time lease evaluation whenever a RoomView is applied. */
  observeRoomSurface(): void;
}

export interface RoomSurfaceOutboxHandle {
  current(): RoomOutbox | null;
  failedIds: ReadonlySet<string>;
  states: ReadonlyMap<string, MessageSendState>;
  dismiss(eventId: string): void;
}

export interface UseRoomSurfaceSessionOptions {
  channelId: string;
  notificationResponseId?: string;
  isFocused?: boolean;
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>;
}

export interface UseRoomSurfaceSessionResult {
  transport: BuzzRigTransport | null;
  adoptTransport(transport: BuzzRigTransport): void;
  roomClient: RoomViewClient | null;
  roomSurface: RoomView | null;
  messageRecordScope: string | null;
  /** A repository write already returned the canonical binding and version. */
  applyRoomRepositoryResult(result: RoomRepositoryResult): void;
  clearRoomRepository(): void;
  /** A message mutation returned the same canonical row as the live lane. */
  applyRoomMessageResult(message: RoomViewMessage): void;
  applyPendingAgentCommands(commands: NonNullable<RoomView['pendingAgentCommands']>): void;
  applyRoomName(name: string, expected?: string): void;
  applyRoomReviewer(reviewerAgentId: string | undefined): void;
  /** Exact server-owned unread boundary captured before this visit advances the read mark. */
  firstUnreadMessageId: string | null;
  /** Server counts captured with the opening boundary, before viewport reads advance it. */
  /**
   * Report what the transcript's viewport can currently see. The boundary it
   * publishes is debounced, so this is safe to call on every viewability pass.
   * `chronological` is the oldest-first transcript — NOT the reversed array the
   * native inverted list renders from, which would rank the oldest visible row
   * as newest and read a scroll back up the transcript as progress.
   */
  advanceReadCursor(
    chronological: readonly ChatDisplayMessage[],
    visible: readonly ChatDisplayMessage[],
  ): void;
  /** Move the boundary back so this message, and everything after it, is unread. */
  markUnreadFrom(messageId: string): Promise<void>;
  /** The viewer's own send moved the server's read mark to this message. */
  acknowledgeReadMark(messageId: string): void;
  liveOverlays: readonly LiveOverlay[];
  liveDraftStore: LiveDraftDrainStore;
  userPubkey: string;
  heartbeatPresences: Record<string, RoomAgentPresence>;
  presenceResolved: boolean;
  presenceReconnectGrace: Record<string, number>;
  presenceNow: number;
  setPresenceNow(now: number): void;
  hydrationFailed: boolean;
  hydrationError: string | null;
  retryHydration(): void;
  readRoom(): void;
  outbox: RoomSurfaceOutboxHandle;
}

/** Owns the Room response lifecycle; presentation remains in the chat screen. */
export function useRoomSurfaceSession({
  channelId,
  notificationResponseId,
  isFocused = true,
  bindingsRef,
}: UseRoomSurfaceSessionOptions): UseRoomSurfaceSessionResult {
  const liveDraftDrainStore = useMemo(() => createLiveDraftDrainStore(), [channelId]);

  const [openingCache] = useState(() => {

    const viewer = peekBuzzViewerContext();
    if (!viewer) return null;
    const view = mobileSurfaceCache.peek(surfaceAddress(viewer.relayUrl, viewer.viewerPubkey, `/room/${channelId}`), isRoomView);
    return view ? { ...viewer, view, scope: identityScope(viewer.relayUrl, viewer.viewerPubkey) } : null;
  });
  useEffect(() => {
    if (openingCache) queueNewestFrameMark(openingCache.view.messages.at(-1)?.id, channelId);
  }, [openingCache]);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [roomClient, setRoomClient] = useState<RoomViewClient | null>(null);
  const [roomSurface, setRoomSurface] = useState<RoomView | null>(openingCache?.view ?? null);
  const scheduleCacheWriteRef = useRef<(() => void) | undefined>(undefined);
  const [identityRecordScope, setIdentityRecordScope] = useState<string | null>(openingCache?.scope ?? null);
  const messageRecordScopeRef = useRef<string | null>(openingCache?.scope ?? null);
  const roomReadStampRef = useRef(0);
  const identityVersion = useIdentityRecords();
  const turnRecords = useRoomTurnRecords(identityRecordScope, channelId);
  const selectedRoomSurface = useMemo(
    () => {
      if ((!roomSurface)) return null;

      const view = identityRecordScope
        ? new IdentitySelection(identityRecordScope, roomReadStampRef.current).roomView(roomSurface)
        : roomSurface;
      stampRoomMessageRows(view.messages, roomReadStampRef.current);
      return turnRecords === view.latestAgentTurns ||
        (turnRecords.length === 0 && view.latestAgentTurns.length === 0)
        ? view : { ...view, latestAgentTurns: turnRecords };
    },
    [roomSurface, identityRecordScope, identityVersion, turnRecords],
  );
  const applyRoomRepositoryResult = useCallback((result: RoomRepositoryResult) => {
    if (result.channelId !== channelId) return;
    setRoomSurface((current) => {
      if (!current || (current.repository?.updatedAt ?? -1) > result.updatedAt) return current;
      const next: RoomView = {
        ...current,
        repositoryResolution: 'repository',
        repository: {
          ...result.binding,
          targetBranch: result.targetBranch,
          updatedAt: result.updatedAt,
          githubEventsEnabled: result.githubEventsEnabled,
        },
      };
      reconciledViewRef.current = next;
      return next;
    });
  }, [channelId]);
  const clearRoomRepository = useCallback(() => {
    setRoomSurface((current) => {
      if (!current) return current;
      const next = { ...current, repository: undefined, repositoryResolution: 'none' as const };
      reconciledViewRef.current = next;
      return next;
    });
  }, []);
  const applyRoomMessageResult = useCallback((message: RoomViewMessage) => {
    // The record first: a row older than the tail lives only in loaded history.
    writeRoomMessage(messageRecordScopeRef.current, channelIdRef.current, message);
    setRoomSurface((current) => {
      if (!current) return current;
      const next = reconcileRoomMessageDelta(current, message);
      reconciledViewRef.current = next;
      void outboxRef.current?.reconcile(new Set(next.messages.map((row) => row.id)));
      scheduleCacheWriteRef.current?.();
      return next;
    });
  }, []);
  const applyPendingAgentCommands = useCallback((commands: NonNullable<RoomView['pendingAgentCommands']>) => {
    if (!commands.length) return;
    setRoomSurface((current) => {
      if (!current) return current;
      const active = new Set(current.latestAgentTurns.map((turn) => turn.requestId));
      const pending = [...(current.pendingAgentCommands ?? [])];
      for (const command of commands) {
        if (!active.has(command.requestId) && !pending.some((row) => row.requestId === command.requestId)) {
          pending.push(command);
        }
      }
      const next = { ...current, pendingAgentCommands: pending };
      reconciledViewRef.current = next;
      return next;
    });
  }, []);
  const applyRoomName = useCallback((name: string, expected?: string) => {
    setRoomSurface((current) => {
      if (!current || (expected !== undefined && current.room.name !== expected)) return current;
      const next = { ...current, room: { ...current.room, name } };
      reconciledViewRef.current = next;
      return next;
    });
  }, []);
  const applyRoomReviewer = useCallback((reviewerAgentId: string | undefined) => {
    setRoomSurface((current) => {
      if (!current) return current;
      const next = { ...current, room: { ...current.room, reviewerAgentId } };
      reconciledViewRef.current = next;
      return next;
    });
  }, []);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const [liveOverlays, setLiveOverlays] = useState<readonly LiveOverlay[]>([]);
  const [userPubkey, setUserPubkey] = useState(openingCache?.viewerPubkey ?? '');
  const [heartbeatPresences, setAgentPresences] = useState<Record<string, RoomAgentPresence>>({});
  const [presenceResolved, setPresenceResolved] = useState(false);
  const [presenceReconnectGrace, setPresenceReconnectGrace] = useState<Record<string, number>>({});
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [hydrationFailed, setHydrationFailed] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [outboxStates, setOutboxStates] = useState<ReadonlyMap<string, MessageSendState>>(new Map());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());

  const outboxRef = useRef<RoomOutbox | null>(null);
  const roomClientRef = useRef<RoomViewClient | null>(null);
  roomClientRef.current = roomClient;
  const liveOverlaysRef = useRef(liveOverlays);
  const readRoomRef = useRef<(() => Promise<void>) | null>(null);
  const reconciledViewRef = useRef<RoomView | null>(openingCache?.view ?? null);
  const sessionStartedRef = useRef(false);
  const agentPresencesRef = useRef(heartbeatPresences);
  const reconnectGraceRef = useRef(presenceReconnectGrace);
  const pendingPaintTracesRef = useRef<readonly ReceivedLiveTrace[]>([]);
  agentPresencesRef.current = heartbeatPresences;
  reconnectGraceRef.current = presenceReconnectGrace;
  liveOverlaysRef.current = liveOverlays;

  useEffect(() => {
    const traces = pendingPaintTracesRef.current;
    if (!roomSurface || traces.length === 0) return;
    pendingPaintTracesRef.current = [];
    logLiveTrace('paint', traces);
    for (const trace of traces) trace.acknowledgePaint?.();
  }, [roomSurface]);

  const channelIdRef = useRef(channelId);
  const isFocusedRef = useRef(isFocused);
  const readVisitFocusRef = useRef(isFocused);
  const isCornerRef = useRef(false);
  isFocusedRef.current = isFocused;
  // One advancer per visit. It debounces the viewport's reports and writes the
  // boundary the reader actually reached; the Room switching out from under it
  // drops whatever it was still holding, because that belongs to the old Room.
  const readCursorRef = useRef<ReadCursorAdvancer | null>(null);
  const readCursorViewerRef = useRef(userPubkey);
  const readViewportRef = useRef<{ roomId: string; viewer: string;
    chronological: readonly ChatDisplayMessage[]; visible: readonly ChatDisplayMessage[] } | null>(null);
  if (readCursorRef.current === null) {
    readCursorRef.current = new ReadCursorAdvancer((messageId) => {
      void roomClientRef.current?.markRead(channelIdRef.current, messageId).catch(() => undefined);
    }, undefined, () => roomClientRef.current !== null);
  }
  useEffect(() => {
    channelIdRef.current = channelId;
    // A different Room under a mounted surface is its own fresh visit, and
    // carries none of the previous Room's suspension.
    readCursorRef.current?.resume();
    // Leaving drops whatever boundary the debounce was still holding — it
    // belongs to the Room being left, and must never be written against this
    // one.
    return () => readCursorRef.current?.cancel();
  }, [channelId]);
  useLayoutEffect(() => {
    const previous = readCursorViewerRef.current;
    readCursorViewerRef.current = userPubkey;
    if (previous && previous !== userPubkey) readCursorRef.current?.cancel();
  }, [userPubkey]);
  useLayoutEffect(() => {
    if (roomClient) readCursorRef.current?.retry();
  }, [roomClient]);
  // A VISIT begins and ends with focus, not with the Room id. Re-arming on
  // `channelId` alone left the advancer suspended forever once mark-unread
  // stopped it: the reader leaves and reopens the same Room, the id never
  // changes, and the viewport silently stops moving the boundary for good.
  //
  // So: arriving re-arms, leaving publishes what was seen. A debounce still
  // holding a boundary when the visit ends is not less read for it.
  useEffect(() => {
    const becameFocused = isFocused && !readVisitFocusRef.current;
    readVisitFocusRef.current = isFocused;
    liveDraftDrainStore.setActive(isFocused);
    if (isFocused) {
      void outboxRef.current?.acknowledgeFailures();
      readCursorRef.current?.resume();
      const viewport = readViewportRef.current;
      if (viewport?.roomId === channelId && viewport.viewer === readCursorViewerRef.current) {
        if (!isCornerRef.current && AppState.currentState === 'active')
          readCursorRef.current?.observe(viewport.chronological, viewport.visible);
      }
      const view = reconciledViewRef.current;
      if (becameFocused && view?.room.id === channelId)
        queueNewestFrameMark(view.messages.at(-1)?.id, channelId);
      void readRoomRef.current?.();
      return;
    }
    readCursorRef.current?.flush();
  }, [channelId, isFocused, liveDraftDrainStore]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') readCursorRef.current?.flush();
    });
    return () => subscription.remove();
  }, []);

  const advanceReadCursor = useCallback(
    (chronological: readonly ChatDisplayMessage[], visible: readonly ChatDisplayMessage[]) => {
      readViewportRef.current = { roomId: channelIdRef.current, viewer: readCursorViewerRef.current, chronological, visible };
      if (isCornerRef.current) return;
      if (!isFocusedRef.current) return;
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
      readCursorRef.current?.observe(chronological, visible);
    },
    [],
  );

  const markUnreadFrom = useCallback(async (messageId: string) => {
    if (isCornerRef.current) return;
    // The reader has said this message is unread. Stop the viewport from
    // reading it again on the very next report, then move the server boundary.
    readCursorRef.current?.suspend();
    const previousMessageId = firstUnreadMessageId;
    const lineWasSpent = unreadLineSpent(channelIdRef.current);
    // Naming a row is asking for the line back, so it gets a ticket even if
    // this visit already spent one (`buzz/unread-line-ticket.ts`). Issued
    // before the boundary moves, because the boundary is what the control
    // re-reads the ledger on.
    issueUnreadLine(channelIdRef.current);
    setFirstUnreadMessageId(messageId);
    try {
      await roomClientRef.current?.markUnread(channelIdRef.current, messageId);
    } catch (error) {
      setFirstUnreadMessageId(previousMessageId);
      if (lineWasSpent) spendUnreadLine(channelIdRef.current);
      readCursorRef.current?.resume();
      throw error;
    }
  }, [firstUnreadMessageId]);

  const acknowledgeReadMark = useCallback((messageId: string) => {
    if (!isCornerRef.current) readCursorRef.current?.acknowledge(messageId);
  }, []);

  const applyAgentPresence = useCallback((presence: RoomAgentPresence | undefined) => {
    if (!presence) return;
    setAgentPresences((current) => {
      const next = mergeAgentPresence(current, presence);
      agentPresencesRef.current = next;
      return next;
    });
    setPresenceReconnectGrace((current) => {
      if (current[presence.agentPubkey] === undefined) return current;
      const next = { ...current };
      delete next[presence.agentPubkey];
      reconnectGraceRef.current = next;
      return next;
    });
    setPresenceNow(Date.now());
  }, []);

  const dismissOutbox = useCallback(
    (eventId: string) => {
      void outboxRef.current?.remove(eventId);
      setFailedIds((current) => {
        const next = new Set(current);
        next.delete(eventId);
        return next;
      });
      bindingsRef.current.dismissOptimisticMessage(eventId);
    },
    [bindingsRef],
  );

  const readRoom = useCallback(() => { void readRoomRef.current?.(); }, []);

  // Focus starts a session once. A covered native-stack route retains its
  // transcript and transport; focus alone never tears them down or rebuilds them.
  const sessionActivated = isFocused || sessionStartedRef.current;
  useRoomSurfaceSubscription([
    liveDraftDrainStore, channelId, sessionActivated, isCornerRef, setFirstUnreadMessageId, isFocusedRef,
    sessionStartedRef, openingCache, agentPresencesRef, reconnectGraceRef, setAgentPresences,
    setPresenceReconnectGrace, setPresenceResolved, liveOverlaysRef, setLiveOverlays,
    reconciledViewRef, setFailedIds, setOutboxStates, setHydrationFailed, setHydrationError,
    bindingsRef, applyAgentPresence, readCursorRef, messageRecordScopeRef, setRoomSurface,
    setPresenceNow, outboxRef, scheduleCacheWriteRef, notificationResponseId, readCursorViewerRef,
    pendingPaintTracesRef, setUserPubkey, setIdentityRecordScope, setTransport, setRoomClient,
    roomReadStampRef, readRoomRef, hydrationAttempt,
  ]);


  const outbox = useMemo<RoomSurfaceOutboxHandle>(
    () => ({
      current: () => outboxRef.current,
      failedIds,
      states: outboxStates,
        dismiss: dismissOutbox,
    }),
    [dismissOutbox, failedIds, outboxStates],
  );

  const retryHydration = useCallback(() => {
    setHydrationAttempt((attempt) => attempt + 1);
  }, [channelId]);

  return {
    transport,
    adoptTransport: setTransport,
    roomClient,
    roomSurface: selectedRoomSurface,
    messageRecordScope: identityRecordScope,
    applyRoomRepositoryResult,
    clearRoomRepository,
    applyRoomMessageResult,
    applyPendingAgentCommands,
    applyRoomName,
    applyRoomReviewer,
    firstUnreadMessageId: (firstUnreadMessageId),
    advanceReadCursor,
    markUnreadFrom,
    acknowledgeReadMark,
    liveOverlays: (liveOverlays),
    liveDraftStore: liveDraftDrainStore,
    userPubkey,
    heartbeatPresences: (heartbeatPresences),
    presenceResolved: (presenceResolved),
    presenceReconnectGrace: (presenceReconnectGrace),
    presenceNow,
    setPresenceNow,
    hydrationFailed,
    hydrationError,
    retryHydration,
    readRoom,
    outbox,
  };
}
