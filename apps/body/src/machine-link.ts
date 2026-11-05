import { HelperOverlayChannel } from './helper-overlay-channel.js';
import { HelperTurnChannel } from './helper-turn-channel.js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { DaemonOperationMap, PostConnectorVaultInput } from '@beeline/api-contract/daemon';
import { helperVersion } from './helper-version.js';
import { unknownServerEventLogger } from './unknown-server-event.js';
import { LiveLink, type LiveLinkTiming, type LiveSocketFactory } from './live-link.js';

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

/** Agent identity and request correlation on the machine connection. Registration
 * metadata is immutable until the next handshake, never a capability lifecycle. */
export class AgentChannel {
  readonly turn = new HelperTurnChannel();
  readonly overlay = new HelperOverlayChannel(frame => this.send(frame), () => this.isOpen());
  readonly #turnRuntimeId = randomUUID();
  readonly #waiters = new Set<() => void>();
  readonly #requests = new Map<string, {
    frame: Record<string, unknown>; sent: boolean;
    resolve: (value: unknown) => void; reject: (error: Error) => void;
  }>();
  readonly #openListeners = new Set<() => void>();
  #wanted = false;
  #registered = false;
  #capabilities: Record<string, unknown> = {};
  initialSnapshotsV1 = true;
  constructor(private readonly machine: MachineLink, readonly agentId: string, private readonly handlers: AgentChannelHandlers) {}
  isOpen(): boolean { return this.#registered && this.machine.link.isOpen(); }
  get reconnects(): number { return this.machine.link.reconnects; }
  activationScope(): {origin:string; generation:number; source:{connectionId:string;epoch:number}} | undefined {
    const c = this.#capabilities;
    return typeof c.activationConnectionId === 'string' && typeof c.activationConnectionEpoch === 'number'
      ? {origin:this.machine.origin, generation:this.reconnects, source:{connectionId:c.activationConnectionId,epoch:c.activationConnectionEpoch}} : undefined;
  }
  usageAccountScope(): {origin:string;ownerId:string;generation:number;source:{connectionId:string;epoch:number}} | undefined {
    const c = this.#capabilities;
    return typeof c.usageOwnerId === 'string' && typeof c.usageConnectionId === 'string' && typeof c.usageConnectionEpoch === 'number'
      ? {origin:this.machine.origin,ownerId:c.usageOwnerId,generation:this.reconnects,source:{connectionId:c.usageConnectionId,epoch:c.usageConnectionEpoch}} : undefined;
  }
  async operationReady(): Promise<void> {
    if (this.isOpen()) return;
    await new Promise<void>(resolve => { this.#waiters.add(resolve); this.start(); });
  }
  requestOperation<N extends keyof DaemonOperationMap>(operation: N, input: DaemonOperationMap[N]['input']): Promise<DaemonOperationMap[N]['output']> {
    const requestId = randomUUID();
    const frame = {type:'daemon-operation',requestId,operation,input};
    return new Promise((resolve,reject) => {
      const pending = {frame,sent:false,resolve:(value:unknown) => resolve(value as DaemonOperationMap[N]['output']),reject};
      this.#requests.set(requestId,pending);
      this.start();
      this.#dispatch(pending);
    });
  }
  #dispatch(pending: {frame:Record<string,unknown>;sent:boolean}): void {
    if (!this.isOpen()) return;
    if (pending.sent) {
      this.send({type:'request-result',requestId:pending.frame.requestId});
      return;
    }
    const input = {...pending.frame.input as Record<string,unknown>};
    // Waiting work binds to the newly authenticated source. Sent work is only
    // read by id: its original effect and source must never be rewritten.
    if (pending.frame.operation === 'readCommandActivation') input.source = this.activationScope()?.source;
    if (['publishAgentUsageAccount','attachAgentUsageAccount'].includes(String(pending.frame.operation))) input.source = this.usageAccountScope()?.source;
    if (pending.frame.operation === 'postAgentUsage' && input.usageSource)
      input.usageSource = {...input.usageSource as object,source:this.usageAccountScope()?.source};
    pending.frame.input = input;
    // Mark before send: test transports and local adapters can answer inline.
    pending.sent = true;
    if (!this.send(pending.frame)) pending.sent = false;
  }
  onOpen(listener: () => void): () => void { this.#openListeners.add(listener); return () => this.#openListeners.delete(listener); }
  start(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.machine.want(this);
  }
  stop(): void {
    if (!this.#wanted) return;
    if (this.isOpen()) this.send({type:'unregister'});
    this.#wanted = false;
    this.socketClosed(true);
    this.machine.unwant(this);
  }
  send(frame: Record<string,unknown>): boolean {
    return this.isOpen() && this.machine.send({...frame,agentId:this.agentId});
  }
  reportVault(report: Omit<PostConnectorVaultInput,'agentId'>): Promise<unknown> | undefined { return this.handlers.reportVault?.(report); }
  requireUpdate(minVersion:string):void { this.machine.link.requireUpdate(minVersion); }
  registration(): Record<string,unknown> | undefined {
    return this.#wanted && !this.#registered ? {...this.handlers.registration(),agentId:this.agentId,
      overlayV1:true,usageAccountV1:true,activationContextV1:true,turnOwnershipV1:true,
      turnRuntimeId:this.#turnRuntimeId,daemonOperationsV1:true} : undefined;
  }
  receive(event:Record<string,unknown>):void {
    if (event.type === 'registered') {
      if (!this.#wanted || this.#registered) return;
      this.#registered = true;
      this.#capabilities = event.capabilities as Record<string,unknown> ?? {};
      const c = this.#capabilities;
      if (typeof c.turnConnectionId === 'string' && typeof c.turnConnectionEpoch === 'number')
        this.turn.negotiate({connectionId:c.turnConnectionId,epoch:c.turnConnectionEpoch});
      this.overlay.negotiate(c.overlayV1 === true);
      for (const pending of this.#requests.values()) this.#dispatch(pending);
      for (const resolve of this.#waiters) resolve();
      this.#waiters.clear();
      this.handlers.onOpen();
      this.machine.registered();
      for (const listener of [...this.#openListeners]) listener();
      return;
    }
    if (event.type === 'register-refused') {
      this.handlers.onRefused?.(String(event.code));
      return; // A refusal never replaces the machine connection or fails work.
    }
    if (event.type === 'unregistered') { this.socketClosed(); return; }
    if (event.type === 'request-missing' && typeof event.requestId === 'string') {
      const pending = this.#requests.get(event.requestId);
      if (pending) { pending.sent = false; this.#dispatch(pending); }
      return;
    }
    if (event.type === 'daemon-operation-result' && typeof event.requestId === 'string') {
      const pending = this.#requests.get(event.requestId);
      if (!pending) return;
      this.#requests.delete(event.requestId);
      if (typeof event.error === 'string') pending.reject(Object.assign(new Error(event.error),{status:event.status,code:event.error}));
      else pending.resolve(event.result);
      this.send({type:'request-ack',requestId:event.requestId});
      return;
    }
    if (this.#registered && !this.overlay.receive(event)) this.handlers.onMessage(event);
  }
  socketClosed(ended = false):void {
    const registered = this.#registered;
    this.#registered = false;
    this.overlay.suspend();
    if (ended) {
      this.turn.stop();
      for (const pending of this.#requests.values()) pending.reject(new Error('Agent runtime ended'));
      this.#requests.clear();
    }
    if (registered) this.handlers.onClose();
  }
  broadcast(event:Record<string,unknown>):void { this.handlers.onMessage(event); }
  updateRequired(minVersion:string):void { this.handlers.onUpdateRequired(minVersion); }
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
    this.link = new LiveLink({
      url: () => this.#url(),
      protocols: () => [MACHINE_SOCKET_PROTOCOL],
      factory: options.factory ?? ((url, protocols, socketOptions) =>
        new WebSocket(url, protocols, socketOptions)),
      onOpen: () => {
        this.#reconciledOnSocket = false;
        this.#pendingRelease = undefined;
        this.#register();
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
    if (this.link.isOpen()) this.#register();
    else this.link.start();
  }

  /** @internal */
  unwant(channel: AgentChannel): void {
    if (this.#channels.get(channel.agentId) === channel) this.#channels.delete(channel.agentId);
    if (!this.#channels.size) this.link.stop();
  }

  send(frame: Record<string,unknown>): boolean { return this.link.send(JSON.stringify(frame)); }
  #register():void {
    const agents = [...this.#channels.values()].flatMap(channel => { const frame=channel.registration(); return frame ? [frame] : []; });
    if (agents.length) this.send({type:'register-machine',agents});
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
    if (event.type === 'registered-machine' && Array.isArray(event.agents)) {
      for (const agent of event.agents) if (agent && typeof agent === 'object' && typeof agent.agentId === 'string')
        this.#channels.get(agent.agentId)?.receive(agent);
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
