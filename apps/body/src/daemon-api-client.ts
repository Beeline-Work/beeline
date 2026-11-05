import { renewSquireShareOnViewerActivity } from './squire-share-renewals.js';
import { invalidateUsageAccountAttachment } from './helper-usage-publisher.js';
import { postChangedAgentUsage } from './helper-usage-binding.js';
import {
  isAgentCommand,
  type AgentCommand,
  type AgentSignInFrame,
  type DaemonOperationMap,
} from '@beeline/api-contract/daemon';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { helperVersion, helperVersionHeader } from './helper-version.js';
import { HostReadBudget, hostReadBudget, ReadBudgetFullError } from './host-read-budget.js';
import {
  retryAfterMs,
  type LiveLink,
  type LiveLinkTiming,
  type LiveSocketFactory,
} from './live-link.js';
import { MachineLink, type AgentChannel } from './machine-link.js';
import { agentSignInFrame } from './agent-sign-in.js';
import { unknownServerEventLogger } from './unknown-server-event.js';
import {
  readRuntimeRecord,
  runtimeDirectory,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];
export type InboxItem = Output<'getRoomInbox'>['items'][number];

/** Membership / corner set change pushed on the daemon live socket. */
export type RoomMembershipChange = {
  readonly roomId?: string;
  readonly parentRoomId?: string;
  /** The corner's opener, carried by the same row that announces the corner. */
  readonly openedBy?: string;
  /** The named Room/corner is already archived, so nothing is started for it. */
  readonly archived?: boolean;
  readonly removed?: boolean;
  readonly repositoryChanged?: boolean;
};

export type DaemonFetch = typeof fetch;
export type DaemonWebSocketFactory = LiveSocketFactory;

export class DaemonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** The server's machine-readable refusal code, `request_failed` if none. */
    readonly code: string = 'request_failed',
    readonly retryAfterMs?: number,
    readonly minVersion?: string,
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

/** The server's one settled answer that this agent no longer exists. */
export const AGENT_REMOVED_CODE = 'agent_removed';

/**
 * Whether the server has definitively said this agent was removed.
 *
 * Nothing else may stand in for it. A refused connection, a timeout, a 5xx,
 * an ordinary 401 from a token that could still be restored — every one of
 * those is uncertainty, and a helper that tore itself down on uncertainty
 * would delete a working runtime the first time the server hiccuped. Only a
 * 403 carrying `agent_removed`, which the server answers exactly when the
 * presented token is revoked AND its agent holds no live membership at all,
 * is proof.
 */
export function isAgentRemovedError(error: unknown): boolean {
  return (
    error instanceof DaemonApiError && error.status === 403 && error.code === AGENT_REMOVED_CODE
  );
}

function membershipChange(event: Record<string, unknown>): RoomMembershipChange {
  return {
    ...(typeof event.roomId === 'string' && event.roomId ? { roomId: event.roomId } : {}),
    ...(typeof event.parentRoomId === 'string' ? { parentRoomId: event.parentRoomId } : {}),
    ...(typeof event.openedBy === 'string' ? { openedBy: event.openedBy } : {}),
    ...(event.archived === true ? { archived: true } : {}),
    ...(event.removed === true ? { removed: true } : {}),
    ...(event.repositoryChanged === true ? { repositoryChanged: true } : {}),
  };
}

