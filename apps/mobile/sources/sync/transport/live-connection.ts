import {
  parseRouterCommandIdentity,
  type RouterCommandIdentity,
  type RouterCommandReceipt,
} from '@beeline/api-contract/router-command';
import {
  PHONE_READ_OPERATIONS,
  readSidebarPreview,
  type PhoneOperationMap,
} from '@beeline/api-contract/phone';
import {
  MonolithRequestTimeoutError,
  MonolithSessionChangedError,
  monolithSession,
} from '@/auth/monolith-session';
import { PhoneSocketError, PhoneSocketDisconnectedError } from './phone-socket-error';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { NostrEvent } from '@beeline/nostr';
import type { LiveWireEvent, MonolithSurfaceEvent } from './monolith-rig-transport';
import {
  acceptCornerStatusFrame,
  noteCornerLaneReleased,
  noteCornerLaneSubscribed,
  noteCornerSocketDropped,
  noteRoomCornersChanged,
} from '@/buzz/room-corner-store';
import { subscribeClientReset } from '@/sync/client-reset';
import { setRequestDeadlineHandler } from './request-deadline';

type MissedUpdates = { type: 'missed-updates'; roomIds: string[]; streams: string[]; workspace: boolean };
type SurfaceFilters = readonly {
  readonly '#h'?: readonly string[];
  readonly '#d'?: readonly string[];
}[];
type SurfaceListener = (event: NostrEvent | MonolithSurfaceEvent) => void;
type Registration = { roomIds: ReadonlySet<string>; listener: SurfaceListener; closed: boolean };
type RequestOptions = { timeoutMs?: number; signal?: AbortSignal };
type PendingRequest = {
  frame: string;
  read: boolean;
  socket?: WebSocket;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};
type Dependencies = {
  authorization(): Promise<string>;
  invalidateAuthorization?(token: string): void;
  liveUrl(): string;
  subscribeIdentityChange(listener: () => void): () => void;
};
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
let connectionState: ConnectionState = 'disconnected';
const stateListeners = new Set<() => void>();
function setConnectionState(next: ConnectionState): void {
  if (connectionState === next) return;
  connectionState = next;
  for (const listener of stateListeners) listener();
}
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    () => connectionState,
    () => 'disconnected',
  );
}
const roomIdsFromFilters = (filters: SurfaceFilters) =>
  new Set(
    filters
      .flatMap((filter) => [
        ...(filter['#h'] ?? []),
        ...(filter['#d'] ?? []).map((value) => value.split(':').at(-1) ?? ''),
      ])
      .filter(Boolean),
  );
const isOpen = (socket: WebSocket | undefined): socket is WebSocket & { readyState: 1 } => socket?.readyState === 1;

/** The only phone socket. Screens call request; push listeners call their same read. */
export class LiveConnection {
  private socket?: WebSocket;
  // One owner-held connection promise prevents parallel screens opening two sockets.
  private connecting?: { promise: Promise<void>; reject(reason: unknown): void };
  private readonly requests = new Map<string, PendingRequest>();
  private readonly registrations = new Set<Registration>();
  private readonly roomReferences = new Map<string, number>();
  private readonly viewing = new Map<string, number>();
  private readonly connected = new Set<() => void>();
  private readonly disconnected = new Set<() => void>();
  private readonly commandListeners = new Set<() => void>();
  private readonly paintOwners = new Map<string, Registration>();
  private requestId = 0;
  private socketEpoch = 0;
  // Identity protects against old authorization completing after sign-out.
  private identity = 0;
  // An old screen's release must not hide a new identity's view of the same Room.
  private viewEpoch = 0;
  private disposed = false;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private pongDeadline?: ReturnType<typeof setTimeout>;
  private readonly stopAppState: () => void;
  private readonly stopIdentity: () => void;

