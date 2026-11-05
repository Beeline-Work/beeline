import { HelperUsageChannel } from './helper-usage-channel.js';
import { HelperActivationChannel } from './helper-activation-channel.js';
import { HelperOverlayChannel } from './helper-overlay-channel.js';
import { HelperTurnChannel } from './helper-turn-channel.js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { DaemonOperationMap, PostConnectorVaultInput } from '@beeline/api-contract/daemon';
import { helperVersion } from './helper-version.js';
import { unknownServerEventLogger } from './unknown-server-event.js';
import { LIVE_LINK_TIMING, LiveLink, type LiveLinkTiming, type LiveSocketFactory } from './live-link.js';

/** Subprotocol of the one socket a helper machine holds for all of its agents. */
export const MACHINE_SOCKET_PROTOCOL = 'beeline.machine.1';

export interface AgentChannelHandlers {
  /** The registration frame: the agent's own token and presence metadata. */
  registration: () => Record<string, unknown>;
  /** Registered (again): resubscribe and run every open wake. */
  onOpen: () => void;
  /** The registration or the whole socket ended. */
  onClose: () => void;
  onMessage: (event: Record<string, unknown>) => void;
  /** The server refused this agent; `agent_removed` is a settled removal. */
  onRefused?: (code: string) => void;
  onUpdateRequired: (minVersion: string) => void;
  /** Machine-owned metadata uses this registration's existing operation owner. */
  reportVault?: (report: Omit<PostConnectorVaultInput, 'agentId'>) => Promise<unknown>;
}

/**
 * One agent's place on the machine socket. The socket carries every agent on
 * the machine; each one registers with its own daemon token, and the server
 * can drop or refuse one agent without touching the others.
 */
export class AgentChannel {
  readonly turn = new HelperTurnChannel(frame => this.send(frame), () => this.isOpen(),
    () => this.machine.reconnectNow());
  readonly activation=new HelperActivationChannel(frame=>this.send(frame),()=>this.activationScope()!==undefined);
  #activationSource:{connectionId:string;epoch:number}|undefined;
  activationContextSelected=false;
  activationScope():{origin:string;generation:number;source:{connectionId:string;epoch:number}}|undefined{
    return this.#activationSource&&this.isOpen()?{origin:this.machine.origin,generation:this.reconnects,source:this.#activationSource}:undefined;
  }
  readonly usage=new HelperUsageChannel(frame=>this.send(frame),()=>this.usageAccountScope()!==undefined);
  readonly overlay=new HelperOverlayChannel(frame=>this.send(frame),()=>this.isOpen());
  #usageOwnerId:string|undefined;
  #usageSource:{connectionId:string;epoch:number}|undefined;
  /** Selection survives disconnects; writes wait for registration. */
  usageAccountSelected=false;
  usageAccountScope():{origin:string;ownerId:string;generation:number;source:{connectionId:string;epoch:number}}|undefined{
    return this.#usageOwnerId&&this.#usageSource&&this.isOpen()?{origin:this.machine.origin,ownerId:this.#usageOwnerId,generation:this.reconnects,source:this.#usageSource}:undefined;
  }
  /** Sticky selection: a reconnect cannot downgrade an operation to HTTP. */
  #operationsSelected = false;
  #operationsAvailable = false;
  #operationsEnded = false;
  get operationsSelected(): boolean { return this.#operationsSelected; }
  readonly #turnRuntimeId = randomUUID();
  readonly #operationWaiters = new Set<(open: boolean) => void>();
  readonly #operationRequests = new Map<string, {
    resolve: (value: unknown) => void; reject: (error: Error) => void;
    deadline: ReturnType<typeof setTimeout>;
  }>();