function endpoint(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

async function responseError(response: Response): Promise<DaemonApiError> {
  let code = 'request_failed';
  let minVersion: string | undefined;
  try {
    const value = (await response.json()) as { error?: unknown; minVersion?: unknown };
    if (typeof value.error === 'string' && value.error) code = value.error;
    if (typeof value.minVersion === 'string') minVersion = value.minVersion;
  } catch {
    // Bodies are deliberately not reflected: they can contain operator data.
  }
  return new DaemonApiError(
    `monolith daemon request failed (${response.status}: ${code})`,
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
    code,
    retryAfterMs(response.headers.get('retry-after')),
    minVersion,
  );
}

export type DaemonClientMetrics = {
  readonly inFlight: number;
  readonly requests: number;
  readonly timeouts: number;
  readonly reconnects: number;
  readonly subscriptionsSent: number;
  readonly readQueueDepth: number;
  readonly readQueueWaitMs: number;
};

const DAEMON_LIVE_EVENT_TYPES = new Set<unknown>([
  'share-viewer-activity',
  'vault-save',
  'helper-release',
  'rooms-changed',
  'discovery-wake',
  'corner-complete',
  'connector-assignment',
  'usage-refresh',
  'agent-sign-in',
  'config-changed',
  'subscribed',
  'commands',
  'inbox',
]);

/** Typed client for the complete named daemon operation contract. */
export class DaemonApiClient {
  /** Only the one-shot Git credential reader selects this exact HTTP read.
   * It must never register a second execution owner for the parent agent. */
  #repositoryCredentialRoom: string | undefined;

  static async readRepositoryCredential(configPath: string, roomId: string, fetchImpl?: DaemonFetch): Promise<Output<'getRoomGitHubToken'>> {
    const runtime = await readRuntimeRecord(configPath);
    if (resolve(configPath) !== resolve(runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey), 'runtime.json'))
      throw new Error('refusing repository credential read outside canonical runtime path');
    const transport = runtime.transport;
    if (!transport?.daemonToken) throw new Error('corner-read-token requires an activated monolith transport');
    const client = new DaemonApiClient(transport.baseUrl, transport.daemonToken, runtime.agent.publicKey, fetchImpl);
    client.#repositoryCredentialRoom = roomId;
    return client.execute('getRoomGitHubToken', { roomId });
  }

  private readonly logUnknownLiveEvent = unknownServerEventLogger('daemon-live');
  private readonly presenceLifecycleId = randomUUID();
  /** This agent's registration on the machine's one live socket. */
  readonly #channel: AgentChannel;
  /** Features can observe negotiation and use the existing overlay owner, but
   * cannot obtain ordinary/turn/usage/activation request capabilities. */
  readonly channel: Readonly<Pick<AgentChannel, 'isOpen' | 'activationScope' | 'usageAccountScope' | 'overlay'>>;
  readonly #machine: MachineLink;
  private registrationRefusal?: DaemonApiError;
  private authorityRefusalListener?: (error: DaemonApiError) => void;
  private channelStateListener?: (connected: boolean, refusal?: string) => void;
  private inFlight = 0;
  private requestCount = 0;
  private subscriptionCount = 0;
  private operationChannelDemanded = false;
  private readonly readBudget?: HostReadBudget;
  private readonly liveRooms = new Map<
    string,
    {
      cursor?: string;
      pushedIds: Set<string>;
      registrations: Set<{
        onItems?: (items: readonly InboxItem[], cursor?: string) => void;
        onState?: (
          connected: boolean,
          capabilities?: { pushIntake: boolean; connectionPresence: boolean; connectionGeneration?: number },
        ) => void;
        onCommands?: (commands: readonly AgentCommand[]) => void;
        presence?: { releaseVersion?: string; sourceSha?: string; available?: boolean };
      }>;
    }
  >();
  private roomsChangedListener?: (event?: RoomMembershipChange) => void;
  private configChangedListener?: () => void;
  private connectorAssignmentListener?: () => void;
  private usageRefreshListener?: (requestId?: string) => void;
  private vaultSaveListener?: (frame: Record<string, unknown>) => void;
  private agentSignInListener?: (frame: AgentSignInFrame) => void;
  private cornerCompleteListener?: (roomId: string) => void;
  private helperReleaseListener?: (release: { version: string; sha: string }) => void;
  private forceUpdateListener?: (minVersion: string) => void;
  private helperIdentity: { releaseVersion: string; sourceSha?: string } = {
    releaseVersion: 'v0.0.0',
  };

  constructor(
    readonly baseUrl: string,
    private readonly daemonToken: string,
    readonly agentId: string,
    private readonly fetchImpl: DaemonFetch = fetch,
    webSocketFactory?: DaemonWebSocketFactory,
    readBudget?: HostReadBudget,
    linkTiming?: Partial<LiveLinkTiming>,
    /** The process's shared machine socket; a standalone client opens its own. */
    machine?: MachineLink,
  ) {
    // Test transports may supply their own admission model. The real network
    // transport always takes the machine-wide budget.
    this.readBudget = readBudget ?? (fetchImpl === fetch ? hostReadBudget : undefined);
    this.#machine =
      machine ??
      new MachineLink({
        baseUrl,
        ...(webSocketFactory ? { factory: webSocketFactory } : {}),
        ...(linkTiming ? { timing: linkTiming } : {}),
      });
    this.#channel = this.#machine.attach(agentId, {
      registration: () => ({
        token: this.daemonToken,
        lifecycleId: this.presenceLifecycleId,
        releaseVersion: this.helperIdentity.releaseVersion,
        ...(this.helperIdentity.sourceSha ? { sourceSha: this.helperIdentity.sourceSha } : {}),
      }),
      onOpen: () => {
        this.liveOpened();
        this.channelStateListener?.(true);
      },
      onMessage: (event) => this.liveMessage(event),
      onClose: () => {
        this.liveSubscriptions.clear();
        this.channelStateListener?.(false);
        for (const room of this.liveRooms.values())
          for (const registration of room.registrations) registration.onState?.(false);
      },
      // Registration uses the same settled retirement check as HTTP. Preserve
      // that proof even after socket selection prohibits HTTP fallback.
      onRefused: (code) => {
        if (code === AGENT_REMOVED_CODE) {
          this.registrationRefusal = new DaemonApiError('Agent removed', 403, false, AGENT_REMOVED_CODE);
          this.roomsChangedListener?.();
        }
        else this.channelStateListener?.(false, code);
      },
      onUpdateRequired: (minVersion) => this.forceUpdateListener?.(minVersion),
      reportVault: report => this.execute('postConnectorVault', { ...report, agentId: this.agentId }),
    });
    this.channel = this.#channel;
  }

  /** Refresh the shared machine observation after an explicit local vault event. */
  refreshMachineVault(): Promise<void> { return this.#machine.refreshVault(); }

  /** The machine socket under this agent's registration. */
  get link(): Pick<LiveLink,'state'|'isOpen'|'onOpen'|'reconnects'> {
    return this.#machine.link;
  }

  /** Connection material for the daemon-owned MCP proxy and corner credentials. */
  connection(): { baseUrl: string; daemonToken: string; agentId: string; helperVersion: string } {
    return {
      baseUrl: this.baseUrl,
      daemonToken: this.daemonToken,
      agentId: this.agentId,
      helperVersion: this.helperIdentity.releaseVersion,
    };
  }

  setHelperIdentity(identity: { releaseVersion?: string; sourceSha?: string }): void {
    this.helperIdentity = {
      releaseVersion: helperVersion(identity.releaseVersion),
      ...(identity.sourceSha ? { sourceSha: identity.sourceSha } : {}),
    };
    this.#machine.setHelperIdentity(identity);
  }

  setForceUpdateListener(listener: (minVersion: string) => void): void {
    this.forceUpdateListener = listener;
  }
  setAuthorityRefusalListener(listener: (error: DaemonApiError) => void): void {
    this.authorityRefusalListener = listener;
  }
  setChannelStateListener(listener: (connected: boolean, refusal?: string) => void): void {
    this.channelStateListener = listener;
  }

  metrics(): DaemonClientMetrics {
    const budget = this.readBudget?.metrics();
    return {
      inFlight: this.inFlight,
      requests: this.requestCount,
      timeouts: 0,
      reconnects: this.#channel.reconnects,
      subscriptionsSent: this.subscriptionCount,
      readQueueDepth: budget?.waiting ?? 0,
      readQueueWaitMs: budget?.totalWaitMs ?? 0,
    };
  }

  /** Called on every live socket open, after resubscription and the wakes. */
  onLiveOpen(listener: () => void): () => void {
    return this.#channel.onOpen(listener);
  }

  /** Add one Room to this agent's shared live socket. */
  liveSubscribe(
    roomId: string,
    cursor?: string,
    onItems?: (items: readonly InboxItem[], cursor?: string) => void,
    onState?: (
      connected: boolean,
      capabilities?: { pushIntake: boolean; connectionPresence: boolean; connectionGeneration?: number },
    ) => void,
    presence?: { releaseVersion?: string; sourceSha?: string; available?: boolean },
    onCommands?: (commands: readonly AgentCommand[]) => void,
  ): () => void {
    let room = this.liveRooms.get(roomId);
    if (!room) {
      room = { pushedIds: new Set(), registrations: new Set() };
      this.liveRooms.set(roomId, room);
    }
    room.cursor = cursor ?? room.cursor;
    const previous = this.liveSubscriptions.get(roomId);
    const registration = { onItems, onState, presence, onCommands };
    room.registrations.add(registration);
    this.ensureLiveSocket();
    this.sendLiveSubscription(roomId);
    if (previous?.ready && this.liveSubscriptions.get(roomId) === previous)
      registration.onState?.(true, previous.capabilities);
    return () => {
      if (!room.registrations.delete(registration)) return;
      if (room.registrations.size) {
        this.sendLiveSubscription(roomId);
        return;
      }
      this.liveRooms.delete(roomId);
      this.liveSubscriptions.delete(roomId);
      this.#channel.send({ type: 'unsubscribe', roomId });
      this.completeLiveRecovery();
      if (!this.liveRooms.size && !this.roomsChangedListener && !this.operationChannelDemanded) this.#channel.stop();
    };
  }

  /** Register the one listener invoked when the server reports this agent's
   * Room/corner memberships changed — a scoped event applies incrementally;
   * an unscoped wake (reconnect) still runs the recovery reconcile. */
  setRoomsChangedListener(listener: (event?: RoomMembershipChange) => void): void {
    this.roomsChangedListener = listener;
    this.ensureLiveSocket();
  }

  /** Register the one listener invoked when the server reports the agent's
   * model/effort selection changed — the wake that hot-restarts every
   * retained session (agent-wide; the event names no single Room). */
  setConfigChangedListener(listener: () => void): void {
    this.configChangedListener = listener;
  }

  /** Connect / pending_ops drain wake. Never a catalog. */
  setConnectorAssignmentListener(listener: () => void): void {
    this.connectorAssignmentListener = listener;
  }

  /** Retire idle sessions as a phone-side config change does (a harness just signed in). */
  emitConfigChanged(): void {
    this.configChangedListener?.();
  }

  /** One `@agent /login` step the agent's owner started in a Room. */
  setUsageRefreshListener(listener: (requestId?: string) => void): void {
    this.usageRefreshListener = listener;
  }

  setVaultSaveListener(listener: (frame: Record<string, unknown>) => void): void {
    this.vaultSaveListener = listener;
  }

  async answerVaultSave(attemptId: string, answer: object): Promise<void> {
    // This one-use vault relay answer has an attempt lifetime, not daemon
    // operation/turn authority. Only whitelisted metadata leaves the helper.
    await this.fetchImpl(endpoint(this.baseUrl, '/v1/vault-save/answer'), {
      method: 'POST', headers: { authorization: `Bearer ${this.daemonToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId, answer }), signal: undefined,
    });
  }

  setAgentSignInListener(listener: (frame: AgentSignInFrame) => void): void {
    this.agentSignInListener = listener;
  }

  /** corner-complete on the subscribed corner — close now, poll is recovery. */
  setCornerCompleteListener(listener: (roomId: string) => void): void {
    this.cornerCompleteListener = listener;
  }

  setHelperReleaseListener(listener: (release: { version: string; sha: string }) => void): void {
    this.helperReleaseListener = listener;
  }

  updateLiveCursor(roomId: string, cursor: string | undefined): void {
    const room = this.liveRooms.get(roomId);
    if (room && cursor) room.cursor = cursor;
  }

  /** Leave the machine socket when this agent's runtime stops. */
  closeLive(): void {
    this.#channel.stop();
  }

  /** Join the existing registration wake; socket loss is not a turn failure. */
  waitForConnection(): Promise<void> { return this.#channel.operationReady(); }

  /** One negotiated command setup read, carried only by the existing machine
   * channel. This method bypasses generic HTTP and context argument injection. */
  async readCommandActivation(input:import('@beeline/api-contract/helper-activation').CommandActivationInput){
    const identity=input&&typeof input==='object'?Object.getOwnPropertyDescriptor(input,'agentId'):undefined;
    if(!identity||!('value' in identity)||identity.value!==this.agentId)throw new Error('Activation runtime identity mismatch');
    this.requestCount++;this.inFlight++;
    try{await this.#channel.operationReady();return await this.#channel.requestOperation('readCommandActivation',input);}finally{this.inFlight--;}
  }

  turnOwnershipScope(): import('@beeline/api-contract/helper-turn-ownership').HelperTurnOwnershipSource | undefined {
    return this.#channel.turn.scope();
  }
  noteOwnedTurnClaim(
    turn: { roomId: string; requestId: string; generationId?: string },
    source: import('@beeline/api-contract/helper-turn-ownership').HelperTurnOwnershipSource,
    onLost: () => void,
  ): void { this.#channel.turn.claimed(turn, source, onLost); }
  releaseOwnedTurn(turn: { roomId: string; requestId: string; generationId?: string }): void { this.#channel.turn.release(turn); }
  noteLegacyTurnClaim(turn: { roomId: string; requestId: string; generationId?: string }): void { this.#channel.turn.claimedLegacy(turn); }
  runWithTurnOwnership<T>(
    turn: { roomId: string; requestId: string; generationId?: string }, task: () => Promise<T>, onLost?: () => void,
  ): Promise<T> | undefined { return this.#channel.turn.runOwned(turn, task, onLost); }

  async execute<Name extends keyof DaemonOperationMap>(
    name: Name,
    input: Input<Name>,
  ): Promise<Output<Name>> {
    if (this.registrationRefusal) throw this.registrationRefusal;
    if (this.#repositoryCredentialRoom !== undefined) {
      if (name !== 'getRoomGitHubToken' || (input as Input<'getRoomGitHubToken'>).roomId !== this.#repositoryCredentialRoom)
        throw new Error('Repository credential reader cannot dispatch another operation');
      return this.#requestHttp(name, input);
    }
    if(name==='readCommandActivation')throw new Error('Activation context requires the command-owned machine adapter');
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== this.agentId) {
      throw new Error('daemon operation agentId does not match the runtime identity');
    }
    this.operationChannelDemanded = true;
    await this.#channel.operationReady();
    if (name === 'postAgentUsage' && candidate.usageSource === undefined)
      return postChangedAgentUsage(this,this.agentId,(input as Input<'postAgentUsage'>).usage) as Promise<Output<Name>>;
    this.requestCount++; this.inFlight++;
    try {
      const result = await this.#channel.requestOperation(name,input);
      if (name === 'postAgentUsage' && (input as Input<'postAgentUsage'>).usage?.spend) {
        const scope=this.#channel.usageAccountScope();
        if(scope)invalidateUsageAccountAttachment(scope.origin,scope.ownerId,this.agentId);
      }
      return result;
    } catch (error) {
      const failure=error as {status?:number;code?:string};
      const status=failure.status??503;
      const refusal=new DaemonApiError(error instanceof Error?error.message:'Machine operation refused',status,
        status===408||status===429||status>=500,failure.code);
      if(status===401)this.authorityRefusalListener?.(refusal);
      throw refusal;
    } finally { this.inFlight--; }
  }

  /** The explicit one-shot repository credential read cannot register another
   * machine owner. Every ordinary runtime operation uses the live connection. */
  async #requestHttp<Name extends keyof DaemonOperationMap>(name: Name, input: Input<Name>): Promise<Output<Name>> {
    const repositoryCredential = name === 'getRoomGitHubToken' && this.#repositoryCredentialRoom !== undefined &&
      (input as Input<'getRoomGitHubToken'>).roomId === this.#repositoryCredentialRoom;
    if (!repositoryCredential)
      throw new Error('HTTP daemon operation requires bootstrap or a registered old server');
    this.requestCount += 1;
    let release: (() => Promise<void>) | undefined;
    let admitted = false;
    let output: Output<Name>;
    try {
      const operation = String(name);
      if (this.readBudget && /^(get|list|read|search)/.test(operation)) {
        release = await this.readBudget.acquire(
          operation === 'getAgentCommands' ||
            operation === 'getRoomInbox' ||
            operation === 'getDaemonBootstrap'
            ? 'urgent'
            : 'background',
          Number.POSITIVE_INFINITY,
        );
      }
      this.inFlight += 1;
      admitted = true;
      const response = await this.fetchImpl(
        endpoint(this.baseUrl, `/v1/daemon/operations/${String(name)}`),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.daemonToken}`,
            'content-type': 'application/json',
            ...helperVersionHeader(this.helperIdentity.releaseVersion),
          },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) {
        const error = await responseError(response);
        if (error.status === 401) this.authorityRefusalListener?.(error);
        if (error.status === 426 && error.code === 'update_required' && error.minVersion)
          this.#channel.requireUpdate(error.minVersion);
        throw error;
      }
      output = (await response.json()) as Output<Name>;
    } catch (error) {
      if (error instanceof ReadBudgetFullError) {
        throw new DaemonApiError(error.message, 429, true, 'read_budget_full', 1_000);
      }
      throw error;
    } finally {
      if (admitted) this.inFlight -= 1;
      await release?.();
    }
    if(name==='postAgentUsage'&&(input as {usage?:{spend?:unknown}}).usage?.spend){
      const scope=this.#channel.usageAccountScope();
      if(scope)invalidateUsageAccountAttachment(scope.origin,scope.ownerId,this.agentId);
    }
    return output;
  }

  private ensureLiveSocket(): void {
    if (this.liveRooms.size || this.roomsChangedListener) this.#channel.start();
  }

  /** Ephemeral request correlation, never persisted or used as turn authority. */
  private readonly liveSubscriptions = new Map<string, {
    requestId: string;
    inboxRequested: boolean;
    commandsSeen: boolean;
    inboxSeen: boolean;
    inboxRequired: boolean;
    ready: boolean;
    capabilities?: {pushIntake:boolean; connectionPresence:boolean; connectionGeneration:number};
  }>();

  private completeLiveRecovery(): void {
  }

  private completeLiveSubscription(roomId: string): void {
    const current = this.liveSubscriptions.get(roomId);
    if (!current || current.ready || !current.capabilities || !current.commandsSeen ||
        (current.inboxRequired && !current.inboxSeen)) return;
    current.ready = true;
    for (const registration of this.liveRooms.get(roomId)?.registrations ?? [])
      registration.onState?.(true, current.capabilities);
    this.completeLiveRecovery();
  }

  private currentLiveSubscription(event: Record<string, unknown>) {
    if (typeof event.roomId !== 'string') return undefined;
    const current = this.liveSubscriptions.get(event.roomId);
    if (!current || (this.#channel.initialSnapshotsV1
      ? event.requestId !== current.requestId
      : event.requestId !== undefined && event.requestId !== current.requestId)) return undefined;
    return current;
  }

  private liveOpened(): void {
    this.liveSubscriptions.clear();
    for (const roomId of this.liveRooms.keys()) this.sendLiveSubscription(roomId);
    // Every wake on this socket is fire-and-forget: a membership written, or
    // a Connect tapped, while this socket was connecting (or between
    // reconnects) never replays its frame. Treat every open as both wakes,
    // so the reconciliation and the drain still reach them.
    this.roomsChangedListener?.();
    this.connectorAssignmentListener?.();
    this.completeLiveRecovery();
  }

  private liveMessage(event: Record<string, unknown>): void {
    if(event.type==='share-viewer-activity'&&typeof event.sessionId==='string'){renewSquireShareOnViewerActivity(event.sessionId);return;}
    if (event.type === 'vault-save') {
      this.vaultSaveListener?.(event);
      return;
    }
    if (
      event.type === 'helper-release' &&
      typeof event.version === 'string' &&
      typeof event.sha === 'string'
    ) {
      this.helperReleaseListener?.({ version: event.version, sha: event.sha });
      return;
    }
    if (event.type === 'rooms-changed') {
      this.roomsChangedListener?.(membershipChange(event));
      return;
    }
    if (
      event.type === 'discovery-wake' &&
      (event.reason === 'listener-resync' || event.reason === 'database-recovered')
    ) {
      this.roomsChangedListener?.();
      return;
    }
    if (event.type === 'corner-complete' && typeof event.roomId === 'string') {
      this.cornerCompleteListener?.(event.roomId);
      return;
    }
    if (event.type === 'connector-assignment') {
      this.connectorAssignmentListener?.();
      return;
    }
    if (event.type === 'usage-refresh') {
      this.usageRefreshListener?.(
        typeof event.requestId === 'string' && /^[0-9a-f-]{36}$/.test(event.requestId) ? event.requestId : undefined,
      );
      return;
    }
    if (event.type === 'agent-sign-in') {
      const frame = agentSignInFrame(event);
      if (frame) this.agentSignInListener?.(frame);
      if (event.step === 'result' && event.outcome === 'signed-in' &&
          typeof event.attemptId === 'string' && event.attemptId) this.configChangedListener?.();
      return;
    }
    if (event.type === 'config-changed') {
      this.configChangedListener?.();
      return;
    }
    if (event.type === 'subscribed' && typeof event.roomId === 'string') {
      const current = this.currentLiveSubscription(event);
      if (!current || current.ready) return;
      const capabilities = event.capabilities as Record<string, unknown> | undefined;
      // Old servers ignore inbox:false. Only the explicit current-server echo
      // retires that lane; an old empty inbox is still a real initial snapshot.
      current.inboxRequired = current.inboxRequested || capabilities?.inboxSnapshot !== false ||
        !this.#channel.initialSnapshotsV1 || capabilities?.initialSnapshotsV1 !== true;
      current.capabilities = {
        pushIntake: capabilities?.pushIntake === true,
        connectionGeneration: this.#channel.reconnects,
        connectionPresence: capabilities?.connectionPresence === true,
      };
      this.completeLiveSubscription(event.roomId);
      return;
    }
    if (
      event.type === 'commands' &&
      typeof event.roomId === 'string' &&
      event.commandProtocol === 1 &&
      Array.isArray(event.commands)
    ) {
      const room = this.liveRooms.get(event.roomId);
      const current = this.currentLiveSubscription(event);
      if (!room || !current) return;
      const commands = event.commands.filter(
        (command): command is AgentCommand =>
          isAgentCommand(command) &&
          command.roomId === event.roomId &&
          command.agentId === this.agentId,
      );
      for (const registration of room.registrations) registration.onCommands?.(commands);
      if (commands.length === event.commands.length) current.commandsSeen = true;
      this.completeLiveSubscription(event.roomId);
      return;
    }
    if (event.type !== 'inbox' || typeof event.roomId !== 'string' || !Array.isArray(event.items)) {
      if (!DAEMON_LIVE_EVENT_TYPES.has(event.type)) this.logUnknownLiveEvent(event.type);
      return;
    }
    const room = this.liveRooms.get(event.roomId);
    const current = this.currentLiveSubscription(event);
    if (!room || !current) return;
    const items: InboxItem[] = [];
    for (const candidate of event.items) {
      if (!candidate || typeof candidate !== 'object') continue;
      const id = (candidate as { id?: unknown }).id;
      if (typeof id === 'string') {
        if (!room.pushedIds.has(id)) items.push(candidate as InboxItem);
        room.pushedIds.add(id);
      }
    }
    while (room.pushedIds.size > 10_000)
      room.pushedIds.delete(room.pushedIds.values().next().value!);
    if (items.length)
      for (const registration of room.registrations)
        registration.onItems?.(items, typeof event.cursor === 'string' ? event.cursor : undefined);
    if (event.items.every(candidate => candidate && typeof candidate === 'object' && typeof candidate.id === 'string'))
      current.inboxSeen = true;
    this.completeLiveSubscription(event.roomId);
  }

  private sendLiveSubscription(roomId: string): void {
    const room = this.liveRooms.get(roomId);
    if (!room || !this.#channel.isOpen()) return;
    const inboxRequested = [...room.registrations].some(registration => registration.onItems !== undefined);
    const previous = this.liveSubscriptions.get(roomId);
    if (previous?.inboxRequested === inboxRequested) return;
    if (previous) this.#channel.send({ type: 'unsubscribe', roomId });
    const current = { requestId: randomUUID(), inboxRequested, commandsSeen: false, inboxSeen: false,
      inboxRequired: true, ready: false };
    this.liveSubscriptions.set(roomId, current);
    this.subscriptionCount += 1;
    if (!this.#channel.send({
      type: 'subscribe',
      roomId,
      requestId: current.requestId,
      inbox: inboxRequested,
      lifecycleId: this.presenceLifecycleId,
      ...(room.cursor ? { cursor: room.cursor } : {}),
      ...[...room.registrations].reverse().find((registration) => registration.presence)?.presence,
    }) && this.liveSubscriptions.get(roomId) === current) this.liveSubscriptions.delete(roomId);
  }
}

