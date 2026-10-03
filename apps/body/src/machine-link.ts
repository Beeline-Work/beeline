import WebSocket from 'ws';
import { helperVersion } from './helper-version.js';
import { LiveLink, type LiveLinkTiming, type LiveSocketFactory } from './live-link.js';

/** Subprotocol of the one socket a helper machine holds for all of its agents. */
export const MACHINE_SOCKET_PROTOCOL = 'beeline.machine.1';

/** Re-registration after the server dropped or refused one agent. */
const REGISTRATION_BACKOFF_BASE_MS = 1_000;
const REGISTRATION_BACKOFF_MAX_MS = 30_000;
/** Only a registration that lived this long resets its backoff. */
const STABLE_REGISTRATION_MS = 30_000;

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
  #wanted = false;
  #registered = false;
  /** A register frame is in flight on the current socket. */
  #pending = false;
  #registeredAt: number | undefined;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #registrations = 0;
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
    if (this.#wanted) return;
    this.#wanted = true;
    this.machine.want(this);
  }

  stop(): void {
    if (!this.#wanted) return;
    this.#wanted = false;
    clearTimeout(this.#retry);
    this.#retry = undefined;
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
    if (!this.#wanted || this.#registered || this.#pending) return;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    // Pending before the send: an answer can arrive before send() returns.
    this.#pending = true;
    if (!this.machine.link.send(JSON.stringify({
      ...this.handlers.registration(), type: 'register', agentId: this.agentId,
    }))) this.#pending = false;
  }

  /** @internal Routed by the machine link. */
  receive(event: Record<string, unknown>): void {
    if (event.type === 'registered') {
      this.#pending = false;
      if (!this.#wanted || this.#registered) return;
      this.#registered = true;
      this.#registeredAt = Date.now();
      this.#registrations += 1;
      this.handlers.onOpen();
      for (const listener of [...this.#openListeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[machine-link] open listener failed', error);
        }
      }
      return;
    }
    if (event.type === 'register-refused') {
      this.#pending = false;
      const code = typeof event.code === 'string' ? event.code : 'refused';
      console.warn(`[machine-link] server refused agent ${this.agentId}: ${code}`);
      this.handlers.onRefused?.(code);
      this.#retryLater();
      return;
    }
    if (event.type === 'unregistered') {
      if (!this.#registered) return;
      console.warn(`[machine-link] server dropped agent ${this.agentId}: ${String(event.reason)}`);
      this.#ended();
      this.#retryLater();
      return;
    }
    if (this.#registered) this.handlers.onMessage(event);
  }

  /** @internal The machine socket closed: every registration ended with it. */
  socketClosed(): void {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#pending = false;
    if (this.#registered) this.#ended();
  }

  /** @internal Machine-wide frames (release notices, force-update). */
  broadcast(event: Record<string, unknown>): void {
    this.handlers.onMessage(event);
  }

  /** @internal */
  updateRequired(minVersion: string): void {
    this.handlers.onUpdateRequired(minVersion);
  }

  #ended(): void {
    const registeredAt = this.#registeredAt;
    this.#registered = false;
    this.#registeredAt = undefined;
    if (registeredAt !== undefined && Date.now() - registeredAt >= STABLE_REGISTRATION_MS)
      this.#failures = 0;
    this.handlers.onClose();
  }

  #retryLater(): void {
    if (!this.#wanted || this.#retry) return;
    const ceiling = Math.min(
      REGISTRATION_BACKOFF_MAX_MS,
      REGISTRATION_BACKOFF_BASE_MS * 2 ** this.#failures,
    );
    this.#failures += 1;
    // Full jitter: agents dropped together do not come back in lockstep.
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (this.machine.link.isOpen()) this.register();
    }, Math.floor(this.machine.random() * ceiling));
    this.#retry.unref?.();
  }
}

/**
 * The helper machine's one socket. Every agent the process hosts is an
 * `AgentChannel` on it; the socket opens while any agent wants it.
 */
export class MachineLink {
  readonly link: LiveLink;
  readonly #channels = new Map<string, AgentChannel>();
  #identity: { releaseVersion: string; sourceSha?: string } = { releaseVersion: 'v0.0.0' };
  readonly random: () => number;

  constructor(
    private readonly options: {
      baseUrl: string;
      factory?: LiveSocketFactory;
      timing?: Partial<LiveLinkTiming>;
      random?: () => number;
    },
  ) {
    this.random = options.random ?? Math.random;
    this.link = new LiveLink({
      url: () => this.#url(),
      protocols: () => [MACHINE_SOCKET_PROTOCOL],
      factory: options.factory ?? ((url, protocols, socketOptions) =>
        new WebSocket(url, protocols, socketOptions)),
      onOpen: () => {
        for (const channel of this.#channels.values()) channel.register();
      },
      onMessage: (data) => this.#message(data),
      onClose: () => {
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
    else this.link.start();
  }

  /** @internal */
  unwant(channel: AgentChannel): void {
    if (this.#channels.get(channel.agentId) === channel) this.#channels.delete(channel.agentId);
    if (!this.#channels.size) this.link.stop();
  }

  stop(): void {
    this.#channels.clear();
    this.link.stop();
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
    if (event.type === 'force-update' && typeof event.minVersion === 'string') {
      this.link.requireUpdate(event.minVersion);
      return;
    }
    if (typeof event.agentId === 'string') {
      this.#channels.get(event.agentId)?.receive(event);
      return;
    }
    // Untagged frames belong to the machine: release notices reach every agent.
    if (event.type === 'helper-release')
      for (const channel of this.#channels.values()) channel.broadcast(event);
  }
}