  /** Only the daemon operation owner may acquire this transport capability.
   * Unsent work waits for registration; the machine owns reconnect recovery. */
  operationReady(): Promise<void> {
    return new Promise((resolve, reject) => this.#whenOperationsReady(open => {
      if (open) resolve();
      else reject(new Error('Machine operation registration unavailable'));
    }));
  }

  #whenOperationsReady(ready: (open: boolean) => void): void {
    if (this.#operationsEnded || this.#refused) { ready(false); return; }
    if (this.isOpen() && (!this.#operationsSelected || this.#operationsAvailable)) {
      ready(true);
      return;
    }
    const settle = (open: boolean) => {
      this.#operationWaiters.delete(settle);
      ready(open);
    };
    this.#operationWaiters.add(settle);
    this.start();
  }

  /** Correlation only; command/generation authority remains in DaemonService.
   * Dispatch from the registration wake itself so socket loss between the
   * owner's readiness check and this call cannot turn unsent work UNKNOWN. */
  requestOperation<N extends keyof DaemonOperationMap>(operation: N, input: DaemonOperationMap[N]['input']): Promise<DaemonOperationMap[N]['output']> {
    return new Promise((resolve, reject) => this.#whenOperationsReady(open => {
      if (!open) { reject(new Error('Machine operation registration unavailable')); return; }
      const requestId = randomUUID();
      const frame = { type: 'daemon-operation', requestId, operation, input };
      const deadline = setTimeout(() => {
        this.#operationRequests.delete(requestId);
        reject(Object.assign(new Error('Machine operation outcome is UNKNOWN; no HTTP fallback'),
          {status: 408, code: 'deadline_exceeded'}));
      }, 30_000);
      deadline.unref?.();
      this.#operationRequests.set(requestId, { resolve: value => resolve(value as DaemonOperationMap[N]['output']), reject, deadline });
      if (!this.send(frame)) this.#suspendOperations();
    }));
  }

  #suspendOperations(ended = false): void {
    this.#operationsAvailable = false;
    if (ended) {
      this.#operationsEnded = true;
      for (const settle of this.#operationWaiters) settle(false);
    }
    for (const pending of this.#operationRequests.values()) {
      clearTimeout(pending.deadline);
      pending.reject(new Error('Machine operation outcome is UNKNOWN; no HTTP fallback'));
    }
    this.#operationRequests.clear();
  }

  #wanted = false;
  #registered = false;
  /** A register frame is in flight on the current socket. */
  #pending = false;
  #refused = false;
  #registrations = 0;
  #intakeHeartbeat = false;
  /** Current-server correlation is required before accepting initial data. */
  initialSnapshotsV1 = false;
  #initialRecoveryPending = false;
  #intakeDeadline: ReturnType<typeof setTimeout> | undefined;
  readonly #openListeners = new Set<() => void>();

  constructor(
    private readonly machine: MachineLink,
    readonly agentId: string,
    private readonly handlers: AgentChannelHandlers,
  ) {}

  /** Registered on an open socket: frames for this agent reach the server. */
  isOpen(): boolean {
    return this.#registered && this.machine.link.isOpen();
  }

  /** Socket reconnects plus this agent's own re-registrations. */
  get reconnects(): number {
    return this.machine.link.reconnects + Math.max(0, this.#registrations - 1);
  }

  /** Called on every registration, after the channel's own open handling. */
  onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  start(): void {
    if (this.#wanted || this.#refused) return;
    this.#operationsEnded = false;
    this.#wanted = true;
    this.machine.want(this);
  }

  stop(): void {
    this.#suspendOperations(true);
    if (!this.#wanted) return;
    this.#wanted = false;
    this.turn.stop();
    this.#activationSource=undefined;this.activation.stop();
    this.#usageOwnerId=undefined;this.#usageSource=undefined;
    this.usage.suspend();
    this.overlay.suspend();
    this.#clearIntakeDeadline();
    if (this.#registered) this.send({ type: 'unregister' });
    this.#registered = false;
    this.#pending = false;
    this.#initialRecoveryPending = false;
    this.initialSnapshotsV1 = false;
    this.machine.unwant(this);
  }

  send(frame: Record<string, unknown>): boolean {
    if (!this.isOpen()) return false;
    return this.machine.link.send(JSON.stringify({ ...frame, agentId: this.agentId }));
  }

  /** @internal The machine selects one authenticated route for its vault. */
  reportVault(report: Omit<PostConnectorVaultInput, 'agentId'>): Promise<unknown> | undefined {
    return this.handlers.reportVault?.(report);
  }

  suspect(): void {
    this.machine.link.suspect();
  }

  /** The server requires a newer helper. Every agent on the socket hears it once. */
  requireUpdate(minVersion: string): void {
    // An agent not yet on the socket is not in the socket's fan-out.
    if (!this.#wanted) this.handlers.onUpdateRequired(minVersion);
    this.machine.link.requireUpdate(minVersion);
  }

  /** The socket opened: ask the server to take this agent. */
  register(): void {
    if (!this.#wanted || this.#registered || this.#pending || this.#refused) return;
    // Pending before the send: an answer can arrive before send() returns.
    this.#pending = true;
    this.#armIntakeDeadline();
    if (!this.machine.link.send(JSON.stringify({
      ...this.handlers.registration(), type: 'register', agentId: this.agentId, intakeHeartbeat: true, overlayV1:true, usageAccountV1:true, activationContextV1:true, turnOwnershipV1:true, turnRuntimeId:this.#turnRuntimeId, daemonOperationsV1:true,
    }))) this.#pending = false;
  }

  /** @internal Routed by the machine link. */
  receive(event: Record<string, unknown>): void {
    if (event.type === 'registered') {
      const pending = this.#pending;
      this.#pending = false;
      if (!this.#wanted || this.#registered) return;
      // A registration completing after its deadline cannot resurrect its owner.
      if (!pending) {
        this.machine.link.send(JSON.stringify({ type: 'unregister', agentId: this.agentId }));
        return;
      }
      this.#registered = true;
      this.#operationsAvailable = (event.capabilities as {daemonOperationsV1?: unknown} | undefined)?.daemonOperationsV1 === true;
      if (this.#operationsAvailable) this.#operationsSelected = true;
      this.initialSnapshotsV1 = (event.capabilities as {initialSnapshotsV1?:unknown}|undefined)?.initialSnapshotsV1 === true;
      const turnCapabilities = event.capabilities as { turnOwnershipV1?: unknown; turnConnectionId?: unknown; turnConnectionEpoch?: unknown; turnContinuationV1?: unknown } | undefined;
      this.turn.negotiate(turnCapabilities?.turnOwnershipV1 === true && typeof turnCapabilities.turnConnectionId === 'string' &&
        Number.isSafeInteger(turnCapabilities.turnConnectionEpoch) && Number(turnCapabilities.turnConnectionEpoch) > 0
        ? { connectionId: turnCapabilities.turnConnectionId, epoch: Number(turnCapabilities.turnConnectionEpoch) } : undefined,
        turnCapabilities?.turnOwnershipV1 === true, turnCapabilities?.turnContinuationV1 === true);
      const activationCapabilities=event.capabilities as {activationContextV1?:unknown;activationConnectionId?:unknown;activationConnectionEpoch?:unknown}|undefined;
      if(activationCapabilities?.activationContextV1===true)this.activationContextSelected=true;
      this.#activationSource=activationCapabilities?.activationContextV1===true&&typeof activationCapabilities.activationConnectionId==='string'&&
        Number.isSafeInteger(activationCapabilities.activationConnectionEpoch)&&Number(activationCapabilities.activationConnectionEpoch)>0
        ?{connectionId:activationCapabilities.activationConnectionId,epoch:Number(activationCapabilities.activationConnectionEpoch)}:undefined;
      this.activation.resume(this.#activationSource);
      const usageCapabilities=event.capabilities as {usageAccountV1?:unknown;usageOwnerId?:unknown;usageConnectionId?:unknown;usageConnectionEpoch?:unknown}|undefined;
      const usageSelected=usageCapabilities?.usageAccountV1===true;
      if(usageSelected)this.usageAccountSelected=true;
      this.#usageOwnerId=usageSelected&&typeof usageCapabilities?.usageOwnerId==='string'?usageCapabilities.usageOwnerId:undefined;
      this.#usageSource=usageSelected&&typeof usageCapabilities?.usageConnectionId==='string'&&Number.isSafeInteger(usageCapabilities.usageConnectionEpoch)&&Number(usageCapabilities.usageConnectionEpoch)>0
        ?{connectionId:usageCapabilities.usageConnectionId,epoch:Number(usageCapabilities.usageConnectionEpoch)}:undefined;
      this.overlay.negotiate((event.capabilities as {overlayV1?:unknown}|undefined)?.overlayV1===true);
      this.#intakeHeartbeat = Boolean(
        (event.capabilities as { intakeHeartbeat?: unknown } | undefined)?.intakeHeartbeat === true,
      );
      this.#clearIntakeDeadline();
      if (this.#intakeHeartbeat) this.#armIntakeDeadline();
      this.#registrations += 1;
      if (!this.#operationsSelected || this.#operationsAvailable)
        for (const settle of [...this.#operationWaiters]) settle(true);
      this.handlers.onOpen();
      this.machine.registered();
      for (const listener of [...this.#openListeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[machine-link] open listener failed', error);
        }
      }
      return;
    }
    if (event.type === 'intake-ready') {
      if (this.#registered && this.#intakeHeartbeat && !this.#initialRecoveryPending) this.#armIntakeDeadline();
      return;
    }
    if (event.type === 'register-refused') {
      if (this.#refused) return;
      this.#pending = false;
      this.#clearIntakeDeadline();
      const code = typeof event.code === 'string' ? event.code : 'refused';
      console.warn(`[machine-link] server refused agent ${this.agentId}: ${code}`);
      this.#refused = ['daemon_token_required', 'agent_removed'].includes(code);
      this.#suspendOperations(this.#refused);
      this.handlers.onRefused?.(code);
      if (this.#refused) {
        this.#wanted = false;
        this.turn.stop();this.activation.stop();
        // A helper with only refused agents must not keep opening sockets
        // that the server will immediately close for having no registration.
        this.machine.unwant(this);
      }
      if (!this.#refused) this.machine.reconnectNow();
      return;
    }
    if (event.type === 'unregistered') {
      if (!this.#registered) return;
      console.warn(`[machine-link] server dropped agent ${this.agentId}: ${String(event.reason)}`);
      this.#ended();
      this.register();
      return;
    }
    if (this.#registered && event.type === 'daemon-operation-result') {
      const pending = typeof event.requestId === 'string' ? this.#operationRequests.get(event.requestId) : undefined;
      if (!pending) return;
      this.#operationRequests.delete(event.requestId as string);
      clearTimeout(pending.deadline);
      if (typeof event.error === 'string') {
        const error = Object.assign(new Error(event.error), {
          status: typeof event.status === 'number' ? event.status : 503,
          code: event.error,
        });
        pending.reject(error);
      } else pending.resolve(event.result);
      return;
    }
    if(this.#registered&&(this.turn.receive(event)||this.overlay.receive(event)||this.usage.receive(event)||this.activation.receive(event)))return;
    if (this.#registered) this.handlers.onMessage(event);
  }

  /** @internal The machine socket closed: every registration ended with it. */
  socketClosed(ended = false): void {
    this.#suspendOperations(ended);
    if (ended) this.turn.stop();
    else this.turn.suspend();
    this.#activationSource=undefined;if(ended)this.activation.stop();else this.activation.suspend();
    this.#usageOwnerId=undefined;this.#usageSource=undefined;
    this.usage.suspend();
    this.overlay.suspend();
    this.#clearIntakeDeadline();
    this.#pending = false;
    if (this.#registered) this.#ended();
    this.#initialRecoveryPending = false;
    this.initialSnapshotsV1 = false;
  }

  /** @internal Machine-wide frames (release notices, force-update). */
  broadcast(event: Record<string, unknown>): void {
    this.handlers.onMessage(event);
  }

  /** @internal */
  updateRequired(minVersion: string): void {
    this.#clearIntakeDeadline();
    this.handlers.onUpdateRequired(minVersion);
  }

  #clearIntakeDeadline(): void {
    clearTimeout(this.#intakeDeadline);
    this.#intakeDeadline = undefined;
  }

  #armIntakeDeadline(): void {
    this.#clearIntakeDeadline();
    this.#intakeDeadline = setTimeout(() => {
      this.#intakeDeadline = undefined;
      if (!this.#wanted) return;
      console.warn(`[machine-link] agent ${this.agentId} ${this.#pending ? 'registration' : 'intake'} stalled; reconnecting`);
      // Reconnect and rebuild subscriptions from current server state. The
      // timeout cannot leave a wanted agent without command intake.
      this.machine.reconnectNow();
    }, this.machine.intakeTimeoutMs ?? LIVE_LINK_TIMING.heartbeatTimeoutMs);
    this.#intakeDeadline.unref?.();
  }

  #ended(): void {
    this.#suspendOperations();
    this.turn.suspend();
    this.#activationSource=undefined;this.activation.suspend();
    this.#usageOwnerId=undefined;this.#usageSource=undefined;
    this.usage.suspend();
    this.overlay.suspend();
    this.#registered = false;
    this.initialSnapshotsV1 = false;
    this.#initialRecoveryPending = false;
    this.#clearIntakeDeadline();
    this.handlers.onClose();
  }

  /** Authentication plus current demanded-lane acknowledgements. */
  recovered(): void {
    if(!this.isOpen())return;
    this.#initialRecoveryPending=false;
    this.#clearIntakeDeadline();
    if(this.#intakeHeartbeat)this.#armIntakeDeadline();
  }
  /** One admission deadline for initial demanded data; controls cannot renew it. */
  awaitInitialRecovery(): void {
    if(!this.isOpen() || this.#initialRecoveryPending)return;
    this.#initialRecoveryPending=true;
    this.#armIntakeDeadline();
  }

}

/**
 * The helper machine's one socket. Every agent the process hosts is an
 * `AgentChannel` on it; the socket opens while any agent wants it.
 */
export class MachineLink {
  readonly #logUnknown = unknownServerEventLogger('machine-link');
  readonly link: LiveLink;
  readonly #channels = new Map<string, AgentChannel>();
  #identity: { releaseVersion: string; sourceSha?: string } = { releaseVersion: 'v0.0.0' };
  #reconciledOnSocket = false;
  #pendingRelease: Record<string, unknown> | undefined;
  #lastVaultContent: string | undefined;
  #vaultRefresh: Promise<void> | undefined;
  #vaultRefreshRequested = false;
  readonly random: () => number;
  readonly intakeTimeoutMs: number;

  constructor(
    private readonly options: {
      baseUrl: string;
      factory?: LiveSocketFactory;
      timing?: Partial<LiveLinkTiming>;
      random?: () => number;
      onRegistered?: () => void;
      readVault?: (agentId: string) => Promise<Omit<PostConnectorVaultInput, 'agentId'>>;
      log?: (message: string) => void;
    },
  ) {
    this.random = options.random ?? Math.random;
    this.intakeTimeoutMs = options.timing?.heartbeatTimeoutMs ?? LIVE_LINK_TIMING.heartbeatTimeoutMs;
    this.link = new LiveLink({
      url: () => this.#url(),
      protocols: () => [MACHINE_SOCKET_PROTOCOL],
      factory: options.factory ?? ((url, protocols, socketOptions) =>
        new WebSocket(url, protocols, socketOptions)),
      onOpen: () => {
        this.#reconciledOnSocket = false;
        this.#pendingRelease = undefined;
        for (const channel of this.#channels.values()) channel.register();
      },
      onMessage: (data) => this.#message(data),
      onClose: () => {
        this.#reconciledOnSocket = false;
        this.#pendingRelease = undefined;
        for (const channel of this.#channels.values()) channel.socketClosed();
      },
      onUpdateRequired: (minVersion) => {
        for (const channel of [...this.#channels.values()]) channel.updateRequired(minVersion);
      },
      ...(options.timing ? { timing: options.timing } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
  }

  get origin():string{return new URL(this.options.baseUrl).origin;}

  setHelperIdentity(identity: { releaseVersion?: string; sourceSha?: string }): void {
    this.#identity = {
      releaseVersion: helperVersion(identity.releaseVersion),
      ...(identity.sourceSha ? { sourceSha: identity.sourceSha } : {}),
    };
  }

  /** The first accepted registration follows the server's cached release frame. */
  registered(): void {
    if (this.#reconciledOnSocket) return;
    this.#reconciledOnSocket = true;
    void this.refreshVault();
    this.options.onRegistered?.();
    if (this.#pendingRelease) {
      const release = this.#pendingRelease;
      this.#pendingRelease = undefined;
      this.#broadcast(release);
    }
  }

  /** One observation at a time for the whole machine, including reconnects. */
  refreshVault(): Promise<void> {
    if (!this.options.readVault) return Promise.resolve();
    this.#vaultRefreshRequested = true;
    this.#vaultRefresh ??= this.#drainVaultRefreshes().finally(() => { this.#vaultRefresh = undefined; });
    return this.#vaultRefresh;
  }

  async #drainVaultRefreshes(): Promise<void> {
    // A real vault event during a slow read/write must not be lost. Only
    // callers request another observation; a failure never requests one.
    while (this.#vaultRefreshRequested) {
      this.#vaultRefreshRequested = false;
      await this.#reportVault();
    }
  }

  async #reportVault(): Promise<void> {
    const channel = [...this.#channels.values()].find(channel => channel.isOpen());
    if (!channel) return;
    try {
      const report = await this.options.readVault!(channel.agentId);
      // The list and host/field sets have no ordering semantics.
      const content = JSON.stringify({ ...report, connections: report.connections.map(item => ({
        ...item, fieldNames: [...item.fieldNames].sort(), allowedHosts: [...item.allowedHosts].sort(),
        ...(item.loginHosts ? { loginHosts: [...item.loginHosts].sort() } : {}),
      })).sort((a, b) => a.reference.localeCompare(b.reference)) });
      if (content === this.#lastVaultContent) return;
      const current = [...this.#channels.values()].find(channel => channel.isOpen());
      if (!current) return;
      const sent = current.reportVault(report);
      if (!sent) return;
      await sent;
      this.#lastVaultContent = content;
    } catch (error) {
      // A failed observation/delivery preserves the last broker verdict.
      this.options.log?.(`Squire machine report unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A later channel for the same agent (an in-process restart) replaces the earlier one. */
  attach(agentId: string, handlers: AgentChannelHandlers): AgentChannel {
    return new AgentChannel(this, agentId, handlers);
  }

  /** @internal */
  want(channel: AgentChannel): void {
    const previous = this.#channels.get(channel.agentId);
    this.#channels.set(channel.agentId, channel);
    if (previous && previous !== channel) previous.socketClosed(true);
    if (this.link.isOpen()) channel.register();
    else {
      this.link.start();
      // A newly attached agent/configuration is an independent demand boundary.
      if(this.link.state==='disconnected')this.link.reconnectNow();
    }
  }

  /** @internal */
  unwant(channel: AgentChannel): void {
    if (this.#channels.get(channel.agentId) === channel) this.#channels.delete(channel.agentId);
    if (!this.#channels.size) this.link.stop();
  }

  /** Open a fresh socket at once; every channel re-registers on it. */
  reconnectNow(): void {
    this.link.reconnectNow();
  }

  stop(forUpdate = false): void {
    for (const channel of this.#channels.values()) channel.socketClosed(true);
    this.#channels.clear();
    this.link.stop(forUpdate);
  }

  #url(): string {
    const liveUrl = new URL('/v1/phone/live', this.options.baseUrl);
    liveUrl.protocol = liveUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    liveUrl.searchParams.set('helperVersion', this.#identity.releaseVersion);
    if (this.#identity.sourceSha) liveUrl.searchParams.set('sourceSha', this.#identity.sourceSha);
    return liveUrl.toString();
  }

  #message(data: string): void {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    // Machine-wide events take precedence over legacy or stray agent tags.
    if (event.type === 'force-update') {
      if (typeof event.minVersion === 'string') this.link.requireUpdate(event.minVersion);
      return;
    }
    if (event.type === 'helper-release') {
      if (!this.#reconciledOnSocket) this.#pendingRelease = event;
      else this.#broadcast(event);
      return;
    }
    if (typeof event.agentId === 'string' && event.agentId.length > 0) {
      this.#channels.get(event.agentId)?.receive(event);
      return;
    }
    // hello is informational; a malformed force-update never authorizes an update.
    if (event.type !== 'hello' && event.type !== 'force-update') this.#logUnknown(event.type);
  }

  #broadcast(event: Record<string, unknown>): void {
    for (const channel of this.#channels.values()) channel.broadcast(event);
  }
}
