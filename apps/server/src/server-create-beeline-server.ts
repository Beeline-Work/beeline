import { handleLiveConnection } from './server-live-connection.js';
import { PHONE_READ_OPERATIONS } from '@beeline/api-contract/phone';
import { createPhoneOperationDispatcher, PhoneOperationError } from './phone-operations.js';
import { VaultSaveRelay } from './vault-save-relay.js';
import { vaultSaveHttp } from './vault-save-http.js';
import { runnableOrigin, serveRunnableArtifact } from './runnable-artifact.js';
import { captureServerError } from './sentry.js';
import { GitHubHttpError } from '@beeline/auth/github';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter } from './computer-session.js';
import type { Duplex } from 'node:stream';
import { acceptedJsonEncoding } from './json-response.js';
import { PhoneViewing } from './phone-viewing.js';
import { bearer, type TokenAuth } from './auth.js';
import { type PhoneService } from './phone-service.js';
import { type MessageBookmarkView, type RoomLiveDelta } from '@beeline/api-contract/phone';
import type { LiveEvent } from './live.js';
import { InvitePreviewAccess } from './invite-preview.js';
import { recordOperatorFunctionEvent } from './operator-dashboard.js';
import { HelperVersionGate, helperVersionBelowMinimum } from './helper-version-gate.js';
import { DaemonConnectionRegistry, type DaemonLiveDependencies } from './daemon-live.js';
import { ServerOptions, maxLiveDbTasks, MAX_LIVE_WAITING_TASKS, exactPath, roomRequestStartedAt, jsonEncodings, json, isWebAppCorsPath, applyWebAppCors, tokenFromProtocol, isMachineSocket, clientKey, MAX_MACHINE_SOCKETS_PER_CLIENT } from './server.js';
import { requestErrorStatus } from './server-request-error-status.js';
import { route } from './server-route.js';



