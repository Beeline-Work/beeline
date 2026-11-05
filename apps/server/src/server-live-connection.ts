import { phoneLiveOutput } from './phone-live-output.js';
import { HelperOverlayViewer, helperOverlayEnabled, fenceHelperOverlayEnqueue } from './helper-overlay.js';
import { fenceCommandReceiptEnqueue } from './router-command-coverage.js';
import { phoneSocketRequests } from './phone-socket.js';
import { createHash, randomUUID } from 'node:crypto';
import { type IncomingMessage } from 'node:http';
import { type WebSocket } from 'ws';
import { PhoneViewing } from './phone-viewing.js';
import { projectSidebarPreview, offscreenMessageFits, readSidebarPreview, type MessageBookmarkView, type RoomLiveDelta } from '@beeline/api-contract/phone';
import type { LiveEvent, LiveTrace } from './live.js';
import { isNeedsYouAsk } from './needs-you.js';
import { recordOperatorFunctionEvent } from './operator-dashboard.js';
import { type DaemonLiveDependencies } from './daemon-live.js';
import { serveAgentSocket, serveMachineSocket, machineConnectionOutput, enableMachineTcpKeepalive } from './machine-connection.js';
import { MAX_LIVE_OUTBOUND_BUFFERED_BYTES, SENT_ROW_LIMIT, RowOrder, SentRow, rowOrderIsNotNewer, LIVE_PING_FRAME, LIVE_PONG_FRAME, ROOM_ID_PATTERN, ServerOptions, isRetryableLiveError, requestErrorStatus } from './server.js';

