import {
  PHONE_READ_OPERATIONS,
  readSidebarPreview,
  type PhoneOperationMap,
} from '@beeline/api-contract/phone';
import {
  MonolithRequestTimeoutError,
  monolithSession,
} from '@/auth/monolith-session';
import { PhoneSocketError, PhoneSocketDisconnectedError } from './phone-socket-error';
import { useSyncExternalStore } from 'react';
import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import type { NostrEvent } from '@beeline/nostr';
import type { LiveWireEvent, MonolithSurfaceEvent } from './monolith-rig-transport';
import { publishPhoneLiveEvent } from './phone-live-events';
import { subscribeClientReset } from '@/sync/client-reset';

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
  reject(reason: unknown, transportFailed?: boolean): void;
};
type Dependencies = {
  authorization(): Promise<string>;
  invalidateAuthorization?(token: string): void;
  liveUrl(): string;
  subscribeIdentityChange(listener: () => void): () => void;
  subscribeNetworkOnline?(listener: () => void): () => void;
};
let connectionFailed = false;
let failureSession = 0;
let outcomeSession = 0;
const stateListeners = new Set<() => void>();
const connectionFailure = () => connectionFailed && outcomeSession === failureSession;
function resetConnectionFailure(): void {
  // A new foreground/account session has no failed request outcome yet.
  failureSession++;
  for (const listener of stateListeners) listener();
}
function setConnectionFailure(failed: boolean): void {
  if (connectionFailure() === failed) return;
  connectionFailed = failed;
  outcomeSession = failureSession;
  for (const listener of stateListeners) listener();
}
export function useConnectionFailure(): boolean {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    connectionFailure,
    () => false,
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

/** The production native/browser host supplies online events without probes. */
export function subscribeNetworkOnline(online: () => void): () => void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.addEventListener('online', online);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', online);
    };
  }
  if (!NativeModules.RNCNetInfo) return () => {};
  // Consume the OS event directly. NetInfo's JS reachability fallback
  // starts HTTP probes and timers, which must not own socket recovery.
  const network = new NativeEventEmitter(NativeModules.RNCNetInfo).addListener(
    'netInfo.networkStatusDidChange',
    (state: { isConnected: boolean; isInternetReachable?: boolean }) => {
      if (state.isConnected && state.isInternetReachable !== false) online();
    },
  );
  return () => network.remove();
}

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
  private readonly paintOwners = new Map<string, Registration>();
  private requestId = 0;
  private socketEpoch = 0;
  private socketGeneration = 0;
  // Identity protects against old authorization completing after sign-out.
  private identity = 0;
  // An old screen's release must not hide a new identity's view of the same Room.
  private viewEpoch = 0;
  private disposed = false;
  private foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  private readonly stopAppState: () => void;
  private readonly stopIdentity: () => void;
  private readonly stopNetwork: () => void;

  constructor(private readonly deps: Dependencies) {
    resetConnectionFailure();
    const subscription = AppState.addEventListener('change', (state) => {
      const foreground = state === 'active';
      if (foreground !== this.foreground) {
        this.foreground = foreground;
        resetConnectionFailure();
      }
      if (foreground) this.refreshRoom();
    });
    this.stopAppState = () => subscription.remove();
    this.stopNetwork = deps.subscribeNetworkOnline?.(() => this.refreshRoom()) ?? (() => {});
    this.stopIdentity = deps.subscribeIdentityChange(() => {
      this.identity++;
      resetConnectionFailure();
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
          publishPhoneLiveEvent({ type: 'room-released', roomId });
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
    const session = failureSession;
    let failed: boolean | undefined;
    try {
      return await this.sendRequest(operation, args, options, (outcome) => {
        failed = outcome;
      }) as PhoneOperationMap[Name]['output'];
    } finally {
      // Only this foreground session's explicit socket outcomes own the banner.
      // Authorization, cancellation and old/background work cannot infer an outage.
      if (failed !== undefined && !this.disposed && this.foreground && identity === this.identity && session === failureSession) {
        const recovered = connectionFailure() && !failed;
        setConnectionFailure(failed);
        if (recovered && isOpen(this.socket)) this.publishConnected();
      }
    }
  }

  // Existing update/artifact observers use this confirmed availability generation.
  commandState(): { generation: number; ready: boolean } {
    const ready = isOpen(this.socket);
    return { generation: this.socketEpoch, ready };
  }

  private sendRequest(
    operation: string,
    args: unknown,
    options: RequestOptions,
    outcome: (failed: boolean) => void,
  ): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(this.abortError());
    // Native close callbacks can arrive late. Settle the old socket's requests
    // before admitting a replacement, so their deadlines cannot undo recovery.
    if (this.socket && this.socket.readyState > 1) this.dropConnection(true);
    const id = String(++this.requestId);
    const read = (PHONE_READ_OPERATIONS as readonly string[]).includes(operation);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', abort);
        this.requests.delete(id);
        return true;
      };
      const request: PendingRequest = {
        frame: JSON.stringify({
          t: 'req',
          id,
          op: operation,
          args,
        }),
        read,
        resolve: (value) => {
          if (!finish()) return;
          outcome(false);
          resolve(value);
        },
        reject: (error, transportFailed = false) => {
          if (!finish()) return;
          if (error instanceof PhoneSocketError) outcome(false);
          else if (transportFailed) outcome(true);
          // A request deadline is not evidence that the shared socket closed.
          // Other requests (including a voice join) still own their answers.
          reject(error);
        },
      };
      const abort = () => request.reject(this.abortError());
      const deadline = setTimeout(() => {
        request.reject(
          Object.assign(new MonolithRequestTimeoutError(), { socketRequest: true }),
          Boolean(request.socket || this.socket),
        );
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
    // A newly mounted screen can discover the same delayed native close.
    if (this.socket && this.socket.readyState > 1) this.dropConnection(true);
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
    void this.deps
      .authorization()
      .then((token) => {
        if (this.connecting !== connection || identity !== this.identity) return;
        const socket = new WebSocket(this.deps.liveUrl(), [`bearer.${token}`]);
        this.socket = socket;
        this.socketGeneration++;
        socket.onopen = () => {
          if (this.socket !== socket) return;
          this.connecting = undefined;
          this.sendSubscribe([...this.roomReferences.keys()]);
          for (const roomId of this.viewing.keys()) this.sendViewing(roomId, true);
          this.sendPending(socket);
          this.publishConnected();
          resolve();
        };
        socket.onmessage = (event) => {
          if (this.socket !== socket) return;
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
              if (error.code === 'unauthorized') this.deps.invalidateAuthorization?.(token);
              pending.reject(new PhoneSocketError(error.code, error.message, error.retryable));
            }
            return;
          }
          this.dispatch(frame as LiveWireEvent | { type: 'pong' }, socket);
        };
        const failed = () => {
          if (this.socket !== socket) return;
          // A network failure says nothing about the credential. Forcing an
          // HTTP renewal here delays the next read after the network returns.
          this.socketFailed(socket);
        };
        socket.onerror = failed;
        socket.onclose = failed;
      })
      .catch((error) => {
        if (this.connecting !== connection) return;
        this.connecting = undefined;
        reject(error);
      });
    return promise;
  }

  private socketFailed(socket: WebSocket): void {
    if (this.socket !== socket) return;
    const waitingRead = [...this.requests.values()].some((request) => request.read);
    this.dropConnection(true);
    // An in-flight read receives the failure. An idle broken socket asks the
    // open screens to read, making the failed request and recovery visible.
    if (!waitingRead && AppState.currentState === 'active') this.refreshRoom();
  }
  private dropConnection(transportFailed = false): void {
    const socket = this.socket;
    this.socket = undefined;
    const connecting = this.connecting;
    this.connecting = undefined;
    connecting?.reject(new PhoneSocketDisconnectedError());
    socket?.close();
    for (const request of [...this.requests.values()])
      request.reject(new PhoneSocketDisconnectedError(), transportFailed);
    this.paintOwners.clear();
    publishPhoneLiveEvent({ type: 'socket-dropped' });
    for (const listener of this.disconnected) listener();
  }
  reconnectNow(): void {
    if (this.socket && this.socket.readyState > 1) this.dropConnection(true);
    if (!this.socket) void this.ensureSocket().catch(() => undefined);
  }

  /** One failed explicit send may replace its socket, then refresh open screens. */
  reconnectAfterFailedSend(generation: number): Promise<void> {
    // Concurrent failures share recovery; an old outcome cannot drop a new socket.
    if (this.disposed) return Promise.resolve();
    if (this.connecting) return this.connecting.promise;
    if (generation !== this.socketGeneration) return Promise.resolve();
    this.dropConnection();
    const opening = this.ensureSocket();
    this.refreshRoom();
    return opening;
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
  private publishConnected(): void {
    this.socketEpoch++;
    for (const listener of this.connected) listener();
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
      case 'trace-painted': {
        const owner = this.paintOwners.get(live.id);
        this.paintOwners.delete(live.id);
        if (owner && !owner.closed) owner.listener({ monolithLive: live });
        return;
      }
    }
    publishPhoneLiveEvent(live);
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
  diagnostics(): { state: number | null; connecting: boolean; generation: number } {
    return { state: this.socket?.readyState ?? null, connecting: Boolean(this.connecting), generation: this.socketGeneration };
  }
  dispose(): void {
    this.disposed = true;
    this.identity++;
    resetConnectionFailure();
    this.dropConnection();
    this.stopAppState();
    this.stopIdentity();
    this.stopNetwork();
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
    subscribeNetworkOnline,
  });
  return shared;
}
export function reconnectNow(): void {
  const connection = sharedLiveConnection();
  connection.reconnectNow();
  void connection.request('readWorkspaces', {}).then(() => connection.refreshRoom()).catch(() => undefined);
}
export function resetSharedLiveConnection(): void {
  shared?.dispose();
  shared = undefined;
}