export interface ActivatedDaemonTransport {
  runtime: AgentRuntimeRecord;
  client: DaemonApiClient;
}

/**
 * Promote a staged one-use exchange token and persist the opaque daemon token
 * before any daemon operation runs. Re-entry with an already-promoted record
 * performs no exchange and is safe across daemon restarts.
 */
export async function activateDaemonTransport(
  path: string,
  fetchImpl: DaemonFetch = fetch,
  machine?: MachineLink,
): Promise<ActivatedDaemonTransport | undefined> {
  const runtime = await readRuntimeRecord(path);
  const expectedPath = resolve(
    runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey),
    'runtime.json',
  );
  if (resolve(path) !== expectedPath) {
    throw new Error(`refusing daemon token exchange outside canonical runtime path: ${path}`);
  }
  const transport = runtime.transport;
  if (!transport) return undefined;
  if ('daemonToken' in transport && transport.daemonToken) {
    return {
      runtime,
      client: new DaemonApiClient(
        transport.baseUrl,
        transport.daemonToken,
        runtime.agent.publicKey,
        fetchImpl,
        undefined,
        undefined,
        undefined,
        machine,
      ),
    };
  }

  const response = await fetchImpl(endpoint(transport.baseUrl, '/v1/auth/daemon/exchange'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exchangeToken: transport.exchangeToken }),
  });
  if (!response.ok) throw await responseError(response);
  const result = (await response.json()) as { daemonToken?: unknown; agentId?: unknown };
  if (
    typeof result.daemonToken !== 'string' ||
    !/^bdt_[A-Za-z0-9_-]{43}$/.test(result.daemonToken) ||
    result.agentId !== runtime.agent.publicKey
  ) {
    throw new Error('daemon token exchange returned an invalid runtime identity');
  }
  const promoted: AgentRuntimeRecord = {
    ...runtime,
    transport: {
      kind: 'monolith',
      baseUrl: transport.baseUrl,
      daemonToken: result.daemonToken,
    },
  };
  await writeRuntimeRecord(promoted);
  return {
    runtime: promoted,
    client: new DaemonApiClient(
      transport.baseUrl,
      result.daemonToken,
      runtime.agent.publicKey,
      fetchImpl,
      undefined,
      undefined,
      undefined,
      machine,
    ),
  };
}