export function createBeelineServer(options: ServerOptions): Server {
  const gameOrigin = runnableOrigin();
  // LiveHub invokes every socket listener synchronously with the same event.
  // Gather those viewers before the microtask starts one authorized row read.
  // Weak keys release the batch when the notification leaves the bus.
  const liveRowBatches = new WeakMap<LiveEvent, {
    viewers: Set<string>;
    result: Promise<ReadonlyMap<string, RoomLiveDelta>>;
  }>();
  const bookmarkReads = new WeakMap<LiveEvent, Promise<MessageBookmarkView | null>>();
  // Share one projection read across sockets for each change.
  const workspaceChangeReads = new WeakMap<LiveEvent,
    ReturnType<PhoneService['liveWorkspaceChange']>>();
  const personChangeReads = new WeakMap<LiveEvent,
    ReturnType<PhoneService['livePersonChange']>>();
  const readChange = <T>(cache: WeakMap<LiveEvent, Promise<T>>, event: LiveEvent,
    load: () => Promise<T>): Promise<T> => {
    let read = cache.get(event);
    if (!read) {
      read = withLiveDbTask(load);
      cache.set(event, read);
    }
    return read;
  };
  const readWorkspaceChange = (event: LiveEvent, id: string) =>
    readChange(workspaceChangeReads, event, () => options.phone.liveWorkspaceChange(id));
  const readPersonChange = (event: LiveEvent, id: string) =>
    readChange(personChangeReads, event, () => options.phone.livePersonChange(id));
  const cornerStatusReads = new WeakMap<LiveEvent, Map<string,
    ReturnType<PhoneService['liveChatCornerStatus']>>>();
  const readCornerStatusForViewer = (event: LiveEvent, roomId: string, viewerId: string) => {
    let viewers = cornerStatusReads.get(event);
    if (!viewers) {
      viewers = new Map();
      cornerStatusReads.set(event, viewers);
    }
    let read = viewers.get(viewerId);
    if (!read) {
      read = withLiveDbTask(() => options.phone.liveChatCornerStatus(roomId, viewerId))
        .finally(() => {
          viewers!.delete(viewerId);
          if (!viewers!.size) cornerStatusReads.delete(event);
        });
      viewers.set(viewerId, read);
    }
    return read;
  };
  const needsYouReads = new WeakMap<LiveEvent, Map<string,
    ReturnType<PhoneService['liveNeedsYou']>>>();
  const readNeedsYouForViewer = (event: LiveEvent, roomId: string, viewerId: string) => {
    let viewers = needsYouReads.get(event);
    if (!viewers) {
      viewers = new Map();
      needsYouReads.set(event, viewers);
    }
    let read = viewers.get(viewerId);
    if (!read) {
      read = withLiveDbTask(() => options.phone.liveNeedsYou(roomId, viewerId))
        .finally(() => {
          viewers!.delete(viewerId);
          if (!viewers!.size) needsYouReads.delete(event);
        });
      viewers.set(viewerId, read);
    }
    return read;
  };
  const readLiveRowForViewer = (
    event: LiveEvent,
    roomId: string,
    viewerId: string,
    target: { type: 'message'; messageId: string } |
      { type: 'turn'; agentId: string; requestId: string },
  ): Promise<RoomLiveDelta | null> => {
    let batch = liveRowBatches.get(event);
    if (!batch) {
      const viewers = new Set<string>();
      batch = {
        viewers,
        result: Promise.resolve().then(() => {
          // The synchronous fanout is complete. A later cursor replay of this
          // event must authorize its own viewers against current membership.
          liveRowBatches.delete(event);
          return withLiveDbTask(() => options.phone.readLiveDeltas(
            roomId, [...viewers], target,
          ));
        }),
      };
      liveRowBatches.set(event, batch);
    }
    batch.viewers.add(viewerId);
    return batch.result.then((deltas) => deltas.get(viewerId) ?? null);
  };
  const helperVersionGate =
    options.helperVersionGate ?? new HelperVersionGate(process.env.BEELINE_MIN_HELPER_VERSION);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 0 });
  const liveDbTaskLimit = maxLiveDbTasks(options.databaseBudget?.app);
  let liveDbTasks = 0;
  const liveDbWaiters: Array<() => void> = [];
  const socketCounts = new Map<string, number>();
  /** Admitted daemon sockets per agent on this machine; a newer upgrade retires them. */
  const daemonSockets = new Map<string, Set<{ socket: Duplex; release: () => void }>>();
  const socketSubscriptions = new Map<WebSocket, () => number>();
  const liveErrors = { database: 0, invalid: 0, internal: 0, overload: 0 };
  const liveCounters = {
    helperVersionRefusals: 0,
    helperForceUpdates: 0,
    heartbeatTerminations: 0,
  };
  const machineSocketCounts = new Map<string, number>();
  const liveHealth = () => ({
    sockets: webSockets.clients.size,
    subscriptions: [...socketSubscriptions.values()].reduce((total, count) => total + count(), 0),
    activeDbTasks: liveDbTasks,
    waitingDbTasks: liveDbWaiters.length,
    errors: { ...liveErrors },
    heartbeatTerminations: liveCounters.heartbeatTerminations,
    ...(helperVersionGate.minimum
      ? {
          helperMinimum: {
            minVersion: helperVersionGate.minimum,
            refusals: liveCounters.helperVersionRefusals,
            forceUpdates: liveCounters.helperForceUpdates,
          },
        }
      : {}),
  });
  const releaseLiveDbTask = () => {
    const next = liveDbWaiters.shift();
    if (next) next();
    else liveDbTasks--;
  };
  const acquireLiveDbTask = async (): Promise<() => void> => {
    if (liveDbTasks < liveDbTaskLimit) {
      liveDbTasks++;
      return releaseLiveDbTask;
    }
    if (liveDbWaiters.length >= MAX_LIVE_WAITING_TASKS)
      throw new Error('live admission overloaded');
    await new Promise<void>((resolve) => liveDbWaiters.push(resolve));
    return releaseLiveDbTask;
  };
  const withLiveDbTask = async <T>(work: () => Promise<T>): Promise<T> => {
    const release = await acquireLiveDbTask();
    try { return await work(); }
    finally { release(); }
  };
  const daemonRegistry = new DaemonConnectionRegistry();
  const vaultSaveRelay = new VaultSaveRelay();
  let shuttingDown = false;
  const daemonLive: DaemonLiveDependencies = {
    operationErrorStatus: requestErrorStatus,
    auth: options.auth,
    phone: options.phone,
    daemon: options.daemon,
    live: options.live,
    database: options.database,
    ...(options.connectionPresence ? { connectionPresence: options.connectionPresence } : {}),
    ...(options.releaseNotify ? { releaseNotify: options.releaseNotify } : {}),
    helperVersionGate,
    acquireLiveDbTask,
    errors: liveErrors,
    counters: liveCounters,
    registry: daemonRegistry,
    vaultSaveRelay,
    shuttingDown: () => shuttingDown,
  };
  // Another server instance accepted a newer connection for an agent this
  // instance still serves: drop ours. Own claims arrive here too and change nothing.
  let releaseConnectionEpochs: (() => void) | undefined;
  const watchConnectionEpochs = () => {
    releaseConnectionEpochs ??= options.live.subscribeAll((event) => {
      if (event.type === 'agent-connection')
        daemonRegistry.observeEpoch(event.agentId, event.epoch);
    });
  };
  const invitePreview = new InvitePreviewAccess(options.database);
  const phoneViewing = new PhoneViewing(options.database, options.connectionPresence?.instanceId ?? randomUUID());
  const dispatchPhoneOperation = createPhoneOperationDispatcher(options, requestErrorStatus);
  // Deployment/free-agent proof tools and the corner fixture controller are non-phone HTTP clients.
  // Keep only their named commands; phone actions use the live socket.
  const httpPhoneOperation: PhoneHttpOperation = (name, input, viewerId, familyId) => {
    if (!(PHONE_READ_OPERATIONS as readonly string[]).includes(name) &&
        !(NON_PHONE_HTTP_WRITES as readonly string[]).includes(name))
      throw new PhoneOperationError(404, { error: 'not_found' });
    if ((name === 'readNeedsYou' || name === 'readTray') && input.markSeen !== false)
      throw new PhoneOperationError(409, { error: 'phone_socket_required' });
    return dispatchPhoneOperation(name, input, viewerId, undefined, familyId);
  };
  const server = createServer((request, response) => {
    if (gameOrigin && request.headers.host === new URL(gameOrigin).host) {
      void serveRunnableArtifact(request, response, gameOrigin, options.objectService).catch(() => {
        if (!response.headersSent) response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        response.end('Unavailable');
      });
      return;
    }
    const url = exactPath(request.url);
    const method = request.method ?? 'GET';
    if (method === 'GET' && /^\/v1\/phone\/rooms\/[^/]+$/.test(url.pathname))
      roomRequestStartedAt.set(response, performance.now());
    const encoding = acceptedJsonEncoding(request.headers['accept-encoding']);
    if (encoding) jsonEncodings.set(response, encoding);
    const observedFunction =
      method === 'POST' &&
      (url.pathname === '/v1/phone/media' || url.pathname === '/v1/daemon/uploads')
        ? 'attachment_upload'
        : method === 'POST' && url.pathname === '/v1/daemon/operations/createCorner'
          ? 'corner_open' : null;
    if (observedFunction) {
      const started = performance.now();
      response.once('finish', () => {
        // The observation is after the response. It cannot delay the write or
        // paint that it describes, and it carries no user or message content.
        if (response.statusCode === 401 || response.statusCode === 403) return;
        const duration = Math.min(600_000, Math.round(performance.now() - started));
        void recordOperatorFunctionEvent(
          options.database,
          observedFunction,
          duration,
          response.statusCode >= 400,
        ).catch(() => undefined);
      });
    }
    console.log('[req]', method, url.pathname);
    const minimum = helperVersionGate.minimum;
    const reportedVersion = request.headers['x-beeline-helper-version'];
    if (
      minimum &&
      method === 'POST' &&
      url.pathname.startsWith('/v1/daemon/') &&
      helperVersionBelowMinimum(
        typeof reportedVersion === 'string' ? reportedVersion : undefined,
        minimum,
      )
    ) {
      liveCounters.helperVersionRefusals++;
      json(response, 426, { error: 'update_required', minVersion: minimum });
      return;
    }
    if (url.pathname !== '/v1/site/download-tap' && isWebAppCorsPath(url.pathname) && applyWebAppCors(request, response, options)) return;
    if (url.pathname === '/v1/vault-save/submit' || url.pathname === '/v1/vault-save/answer') {
      void vaultSaveHttp(request, response, options, vaultSaveRelay);
      return;
    }
    void route(
      request,
      response,
      options,
      invitePreview,
      liveHealth,
      helperVersionGate,
      httpPhoneOperation,
    ).catch((error) => {
      const message = error instanceof Error ? error.message : 'request failed';
      const status = requestErrorStatus(error);
      if (error instanceof GitHubHttpError && error.rateLimited && error.retryAfter)
        response.setHeader('retry-after', error.retryAfter);
      // A failing Telegram delivery must not create another alert to itself.
      if (status >= 500 && !['/api/webhooks/sentry', '/v1/sentry/webhook'].includes(url.pathname)) captureServerError(error);
      console.error(
        '[req-error]',
        method,
        url.pathname,
        `status=${status}`,
        error instanceof Error ? error.stack || error.message : String(error),
      );
      json(response, status, error instanceof PhoneOperationError ? error.payload : { error: message });
    });
  });
  // HTTP `close` waits for upgraded sockets. Terminate them before starting
  // that wait, otherwise an idle daemon subscription can hold shutdown open.
  const closeHttp = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    // Connections stay held across a restart: helpers reconnect to a running
    // instance, and this instance's lease releases whatever never returns.
    shuttingDown = true;
    releaseConnectionEpochs?.();
    for (const client of webSockets.clients) client.terminate();
    webSockets.close();
    return closeHttp((error) => {
      void phoneViewing.endAll().then(
        () => callback?.(error),
        (releaseError: unknown) => {
          console.error('[live] viewing shutdown release failed', releaseError);
          callback?.(error ?? (releaseError instanceof Error ? releaseError : new Error(String(releaseError))));
        },
      );
    });
  }) as Server['close'];
  server.on('upgrade', (request, socket, head) => {
    if (gameOrigin && request.headers.host === new URL(gameOrigin).host) {
      socket.destroy();
      return;
    }
    void (async () => {
      const url = exactPath(request.url);
      const computer = /^\/s\/([A-Za-z0-9_-]{43})\/(?:ws|stream)$/.exec(url.pathname);
      if (computer) {
        await upgradeComputerSession(request, socket, head, options.database, options.live, computer[1]!);
        return;
      }
      const computerSource = /^\/s\/([A-Za-z0-9_-]{43})\/source$/.exec(url.pathname);
      if (computerSource) {
        const token = bearer(request.headers.authorization);
        const agentId = token ? await options.auth.authenticateDaemon(token) : null;
        if (!agentId) { socket.destroy(); return; }
        await upgradeBodyComputerSource(request, socket, head, options.database, options.live, computerSource[1]!, agentId);
        return;
      }
      const computerWait = /^\/s\/([A-Za-z0-9_-]{43})\/wait$/.exec(url.pathname);
      if (computerWait) {
        const token = bearer(request.headers.authorization);
        const agentId = token ? await options.auth.authenticateDaemon(token) : null;
        if (!agentId) { socket.destroy(); return; }
        const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
        await upgradeComputerWaiter(request, socket, head, options.database, computerWait[1]!, agentId, since);
        return;
      }
      if (url.pathname !== '/v1/phone/live') {
        socket.destroy();
        return;
      }
      const raw = tokenFromProtocol(request);
      const helperVersion = url.searchParams.get('helperVersion') ?? undefined;
      const helperSourceSha = url.searchParams.get('sourceSha') ?? undefined;
      const minimum = helperVersionGate.minimum;
      const machine = isMachineSocket(request);
      if (
        (machine || raw?.startsWith('bdt_')) &&
        minimum &&
        helperVersionBelowMinimum(helperVersion, minimum)
      ) {
        liveCounters.helperVersionRefusals++;
        const payload = JSON.stringify({ error: 'update_required', minVersion: minimum });
        socket.write(
          `HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
        );
        socket.destroy();
        return;
      }
      if (machine) {
        // Identity arrives per agent after the upgrade; bound the anonymous
        // sockets one client address can hold open meanwhile.
        const key = clientKey(request);
        const open = machineSocketCounts.get(key) ?? 0;
        if (open >= MAX_MACHINE_SOCKETS_PER_CLIENT) {
          liveErrors.overload++;
          socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
          socket.destroy();
          return;
        }
        machineSocketCounts.set(key, open + 1);
        socket.once('close', () => {
          const remaining = (machineSocketCounts.get(key) ?? 1) - 1;
          if (remaining <= 0) machineSocketCounts.delete(key);
          else machineSocketCounts.set(key, remaining);
        });
        webSockets.handleUpgrade(request, socket, head, (client) =>
          webSockets.emit('connection', client, request, {
            identityId: '',
            kind: 'machine',
            helperVersion,
            helperSourceSha,
          }),
        );
        return;
      }
      // Daemon tokens have a distinct prefix. Avoid making every phone socket
      // pay for a failed daemon-auth query before its ordinary session lookup.
      const daemonId = raw?.startsWith('bdt_') ? await options.auth.authenticateDaemon(raw) : null;
      const phoneSession =
        !daemonId && raw && !raw.startsWith('bdt_') ? await readPhoneSession(options.auth, raw) : null;
      const phoneId = phoneSession?.identityId ?? null;
      const identityId = daemonId ?? phoneId;
      if (!identityId) {
        const payload = JSON.stringify({ error: 'phone_token_required' });
        socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
        socket.destroy();
        return;
      }
      // Newest socket wins. A helper holds one live socket, so an older one
      // for the same agent belongs to a dead process or a dead network path.
      // Its count is released now, not on its eventual close, so zombies can
      // never hold the cap against the helper that replaced them.
      if (daemonId) {
        for (const older of [...(daemonSockets.get(daemonId) ?? [])]) {
          older.release();
          older.socket.destroy();
        }
      }
      const openSockets = socketCounts.get(identityId) ?? 0;
      if (openSockets >= (daemonId ? 4 : 8)) {
        liveErrors.overload++;
        socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
        socket.destroy();
        return;
      }
      socketCounts.set(identityId, openSockets + 1);
      let released = false;
      const admitted = {
        socket,
        release: () => {
          if (released) return;
          released = true;
          const remaining = socketCounts.get(identityId) ?? 1;
          if (remaining <= 1) socketCounts.delete(identityId);
          else socketCounts.set(identityId, remaining - 1);
          const agentSockets = daemonSockets.get(identityId);
          agentSockets?.delete(admitted);
          if (agentSockets?.size === 0) daemonSockets.delete(identityId);
        },
      };
      if (daemonId) {
        const agentSockets = daemonSockets.get(daemonId) ?? new Set();
        agentSockets.add(admitted);
        daemonSockets.set(daemonId, agentSockets);
      }
      socket.once('close', admitted.release);
      webSockets.handleUpgrade(request, socket, head, (client) =>
        webSockets.emit('connection', client, request, {
          identityId,
          kind: daemonId ? 'daemon' : 'phone',
          helperVersion,
          helperSourceSha,
          ...(phoneSession?.familyId ? { familyId: phoneSession.familyId } : {}),
        }),
      );
    })().catch(() => socket.destroy());
  });
  webSockets.on(
    'connection',
    (
      client: WebSocket,
      _request: IncomingMessage,
      principal: {
        identityId: string;
        kind: 'phone' | 'daemon' | 'machine';
        helperVersion?: string;
        helperSourceSha?: string;
        familyId?: string;
      },
    ) => {
return handleLiveConnection({ liveErrors, watchConnectionEpochs, socketSubscriptions, daemonLive, options, readNeedsYouForViewer, readLiveRowForViewer, readWorkspaceChange, readPersonChange, bookmarkReads, withLiveDbTask, dispatchPhoneOperation, readCornerStatusForViewer, phoneViewing, acquireLiveDbTask }, client, _request, principal);
},
  );
  server.once('listening', () => { void options.daemon.warmConnectorIndex?.(); });
  return server;
}


export const phoneFamilies = new WeakMap<IncomingMessage, string>();


/** Identity plus the sign-in family, when this auth implementation can name one. */
export async function readPhoneSession(
  auth: {
    authenticatePhone(token: string): Promise<string | null>;
    authenticatePhoneSession?(token: string): Promise<{ identityId: string; familyId: string } | null>;
  },
  token: string,
): Promise<{ identityId: string; familyId: string | null } | null> {
  if (typeof auth.authenticatePhoneSession === 'function') {
    const session = await auth.authenticatePhoneSession(token);
    return session ? { identityId: session.identityId, familyId: session.familyId } : null;
  }
  const identityId = await auth.authenticatePhone(token);
  return identityId ? { identityId, familyId: null } : null;
}


export async function phoneIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  // Family is recorded beside the identity lookup. The identity return stays the
  // access-token query System messages already follow.
  if (value) await rememberPhoneFamily(request, options.auth, value);
  return value ? options.auth.authenticatePhone(value) : null;
}


export async function rememberPhoneFamily(
  request: IncomingMessage,
  auth: TokenAuth,
  token: string,
): Promise<void> {
  if (typeof auth.authenticatePhoneSession !== 'function') return;
  const session = await auth.authenticatePhoneSession(token);
  if (session?.familyId) phoneFamilies.set(request, session.familyId);
}


export async function daemonIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  return value ? options.auth.authenticateDaemon(value) : null;
}

/**
 * Why a daemon request was refused, in the only two shapes a helper may act
 * on. `agent_removed` is a settled fact — the token is revoked and its agent
 * holds no membership anywhere — and is what lets the helper stop itself.
 * Everything else stays the ordinary 401 it retries against.
 */
export async function refuseDaemon(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const value = bearer(request.headers.authorization);
  const retired = value ? await options.auth.retiredDaemonAgent(value) : null;
  if (retired) json(response, 403, { error: 'agent_removed' });
  else json(response, 401, { error: 'daemon_token_required' });
}


// Non-phone consumers: apps/server/scripts/verify-fly-cutover.mjs, infra/free-agent/*.mjs,
// and apps/mobile/evidence/corner-list-live/proof-kit/control.mts. Keep this closed list.
export const NON_PHONE_HTTP_WRITES = ['createWorkspace', 'deleteWorkspace', 'sendRoomMessage', 'requestCornerClose'] as const;

export type PhoneHttpOperation = (name: (typeof PHONE_READ_OPERATIONS)[number] | (typeof NON_PHONE_HTTP_WRITES)[number], input: Record<string, unknown>,
  viewerId: string, familyId?: string) => Promise<unknown>;