type LiveConnectionContext = {
  liveErrors: { database: number; invalid: number; internal: number; overload: number; };
  watchConnectionEpochs: () => void;
  socketSubscriptions: Map<WebSocket, () => number>;
  daemonLive: DaemonLiveDependencies;
  options: ServerOptions;
  readNeedsYouForViewer: (event: LiveEvent, roomId: string, viewerId: string) => Promise<{ workspaceId: string; count: number; items: readonly import("@beeline/api-contract/phone").NeedsYouItemView[]; } | null>;
  readLiveRowForViewer: (event: LiveEvent, roomId: string, viewerId: string, target: { type: "message"; messageId: string; } | { type: "turn"; agentId: string; requestId: string; }) => Promise<RoomLiveDelta | null>;
  readWorkspaceChange: (event: LiveEvent, id: string) => Promise<{ workspace: { id: string; name: string; avatar?: string; }; viewers: ReadonlySet<string>; } | null>;
  readPersonChange: (event: LiveEvent, id: string) => Promise<{ person: import("@beeline/api-contract/phone").RoomViewIdentity; pushLevel?: import("@beeline/api-contract/phone").PushLevel; viewers: ReadonlySet<string>; } | null>;
  bookmarkReads: WeakMap<LiveEvent, Promise<MessageBookmarkView | null>>;
  withLiveDbTask: <T>(work: () => Promise<T>) => Promise<T>;
  dispatchPhoneOperation: (name: string, input: Record<string, unknown>, viewerId: string, signal?: AbortSignal | undefined, familyId?: string | undefined, command?: import("@beeline/api-contract/router-command").RouterCommandIdentity | undefined) => Promise<unknown>;
  readCornerStatusForViewer: (event: LiveEvent, roomId: string, viewerId: string) => Promise<{ cornerCount: number; waitingCornerCount: number; mineCornerCount: number; openCorners: import("@beeline/api-contract/phone").ChatListCorner[]; agentState: "needs-you" | "working" | null; attentionReason?: NonNullable<import("@beeline/api-contract/phone").ChatListItem["attentionReason"]>; corners: import("@beeline/api-contract/phone").CornerListView["corners"]; nextOpen?: string; } | null>;
  phoneViewing: PhoneViewing;
  acquireLiveDbTask: () => Promise<() => void>;
};
export function handleLiveConnection(ctx: LiveConnectionContext, client: WebSocket, _request: IncomingMessage, principal: {
        identityId: string;
        kind: 'phone' | 'daemon' | 'machine';
        helperVersion?: string;
        helperSourceSha?: string;
        familyId?: string;
      }) {
      const sendLive = principal.kind === 'phone'
        ? phoneLiveOutput(client, MAX_LIVE_OUTBOUND_BUFFERED_BYTES, () => { ctx.liveErrors.overload++; })
        : machineConnectionOutput(client, MAX_LIVE_OUTBOUND_BUFFERED_BYTES, () => { ctx.liveErrors.overload++; });
      if (principal.kind !== 'phone') {
        enableMachineTcpKeepalive(_request.socket);
        ctx.watchConnectionEpochs();
        const trackSubscriptions = (count: () => number) => ctx.socketSubscriptions.set(client, count);
        client.on('close', () => ctx.socketSubscriptions.delete(client));
        if (principal.kind === 'machine')
          serveMachineSocket(
            ctx.daemonLive,
            client,
            principal,
            sendLive,
            trackSubscriptions,
          );
        else serveAgentSocket(ctx.daemonLive, client, principal, sendLive, trackSubscriptions);
        return;
      }
      const releaseServerConnection = ctx.options.connectionPresence?.holdServerConnection();
      client.once('close', () => releaseServerConnection?.());
      client.once('error', () => releaseServerConnection?.());
      ctx.options.live.humanConnected(principal.identityId);
      // Rooms this socket views hold pushes until it says otherwise or closes.
      const viewingSession = randomUUID();
      const viewedRooms = new Set<string>();
      const previewRooms = new Set<string>();
      const releases = new Map<string, () => void>();
      let phoneViewClosed = false;
      // Workspace membership notifications survive the deletion cascade and
      // reach the affected identity without requiring a readable Room.
      let needsYouDelivery = Promise.resolve();
      // Workspace and identity changes keep their commit order on this socket.
      let identityDelivery = Promise.resolve();
      const sendNeedsYouDelta = (event: LiveEvent, roomId: string) => {
        if (!ctx.options.phone.liveNeedsYou) return;
        // A later projection must not overtake an earlier one and then be
        // overwritten by its stale count or slice on the same socket.
        needsYouDelivery = needsYouDelivery.then(() =>
          ctx.readNeedsYouForViewer(event, roomId, principal.identityId).then((value) => {
            if (!value) return;
            sendLive(JSON.stringify({ type: 'needs-you-delta', roomId: '',
              sourceRoomId: roomId, ...value }));
          })).catch(() => {sendLive(JSON.stringify({ type: 'invalidate', roomId: '',
          reason: 'needs-you-gap' }));});
      };
      const releaseWorkspaces = ctx.options.live.subscribeAll((event) => {
        if (event.type === 'resource-change') {
          if (event.ownerId === principal.identityId)
            sendLive(JSON.stringify({ type: 'resource-change', roomId: '',
              resource: event.resource, ...(event.resourceId ? { resourceId: event.resourceId } : {}),
              ...(event.version ? { version: event.version } : {}), ...(event.usageOnly ? { usageOnly: true } : {}) }));
          return;
        }
        if (event.type !== 'invalidate') return;
        if (event.roomId !== '') {
          if (releases.has(event.roomId)) return;
          if (!event.messageId || !ctx.options.phone.liveNeedsYou) return;
          const local = event.committedRow?.type === 'message' ? event.committedRow.row : null;
          const candidate = event.needsYouCandidate || event.reason === 'phone-write' ||
            event.agentId === principal.identityId ||
            (local && (local.presentation === 'card' || local.presentation === 'system' ||
              isNeedsYouAsk(local.text)));
          if (!candidate) return;
          void ctx.readLiveRowForViewer(event, event.roomId, principal.identityId,
            { type: 'message', messageId: event.messageId }).then((delta) => {
            if (delta?.type !== 'message-delta') return;
            const message = delta.message;
            if (message.author.pubkey === principal.identityId ||
                message.presentation === 'card' || message.presentation === 'system' ||
                (message.mentionPubkeys?.includes(principal.identityId) &&
                  isNeedsYouAsk(message.text))) sendNeedsYouDelta(event, event.roomId);
          }).catch(() => undefined);
          return;
        }
        if (event.reason === 'postgres:workspaces' && event.workspaceId) {
          const read = ctx.readWorkspaceChange(event, event.workspaceId);
          identityDelivery = identityDelivery.then(() => read.then((change) => {
            if (!change?.viewers.has(principal.identityId)) return;
            sendLive(JSON.stringify({ type: 'workspace-changed', roomId: '',
              workspace: change.workspace }));
          })).catch(() => undefined);
          return;
        }
        if (event.reason === 'postgres:identities' && event.personId) {
          // A push level change alone carries its owner as the only reader.
          if (event.readerId && event.readerId !== principal.identityId) return;
          const read = ctx.readPersonChange(event, event.personId);
          identityDelivery = identityDelivery.then(() => read.then((change) => {
            if (!change?.viewers.has(principal.identityId)) return;
            // The push level is the owner's own setting; no other viewer hears it.
            sendLive(JSON.stringify({ type: 'person-changed', roomId: '', person: change.person,
              ...(change.person.pubkey === principal.identityId && change.pushLevel
                ? { pushLevel: change.pushLevel } : {}) }));
          })).catch(() => undefined);
          return;
        }
        if (event.readerId !== principal.identityId) return;
        if (event.reason === 'postgres:memberships') {
          sendLive(JSON.stringify({ type: 'invalidate', roomId: '', reason: event.reason }));
          return;
        }
        if (event.reason === 'postgres:needs_you_marks' && event.sourceRoomId) {
          sendNeedsYouDelta(event, event.sourceRoomId);
          return;
        }
        if (event.reason !== 'postgres:message_bookmarks' || !event.messageId ||
            !event.workspaceId || !ctx.options.phone.readLiveBookmark) return;
        let read = ctx.bookmarkReads.get(event);
        if (!read) {
          read = (event.operation === 'DELETE'
            ? Promise.resolve(null)
            : ctx.withLiveDbTask(() => ctx.options.phone.readLiveBookmark(
              event.messageId!, principal.identityId)))
            .finally(() => ctx.bookmarkReads.delete(event));
          ctx.bookmarkReads.set(event, read);
        }
        void read.then((bookmark) => {
          sendLive(JSON.stringify({ type: 'bookmark-delta', roomId: '',
            workspaceId: event.workspaceId, messageId: event.messageId, bookmark }));
        }).catch(() => sendLive(JSON.stringify({ type: 'invalidate', roomId: '',
          reason: 'bookmark-gap' })));
      });
      const releasePersonalResync = ctx.options.live.subscribeResync(() => {
        if (client.readyState === client.OPEN)
          sendLive(JSON.stringify({ type: 'invalidate', roomId: '', reason: 'reconnect' }));
      });
      // Keep in-flight rows while ordering and deduplicating delivered projections.
      const sentRows = new Map<string, SentRow>();
      const beginRowRead = (key: string) => {
        const row = sentRows.get(key) ?? { reads: 0 };
        row.reads += 1;
        sentRows.set(key, row);
      };
      const endRowRead = (key: string) => {
        const row = sentRows.get(key);
        if (!row) return;
        row.reads -= 1;
        if (!row.reads && row.fingerprint === undefined) sentRows.delete(key);
      };
      const admitRow = (key: string, order: RowOrder | undefined, fingerprint: string) => {
        const sent = sentRows.get(key) ?? { reads: 0 };
        if (rowOrderIsNotNewer(order, sent.order)) return false;
        // An unchanged projection is not sent, but its order still advances,
        // so an older frame with other content cannot follow it.
        sentRows.delete(key);
        sentRows.set(key, { order: order ?? sent.order, fingerprint, reads: sent.reads });
        for (const [candidate, row] of sentRows) {
          if (sentRows.size <= SENT_ROW_LIMIT) break;
          if (!row.reads) sentRows.delete(candidate);
        }
        return sent.fingerprint !== fingerprint;
      };
      const sendDraft = (event: Extract<LiveEvent, { type: 'draft' | 'thought' }>): boolean =>
        sendLive(JSON.stringify(event));
      const enqueueHelperOverlay=(raw:LiveEvent):boolean=>{
        if(client.readyState!==client.OPEN||!overlayViewer.canDeliver(raw))return false;
        const event=overlayViewer.normalize(raw);
        let sent=false;
        if(event.type==='draft'||event.type==='thought')sent=sendDraft(event);
        else if(event.type==='retract'){
          sent=sendLive(JSON.stringify(event));
        }
        if(sent)overlayViewer.delivered(event);
        return sent;
      };
      const overlayViewer=new HelperOverlayViewer(event=>{
        void fenceHelperOverlayEnqueue(ctx.options.database,event,()=>enqueueHelperOverlay(event),principal.identityId);
      });
      ctx.socketSubscriptions.set(client, () => releases.size);
      let socketTaskTail = Promise.resolve();
      const pendingPaintTraces = new Map<
        string,
        {
          readonly startedAt?: number;
          readonly databaseAt: number;
          readonly databaseClock: boolean;
          readonly kind: 'message' | 'turn';
        }
      >();
      const rememberPaintTrace = (trace: LiveTrace | undefined, kind: 'message' | 'turn') => {
        if (!trace || (typeof trace.startedAt !== 'number' && trace.paintAck !== 'database-clock'))
          return;
        pendingPaintTraces.set(trace.id, {
          startedAt: trace.startedAt,
          databaseAt: trace.databaseAt,
          databaseClock: trace.paintAck === 'database-clock',
          kind,
        });
        if (pendingPaintTraces.size > 64) {
          const oldest = pendingPaintTraces.keys().next().value;
          if (oldest) pendingPaintTraces.delete(oldest);
        }
      };
      const handlePhoneRequest = phoneSocketRequests(client, principal.identityId,
        ctx.dispatchPhoneOperation, sendLive, requestErrorStatus, principal.familyId,
        (_name, _args, result, enqueue) => fenceCommandReceiptEnqueue(ctx.options.database, principal.identityId, result, enqueue));
      client.on('message', (raw) => {
        const frameBytes = Array.isArray(raw)
          ? raw.reduce((total, part) => total + part.length, 0)
          : raw.byteLength;
        // The phone's liveness ping needs no database work, so it never
        // waits behind the admission queue.
        if (frameBytes <= 32 && raw.toString() === LIVE_PING_FRAME) {
          sendLive(LIVE_PONG_FRAME);
          return;
        }
        if (frameBytes <= 32 && raw.toString() === '{"type":"sync"}') {
          sendLive('{"type":"sync-ok"}');
          return;
        }
        try {
          const parsed = JSON.parse(raw.toString());
          if (handlePhoneRequest(parsed)) return;
        } catch {
          ctx.liveErrors.invalid++;
          return;
        }
        const processMessage = async () => {
          if (client.readyState !== client.OPEN) return;
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            ctx.liveErrors.invalid++;
            return;
          }
          if (!message || typeof message !== 'object') return;
          const item = message as Record<string, unknown>;
          // Installed phones still send sync before selecting ordinary reads.
          if (item.type === 'sync') { sendLive('{"type":"sync-ok"}'); return; }
          if (item.type === 'trace-paint' && typeof item.id === 'string') {
            const trace = pendingPaintTraces.get(item.id);
            if (!trace || client.readyState !== client.OPEN) return;
            pendingPaintTraces.delete(item.id);
            if (trace.databaseClock) {
              const clock = (
                await ctx.options.database.query<{ clock_at: Date }>(
                  `SELECT clock_timestamp() clock_at`,
                )
              ).rows[0]?.clock_at;
              if (!clock || client.readyState !== client.OPEN) return;
              const databaseClockAt = clock.getTime();
              sendLive(
                JSON.stringify({
                  type: 'trace-painted',
                  id: item.id,
                  databaseAt: trace.databaseAt,
                  databaseClockAt,
                  upperBoundMs: databaseClockAt - trace.databaseAt,
                }),
              );
              return;
            }
            if (typeof trace.startedAt !== 'number') return;
            const serverReceivedAt = Date.now();
            if (
              trace.kind === 'message' &&
              serverReceivedAt >= trace.startedAt &&
              serverReceivedAt - trace.startedAt <= 600_000
            ) {
              void recordOperatorFunctionEvent(
                ctx.options.database,
                'message_delivery',
                serverReceivedAt - trace.startedAt,
                false,
              ).catch(() => undefined);
            }
            sendLive(
              JSON.stringify({
                type: 'trace-painted',
                id: item.id,
                startedAt: trace.startedAt,
                databaseAt: trace.databaseAt,
                serverReceivedAt,
                upperBoundMs: serverReceivedAt - trace.startedAt,
              }),
            );
            return;
          }
          if (item.type === 'subscribe') {
            const requestedRoomIds = Array.isArray(item.roomIds)
              ? [
                  ...new Set(
                    (item.roomIds as unknown[]).filter(
                      (id): id is string => typeof id === 'string' && id.length > 0,
                    ),
                  ),
                ]
              : typeof item.roomId === 'string'
                ? [item.roomId]
                : [];
            if (requestedRoomIds.length === 0) return;
            const readableRooms = await ctx.options.phone.canReadRooms(
              requestedRoomIds,
              principal.identityId,
            );
            for (const roomId of requestedRoomIds) {
              if (!readableRooms.has(roomId)) continue;
              releases.get(roomId)?.();
              if (item.sidebarPreviews === true) previewRooms.add(roomId);
              // Agents whose draft this socket has already been handed live.
              // The snapshot below is read asynchronously, so a delta can land
              // first; replacing it with the older row would show the reader the
              // answer going backwards.
              const streamed = new Set<string>();
              const forwardEvent = (event: LiveEvent) => {
                  const sendFrame = (payload: Record<string, unknown>) => sendLive(JSON.stringify(payload));
                  if (
                    event.type === 'invalidate' &&
                    event.readerId &&
                    event.readerId !== principal.identityId
                  )
                    return;
                  if (event.type === 'draft') streamed.add(event.agentId);
                  if (event.type !== 'invalidate') {
                    if (client.readyState !== client.OPEN) return;
                    if(helperOverlayEnabled() && 'overlayV1' in event && event.overlayV1){
                      if(!viewedRooms.has(roomId)||!overlayViewer.accept(event))return;
                      return fenceHelperOverlayEnqueue(ctx.options.database,event,()=>enqueueHelperOverlay(event),principal.identityId);
                    }
                    if (event.type === 'draft' || event.type === 'thought') sendDraft(event);
                    else {
                      sendFrame(event);
                    }
                    return;
                  }
                  // committedRow is process-local authority input. Strip it
                  // before every wire branch, including malformed/no-target
                  // invalidations, so only a projected public delta can leave.
                  const { committedRow, trace: eventTrace } = event;
                  // Phone readers react to the reason and Room; the remaining
                  // LiveEvent fields route helper work or identify a row that
                  // will instead be sent as a projected delta below.
                  const wireEvent = { type: 'invalidate', roomId, reason: event.reason };
                  const target = event.messageId
                    ? ({ type: 'message' as const, messageId: event.messageId } as const)
                    : event.agentId && event.requestId
                      ? ({
                          type: 'turn' as const,
                          agentId: event.agentId,
                          requestId: event.requestId,
                        } as const)
                      : undefined;
                  if (!target) {
                    if (item.roomStateProjections === true && ((event.reason === 'postgres:room_read_marks' && event.readerId === principal.identityId &&
                          typeof ctx.options.phone.liveReadState === 'function') ||
                        (event.reason === 'postgres:agent_commands' && typeof ctx.options.phone.liveRoomCommands === 'function'))) {
                      const readMark = event.reason === 'postgres:room_read_marks';
                      const stateKey = `${roomId}:${readMark ? 'read-state' : 'room-commands'}`;
                      beginRowRead(stateKey);
                      return ctx.withLiveDbTask(async () => readMark
                        ? ctx.options.phone.liveReadState(roomId, principal.identityId)
                        : ctx.options.phone.liveRoomCommands(roomId, principal.identityId))
                        .then((state) => {
                          if (client.readyState !== client.OPEN) return;
                          if (state === null) { sendFrame(wireEvent); return; }
                          if (!admitRow(stateKey, undefined,
                            JSON.stringify(state))) return;
                          sendFrame(readMark ? { type: 'read-state', roomId, readCursor: state }
                            : { type: 'room-commands', roomId, commands: state });
                        }).catch(() => { if (client.readyState === client.OPEN) sendFrame(wireEvent); })
                        .finally(() => endRowRead(stateKey));
                    }
                    if (event.reason === 'corner-status' &&
                        typeof ctx.options.phone.liveChatCornerStatus === 'function') {
                      const statusKey = `${roomId}:corner-status`;
                      beginRowRead(statusKey);
                      return ctx.readCornerStatusForViewer(event, roomId, principal.identityId)
                        .then((status) => {
                          if (client.readyState !== client.OPEN) return;
                          if (!status) { sendFrame(wireEvent); return; }
                          if (!admitRow(statusKey,
                            undefined,
                            JSON.stringify(status))) return;
                          sendFrame({ type: 'corner-status', roomId, ...status });
                        })
                        .catch(() => {
                          if (client.readyState === client.OPEN) sendFrame(wireEvent);
                        })
                        .finally(() => endRowRead(statusKey));
                    }
                    if (client.readyState === client.OPEN)
                      sendFrame({ ...wireEvent,
                        ...(ctx.options.livePaintDiagnostics && eventTrace ? { trace: eventTrace } : {}) });
                    return;
                  }
                  const trace = ctx.options.livePaintDiagnostics ? eventTrace : undefined;
                  const wireTrace =
                    trace && ctx.options.livePaintDiagnostics && typeof trace.startedAt !== 'number'
                      ? ({ ...trace, paintAck: 'database-clock' as const } satisfies LiveTrace)
                      : trace;
                  const fallback = {
                    ...wireEvent,
                    ...(wireTrace ? { trace: wireTrace } : {}),
                    reason: `delta-fallback:${event.reason}`,
                  };
                  // Cross-process notifications carry only the committed row
                  // identity. Resolve every row independently: the result stays
                  // on the direct socket-delta path even when the app pool takes
                  // longer than an arbitrary UI deadline, and one slow/bad read
                  // cannot hold later committed messages behind it. The client
                  // reconciler restores causal order from createdAt/id.
                  // An internal row must agree with the Room-scoped bus key. A
                  // mismatch is neither serialized nor retried against attacker-
                  // controlled ids; the canonical PostgreSQL hint remains the
                  // independent recovery path for the real Room.
                  if (committedRow?.type === 'message' && committedRow.row.room_id !== roomId) return;
                  const rowKey = target.type === 'message'
                    ? `${roomId}:message:${target.messageId}`
                    : `${roomId}:turn:${target.agentId}:${target.requestId}`;
                  beginRowRead(rowKey);
                  const pendingDelta = (async () => committedRow?.type === 'message'
                    ? ctx.options.phone.projectCommittedLiveDelta(
                      roomId, committedRow, principal.identityId)
                    : ctx.readLiveRowForViewer(event, roomId, principal.identityId, target))().then(
                    (delta) => ({ delta }) as const,
                    (error: unknown) => ({ error }) as const,
                  );
                  return pendingDelta
                    .then(async (result) => {
                      if (client.readyState !== client.OPEN) return;
                      if ('error' in result) throw result.error;
                      if (!result.delta) {
                        sendFrame(fallback);
                        return;
                      }
                      let workflowRuns;
                      if (result.delta.type === 'message-delta' &&
                          result.delta.message.systemEvent?.kind === 'workflow-handoff' &&
                          typeof ctx.options.phone.liveWorkflowRuns === 'function') {
                        try {
                          workflowRuns = (await ctx.options.phone.liveWorkflowRuns(
                            roomId, principal.identityId)).workflows;
                        } catch {
                          // A workflow read failure leaves the ordinary HTTP
                          // resource path as the covering read.
                        }
                      }
                      let starPrompt;
                      if (result.delta.type === 'message-delta' &&
                          typeof ctx.options.phone.liveStarPrompt === 'function') {
                        const message = result.delta.message;
                        if (message.author.kind === 'agent' && message.presentation === 'message') {
                          try { starPrompt = await ctx.options.phone.liveStarPrompt(principal.identityId); }
                          catch { /* Keep the committed message available when optional eligibility fails. */ }
                        }
                      }
                      const publicDelta = { ...result.delta,
                        ...(workflowRuns ? { workflowRuns } : {}),
                        ...(starPrompt ? { starPrompt: starPrompt.prompt } : {}) };
                      // Never roll a row back after a newer projection.
                      if (!admitRow(rowKey,
                        publicDelta.type === 'message-delta' && publicDelta.version !== undefined
                          ? { version: publicDelta.version } : undefined,
                        createHash('sha256').update(JSON.stringify(publicDelta)).digest('hex')))
                        return;
                      rememberPaintTrace(wireTrace, target.type);
                      const sidebarOnly = previewRooms.has(roomId) && !viewedRooms.has(roomId);
                      // Voice cards change a separate list mark; retain its covering read.
                      let wireDelta: object = publicDelta;
                      if (sidebarOnly && publicDelta.type === 'message-delta' &&
                          !offscreenMessageFits(publicDelta)) {
                        const preview = publicDelta.message.voiceCall ? null
                          : projectSidebarPreview(publicDelta, principal.identityId);
                        wireDelta = preview && readSidebarPreview(preview) ? preview : wireEvent;
                      }
                      sendFrame({ ...wireDelta,
                        ...(wireTrace ? { trace: wireTrace } : {}) });
                      if (result.delta.type === 'message-delta') {
                        const message = result.delta.message;
                        if (message.author.pubkey === principal.identityId ||
                            message.presentation === 'card' || message.presentation === 'system' ||
                            (message.mentionPubkeys?.includes(principal.identityId) &&
                              isNeedsYouAsk(message.text))) sendNeedsYouDelta(event, roomId);
                      }
                    })
                    .catch((error) => {
                      console.error(
                        '[live] committed row delivery failed',
                        error instanceof Error ? error.message : String(error),
                      );
                      if (client.readyState === client.OPEN) {
                        rememberPaintTrace(wireTrace, target.type);
                        sendFrame(fallback);
                      }
                    })
                    .finally(() => endRowRead(rowKey));
              };
              releases.set(roomId, ctx.options.live.subscribe(roomId, forwardEvent));
              sendLive(JSON.stringify({ type: 'subscribed', roomId }));
              // A live lane carries only what is written after this point, so a
              // reader who joins a turn already in progress has missed the draft
              // it is writing. Hand over the running one now; every later delta
              // arrives through the subscription above and replaces it. A read
              // that fails leaves the lane exactly as it was before.
              const snapshot = await ctx.options.phone
                .liveDraftSnapshot(roomId)
                .catch(() => [] as LiveEvent[]);
              for (const event of snapshot) {
                if (event.type === 'draft' && streamed.has(event.agentId)) continue;
                if (client.readyState === client.OPEN &&
                    (event.type === 'draft' || event.type === 'thought')) {
                  if(helperOverlayEnabled() && event.overlayV1)continue;
                  sendDraft(event);
                }
              }
              for (const event of ctx.options.live.presenceSnapshot(roomId)) {
                if (client.readyState === client.OPEN) sendLive(JSON.stringify(event));
              }
            }
          }
          if (
            item.type === 'viewing' &&
            typeof item.roomId === 'string' &&
            ROOM_ID_PATTERN.test(item.roomId) &&
            typeof item.viewing === 'boolean'
          ) {
            if(helperOverlayEnabled()){
              if(item.viewing && !viewedRooms.has(item.roomId))overlayViewer.enter(item.roomId);
              else if(!item.viewing)overlayViewer.leave(item.roomId);
            }
            if (item.viewing) viewedRooms.add(item.roomId);
            else viewedRooms.delete(item.roomId);
            if (!phoneViewClosed){
              try {
                const revision=await ctx.phoneViewing.view(viewingSession, principal.identityId, item.roomId, item.viewing);
                if(helperOverlayEnabled() && item.viewing) {
                  if(revision!==undefined)overlayViewer.commit(item.roomId,revision);
                  else { overlayViewer.leave(item.roomId); viewedRooms.delete(item.roomId); }
                }
              } catch(error) {
                if(helperOverlayEnabled() && item.viewing) { overlayViewer.leave(item.roomId); viewedRooms.delete(item.roomId); }
                throw error;
              }
            }
            return;
          }
          if (item.type === 'unsubscribe' && typeof item.roomId === 'string') {
            if(helperOverlayEnabled()){
              overlayViewer.leave(item.roomId);
              if(viewedRooms.delete(item.roomId) && !phoneViewClosed)await ctx.phoneViewing.view(viewingSession,principal.identityId,item.roomId,false);
            }
            releases.get(item.roomId)?.();
            releases.delete(item.roomId);
            previewRooms.delete(item.roomId);
            sentRows.delete(`${item.roomId}:corner-status`);
          }
        };
        socketTaskTail = socketTaskTail
          .then(async () => {
            if (client.readyState !== client.OPEN) return;
            const releaseDbTask = await ctx.acquireLiveDbTask();
            try {
              if (client.readyState === client.OPEN) await processMessage();
            } finally {
              releaseDbTask();
            }
          })
          .catch((error) => {
            const retryable = isRetryableLiveError(error);
            const code =
              error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
            const kind = retryable ? 'database' : code === '22P02' ? 'invalid' : 'internal';
            ctx.liveErrors[kind]++;
            console.error('[live] message failed', { kind, error });
            if (client.readyState === client.OPEN) {
              const failed = JSON.parse(raw.toString()) as { id?: string; roomId?: string; roomIds?: string[] };
              const roomIds = failed.roomIds ?? (failed.roomId ? [failed.roomId] : []);
              for (const roomId of roomIds) sendLive(JSON.stringify({ type: 'reload', roomId }));
              if (!roomIds.length) sendLive(JSON.stringify(failed.id
                ? { t: 'res', id: failed.id, ok: false, error: { code: 'unavailable', message: 'This request failed', retryable } }
                : { type: 'invalidate', roomId: '', reason: 'reconnect' }));
            }
          });
      });
      const releasePhoneView = () => {
        if (phoneViewClosed) return;
        phoneViewClosed = true;
        overlayViewer.clear();
        void ctx.phoneViewing.end(viewingSession).catch((error) =>
          console.error('[live] viewing release failed', error),
        );
      };
      client.on('error', releasePhoneView);
      client.on('close', () => {
        ctx.socketSubscriptions.delete(client);
        ctx.options.live.humanDisconnected(principal.identityId);
        releasePhoneView();
        releaseWorkspaces();
        releasePersonalResync();
        pendingPaintTraces.clear();
        for (const release of releases.values()) release();
        releases.clear();
        sentRows.clear();
      });
    }
