import type { MessageSendState } from '@/buzz/message-outbox';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { useEffect, type MutableRefObject } from 'react';
import { AppState } from 'react-native';
import { router } from 'expo-router';
import { KIND_AGENT_DRAFT, LiveOverlayDecoder, isRoomView, type LiveOverlay, type RoomView, type RoomViewMessage } from '@beeline/buzz-client';
import { RoomViewClient, RoomViewHttpError } from '@/sync/transport/room-view-client';
import { loadBuzzIdentity, loadBuzzViewerPubkey, peekBuzzViewerContext, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { markRoomOpen, markRoomOpenWeight } from '@/buzz/room-open-trace';
import { displayRoomMessages, reconcileRoomView, reconcileRoomMessageDelta, reconcileRoomTurnDelta } from '@/buzz/room-view-presentation';
import { offerRoomTurns, roomTurns, writeRoomMessage, writeRoomTurn } from '@/buzz/room-message-records';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { ReadCursorAdvancer } from '@/buzz/read-cursor-advance';
import { liveDraftRowId } from '@/buzz/draft-settle';
import { applyLiveOverlayStructure, liveDraftDrainKey, type LiveDraftDrainStore } from '@/buzz/live-draft-drain';
import { createRoomOutbox, mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { identityScope } from '@/buzz/identity-records';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { BuzzRigTransport } from '@/sync/transport';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { mergeAgentPresenceBatch, type RoomAgentPresence } from '@/buzz/agent-presence';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { takePrefetchedPushRoom } from '@/push/push-room-prefetch';
import { LIVE_CACHE_WRITE_DELAY_MS, ROOM_READ_UNCHANGED_REASONS, ReceivedLiveTrace, logLiveTrace, queueNewestFrameMark, yieldToPaint, logLivePaintAck, eventTag, eventMarkers, reopenIfDismissed, RoomSurfaceSessionBindings } from './useRoomSurfaceSession';

type Props = [
  liveDraftDrainStore: LiveDraftDrainStore,
  channelId: string,
  sessionActivated: boolean,
  isCornerRef: import("react/index").RefObject<boolean>,
  setFirstUnreadMessageId: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  isFocusedRef: import("react/index").RefObject<boolean>,
  sessionStartedRef: import("react/index").RefObject<boolean>,
  openingCache: { view: RoomView; scope: string; relayUrl: string; viewerPubkey: string; } | null,
  agentPresencesRef: import("react/index").RefObject<Record<string, RoomAgentPresence>>,
  reconnectGraceRef: import("react/index").RefObject<Record<string, number>>,
  setAgentPresences: import("react/index").Dispatch<import("react/index").SetStateAction<Record<string, RoomAgentPresence>>>,
  setPresenceReconnectGrace: import("react/index").Dispatch<import("react/index").SetStateAction<Record<string, number>>>,
  setPresenceResolved: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  liveOverlaysRef: import("react/index").RefObject<readonly LiveOverlay[]>,
  setLiveOverlays: import("react/index").Dispatch<import("react/index").SetStateAction<readonly LiveOverlay[]>>,
  reconciledViewRef: import("react/index").RefObject<RoomView | null>,
  setFailedIds: import("react/index").Dispatch<import("react/index").SetStateAction<ReadonlySet<string>>>,
  setOutboxStates: import("react/index").Dispatch<import("react/index").SetStateAction<ReadonlyMap<string, MessageSendState>>>,
  setHydrationFailed: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setHydrationError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>,
  applyAgentPresence: (presence: RoomAgentPresence | undefined) => void,
  readCursorRef: import("react/index").RefObject<ReadCursorAdvancer | null>,
  messageRecordScopeRef: import("react/index").RefObject<string | null>,
  setRoomSurface: import("react/index").Dispatch<import("react/index").SetStateAction<RoomView | null>>,
  setPresenceNow: import("react/index").Dispatch<import("react/index").SetStateAction<number>>,
  outboxRef: import("react/index").RefObject<{ restore: () => Promise<void>; list: () => readonly import("@/buzz/message-outbox").MessageOutboxRecord[]; get: (id: string) => import("@/buzz/message-outbox").MessageOutboxRecord | undefined; enqueue: (event: import("@beeline/nostr").NostrEvent, row: RoomViewMessage) => Promise<void>; fail: (id: string, reason?: string) => Promise<void>; remove: (id: string) => Promise<void>; reconcile: (ids: ReadonlySet<string>) => Promise<void>; send: (id: string, cause?: "send" | "reconnect") => Promise<import("@beeline/api-contract/phone").AgentMessageWriteResult | undefined>; state: (id: string) => MessageSendState | undefined; acknowledgeFailures: () => Promise<void>; subscribe: (listener: () => void) => () => void; } | null>,
  scheduleCacheWriteRef: import("react/index").RefObject<(() => void) | undefined>,
  notificationResponseId: string | undefined,
  readCursorViewerRef: import("react/index").RefObject<string>,
  pendingPaintTracesRef: import("react/index").RefObject<readonly ReceivedLiveTrace[]>,
  setUserPubkey: import("react/index").Dispatch<import("react/index").SetStateAction<string>>,
  setIdentityRecordScope: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setTransport: import("react/index").Dispatch<import("react/index").SetStateAction<BuzzRigTransport | null>>,
  setRoomClient: import("react/index").Dispatch<import("react/index").SetStateAction<RoomViewClient | null>>,
  roomReadStampRef: import("react/index").RefObject<number>,
  readRoomRef: import("react/index").RefObject<(() => Promise<void>) | null>,
  hydrationAttempt: number,
];
export function useRoomSurfaceSubscription([
  liveDraftDrainStore,
  channelId, sessionActivated, isCornerRef, setFirstUnreadMessageId, isFocusedRef,
  sessionStartedRef, openingCache, agentPresencesRef, reconnectGraceRef, setAgentPresences,
  setPresenceReconnectGrace, setPresenceResolved, liveOverlaysRef, setLiveOverlays,
  reconciledViewRef, setFailedIds, setOutboxStates, setHydrationFailed, setHydrationError,
  bindingsRef, applyAgentPresence, readCursorRef, messageRecordScopeRef, setRoomSurface,
  setPresenceNow, outboxRef, scheduleCacheWriteRef, notificationResponseId, readCursorViewerRef,
  pendingPaintTracesRef, setUserPubkey, setIdentityRecordScope, setTransport, setRoomClient,
  roomReadStampRef, readRoomRef, hydrationAttempt,
]: Props): [

] {

  useEffect(() => {
    if ((!channelId)) return;
    if (!sessionActivated) return;
    isCornerRef.current = false;
    setFirstUnreadMessageId(null);
    liveDraftDrainStore.setActive(true);

    let cancelled = false;
    let stopOutbox: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let readRoom: (() => Promise<void>) | undefined;
    const readVisibleRoom = () => {
      if (
        !isFocusedRef.current ||
        AppState.currentState === 'background' ||
        AppState.currentState === 'inactive'
      ) {
        return undefined;
      }
      void readRoom?.();
    };
    // Any frame on this watch since the last applied read. A read that finds a
    // newer message while the socket stayed silent proves the socket missed it.
    // Turn deltas heard while a Room read is in flight. Turn times are whole
    // seconds, so the read cannot tell a same-second retry from a stale turn;
    // replaying these in order on top of the read keeps what the socket said.
    let readStamp = 0;
    let messageDeltasDuringRead: RoomViewMessage[] | undefined;
    let commandsDuringRead: RoomView['pendingAgentCommands'];
    let cursorDuringRead: RoomView['viewer']['readCursor'];
    let decoder: LiveOverlayDecoder | undefined;
    let pendingOverlayEvents: Parameters<LiveOverlayDecoder['decode']>[0][] = [];
    let watchGeneration = 0;
    let hasPainted = false;
    let reopenedChat = false;
    let pendingReadTraces: ReceivedLiveTrace[] = [];
    let capturedUnreadBoundary = false;
    let cacheAddress: ReturnType<typeof surfaceAddress> | undefined;
    let cacheWriteTimer: ReturnType<typeof setTimeout> | undefined;

    const openingViewer = peekBuzzViewerContext();
    const openingFrame = !sessionStartedRef.current && openingCache &&
      openingCache.view.room.id === channelId &&
      openingCache.viewerPubkey === openingViewer?.viewerPubkey &&
      openingCache.relayUrl === openingViewer?.relayUrl;
    sessionStartedRef.current = true;
    // Initial state already describes this cached response. Resetting it here
    // commits another Room render before its first frame can be submitted.
    if (!openingFrame) {
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
    if (!openingFrame) bindingsRef.current.resetTranscript();

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

    const paintView = (view: RoomView, fresh: boolean): RoomView | null => {
      if (cancelled) return null;
      isCornerRef.current = Boolean(view.parent?.id ?? view.room.parentId);
      if (isCornerRef.current) readCursorRef.current?.cancel();
      offerRoomTurns(messageRecordScopeRef.current, channelId, view.latestAgentTurns, fresh ? readStamp : 0);
      const selectedTurns = roomTurns(messageRecordScopeRef.current, channelId);
      const selectedView = selectedTurns.length === 0 && view.latestAgentTurns.length === 0
        ? view : { ...view, latestAgentTurns: selectedTurns };
      const stableView = (reconcileRoomView(reconciledViewRef.current, selectedView));
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
      hasPainted = true;
      bindingsRef.current.observeRoomSurface();
      if (fresh && !isCornerRef.current) {
        // The server's own mark: a viewport that sees nothing past it writes nothing.
        const mark = view.viewer.readCursor?.messageId;
        if (mark) readCursorRef.current?.seed(mark);
      }
      if (fresh && !capturedUnreadBoundary && !isCornerRef.current) {
        // This is the last server answer before markRead advances to the tail.
        // Keep the exact id for the whole focused visit; later refreshes may
        // clear the cursor but must not move the divider under the reader.
        capturedUnreadBoundary = true;
        setFirstUnreadMessageId(view.viewer.readCursor?.firstUnreadMessageId ?? null);

      }
      setRoomSurface(stableView);
      if (fresh) {
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
      relayUrl: string,
      fresh: boolean,
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
      if (fresh) setPresenceResolved(true);
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
      cacheAddress = surfaceAddress(relayUrl, identityPubkey, `/room/${channelId}`);
      if ((fresh)) {
        void mobileSurfaceCache.write(cacheAddress, stableView, isRoomView);
      }
    };

    // Live deltas reach disk too, so a cold open never paints a tail older
    // than what this screen last showed. One write per burst of deltas.
    const flushCacheWrite = () => {
      if (!cacheWriteTimer) return;
      clearTimeout(cacheWriteTimer);
      cacheWriteTimer = undefined;
      const view = reconciledViewRef.current;
      if (cancelled || !view || !cacheAddress) return;
      void mobileSurfaceCache.write(cacheAddress, view, isRoomView);
    };
    const scheduleCacheWrite = () => {
      if (cacheWriteTimer || !cacheAddress) return;
      cacheWriteTimer = setTimeout(flushCacheWrite, LIVE_CACHE_WRITE_DELAY_MS);
    };
    // A retained Room can still have a debounce pending while a corner opens.
    // Enter the storage queue before the app suspends; background writes flush it.
    const cacheAppStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') flushCacheWrite();

    });
    scheduleCacheWriteRef.current = scheduleCacheWrite;

    const applyView = (
      view: RoomView,
      identityPubkey: string,
      relayUrl: string,
      fresh: boolean,
    ) => {
      const parent = view.parent?.id ?? view.room.parentId;
      if (notificationResponseId && parent && (view.room.archived || view.cornerLifecycle?.lifecycle === 'done')) {
        router.replace({ pathname: '/beeline/chat/[channelId]', params: { channelId: parent } });
        return;
      }
      const stableView = paintView(view, fresh);
      if (stableView) enrichView(stableView, identityPubkey, relayUrl, fresh);
    };

    const installWatch = async (): Promise<void> => {
      const generation = ++watchGeneration;
      const currentTransport = transportForEffect;
      if (!currentTransport) return;
      const client = await currentTransport.ensureClient();
      let replaying = true;
      // One Room open is one live subscription. watchFilters still name the
      // workspace, parent, and (from a stale cache) every corner; expanding
      // those #h/#d keys is the subscribe storm. The opened Room is the only
      // lane this surface paints.
      const stop = await client.surfaceSubscribe(
        [{ '#h': [channelId] }],
        (event: Parameters<LiveOverlayDecoder['decode']>[0] | MonolithSurfaceEvent) => {
          if (cancelled || generation !== watchGeneration) return;

          if ('monolithLive' in event) {
            const surfaceEvent = event as MonolithSurfaceEvent;
            const live = surfaceEvent.monolithLive;
            if (live.type === 'trace-painted') {
              logLivePaintAck(live);
              return;
            }
            if (live.type === 'sync-ok') return;
            if (live.type === 'subscribed') {
              markRoomOpen('subscribed', live.roomId);
              return;
            }
            if (live.type === 'sidebar-preview') {
              if (live.roomId === channelId) readVisibleRoom();
              return;
            }
            if (live.type === 'read-state' || live.type === 'room-commands') {
              if (live.roomId !== channelId) return;
              if (messageDeltasDuringRead) {
                if (live.type === 'read-state') cursorDuringRead = live.readCursor;
                else commandsDuringRead = live.commands;
              }
              const current = reconciledViewRef.current;
              if (live.type === 'read-state' && live.readCursor.messageId)
                readCursorRef.current?.acknowledge(live.readCursor.messageId);
              if (!current) return;
              const next = live.type === 'read-state'
                ? { ...current, viewer: { ...current.viewer, readCursor: live.readCursor } }
                : { ...current, pendingAgentCommands: live.commands };
              reconciledViewRef.current = next;
              setRoomSurface(next);
              scheduleCacheWrite();
              return;
            }
            if (live.type === 'message-delta' || live.type === 'turn-delta') {
              if (live.roomId !== channelId) return;
              const deltaMessage = live.type === 'message-delta'
                ? live.version === undefined ? live.message : { ...live.message, version: live.version }
                : null;
              if (live.type === 'message-delta' && live.message.requestId) {
                liveDraftDrainStore.finalize(
                  liveDraftDrainKey(live.message.author.pubkey, live.message.requestId),
                );
              } else if (live.type === 'turn-delta' && live.turn.status === 'complete') {
                liveDraftDrainStore.finalize(
                  liveDraftDrainKey(live.turn.agentPubkey, live.turn.requestId),
                );
              }
              const received = live.trace
                ? {
                    ...live.trace,
                    reason: live.type,
                    receivedAt: Date.now(),
                    ...(surfaceEvent.acknowledgePaint
                      ? { acknowledgePaint: surfaceEvent.acknowledgePaint }
                      : {}),
                  }
                : undefined;
              if (received) logLiveTrace('socket-receipt', [received], received.receivedAt);
              if (live.type === 'turn-delta')
                writeRoomTurn(messageRecordScopeRef.current, channelId, live.turn);
              else {
                messageDeltasDuringRead?.push(deltaMessage!);
                // A row older than the tail lives only in loaded history.
                writeRoomMessage(messageRecordScopeRef.current, channelId, deltaMessage!);
              }
              const current = reconciledViewRef.current;
              if (!current) {
                // The opening read is already in flight. Its snapshot will be
                // replayed with this row, so a second GET adds no information.
                return;
              }
              if (live.type === 'message-delta' && live.message.author.pubkey === readCursorViewerRef.current)
                readCursorRef.current?.acknowledge(live.message.id);
              const next =
                live.type === 'message-delta'
                  ? reconcileRoomMessageDelta(current, deltaMessage!)
                  : reconcileRoomTurnDelta(current, live.turn, roomTurns(messageRecordScopeRef.current, channelId));
              if (next === current) {
                received?.acknowledgePaint?.();
                return;
              }
              reconciledViewRef.current = next;
              hasPainted = true;
              bindingsRef.current.observeRoomSurface();
              if (received)
                pendingPaintTracesRef.current = [
                  ...pendingPaintTracesRef.current.slice(-15),
                  received,
                ];
              setRoomSurface(next);
              scheduleCacheWrite();
              if (live.type === 'message-delta') {
                void outboxRef.current?.reconcile(
                  new Set(next.messages.map((message) => message.id)),
                );
                setFailedIds((failed) => {
                  if (!failed.has(live.message.id)) return failed;
                  const reconciled = new Set(failed);
                  reconciled.delete(live.message.id);
                  return reconciled;
                });
              }
              return;
            }
            if (live.type === 'invalidate') {
              if (ROOM_READ_UNCHANGED_REASONS.has(live.reason)) return;
              // A committed row's own delta follows this hint and paints it.
              // Only a row the server could not read (its fallback, which
              // `reconcilesDelivery` names) or a change no row describes
              // falls through to one Room read.
              if (live.deliveryId) return;
              if (live.trace) {
                const received = {
                  ...live.trace,
                  reason: live.reason,
                  receivedAt: Date.now(),
                  ...(surfaceEvent.acknowledgePaint
                    ? { acknowledgePaint: surfaceEvent.acknowledgePaint }
                    : {}),
                };
                pendingReadTraces = [...pendingReadTraces.slice(-15), received];
                logLiveTrace('socket-receipt', [received], received.receivedAt);
              }
              // A claim has already committed its WORKING receipt before the
              // server emits this invalidation. Give that receipt an immediate
              // authoritative read instead of placing it behind ordinary
              // surface coalescing, where a short turn can complete first.
              if (['message', 'turn', 'activity', 'phone-write'].includes(live.reason)) {
                // A same-process committed-row delta follows only when the
                // invalidation names its row. A targetless phone-write is the
                // whole hint — swallowing it leaves the newest message
                // unpainted until remount.
                const namedRow =
                  typeof live.messageId === 'string' ||
                  (typeof live.agentId === 'string' && typeof live.requestId === 'string');
                if (!namedRow) readVisibleRoom();
              } else if (live.reason === 'postgres:agent_turns') {
                readVisibleRoom();
              } else {
                readVisibleRoom();
              }
            } else if (live.roomId !== channelId) {
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

          const markers = eventMarkers(event);
          const requestId = eventTag(event, 'request');
          const replayedWorkingReceipt = replaying && eventTag(event, 'status') === 'working';
          if (
            event.kind === 9 &&
            eventTag(event, 'h') === channelId &&
            markers.includes('agent-turn') &&
            requestId &&
            (!replaying || replayedWorkingReceipt)
          ) {
            readVisibleRoom();
            return;
          }
          if (replaying) return;
          const expectsPaintedMessage =
            event.kind === 9 &&
            eventTag(event, 'h') === channelId &&
            (markers.length === 0 ||
              markers.some((marker: string) =>
                [
                  'agent-message',
                  'github-event',
                  'buzz-attachment',
                  'corner-branch-ended',
                  'corner-worktree-cleaned',
                ].includes(marker),
              ));
          if (expectsPaintedMessage) {
            readVisibleRoom();
          } else {
            readVisibleRoom();
          }
        },
      );
      replaying = false;
      if (cancelled || generation !== watchGeneration) {
        stop();
        return;
      }

      unsubscribe?.();
      unsubscribe = stop;
    };

    let stopOpeningResponse = () => {};
    if (openingFrame && openingViewer) {
      const address = surfaceAddress(openingViewer.relayUrl, openingViewer.viewerPubkey, `/room/${channelId}`);
      const paintOpeningResponse = () => {
        const viewer = peekBuzzViewerContext();
        if (cancelled || viewer?.viewerPubkey !== openingViewer.viewerPubkey ||
            viewer.relayUrl !== openingViewer.relayUrl) return;
        const view = mobileSurfaceCache.peek(address, isRoomView);
        if (view && view !== reconciledViewRef.current) {
          paintView(view, false);
          queueNewestFrameMark(view.messages.at(-1)?.id, channelId);
        }
      };
      // A missing-row reply may arrive while the cached frame is committing.
      // Observe the authorized response now instead of holding it behind setup.
      stopOpeningResponse = mobileSurfaceCache.subscribe(address, paintOpeningResponse);
      paintOpeningResponse();
    }

    let transportForEffect: BuzzRigTransport | undefined;
    void (async () => {
      try {
        if (openingFrame) {
          await yieldToPaint();
          if (cancelled) return;
        }
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
        const address = surfaceAddress(relayUrl, viewerPubkey, `/room/${channelId}`);
        markRoomOpen('session-start', channelId);
        markRoomOpen('cache-read-start');
        const cached = (await mobileSurfaceCache.read(address, isRoomView));
        markRoomOpen('cache-read-end', cached ? 'hit' : 'miss');
        let paintedCache: RoomView | null = null;
        if (cached && !cancelled) {
          paintedCache = paintView(cached, false);
          const cachedNewest = cached.messages.at(-1)?.id;
          markRoomOpen('cache-apply', cachedNewest);
          queueNewestFrameMark(cachedNewest, channelId);
        }
        markRoomOpen('occupancy-yield-start');
        if (!openingFrame || cached !== openingCache.view) await yieldToPaint();
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
          // Rows display failures, never the delivery queue. Healthy sends must
          // not rerender the whole Room before the receipt can paint.
          const states = new Map<string, MessageSendState>();
          const failed = new Set<string>();
          for (const record of outbox.list()) {
            const state = outbox.state(record.event.id);
            if (state && state.kind !== 'sending') states.set(record.event.id, state);
            if (record.status === 'failed') failed.add(record.event.id);
          }
          setOutboxStates(current => current.size === states.size && [...states].every(([id, state]) =>
            current.get(id)?.kind === state.kind && current.get(id)?.text === state.text) ? current : states);
          setFailedIds(current => current.size === failed.size && [...failed].every(id => current.has(id))
            ? current : failed);
        };
        stopOutbox = outbox.subscribe(updateOutbox);
        updateOutbox();
        if (paintedCache) enrichView(paintedCache, identity.publicKey, relayUrl, false);
        if (cancelled) return;

        let openingPrefetch = takePrefetchedPushRoom(notificationResponseId ?? `room-open:${channelId}`, channelId);
        readRoom = async () => {
          if (cancelled) return;

          const traces = pendingReadTraces;
          pendingReadTraces = [];
          logLiveTrace('room-read-start', traces);
          markRoomOpen('room-read-start');
          messageDeltasDuringRead = [];
          commandsDuringRead = undefined;
          cursorDuringRead = undefined;
          try {
            const prefetched = openingPrefetch;
            openingPrefetch = null;
            readStamp = prefetched ? 0 : currentSurfaceStamp();
            const view = await (prefetched ? prefetched : nextRoomClient.room(channelId));
            logLiveTrace('room-read-end', traces);
            markRoomOpen('room-read-end', view.messages.at(-1)?.id);
            markRoomOpenWeight(view);
            pendingPaintTracesRef.current = traces;

            if (cancelled) return;
            roomReadStampRef.current = readStamp;
            const replayedMessages = messageDeltasDuringRead ?? [];
            messageDeltasDuringRead = undefined;
            applyView(
              replayedMessages.reduce(reconcileRoomMessageDelta, {
                ...view,
                ...(commandsDuringRead ? { pendingAgentCommands: commandsDuringRead } : {}),
                ...(cursorDuringRead ? { viewer: { ...view.viewer, readCursor: cursorDuringRead } } : {}),
              }),
              identity.publicKey,
              relayUrl,
              true,
            );
            // Disk completion does not mean the tap-time response has arrived.
            // Keep painting cache publishes through identity/outbox setup until
            // the opening read is actually applied (cleanup also unsubscribes).
            stopOpeningResponse();
            if (!view.parent && !reopenedChat) {
              reopenedChat = true;
              // Only a Room the reader dismissed from the list needs reopening;
              // the live Room list says which, or else the server decides.
              void reopenIfDismissed(nextTransport, view, relayUrl, identity.publicKey).catch(() => {
                reopenedChat = false;
              });
            }
            // The read mark is no longer advanced from here. A fetched view
            // says what EXISTS, not what was seen, and marking its tail read
            // cleared the badge for messages sitting well below the fold.
            // The viewport owns the boundary now (`advanceReadCursor`).
          } catch (error) {
            logLiveTrace('room-read-error', traces);
            markRoomOpen('room-read-error');
            messageDeltasDuringRead = undefined;

            if (cancelled) return;
            setPresenceResolved(false);
            const terminal =
              error instanceof RoomViewHttpError &&
              (error.status === 401 || error.status === 403 || error.status === 404);
            // A failed read waits for the next subscribed frame or foreground.
            // It does not schedule another read.
            if (terminal) {
              setRoomSurface(null);
              for (const overlay of liveOverlaysRef.current) {
                if (overlay.kind === 'draft') {
                  liveDraftDrainStore.remove(liveDraftDrainKey(overlay.agentPubkey, overlay.requestId));
                }
              }
              liveOverlaysRef.current = [];
              setLiveOverlays([]);
              unsubscribe?.();
              unsubscribe = undefined;
              void mobileSurfaceCache.remove(address);
            }
            const copy = appErrorCopy(error, 'Could not load this Room.');
            setHydrationFailed(Boolean(copy));
            setHydrationError(copy || null);
          }
        };
        readRoomRef.current = readRoom;
        markRoomOpen('watch-install');
        await installWatch();
        if (cancelled) return;
        await readRoom();
        markRoomOpen('watch-ready');
      } catch (error) {
        if (cancelled) return;
        const copy = appErrorCopy(error, `Could not open this ${ROOM_LABEL}.`);
        setHydrationFailed(Boolean(copy));
        setHydrationError(copy || null);
      }
    })();

    return () => {
      stopOpeningResponse();
      cacheAppStateSubscription.remove();
      flushCacheWrite();
      cancelled = true;
      watchGeneration += 1;
      unsubscribe?.();
      stopOutbox?.();
      outboxRef.current = null;
      readRoomRef.current = null;
      reconciledViewRef.current = null;
      scheduleCacheWriteRef.current = undefined;
      for (const overlay of liveOverlaysRef.current) {
        if (overlay.kind === 'draft') {
          liveDraftDrainStore.remove(liveDraftDrainKey(overlay.agentPubkey, overlay.requestId));
        }
      }
      liveOverlaysRef.current = [];
    };
  }, [applyAgentPresence, bindingsRef, channelId, hydrationAttempt, notificationResponseId, sessionActivated]);
return [

  ];
}
