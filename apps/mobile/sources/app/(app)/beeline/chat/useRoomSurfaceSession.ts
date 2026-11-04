import type { MessageSendState } from '@/buzz/message-outbox';
import { reconnectNow } from '@/sync/transport/live-connection';
import { useRouterFamily } from '@/buzz/router-family';
import { acquireRouterLane, retryRouterLane } from '@/buzz/router-owner';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AppState } from 'react-native';
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
  RoomViewClient,
} from '@/sync/transport/room-view-client';

import {
  loadBuzzIdentity,
  loadBuzzViewerPubkey,
  getEffectiveRelayUrl,
} from '@/auth/buzz-identity-storage';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { issueUnreadLine, spendUnreadLine, unreadLineSpent } from '@/buzz/unread-line-ticket';
import {
  displayRoomMessages,
  reconcileRoomMessageDelta,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import { offerRoomTurns, writeRoomMessage } from '@/buzz/room-message-records';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { ReadCursorAdvancer } from '@/buzz/read-cursor-advance';
import { observeVisibleRoomRows, requireOpeningRoomResponse, openingRoomResponseReady, roomDrawGeneration } from '@/buzz/room-draw-barrier';
import { messageBoundaryIds } from '@/buzz/room-new-message-boundary';
import { liveDraftRowId } from '@/buzz/draft-settle';
import {
  applyLiveOverlayStructure,
  liveDraftDrainKey,
  liveDraftDrainStore,
  type LiveDraftDrainStore,
} from '@/buzz/live-draft-drain';
import { createRoomOutbox } from '@/buzz/surface-storage';
import { identityScope } from '@/buzz/identity-records';
import { BuzzRigTransport } from '@/sync/transport';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import {
  mergeAgentPresence,
  mergeAgentPresenceBatch,
  type RoomAgentPresence,
} from '@/buzz/agent-presence';
import { liveChatList } from '@/buzz/chat-list-store';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { scheduleAnimationFrame } from '@/buzz/host-scheduler';

const EMPTY_ROUTER_OVERLAYS: readonly LiveOverlay[] = Object.freeze([]);
const EMPTY_ROUTER_PRESENCES: Record<string, RoomAgentPresence> = Object.freeze({});
const EMPTY_ROUTER_GRACE: Record<string, number> = Object.freeze({});

export { markRoomOpen };

function queueNewestFrameMark(detail?: string, roomId?: string): void {
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
function yieldToPaint(): Promise<void> {
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

type RoomOutbox = ReturnType<typeof createRoomOutbox>;

async function reopenIfDismissed(
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
  outbox: RoomSurfaceOutboxHandle;
}

/** Owns the Room response lifecycle; presentation remains in the chat screen. */
export function useRoomSurfaceSession({
  channelId,
  notificationResponseId,
  isFocused = true,
  bindingsRef,
}: UseRoomSurfaceSessionOptions): UseRoomSurfaceSessionResult {
  const routerHeadMode = useRouterFamily('room-head');
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [roomClient, setRoomClient] = useState<RoomViewClient | null>(null);
  const [roomSurface, setRoomSurface] = useState<RoomView | null>(null);
  const [identityRecordScope, setIdentityRecordScope] = useState<string | null>(null);
  const messageRecordScopeRef = useRef<string | null>(null);
  const roomReadStampRef = useRef(0);
  const selectedRoomSurface = routerHeadMode === 'router' ? roomSurface : null;
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
  const [userPubkey, setUserPubkey] = useState('');
  const [heartbeatPresences, setAgentPresences] = useState<Record<string, RoomAgentPresence>>({});
  const [presenceResolved, setPresenceResolved] = useState(false);
  const [presenceReconnectGrace, setPresenceReconnectGrace] = useState<Record<string, number>>({});
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const [hydrationFailed, setHydrationFailed] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [outboxStates, setOutboxStates] = useState<ReadonlyMap<string, MessageSendState>>(new Map());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());

  const outboxRef = useRef<RoomOutbox | null>(null);
  const roomClientRef = useRef<RoomViewClient | null>(null);
  roomClientRef.current = roomClient;
  const liveOverlaysRef = useRef(liveOverlays);
  const reconciledViewRef = useRef<RoomView | null>(null);
  const sessionStartedRef = useRef(false);
  const openingDrawRef = useRef<number | undefined>(undefined);
  const drawingChannelRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!isFocused || drawingChannelRef.current === channelId) return;
    drawingChannelRef.current = channelId;
    // Optional reads wait for the canonical opening response and its paint.
    requireOpeningRoomResponse();
    openingDrawRef.current = roomDrawGeneration();
  }, [channelId, isFocused]);
  const agentPresencesRef = useRef(heartbeatPresences);
  const reconnectGraceRef = useRef(presenceReconnectGrace);
  agentPresencesRef.current = heartbeatPresences;
  reconnectGraceRef.current = presenceReconnectGrace;
  liveOverlaysRef.current = liveOverlays;

  useLayoutEffect(() => {
    if (routerHeadMode !== 'pending') return;
    // A backgrounded owner may not hear lane invalidation. Clear retained
    // private projections before another frame can expose them on foreground.
    reconciledViewRef.current = null;
    liveOverlaysRef.current = EMPTY_ROUTER_OVERLAYS;
    agentPresencesRef.current = EMPTY_ROUTER_PRESENCES;
    reconnectGraceRef.current = EMPTY_ROUTER_GRACE;
    setRoomSurface(null);
    setLiveOverlays(EMPTY_ROUTER_OVERLAYS);
    setAgentPresences(EMPTY_ROUTER_PRESENCES);
    setPresenceReconnectGrace(EMPTY_ROUTER_GRACE);
    setPresenceResolved(false);
    setFirstUnreadMessageId(null);
    bindingsRef.current.resetTranscript();
  }, [routerHeadMode, bindingsRef]);

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
        observeVisibleRoomRows(channelId, viewport.visible.flatMap(messageBoundaryIds));
        if (!isCornerRef.current && AppState.currentState === 'active')
          readCursorRef.current?.observe(viewport.chronological, viewport.visible);
      }
      const view = reconciledViewRef.current;
      if (becameFocused && view?.room.id === channelId)
        queueNewestFrameMark(view.messages.at(-1)?.id, channelId);
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
      if (isFocusedRef.current)
        observeVisibleRoomRows(channelIdRef.current, visible.flatMap(messageBoundaryIds));
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

  // Focus starts a session once. A covered native-stack route retains its
  // transcript and transport; focus alone never tears them down or rebuilds them.
  const sessionActivated = isFocused || sessionStartedRef.current;
  useEffect(() => {
    if (!channelId || routerHeadMode === 'pending') return;
    if (!sessionActivated) return;
    isCornerRef.current = false;
    setFirstUnreadMessageId(null);
    liveDraftDrainStore.setActive(true);

    let openingDraw = openingDrawRef.current;
    openingDrawRef.current = undefined;
    const releaseOpeningResponse = (view?: RoomView) => {
      if (openingDraw === undefined) return;
      openingRoomResponseReady(view?.messages.at(-1)?.id, openingDraw);
      openingDraw = undefined;
    };
    let cancelled = false;
    let stopOutbox: (() => void) | undefined;
    let stopRouterLane: (() => void) | undefined;
    let reopenedChat = false;
    let unsubscribe: (() => void) | undefined;
    let decoder: LiveOverlayDecoder | undefined;
    let pendingOverlayEvents: Parameters<LiveOverlayDecoder['decode']>[0][] = [];
    let watchGeneration = 0;
    let capturedUnreadBoundary = false;

    sessionStartedRef.current = true;
    // Initial state already describes this cached response. Resetting it here
    // commits another Room render before its first frame can be submitted.
    {
      agentPresencesRef.current = {};
      reconnectGraceRef.current = {};
      setAgentPresences({});
      setPresenceReconnectGrace({});
      setPresenceResolved(false);
      liveOverlaysRef.current = [];
      setLiveOverlays([]);
      reconciledViewRef.current = null;
      setFailedIds(new Set());
      setOutboxStates(new Map());
    }
    setHydrationFailed(false);
    setHydrationError(null);
    bindingsRef.current.resetTranscript();

    // Seconds, but not WHOLE seconds. A draft's first snapshot is the anchor
    // its row keeps for the rest of the turn (C107), and two turns starting a
    // few hundred milliseconds apart floored to the same second — leaving the
    // transcript to break the tie by row id rather than by which agent
    // started. Fractional seconds compare against durable stamps unchanged.
    const liveLaneStamp = () => Date.now() / 1000;

    const applyDecodedOverlay = (overlay: LiveOverlay) => {
      if (overlay.kind === 'presence') {
        applyAgentPresence({
          agentPubkey: overlay.agentPubkey,
          status: overlay.status,
          observedAt: overlay.createdAt,
          ...(overlay.held ? { held: true } : {}),
        });
        return;
      }
      // A cumulative draft arrival mutates only the keyed drain queue; React
      // state changes once to open/close a lane, never for text.
      const current = liveOverlaysRef.current;
      const next = applyLiveOverlayStructure(current, overlay, liveDraftDrainStore);
      if (next === current) return;
      liveOverlaysRef.current = next;
      setLiveOverlays(next);
    };

    const paintView = (view: RoomView): RoomView | null => {
      if (cancelled) return null;
      isCornerRef.current = Boolean(view.parent?.id ?? view.room.parentId);
      if (isCornerRef.current) readCursorRef.current?.cancel();
      offerRoomTurns(messageRecordScopeRef.current, channelId, view.latestAgentTurns, 0);
      const stableView = view;
      for (const message of stableView.messages) {
        if (message.requestId) {
          liveDraftDrainStore.finalize(liveDraftDrainKey(message.author.pubkey, message.requestId));
        }
      }
      for (const turn of stableView.latestAgentTurns) {
        if (turn.status === 'complete') {
          liveDraftDrainStore.finalize(liveDraftDrainKey(turn.agentPubkey, turn.requestId));
        }
      }
      reconciledViewRef.current = stableView;
      bindingsRef.current.observeRoomSurface();
      if (!isCornerRef.current) {
        // The server's own mark: a viewport that sees nothing past it writes nothing.
        const mark = view.viewer.readCursor?.messageId;
        if (mark) readCursorRef.current?.seed(mark);
      }
      if (!capturedUnreadBoundary && !isCornerRef.current) {
        // This is the last server answer before markRead advances to the tail.
        // Keep the exact id for the whole focused visit; later refreshes may
        // clear the cursor but must not move the divider under the reader.
        capturedUnreadBoundary = true;
        setFirstUnreadMessageId(view.viewer.readCursor?.firstUnreadMessageId ?? null);

      }
      setRoomSurface(stableView);
      {
        const newest = stableView.messages.at(-1)?.id;
        markRoomOpen('fresh-apply', newest);
        queueNewestFrameMark(newest, channelId);
      }
      setHydrationFailed(false);
      setHydrationError(null);
      return stableView;
    };

    const enrichView = (
      stableView: RoomView,
      identityPubkey: string,
    ) => {
      if (cancelled) return;
      const viewWorkspaceId = stableView.room.workspaceId;
      if (viewWorkspaceId) {
        void Promise.all([
          saveActiveCommunityId(identityPubkey, viewWorkspaceId),
          saveLastViewedChannel(identityPubkey, viewWorkspaceId, channelId),
        ]).catch(() => undefined);
      }

      const presences = Object.fromEntries(
        stableView.members.flatMap((member) =>
          member.presence
            ? [
                [
                  member.identity.pubkey,
                  {
                    agentPubkey: member.identity.pubkey,
                    status: member.presence.status,
                    observedAt: member.presence.observedAt,
                    ...(member.presence.held ? { held: true } : {}),
                  },
                ],
              ]
            : [],
        ),
      ) as Record<string, RoomAgentPresence>;
      const mergedPresences = mergeAgentPresenceBatch(
        agentPresencesRef.current,
        Object.values(presences),
      );
      agentPresencesRef.current = mergedPresences;
      setAgentPresences(mergedPresences);
      setPresenceResolved(true);
      setPresenceNow(Date.now());

      decoder = new LiveOverlayDecoder(
        channelId,
        new Set(
          stableView.members
            .filter((member) => member.identity.kind === 'agent')
            .map((member) => member.identity.pubkey),
        ),
        new Set([channelId, ...(stableView.parent ? [stableView.parent.id] : [])]),
      );
      const replayedOverlays = pendingOverlayEvents;
      pendingOverlayEvents = [];
      for (const event of replayedOverlays) {
        const overlay = decoder.decode(event);
        if (overlay) applyDecodedOverlay(overlay);
      }
      const authoritativeIds = new Set(stableView.messages.map((message) => message.id));
      void outboxRef.current?.reconcile(authoritativeIds);
      setFailedIds((current) => {
        const next = new Set([...current].filter((id) => !authoritativeIds.has(id)));
        return next.size === current.size ? current : next;
      });
    };

    const applyView = (
      view: RoomView,
      identityPubkey: string,
    ) => {
      const parent = view.parent?.id ?? view.room.parentId;
      if (notificationResponseId && parent && (view.room.archived || view.cornerLifecycle?.lifecycle === 'done')) {
        router.replace({ pathname: '/beeline/chat/[channelId]', params: { channelId: parent } });
        return;
      }
      const stableView = paintView(view);
      if (stableView) enrichView(stableView, identityPubkey);
    };

    const installWatch = async (): Promise<void> => {
      const generation = ++watchGeneration;
      const currentTransport = transportForEffect;
      if (!currentTransport) return;
      const client = await currentTransport.ensureClient();
      // One Room open is one live subscription. watchFilters still name the
      // workspace, parent, and (from a stale cache) every corner; expanding
      // those #h/#d keys is the subscribe storm. The opened Room is the only
      // lane this surface paints.
      const stop = await client.surfaceSubscribe(
        [{ '#h': [channelId] }],
        (event: Parameters<LiveOverlayDecoder['decode']>[0] | MonolithSurfaceEvent) => {
          if (cancelled || generation !== watchGeneration) return;
          if ((!isFocusedRef.current || AppState.currentState !== 'active')) return;
          if ('monolithLive' in event &&
              !['presence', 'draft', 'thought', 'retract'].includes((event as MonolithSurfaceEvent).monolithLive.type)) return;
          if ('monolithLive' in event) {
            const surfaceEvent = event as MonolithSurfaceEvent;
            const live = surfaceEvent.monolithLive;
            if (!('roomId' in live) || live.roomId !== channelId) {
              // A Room watch no longer includes child corners. An ephemeral
              // lane still belongs exclusively to its emitting Room.
              return;
            } else if (live.type === 'presence') {
              applyDecodedOverlay({
                kind: 'presence',
                key: `presence:${live.agentId}:${live.roomId}`,
                agentPubkey: live.agentId,
                status: live.status,
                createdAt: live.observedAt,
                ...(live.held === true ? { held: true } : {}),
              });
            } else if (live.type === 'draft') {
              applyDecodedOverlay({
                kind: 'draft',
                key: `draft:${live.agentId}:${live.turnId}`,
                stableId: liveDraftRowId(live.agentId, live.turnId),
                agentPubkey: live.agentId,
                requestId: live.turnId,
                text: live.text,
                closed: false,
                createdAt: liveLaneStamp(),
              });
            } else if (live.type === 'thought') {
              applyDecodedOverlay({
                kind: 'thought',
                key: `thought:${live.agentId}:${live.turnId}`,
                agentPubkey: live.agentId,
                sessionId: live.turnId,
                text: live.text,
                closed: false,
                createdAt: liveLaneStamp(),
              });
            } else if (live.type === 'retract') {
              applyDecodedOverlay(
                live.kind === 'draft'
                  ? {
                      kind: 'draft',
                      key: `draft:${live.agentId}:${live.turnId}`,
                      stableId: liveDraftRowId(live.agentId, live.turnId),
                      agentPubkey: live.agentId,
                      requestId: live.turnId,
                      closed: true,
                      createdAt: liveLaneStamp(),
                    }
                  : {
                      kind: 'thought',
                      key: `thought:${live.agentId}:${live.turnId}`,
                      agentPubkey: live.agentId,
                      sessionId: live.turnId,
                      closed: true,
                      createdAt: liveLaneStamp(),
                    },
              );
            }
            return;
          }
          if (!decoder && event.kind === KIND_AGENT_DRAFT) {
            pendingOverlayEvents = [...pendingOverlayEvents.slice(-63), event];
            return;
          }
          const overlay = decoder?.decode(event);
          if (overlay) {
            applyDecodedOverlay(overlay);
            return;
          }
          return;
        },
      );
      if (cancelled || generation !== watchGeneration) {
        stop();
        return;
      }
       unsubscribe?.(); unsubscribe = stop; return;
    };

    let transportForEffect: BuzzRigTransport | undefined;
    void (async () => {
      try {
        markRoomOpen('session-effect', channelId);
        markRoomOpen('identity-start');
        const viewerPubkey = await loadBuzzViewerPubkey();
        markRoomOpen('identity-ready');
        if (!viewerPubkey) {
          router.replace('/beeline/onboarding');
          return;
        }
        if (cancelled) return;
        setUserPubkey(viewerPubkey);

        markRoomOpen('relay-start');
        const relayUrl = await getEffectiveRelayUrl();
        markRoomOpen('relay-ready');
        if (cancelled) return;
        const scope = identityScope(relayUrl, viewerPubkey);
        messageRecordScopeRef.current = scope;
        setIdentityRecordScope(scope);
        markRoomOpen('session-start', channelId);
        markRoomOpen('occupancy-yield-start');
        await yieldToPaint();
        markRoomOpen('occupancy-yield-end');
        if (cancelled) return;

        markRoomOpen('auth-start');
        const identity = await loadBuzzIdentity();
        markRoomOpen('auth-ready');
        if (!identity) {
          router.replace('/beeline/onboarding');
          return;
        }
        if (cancelled) return;

        const nextTransport = new BuzzRigTransport(identity);
        const nextRoomClient = new RoomViewClient({
          baseUrl: relayUrl,
          identity,
          onPhysicalRequest: ({ method, path }) => {
            markRoomOpen('physical-request', `${method} ${path}`);
          },
        });
        transportForEffect = nextTransport;
        setTransport(nextTransport);
        setRoomClient(nextRoomClient);

        const outbox = createRoomOutbox(relayUrl, identity, channelId);
        outboxRef.current = outbox;
        await outbox.restore();
        if (cancelled) return;
        const restored = outbox
          .list()
          .map((record) => displayRoomMessages([record.row], identity.publicKey)[0]!);
        if (restored.length) bindingsRef.current.restoreOutboxMessages(restored);
        setFailedIds(
          new Set(
            outbox
              .list()
              .filter((record) => record.status === 'failed')
              .map((record) => record.event.id),
          ),
        );
        const updateOutbox = () => {
          if (cancelled) return;
          if (isFocusedRef.current && AppState.currentState === 'active') void outbox.acknowledgeFailures();
          setOutboxStates(new Map(outbox.list().map(record => [record.event.id, outbox.state(record.event.id)!])));
          setFailedIds(new Set(outbox.list().filter(record => record.status === 'failed').map(record => record.event.id)));
        };
        stopOutbox = outbox.subscribe(updateOutbox);
        updateOutbox();
        if (cancelled) return;

          const request = { family: 'room-head' as const, roomId: channelId };
          const changed = () => {
            if (cancelled) return;
            const state = lane.current();
            if (state.value && isRoomView(state.value)) {
              applyView(state.value, identity.publicKey);
              releaseOpeningResponse(state.value);
              if (!state.value.parent && !reopenedChat && isFocusedRef.current && AppState.currentState === 'active') {
                reopenedChat = true;
                void reopenIfDismissed(nextTransport, state.value, relayUrl, identity.publicKey)
                  .catch(() => undefined);
              }
            } else if (state.state === 'REVOKED' || state.value === null && state.state === 'PARKED') {
              reconciledViewRef.current = null; setRoomSurface(null);
              liveOverlaysRef.current = []; setLiveOverlays([]);
              setHydrationFailed(true); setHydrationError(state.error);
            }
            if (state.state === 'PARKED') { setHydrationFailed(true); setHydrationError(state.error); }
          };
          const lane = acquireRouterLane(request, () => isFocusedRef.current, changed);
          stopRouterLane = lane.release;
          changed();
          // This retains only the existing ephemeral overlay/viewing channel.
          // Durable state comes exclusively from the negotiated lane actor.
          await installWatch();
          return;
      } catch (error) {
        if (cancelled) return;
        setHydrationFailed(true);
        setHydrationError(appErrorCopy(error, `Could not open this ${ROOM_LABEL}.`));
      }
    })();

    return () => {
      stopRouterLane?.();
      cancelled = true;
      watchGeneration += 1;
      unsubscribe?.();
      stopOutbox?.();
      outboxRef.current = null;
      reconciledViewRef.current = null;
      for (const overlay of liveOverlaysRef.current) {
        if (overlay.kind === 'draft') {
          liveDraftDrainStore.remove(liveDraftDrainKey(overlay.agentPubkey, overlay.requestId));
        }
      }
      liveOverlaysRef.current = [];
    };
  }, [
    applyAgentPresence,
    bindingsRef,
    channelId,
    routerHeadMode,
    notificationResponseId,
    sessionActivated,
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
    if (routerHeadMode === 'router') retryRouterLane({ family: 'room-head', roomId: channelId });
    else reconnectNow();
  }, [channelId, routerHeadMode]);

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
    firstUnreadMessageId: routerHeadMode === 'pending' ? null : firstUnreadMessageId,
    advanceReadCursor,
    markUnreadFrom,
    acknowledgeReadMark,
    liveOverlays: routerHeadMode === 'pending' ? EMPTY_ROUTER_OVERLAYS : liveOverlays,
    liveDraftStore: liveDraftDrainStore,
    userPubkey,
    heartbeatPresences: routerHeadMode === 'pending' ? EMPTY_ROUTER_PRESENCES : heartbeatPresences,
    presenceResolved: routerHeadMode !== 'pending' && presenceResolved,
    presenceReconnectGrace: routerHeadMode === 'pending' ? EMPTY_ROUTER_GRACE : presenceReconnectGrace,
    presenceNow,
    setPresenceNow,
    hydrationFailed,
    hydrationError,
    retryHydration,
    outbox,
  };
}