  constructor(private readonly deps: Dependencies) {
    setRequestDeadlineHandler(() => this.reportRequestDeadlineMissed());
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        this.checkHealth();
        this.refreshRoom();
      } else this.clearHeartbeat();
    });
    this.stopAppState = () => subscription.remove();
    this.stopIdentity = deps.subscribeIdentityChange(() => {
      this.identity++;
      this.viewEpoch++;
      this.viewing.clear();
      this.dropConnection();
      this.refreshRoom();
    });
  }

  register(filters: SurfaceFilters, listener: SurfaceListener): Promise<() => void> {
    const registration: Registration = {
      roomIds: roomIdsFromFilters(filters),
      listener,
      closed: false,
    };
    this.registrations.add(registration);
    for (const roomId of registration.roomIds)
      this.roomReferences.set(roomId, (this.roomReferences.get(roomId) ?? 0) + 1);
    // A joining screen asks the server for current pushed state, never a local stream cache.
    if (isOpen(this.socket)) this.sendSubscribe([...registration.roomIds]);
    else void this.ensureSocket().catch(() => undefined);
    return Promise.resolve(() => {
      if (registration.closed) return;
      registration.closed = true;
      this.registrations.delete(registration);
      for (const roomId of registration.roomIds) {
        const remaining = (this.roomReferences.get(roomId) ?? 1) - 1;
        if (remaining > 0) this.roomReferences.set(roomId, remaining);
        else {
          this.roomReferences.delete(roomId);
          noteCornerLaneReleased(roomId);
          if (isOpen(this.socket))
            this.socket.send(JSON.stringify({ type: 'unsubscribe', roomId }));
        }
      }
    });
  }

  async request<Name extends keyof PhoneOperationMap>(
    operation: Name,
    args: PhoneOperationMap[Name]['input'],
    options: RequestOptions = {},
  ): Promise<PhoneOperationMap[Name]['output']> {
    const identity = this.identity;
    const read = (PHONE_READ_OPERATIONS as readonly string[]).includes(operation);
    for (let attempt = 0; ; attempt++) {
      if (identity !== this.identity) throw new MonolithSessionChangedError();
      try {
        return (await this.sendRequest(
          operation,
          args,
          options,
        )) as PhoneOperationMap[Name]['output'];
      } catch (error) {
        if (!read || attempt === 2 || options.signal?.aborted || identity !== this.identity)
          throw error;
      }
    }
  }

  commandState(): { generation: number; commandDedupV1: boolean; ready: boolean } {
    const ready = isOpen(this.socket);
    return { generation: this.socketEpoch, commandDedupV1: ready, ready };
  }
  subscribeCommandCapabilities(listener: () => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
  requestCommand(
    operation: string,
    args: unknown,
    command: RouterCommandIdentity,
    options: RequestOptions = {},
  ): Promise<RouterCommandReceipt> {
    if (!isOpen(this.socket))
      return Promise.reject(
        new PhoneSocketError(
          'command_unavailable',
          'Durable commands are unavailable on this connection',
          false,
        ),
      );
    let identity: RouterCommandIdentity;
    try {
      identity = parseRouterCommandIdentity(command);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.sendRequest(operation, args, options, identity) as Promise<RouterCommandReceipt>;
  }

  private sendRequest(
    operation: string,
    args: unknown,
    options: RequestOptions,
    command?: RouterCommandIdentity,
  ): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(this.abortError());
    const id = String(++this.requestId);
    const read = (PHONE_READ_OPERATIONS as readonly string[]).includes(operation);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', abort);
        this.requests.delete(id);
      };
      const request: PendingRequest = {
        frame: JSON.stringify({
          t: 'req',
          id,
          op: operation,
          args,
          ...(command ? { command } : {}),
        }),
        read,
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          if (
            read &&
            !(error instanceof Error && error.name === 'AbortError') &&
            (request.socket
              ? this.socket === request.socket
              : !this.socket && this.connecting !== undefined)
          )
            this.dropConnection();
          reject(error);
        },
      };
      const abort = () => request.reject(this.abortError());
      const deadline = setTimeout(() => {
        if (read) request.reject(new MonolithRequestTimeoutError());
        else this.checkHealth();
      }, options.timeoutMs ?? 20_000);
      this.requests.set(id, request);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (isOpen(this.socket)) this.sendPending(this.socket);
      else void this.ensureSocket().catch((error) => request.reject(error));
    });
  }
  private abortError(): Error {
    const error = new Error('The request was aborted.');
    error.name = 'AbortError';
    return error;
  }
  private sendPending(socket: WebSocket): void {
    for (const request of this.requests.values()) {
      if (request.socket) continue;
      request.socket = socket;
      try {
        socket.send(request.frame);
      } catch {
        this.socketFailed(socket);
        return;
      }
    }
  }

  private ensureSocket(): Promise<void> {
    if (isOpen(this.socket)) return Promise.resolve();
    if (this.connecting) return this.connecting.promise;
    if (this.disposed) return Promise.reject(new PhoneSocketDisconnectedError());
    const identity = this.identity;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const connection = { promise, reject };
    this.connecting = connection;
    setConnectionState('connecting');
    void this.deps
      .authorization()
      .then((token) => {
        if (this.connecting !== connection || identity !== this.identity) return;
        const socket = new WebSocket(this.deps.liveUrl(), [`bearer.${token}`]);
        this.socket = socket;
        this.socketEpoch++;
        socket.onopen = () => {
          if (this.socket !== socket) return;
          this.connecting = undefined;
          setConnectionState('connected');
          this.sendSubscribe([...this.roomReferences.keys()]);
          for (const roomId of this.viewing.keys()) this.sendViewing(roomId, true);
          this.sendPending(socket);
          this.scheduleHeartbeat();
          for (const listener of this.commandListeners) listener();
          for (const listener of this.connected) listener();
          resolve();
        };
        socket.onmessage = (event) => {
          if (this.socket !== socket) return;
          this.scheduleHeartbeat();
          let frame: unknown;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (!frame || typeof frame !== 'object') return;
          const reply = frame as Record<string, unknown>;
          if (reply.t === 'res' && typeof reply.id === 'string') {
            const pending = this.requests.get(reply.id);
            if (!pending || pending.socket !== socket) return;
            if (reply.ok === true) pending.resolve(reply.result);
            else {
              const error = reply.error as { code: string; message: string; retryable: boolean };
              pending.reject(new PhoneSocketError(error.code, error.message, error.retryable));
            }
            return;
          }
          this.dispatch(frame as LiveWireEvent | { type: 'pong' }, socket);
        };
        const failed = () => {
          if (this.socket !== socket) return;
          // A rejected opening invalidates only this access token; the next read
          // attempt obtains the refreshed authorization through the same callback.
          if (socket.readyState !== 1 && this.connecting === connection)
            this.deps.invalidateAuthorization?.(token);
          this.socketFailed(socket);
        };
        socket.onerror = failed;
        socket.onclose = failed;
      })
      .catch((error) => {
        if (this.connecting !== connection) return;
        this.connecting = undefined;
        setConnectionState('disconnected');
        reject(error);
      });
    return promise;
  }

  private socketFailed(socket: WebSocket): void {
    if (this.socket !== socket) return;
    const waitingRead = [...this.requests.values()].some((request) => request.read);
    this.dropConnection();
    // An in-flight read already owns its three attempts. An idle broken socket
    // asks the open screens to invoke that same read, which reconnects as needed.
    if (!waitingRead && AppState.currentState === 'active') this.refreshRoom();
  }
  private dropConnection(): void {
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    const connecting = this.connecting;
    this.connecting = undefined;
    connecting?.reject(new PhoneSocketDisconnectedError());
    socket?.close();
    for (const request of [...this.requests.values()])
      request.reject(new PhoneSocketDisconnectedError());
    this.paintOwners.clear();
    noteCornerSocketDropped();
    setConnectionState('disconnected');
    for (const listener of this.commandListeners) listener();
    for (const listener of this.disconnected) listener();
  }
  reconnectNow(): void {
    if (this.socket && this.socket.readyState > 1) this.dropConnection();
    if (!this.socket) void this.ensureSocket().catch(() => undefined);
  }
  reportRequestDeadlineMissed(): void {
    this.checkHealth();
  }
  private checkHealth(): void {
    if (AppState.currentState !== 'active' || this.pongDeadline) return;
    if (!this.socket) return;
    if (!isOpen(this.socket)) {
      if (this.socket.readyState > 1) this.socketFailed(this.socket);
      return;
    }
    const socket = this.socket;
    this.pongDeadline = setTimeout(() => this.socketFailed(socket), 5_000);
    try {
      socket.send('{"type":"ping"}');
    } catch {
      this.socketFailed(socket);
    }
  }
  private scheduleHeartbeat(): void {
    clearTimeout(this.heartbeat);
    if (AppState.currentState !== 'active') return;
    this.heartbeat = setTimeout(() => this.checkHealth(), 30_000);
  }
  private clearHeartbeat(): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.pongDeadline);
    this.heartbeat = undefined;
    this.pongDeadline = undefined;
  }

  view(roomId: string): () => void {
    const epoch = this.viewEpoch;
    this.viewing.set(roomId, (this.viewing.get(roomId) ?? 0) + 1);
    if (this.viewing.get(roomId) === 1) this.sendViewing(roomId, true);
    let released = false;
    return () => {
      if (released || epoch !== this.viewEpoch) return;
      released = true;
      const remaining = (this.viewing.get(roomId) ?? 1) - 1;
      if (remaining > 0) this.viewing.set(roomId, remaining);
      else {
        this.viewing.delete(roomId);
        this.sendViewing(roomId, false);
      }
    };
  }
  isViewing(roomId: string): boolean {
    return this.viewing.has(roomId);
  }
  private sendViewing(roomId: string, viewing: boolean): void {
    if (isOpen(this.socket)) this.socket.send(JSON.stringify({ type: 'viewing', roomId, viewing }));
  }
  private sendSubscribe(roomIds: readonly string[]): void {
    if (isOpen(this.socket) && roomIds.length)
      this.socket.send(
        JSON.stringify({
          type: 'subscribe',
          roomIds,
          sidebarPreviews: true,
          roomStateProjections: true,
        }),
      );
  }
  subscribeConnected(listener: () => void): () => void {
    this.connected.add(listener);
    return () => this.connected.delete(listener);
  }
  subscribeDisconnected(listener: () => void): () => void {
    this.disconnected.add(listener);
    return () => this.disconnected.delete(listener);
  }
  notePushedMessage(roomId: string): void {
    if (this.roomReferences.has(roomId)) this.refreshRoom(roomId);
  }
  refreshRoom(roomId?: string): void {
    for (const registration of this.registrations) {
      if (registration.closed || (roomId && !registration.roomIds.has(roomId))) continue;
      registration.listener({
        monolithLive: {
          type: 'invalidate',
          roomId: roomId ?? registration.roomIds.values().next().value ?? '',
          reason: roomId ? 'resync' : 'reconnect',
        },
      });
    }
  }

  private dispatch(live: LiveWireEvent | { type: 'pong' } | MissedUpdates, socket: WebSocket): void {
    switch (live.type) {
      case 'pong':
        clearTimeout(this.pongDeadline);
        this.pongDeadline = undefined;
        return;
      case 'sync-ok':
        return;
      case 'missed-updates':
        this.refreshRoom();
        return;
      case 'sidebar-preview':
        if (!readSidebarPreview(live)) {
          this.refreshRoom(live.roomId);
          return;
        }
        break;
      case 'corner-status':
        if (!acceptCornerStatusFrame(live)) return;
        break;
      case 'subscribed':
        noteCornerLaneSubscribed(live.roomId);
        break;
      case 'invalidate':
        if (['corner-status', 'corner', 'resync'].includes(live.reason))
          noteRoomCornersChanged(live.roomId);
        break;
      case 'trace-painted': {
        const owner = this.paintOwners.get(live.id);
        this.paintOwners.delete(live.id);
        if (owner && !owner.closed) owner.listener({ monolithLive: live });
        return;
      }
    }
    if (!('roomId' in live)) return;
    for (const registration of this.registrations) {
      if (
        registration.closed ||
        (live.roomId ? !registration.roomIds.has(live.roomId) : registration.roomIds.size !== 0)
      )
        continue;
      const trace = 'trace' in live ? live.trace : undefined;
      registration.listener({
        monolithLive: live,
        ...(typeof trace?.startedAt === 'number' || trace?.paintAck === 'database-clock'
          ? {
              acknowledgePaint: () => {
                if (registration.closed || this.socket !== socket || !isOpen(socket)) return;
                this.paintOwners.set(trace.id, registration);
                socket.send(JSON.stringify({ type: 'trace-paint', id: trace.id }));
              },
            }
          : {}),
      });
    }
  }
  diagnostics(): { state: number | null; connecting: boolean } {
    return { state: this.socket?.readyState ?? null, connecting: Boolean(this.connecting) };
  }
  dispose(): void {
    this.disposed = true;
    this.identity++;
    this.dropConnection();
    this.stopAppState();
    this.stopIdentity();
    this.registrations.clear();
    this.roomReferences.clear();
    this.viewing.clear();
  }
}
let shared: LiveConnection | undefined;
export function sharedLiveConnection(): LiveConnection {
  shared ??= new LiveConnection({
    authorization: () => monolithSession.authorization(),
    invalidateAuthorization: (token) => monolithSession.invalidateAuthorization(token),
    liveUrl: () => `${getBuzzRuntimeConfig().monolithUrl.replace(/^http/, 'ws')}/v1/phone/live`,
    subscribeIdentityChange: subscribeClientReset,
  });
  return shared;
}
export function reportRequestDeadlineMissed(): void {
  sharedLiveConnection().reportRequestDeadlineMissed();
}
export function reconnectNow(): void {
  sharedLiveConnection().reconnectNow();
}
export function resetSharedLiveConnection(): void {
  shared?.dispose();
  shared = undefined;
}
