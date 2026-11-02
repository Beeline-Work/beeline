import { HelperOverlayChannel } from './helper-overlay-channel.js';
import WebSocket from 'ws';
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
}

/**
 * One agent's place on the machine socket. The socket carries every agent on
 * the machine; each one registers with its own daemon token, and the server
 * can drop or refuse one agent without touching the others.
 */
export class AgentChannel {
  readonly overlay=new HelperOverlayChannel(frame=>this.send(frame),()=>this.isOpen());
  #wanted = false;
  #registered = false;
  /** A register frame is in flight on the current socket. */
  #pending = false;
  #refused = false;
  #recovered = false;
  #replacementSpent = false;
  #registrations = 0;
  #intakeHeartbeat = false;
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
    this.#wanted = true;
    this.machine.want(this);
  }

  stop(): void {
    if (!this.#wanted) return;
    this.#wanted = false;
    this.overlay.suspend();
    this.#clearIntakeDeadline();
    if (this.#registered) this.send({ type: 'unregister' });
    this.#registered = false;
    this.#pending = false;
    this.machine.unwant(this);
  }

  send(frame: Record<string, unknown>): boolean {
    if (!this.isOpen()) return false;
    return this.machine.link.send(JSON.stringify({ ...frame, agentId: this.agentId }));
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
      ...this.handlers.registration(), type: 'register', agentId: this.agentId, intakeHeartbeat: true, overlayV1:true,
    }))) this.#pending = false;
  }

  /** @internal Routed by the machine link. */
  receive(event: Record<string, unknown>): void {
    if (event.type === 'registered') {
      this.#pending = false;
      if (!this.#wanted || this.#registered) return;
      this.#registered = true;
      this.overlay.negotiate((event.capabilities as {overlayV1?:unknown}|undefined)?.overlayV1===true);
      this.#intakeHeartbeat = Boolean(
        (event.capabilities as { intakeHeartbeat?: unknown } | undefined)?.intakeHeartbeat === true,
      );
      this.#clearIntakeDeadline();
      if (this.#intakeHeartbeat) this.#armIntakeDeadline();
      this.#registrations += 1;
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
      if (this.#registered && this.#intakeHeartbeat) this.#armIntakeDeadline();
      return;
    }
    if (event.type === 'register-refused') {
      if (this.#refused) return;
      this.#pending = false;
      this.#clearIntakeDeadline();
      const code = typeof event.code === 'string' ? event.code : 'refused';
      console.warn(`[machine-link] server refused agent ${this.agentId}: ${code}`);
      this.#refused = ['daemon_token_required', 'agent_removed', 'too_many_agents'].includes(code);
      this.handlers.onRefused?.(code);
      if (this.#refused) {
        this.#wanted = false;
        // A helper with only refused agents must not keep opening sockets
        // that the server will immediately close for having no registration.
        this.machine.unwant(this);
      }
      return;
    }
    if (event.type === 'unregistered') {
      if (!this.#registered) return;
      console.warn(`[machine-link] server dropped agent ${this.agentId}: ${String(event.reason)}`);
      const recovered=this.#recovered;
      this.#ended();
      if(recovered && !this.#replacementSpent){this.#replacementSpent=true;this.register();}
      return;
    }
    if(this.#registered&&this.overlay.receive(event))return;
    if (this.#registered) this.handlers.onMessage(event);
  }

  /** @internal The machine socket closed: every registration ended with it. */
  socketClosed(): void {
    this.overlay.suspend();
    this.#clearIntakeDeadline();
    this.#pending = false;
    if (this.#registered) this.#ended();
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
      console.warn(`[machine-link] agent ${this.agentId} ${this.#pending ? 'registration' : 'intake'} stalled; parked`);
      // A missing registration/intake acknowledgement is not an independent
      // recovery boundary and cannot reopen the machine repeatedly.
      this.#pending = false;
      if(this.#registered) this.#ended();
    }, this.machine.intakeTimeoutMs ?? LIVE_LINK_TIMING.heartbeatTimeoutMs);
    this.#intakeDeadline.unref?.();
  }

  #ended(): void {
    this.overlay.suspend();
    this.#registered = false;
    this.#clearIntakeDeadline();
    this.#recovered = false;
    this.handlers.onClose();
  }

  /** Authentication plus current demanded-lane acknowledgements. */
  recovered(): void {
    if(!this.isOpen() || this.#recovered)return;
    this.#recovered=true;this.#replacementSpent=false;
    this.machine.recovered();
  }
  get recoveryComplete(): boolean {return this.#recovered;}

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
  readonly random: () => number;
  readonly intakeTimeoutMs: number;

  constructor(
    private readonly options: {
      baseUrl: string;
      factory?: LiveSocketFactory;
      timing?: Partial<LiveLinkTiming>;
      random?: () => number;
      onRegistered?: () => void;
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
    this.options.onRegistered?.();
    if (this.#pendingRelease) {
      const release = this.#pendingRelease;
      this.#pendingRelease = undefined;
      this.#broadcast(release);
    }
  }

  /** Reset one incident only when every owned agent has caught up. */
  recovered(): void {
    if([...this.#channels.values()].every(channel=>channel.isOpen() && channel.recoveryComplete))
      this.link.markRecovered();
  }

  /** A later channel for the same agent (an in-process restart) replaces the earlier one. */
  attach(agentId: string, handlers: AgentChannelHandlers): AgentChannel {
    return new AgentChannel(this, agentId, handlers);
  }

  /** @internal */
  want(channel: AgentChannel): void {
    const previous = this.#channels.get(channel.agentId);
    this.#channels.set(channel.agentId, channel);
    if (previous && previous !== channel) previous.socketClosed();
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
    for (const channel of this.#channels.values()) channel.socketClosed();
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
