import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AppState } from 'react-native';
import { router } from 'expo-router';
import {
  KIND_AGENT_DRAFT,
  LiveOverlayDecoder,
  RoomViewClient,
  RoomViewHttpError,
  SurfaceRefreshScheduler,
  applyLiveOverlay,
  isRoomView,
  type LiveOverlay,
  type RoomView,
} from '@beeline/buzz-client';

import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { displayRoomMessages, reconcileRoomView, type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { createRoomOutbox, mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { BuzzRigTransport } from '@/sync/transport';
import {
  mergeAgentPresence,
  mergeAgentPresenceBatch,
  type RoomAgentPresence,
} from '@/buzz/agent-presence';
import { ROOM_LABEL } from '@/buzz/vocabulary';

const OUTBOX_CONFIRMATION_TIMEOUT_MS = 15_000;

type RoomOutbox = ReturnType<typeof createRoomOutbox>;

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
  markFailed(eventId: string): Promise<void>;
  scheduleConfirmation(eventId: string): void;
  retry(eventId: string, transport?: BuzzRigTransport | null): void;
  dismiss(eventId: string): void;
}

export interface RoomSurfaceRefreshSignal {
  signal(): void;
  force(): void;
}

export interface UseRoomSurfaceSessionOptions {
  channelId: string;
  notificationResponseId?: string;
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>;
}

export interface UseRoomSurfaceSessionResult {
  transport: BuzzRigTransport | null;
  adoptTransport(transport: BuzzRigTransport): void;
  roomClient: RoomViewClient | null;
  roomSurface: RoomView | null;
  liveOverlays: readonly LiveOverlay[];
  userPubkey: string;
  heartbeatPresences: Record<string, RoomAgentPresence>;
  presenceResolved: boolean;
  presenceReconnectGrace: Record<string, number>;
  presenceNow: number;
  setPresenceNow(now: number): void;
  hydrationFailed: boolean;
  hydrationError: string | null;
  retryHydration(): void;
  refreshSignal: RoomSurfaceRefreshSignal;
  outbox: RoomSurfaceOutboxHandle;
}

/** Owns the Room response lifecycle; presentation remains in the chat screen. */
export function useRoomSurfaceSession({
  channelId,
  notificationResponseId,
  bindingsRef,
}: UseRoomSurfaceSessionOptions): UseRoomSurfaceSessionResult {
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [roomClient, setRoomClient] = useState<RoomViewClient | null>(null);
  const [roomSurface, setRoomSurface] = useState<RoomView | null>(null);
  const [liveOverlays, setLiveOverlays] = useState<readonly LiveOverlay[]>([]);
  const [userPubkey, setUserPubkey] = useState('');
  const [heartbeatPresences, setAgentPresences] = useState<Record<string, RoomAgentPresence>>({});
  const [presenceResolved, setPresenceResolved] = useState(false);
  const [presenceReconnectGrace, setPresenceReconnectGrace] = useState<Record<string, number>>({});
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const [hydrationAttempt, setHydrationAttempt] = useState(0);
  const [hydrationFailed, setHydrationFailed] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(new Set());

  const outboxRef = useRef<RoomOutbox | null>(null);
  const schedulerRef = useRef<SurfaceRefreshScheduler<RoomView> | null>(null);
  const reconciledViewRef = useRef<RoomView | null>(null);
  const confirmationTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const agentPresencesRef = useRef(heartbeatPresences);
  const reconnectGraceRef = useRef(presenceReconnectGrace);
  agentPresencesRef.current = heartbeatPresences;
  reconnectGraceRef.current = presenceReconnectGrace;

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

  const markFailed = useCallback(async (eventId: string) => {
    await outboxRef.current?.fail(eventId);
    setFailedIds((current) => new Set(current).add(eventId));
  }, []);

  const scheduleConfirmation = useCallback(
    (eventId: string) => {
      const previous = confirmationTimersRef.current.get(eventId);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        const record = outboxRef.current?.get(eventId);
        if (!record || record.status !== 'pending') return;
        void markFailed(eventId);
      }, OUTBOX_CONFIRMATION_TIMEOUT_MS);
      confirmationTimersRef.current.set(eventId, timer);
    },
    [markFailed],
  );

  const retryOutbox = useCallback(
    (eventId: string, retryTransport?: BuzzRigTransport | null) => {
      const outbox = outboxRef.current;
      const record = outbox?.get(eventId);
      const activeTransport = retryTransport === undefined ? transport : retryTransport;
      if (!outbox || !record || !activeTransport) return;
      void (async () => {
        await outbox.retry(eventId);
        setFailedIds((current) => {
          const next = new Set(current);
          next.delete(eventId);
          return next;
        });
        try {
          await activeTransport.publishPreparedMessage(record.event);
          schedulerRef.current?.signal();
          scheduleConfirmation(eventId);
        } catch {
          await markFailed(eventId);
        }
      })();
    },
    [markFailed, scheduleConfirmation, transport],
  );

  const dismissOutbox = useCallback(
    (eventId: string) => {
      const timer = confirmationTimersRef.current.get(eventId);
      if (timer) clearTimeout(timer);
      confirmationTimersRef.current.delete(eventId);
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

  const refreshSignal = useMemo<RoomSurfaceRefreshSignal>(
    () => ({
      signal: () => schedulerRef.current?.signal(),
      force: () => schedulerRef.current?.force(),
    }),
    [],
  );

  useEffect(() => {
    if (!channelId) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;
    let scheduler: SurfaceRefreshScheduler<RoomView> | undefined;
    let decoder: LiveOverlayDecoder | undefined;
    let pendingOverlayEvents: Parameters<LiveOverlayDecoder['decode']>[0][] = [];
    let watchGeneration = 0;
    let watchKey = '';
    let hasPainted = false;

    agentPresencesRef.current = {};
    reconnectGraceRef.current = {};
    setAgentPresences({});
    setPresenceReconnectGrace({});
    setPresenceResolved(false);
    setLiveOverlays([]);
    reconciledViewRef.current = null;
    setFailedIds(new Set());
    setHydrationFailed(false);
    setHydrationError(null);
    bindingsRef.current.resetTranscript();

    const applyDecodedOverlay = (overlay: LiveOverlay) => {
      setLiveOverlays((current) => applyLiveOverlay(current, overlay));
      if (overlay.kind === 'presence') {
        applyAgentPresence({
          agentPubkey: overlay.agentPubkey,
          status: overlay.status,
          observedAt: overlay.createdAt * 1_000,
        });
      }
    };

    const applyView = (view: RoomView, identityPubkey: string, relayUrl: string, fresh: boolean) => {
      if (cancelled) return;
      const stableView = reconcileRoomView(reconciledViewRef.current, view);
      reconciledViewRef.current = stableView;
      hasPainted = true;
      bindingsRef.current.observeRoomSurface();
      setRoomSurface(stableView);
      setHydrationFailed(false);
      setHydrationError(null);
      void Promise.all([
        saveActiveCommunityId(identityPubkey, stableView.room.workspaceId),
        saveLastViewedChannel(identityPubkey, stableView.room.workspaceId, channelId),
      ]).catch(() => undefined);

      const presences = Object.fromEntries(
        stableView.members.flatMap((member) =>
          member.presence
            ? [[member.identity.pubkey, {
                agentPubkey: member.identity.pubkey,
                status: member.presence.status,
                observedAt: member.presence.observedAt * 1_000,
              }]]
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
        new Set([
          channelId,
          ...(stableView.parent ? [stableView.parent.id] : []),
          ...stableView.corners.map((corner) => corner.corner.id),
        ]),
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
      for (const id of authoritativeIds) {
        const timer = confirmationTimersRef.current.get(id);
        if (timer) clearTimeout(timer);
        confirmationTimersRef.current.delete(id);
      }

      if (fresh) {
        void mobileSurfaceCache.write(
          surfaceAddress(relayUrl, identityPubkey, `/room/${channelId}`),
          stableView,
          isRoomView,
        );
      }
      const nextWatchKey = JSON.stringify(stableView.watchFilters);
      if (fresh && nextWatchKey !== watchKey) void installWatch(stableView.watchFilters);
    };

    const installWatch = async (filters: RoomView['watchFilters']): Promise<void> => {
      const generation = ++watchGeneration;
      watchKey = JSON.stringify(filters);
      const currentTransport = transportForEffect;
      if (!currentTransport) return;
      const client = await currentTransport.ensureClient();
      let replaying = true;
      const stop = await client.surfaceSubscribe(filters, (event) => {
        if (cancelled || generation !== watchGeneration) return;
        if (!decoder && event.kind === KIND_AGENT_DRAFT) {
          pendingOverlayEvents = [...pendingOverlayEvents.slice(-63), event];
          return;
        }
        const overlay = decoder?.decode(event);
        if (overlay) {
          applyDecodedOverlay(overlay);
          return;
        }
        if (replaying) return;
        const markers = event.tags.flatMap((tag) =>
          tag[0] === 't' && tag[1] ? [tag[1]] : [],
        );
        const expectsPaintedMessage =
          event.kind === 9 &&
          (markers.length === 0 ||
            markers.some((marker) =>
              ['agent-message', 'github-event', 'buzz-attachment'].includes(marker),
            ));
        if (expectsPaintedMessage) {
          scheduler?.signalUntil((view) =>
            view.messages.some((message) => message.id === event.id),
          );
        } else {
          scheduler?.signal();
        }
      });
      replaying = false;
      if (cancelled || generation !== watchGeneration) {
        stop();
        return;
      }
      unsubscribe?.();
      unsubscribe = stop;
    };

    let transportForEffect: BuzzRigTransport | undefined;
    void (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }
        if (cancelled) return;
        setUserPubkey(identity.publicKey);

        const relayUrl = await getEffectiveRelayUrl();
        if (cancelled) return;
        const nextTransport = new BuzzRigTransport(identity, relayUrl);
        const nextRoomClient = new RoomViewClient({
          baseUrl: relayUrl,
          identity,
          onPhysicalRequest: ({ method, path }) => {
            console.warn(`[room-surface] physical-request ${method} ${path}`);
          },
        });
        transportForEffect = nextTransport;
        setTransport(nextTransport);
        setRoomClient(nextRoomClient);

        const outbox = createRoomOutbox(identity, channelId);
        outboxRef.current = outbox;
        await outbox.restore();
        if (cancelled) return;
        const restored = outbox
          .list()
          .map((record) => displayRoomMessages([record.row], identity.publicKey)[0]!);
        if (restored.length) bindingsRef.current.restoreOutboxMessages(restored);
        setFailedIds(
          new Set(
            outbox.list().filter((record) => record.status === 'failed').map((record) => record.event.id),
          ),
        );
        for (const record of outbox.list().filter((record) => record.status === 'pending')) {
          await outbox.attempted(record.event.id);
          void nextTransport.publishPreparedMessage(record.event).then(
            () => {
              schedulerRef.current?.signal();
              scheduleConfirmation(record.event.id);
            },
            () => void markFailed(record.event.id),
          );
        }

        const address = surfaceAddress(relayUrl, identity.publicKey, `/room/${channelId}`);
        const cached = await mobileSurfaceCache.read(address, isRoomView);
        if (cached && !cancelled) applyView(cached, identity.publicKey, relayUrl, false);

        scheduler = new SurfaceRefreshScheduler({
          fetch: () => nextRoomClient.room(channelId),
          apply: (view) => applyView(view, identity.publicKey, relayUrl, true),
          onError: (error) => {
            if (cancelled) return;
            const terminal =
              error instanceof RoomViewHttpError &&
              (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 502);
            if (terminal) {
              setRoomSurface(null);
              setLiveOverlays([]);
              unsubscribe?.();
              unsubscribe = undefined;
              void mobileSurfaceCache.remove(address);
            }
            if (terminal || !hasPainted) {
              setHydrationFailed(true);
              setHydrationError(
                error instanceof RoomViewHttpError && error.code === 'invalid_surface_response'
                  ? 'The server returned an invalid Room response.'
                  : `Could not load this conversation. ${String(error)}`,
              );
            } else {
              setHydrationError(`Offline — showing the last saved response. ${String(error)}`);
            }
          },
        });
        schedulerRef.current = scheduler;
        const initialFilters = cached?.watchFilters ?? [{ '#h': [channelId] }];
        await scheduler.startAfter(installWatch(initialFilters));

        appStateSubscription = AppState.addEventListener('change', (state) => {
          if (state === 'active') scheduler?.force();
        });
      } catch (error) {
        if (cancelled) return;
        setHydrationFailed(true);
        setHydrationError(`Could not open this ${ROOM_LABEL}. ${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
      watchGeneration += 1;
      scheduler?.dispose();
      appStateSubscription?.remove();
      unsubscribe?.();
      for (const timer of confirmationTimersRef.current.values()) clearTimeout(timer);
      confirmationTimersRef.current.clear();
      outboxRef.current = null;
      schedulerRef.current = null;
      reconciledViewRef.current = null;
    };
  }, [applyAgentPresence, bindingsRef, channelId, hydrationAttempt, markFailed, notificationResponseId, scheduleConfirmation]);

  const outbox = useMemo<RoomSurfaceOutboxHandle>(
    () => ({
      current: () => outboxRef.current,
      failedIds,
      markFailed,
      scheduleConfirmation,
      retry: retryOutbox,
      dismiss: dismissOutbox,
    }),
    [dismissOutbox, failedIds, markFailed, retryOutbox, scheduleConfirmation],
  );

  return {
    transport,
    adoptTransport: setTransport,
    roomClient,
    roomSurface,
    liveOverlays,
    userPubkey,
    heartbeatPresences,
    presenceResolved,
    presenceReconnectGrace,
    presenceNow,
    setPresenceNow,
    hydrationFailed,
    hydrationError,
    retryHydration: () => setHydrationAttempt((attempt) => attempt + 1),
    refreshSignal,
    outbox,
  };
}
