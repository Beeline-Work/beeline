import { MachineRequestResults } from './machine-request-results.js';
import { helperUsageCodecs } from '@beeline/net/helper-codecs';
import { helperActivationCodecs } from '@beeline/net/helper-activation-codecs';
import { helperTurnCodecs } from '@beeline/net/helper-turn-codecs';
import { helperActivationEnabled,fenceCommandActivationEnqueue } from './helper-activation.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { helperUsageEnabled } from './helper-usage.js';
import { applyHelperOverlay, helperOverlayEnabled, subscribeHelperOverlayDemand } from './helper-overlay.js';
import { changesDaemonInbox } from './daemon-inbox-cause.js';
import { randomUUID } from 'node:crypto';
import type { VaultSaveRelay } from './vault-save-relay.js';
import { isTransientDatabaseConnectionError } from './database.js';
import type { TokenAuth } from './auth.js';
import type { ConnectionPresence } from './connection-presence.js';
import { DAEMON_OPERATION_NAMES, type DaemonService, type OwnedModelClaimCapability } from './daemon-service.js';
import type { HelperVersionGate } from './helper-version-gate.js';
import type { LiveHub, LiveTrace } from './live.js';
import type { PhoneService } from './phone-service.js';
import type { ReleaseNotifier } from './release-notify.js';
import type { SqlDatabase } from './database.js';

export const MAX_LIVE_SESSION_QUEUED_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_ROOMS_PER_SESSION = 8_192;
export const MAX_LIVE_SUBSCRIBE_FRAME_ROOMS = 32;

export interface DaemonLiveDependencies {
  readonly vaultSaveRelay?: VaultSaveRelay;
  readonly auth: TokenAuth;
  readonly phone: PhoneService;
  readonly daemon: DaemonService;
  readonly live: LiveHub;
  readonly database: SqlDatabase;
  readonly connectionPresence?: ConnectionPresence;
  readonly releaseNotify?: ReleaseNotifier;
  readonly helperVersionGate: HelperVersionGate;
  readonly acquireLiveDbTask: () => Promise<() => void>;
  readonly errors: { database: number; invalid: number; internal: number; overload: number };
  readonly counters: { helperVersionRefusals: number; helperForceUpdates: number };
  readonly registry: DaemonConnectionRegistry;
  readonly operationErrorStatus?: (error: unknown) => number;
  /** True while this server is shutting down: its connections stay held for the successor. */
  readonly shuttingDown: () => boolean;
}

function isInboxCursor(value: unknown): value is string {
  return typeof value === 'string' && /^\d+,[0-9a-f]{64}$/.test(value);
}

function isRetryableLiveError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return isTransientDatabaseConnectionError(error) || code === '57014' || code === '53300';
}

/**
 * Newest connection wins, per agent, across old per-agent sockets and machine
 * registrations on this server. Across server instances the connection epoch
 * decides: an instance drops its own session once it learns of a newer epoch.
 */
export class DaemonConnectionRegistry {
  readonly #sessions = new Map<string, DaemonAgentSession>();
  readonly #newestEpoch = new Map<string, number>();

  claim(session: DaemonAgentSession): void {
    const previous = this.#sessions.get(session.agentId);
    this.#sessions.set(session.agentId, session);
    if (previous && previous !== session) previous.evict('replaced');
  }

  release(session: DaemonAgentSession): void {
    if (this.#sessions.get(session.agentId) === session) this.#sessions.delete(session.agentId);
  }

  /** Some instance accepted connection `epoch` for this agent. */
  observeEpoch(agentId: string, epoch: number): void {
    if (epoch > (this.#newestEpoch.get(agentId) ?? 0)) this.#newestEpoch.set(agentId, epoch);
    this.#settle(agentId);
  }

  /** This instance's session learned its own epoch. */
  settled(session: DaemonAgentSession): void {
    this.#settle(session.agentId);
  }

  #settle(agentId: string): void {
    const session = this.#sessions.get(agentId);
    const newest = this.#newestEpoch.get(agentId) ?? 0;
    if (session?.epoch !== undefined && session.epoch < newest) session.evict('replaced');
    // Only the newest epoch matters; forget it once no session can be older.
    if (!session) this.#newestEpoch.delete(agentId);
  }
}

/** How a session reaches its helper: a whole old socket, or one registration on a machine socket. */
export interface DaemonSessionTransport {
  send(event: Record<string, unknown>): void;
  isOpen(): boolean;
  /** Ends this agent's session: an old socket closes; a registration is dropped. */
  drop(code: number, reason: string): void;
  /** False after the socket refused a frame for its helper version. */
  admit(item: Record<string, unknown>): boolean;
  /** Ordinary operations preserve HTTP's per-request token revocation check. */
  authenticateOperation?: () => Promise<{error: string; status: number} | undefined>;
}

/**
 * One agent's live session: authorization, Room subscriptions, command intake,
 * wakes and its own bounded task queue. A machine socket holds one per
 * registered agent, so one agent's overload or failure drops only its own.
 */
export class DaemonAgentSession {
  readonly connectionId = randomUUID();
  epoch: number | undefined;
  turnSource?: { connectionId: string; epoch: number };
  readonly #releases = new Map<string, () => void>();
  readonly #subscriptionIntents = new Map<string, Record<string, unknown>>();
  readonly #wakeReleases: Array<() => void> = [];
  #queuedBytes = 0;
  #tail = Promise.resolve();
  #closed = false;
  readonly #closedSignal = new AbortController();
  #claimed = false;
  #forUpdate = false;
  #turnOwnershipAccepted = false;
  #ownedModelCapability?: OwnedModelClaimCapability;
  readonly #projections = new Set<Promise<unknown>>();

  readonly #overlayReleases=new Map<string,()=>void>();
  usageOwnerId:string|undefined;
  get usageAccountV1():boolean{return this.presence.usageAccountV1===true&&helperUsageEnabled()&&this.usageOwnerId!==undefined&&this.epoch!==undefined;}
  get overlayV1():boolean{return this.presence.overlayV1===true&&helperOverlayEnabled()&&this.epoch!==undefined;}
  get activationContextV1():boolean{return this.presence.activationContextV1===true&&helperActivationEnabled()&&this.epoch!==undefined;}
  get turnContinuationV1():boolean{return this.presence.turnRuntimeId!==undefined;}
  get turnOwnershipV1():boolean{return this.turnSource!==undefined&&this.#turnOwnershipAccepted&&Number.isSafeInteger(this.epoch)&&Number(this.epoch)>0;}
  get ownedModelV1():boolean{return this.turnOwnershipV1&&this.#ownedModelCapability!==undefined&&this.deps.daemon.ownedModelReady();}

  constructor(
    private readonly deps: DaemonLiveDependencies,
    readonly agentId: string,
    private readonly transport: DaemonSessionTransport,
    private readonly presence: {
      lifecycleId?: string;
      turnRuntimeId?: string;
      releaseVersion?: string;
      sourceSha?: string;
      overlayV1?: boolean;
      usageAccountV1?:boolean;
      activationContextV1?:boolean;
      turnOwnershipV1?:boolean;
      ownedModelV1?:boolean;
      daemonOperationsV1?:boolean;
    } = {},
  ) {
    const { live, database } = deps;
    this.#wakeReleases.push(deps.vaultSaveRelay?.attach(agentId, frame => {
      if (!transport.isOpen()) return false;
      transport.send(frame);
      return true;
    }) ?? (() => {}));
    // A fresh Room (or any Room/corner membership change) inserts a
    // `memberships` row whose live notification is Room-scoped — a Room this
    // daemon has never heard of, so it holds no socket subscription for it.
    // Deliver an agent-directed wake instead so discovery starts now.
    this.#wakeReleases.push(
      live.subscribeAll((event) => {
        if (event.type === 'usage-refresh') {
          if (event.agentId === agentId && transport.isOpen())
            transport.send({ type: 'usage-refresh', ...(event.requestId ? { requestId: event.requestId } : {}) });
          return;
        }
        if (event.type === 'agent-sign-in') {
          // Only this agent's own helper hears its sign-in steps; the
          // link/result answers stay on the server for the waiting phone.
          if (event.agentId !== agentId || !transport.isOpen()) return;
          if (event.step === 'start')
            transport.send({
              type: 'agent-sign-in',
              step: 'start',
              attemptId: event.attemptId,
              cardId: event.cardId,
            });
          else if (event.step === 'code')
            transport.send({
              type: 'agent-sign-in',
              step: 'code',
              attemptId: event.attemptId,
              code: event.code,
            });
          return;
        }
        if (
          event.type !== 'invalidate' ||
          event.targetAgentId !== agentId ||
          !transport.isOpen()
        )
          return;
        if(event.reason==='computer-viewer-activity'&&event.requestId){
          transport.send({type:'share-viewer-activity',sessionId:event.requestId});return;
        }
        if (event.reason === 'connector-assignment') {
          transport.send({ type: 'connector-assignment' });
          return;
        }
        if (event.reason === 'postgres:agent_commands') {
          // A command queued for a corner this agent's helper has never
          // watched (no prior membership push reached it, or it reconnected
          // and missed one) carries the same parent/opener a membership push
          // does, so it can start that corner's intake directly. A command
          // for a top-level Room needs no push: every desired Room starts
          // eagerly on membership alone.
          if (!event.parentRoomId) return;
        } else if (event.reason !== 'postgres:memberships') return;
        transport.send({
          type: 'rooms-changed',
          ...(event.roomId ? { roomId: event.roomId } : {}),
          ...(event.parentRoomId ? { parentRoomId: event.parentRoomId } : {}),
          ...(event.openedBy ? { openedBy: event.openedBy } : {}),
          ...(event.archived ? { archived: true } : {}),
          ...(event.removed ? { removed: true } : {}),
        });
      }),
      live.subscribeResync(() =>
        transport.send({ type: 'discovery-wake', reason: 'listener-resync' }),
      ),
    );
    const recovery = database.onRecovery?.(() =>
      transport.send({ type: 'discovery-wake', reason: 'database-recovered' }),
    );
    if (recovery) this.#wakeReleases.push(recovery);
  }

  get subscriptions(): number {
    return this.#releases.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #projection<T>(read: () => Promise<T>): Promise<T> {
    const pending = read();
    this.#projections.add(pending);
    try { return await pending; }
    finally { this.#projections.delete(pending); }
  }

  /**
   * Record this connection as the agent's newest and hold its presence. A
   * failed write is logged: intake still works, presence then rides on the
   * per-Room announcements and HTTP evidence exactly as before.
   */
  async claim(): Promise<void> {
    this.deps.registry.claim(this);
    const presence = this.deps.connectionPresence;
    if (!presence) return;
    try {
      const epoch = await presence.claimConnection(this.agentId, {
        connectionId: this.connectionId,
        ...this.presence,
      });
      this.#claimed = true;
      if (this.#closed) {
        await this.#releaseConnection();
        return;
      }
      this.epoch = epoch;
      this.turnSource = {connectionId:this.connectionId,epoch};
      const requested = true;
      const model = requested ? await this.deps.daemon.negotiateOwnedModel(this.agentId,
        this.turnSource!, this.presence.ownedModelV1 === true) : undefined;
      this.#ownedModelCapability = model?.capability;
      this.#turnOwnershipAccepted = requested && (model?.freeAgent !== true || model.capability !== undefined);
      this.deps.registry.settled(this);
      if(this.presence.usageAccountV1&&helperUsageEnabled())this.usageOwnerId=(await this.deps.database.query<{owner_id:string|null}>(
        'SELECT owner_id FROM agents WHERE agent_id=$1',[this.agentId])).rows[0]?.owner_id??undefined;
    } catch (error) {
      console.error('[presence] connection claim failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** A newer connection for this agent exists (here or on another server). */
  evict(reason: string): void {
    if (this.#closed) return;
    this.transport.drop(4001, reason);
    this.close();
  }

  /** Queue one frame behind this agent's earlier frames. */
  frame(raw: Record<string, unknown>, frameBytes: number): void {
    if (this.#closed) return;
    if (['daemon-operation','request-result','request-ack'].includes(String(raw.type))) {
      // Provider work and waitForCornerWake must not hold the serial intake
      // queue or its database semaphore: Stop/subscriptions still need service.
      // This is the same authenticated service adapter as old HTTP ingress.
      if (!this.presence.daemonOperationsV1 || !this.transport.admit(raw)) return;
      void this.#operation(raw);
      return;
    }
    if (this.#queuedBytes + frameBytes > MAX_LIVE_SESSION_QUEUED_BYTES) {
      this.deps.errors.overload++;
      this.transport.send({type:'live-refused',reason:'live admission overloaded'});
      return;
    }
    // Cancellation does no database work and must fence an already awaited
    // projection immediately, rather than queue behind that same projection.
    if (raw.type === 'unsubscribe' && typeof raw.roomId === 'string') {
      if (!this.transport.admit(raw)) return;
      this.#subscriptionIntents.delete(raw.roomId);
      this.#overlayReleases.get(raw.roomId)?.(); this.#overlayReleases.delete(raw.roomId);
      this.#releases.get(raw.roomId)?.(); this.#releases.delete(raw.roomId);
      return;
    }
    if (raw.type === 'subscribe') {
      const rooms = Array.isArray(raw.roomIds) ? raw.roomIds : [raw.roomId];
      if (rooms.length <= MAX_LIVE_SUBSCRIBE_FRAME_ROOMS)
        for (const room of rooms) if (typeof room === 'string' && room) this.#subscriptionIntents.set(room, raw);
    }
    this.#queuedBytes += frameBytes;
    this.#tail = this.#tail.then(async () => {
      if (this.#closed || !this.transport.isOpen()) return;
      const releaseDbTask = await this.deps.acquireLiveDbTask();
      try {
        if (!this.#closed && this.transport.isOpen()) await this.#process(raw);
      } finally {
        releaseDbTask();
      }
    }).catch((error) => {
      const retryable = isRetryableLiveError(error);
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      const kind = retryable ? 'database' : code === '22P02' ? 'invalid' : 'internal';
      this.deps.errors[kind]++;
      console.error('[live] message failed', { kind, error });
    }).finally(() => {
      for (const [roomId, intent] of this.#subscriptionIntents)
        if (intent === raw) this.#subscriptionIntents.delete(roomId);
      this.#queuedBytes -= frameBytes;
    });
  }

  close(forUpdate = false): void {
    if (this.#closed) return;
    this.#forUpdate = forUpdate;
    this.#closed = true;
    this.#closedSignal.abort();
    this.#ownedModelCapability = undefined;
    for (const release of this.#wakeReleases.splice(0)) release();
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#subscriptionIntents.clear();
    for(const release of this.#overlayReleases.values())release();this.#overlayReleases.clear();
    this.deps.registry.release(this);
    void this.#releaseConnection();
  }

  async #releaseConnection(): Promise<void> {
    if (!this.#claimed || this.deps.shuttingDown()) return;
    this.#claimed = false;
    await this.deps.connectionPresence?.releaseConnection(this.agentId, this.connectionId, this.#forUpdate)
      .catch((error) => console.error('[presence] connection release failed',
        error instanceof Error ? error.message : String(error)));
  }

  async #operation(item: Record<string, unknown>): Promise<void> {
    if (typeof item.requestId !== 'string' || !item.requestId || item.requestId.length > 128) return;
    const results = new MachineRequestResults(this.deps.database);
    const requestId = item.requestId;
    const reply = (result:Record<string,unknown>|undefined) => {
      if (!this.#closed && this.transport.isOpen()) this.transport.send(result
        ? {type:'daemon-operation-result',requestId,...result} : {type:'request-missing',requestId});
    };
    try {
      // Re-check credentials on result reads as well as original dispatch.
      const refusal = this.transport.authenticateOperation ? await this.transport.authenticateOperation()
        : {error:'daemon_token_required',status:401};
      if(refusal){reply(refusal);return;}
      if(item.type === 'request-result') { reply(await results.read(this.agentId,requestId,this.#closedSignal.signal));return; }
      if(item.type === 'request-ack') { await results.acknowledge(this.agentId,requestId);return; }
      reply(await results.execute(this.agentId,requestId,{operation:item.operation,input:item.input},async()=>{
        try {
          if(Object.keys(item).some(key=>!['type','agentId','requestId','operation','input'].includes(key)) ||
            typeof item.operation!=='string' || !DAEMON_OPERATION_NAMES.has(item.operation as keyof DaemonOperationMap) ||
            !item.input || typeof item.input!=='object' || Array.isArray(item.input))
            return {error:'invalid_daemon_operation',status:400};
          const operation=item.operation as keyof DaemonOperationMap;
          const input=item.input as never;
          if(operation==='readCommandActivation'){
            const parsed=helperActivationCodecs.params.parse(input);
            if(parsed.agentId!==this.agentId || parsed.source.connectionId!==this.connectionId || parsed.source.epoch!==this.epoch)
              return {error:'activation_source_mismatch',status:409};
            return {result:await this.deps.daemon.readCommandActivation(parsed,this.agentId)};
          }
          const owned=['claimAgentCommand','acknowledgeAgentCommand','postAgentTurnReceipt'].includes(operation);
          return {result:await this.deps.daemon.execute(operation,input,this.agentId,
            owned ? this.turnSource : undefined,owned ? this.#ownedModelCapability : undefined)};
        } catch(error) {
          return {error:error instanceof Error?error.message:'daemon_operation_refused',status:this.deps.operationErrorStatus?.(error)??503};
        }
      }));
    } catch(error) {
      // Persistence/read failure is not a socket failure and does not turn an
      // admitted request into an invented outcome. Recovery re-reads its id.
      console.error('[live] machine request storage failed',error);
    }
  }

  async #process(item: Record<string, unknown>): Promise<void> {
    if (!this.transport.admit(item)) return;
    if (item.type === 'turn-operation') {
      const operation = item.operation;
      if (!this.turnOwnershipV1 || this.epoch === undefined || typeof item.requestId !== 'string' ||
          !item.requestId || item.requestId.length > 128 ||
          (operation !== 'claimAgentCommand' && operation !== 'postAgentTurnReceipt' && operation !== 'acknowledgeAgentCommand')) return;
      try {
        if (Object.keys(item).some(key => !['type', 'agentId', 'requestId', 'operation', 'input'].includes(key)))
          throw new Error('Turn unknown frame field');
        const input = helperTurnCodecs(operation).params.parse(item.input);
        if ('agentId' in input && input.agentId !== this.agentId) throw new Error('Turn registration mismatch');
        const source = this.turnSource!;
        const result = helperTurnCodecs(operation).result.parse(await this.deps.daemon.execute(operation, input, this.agentId, source, this.#ownedModelCapability));
        const reply = { type: 'turn-result', requestId: item.requestId, result };
        await this.deps.daemon.fenceOwnedTurnReply(this.agentId, source, input, () => {
          if (!this.#closed && this.transport.isOpen()) this.transport.send(reply);
        }, operation === 'claimAgentCommand');
      } catch (error) {
        if (!this.#closed && this.transport.isOpen())
          this.transport.send({ type: 'turn-result', requestId: item.requestId, error: 'turn_operation_unconfirmed',
            status: this.deps.operationErrorStatus?.(error) ?? 503 });
      }
      return;
    }
    if(item.type==='activation-context'){
      if(!this.activationContextV1||typeof item.requestId!=='string'||!item.requestId||item.requestId.length>128)return;
      try{
        if(Object.keys(item).some(key=>!['type','requestId','agentId','input'].includes(key)))throw new Error('Activation unknown frame field');
        const input=helperActivationCodecs.params.parse(item.input);
        if(input.agentId!==this.agentId||input.source.connectionId!==this.connectionId||input.source.epoch!==this.epoch)
          throw new Error('Activation registration source mismatch');
        const snapshot=helperActivationCodecs.result.parse(await this.deps.daemon.readCommandActivation(input,this.agentId));
        const accepted=await fenceCommandActivationEnqueue(this.deps.database,snapshot,current=>{
          const reply={type:'activation-context-result',requestId:item.requestId,result:current};
          if(!this.#closed&&this.transport.isOpen())this.transport.send(reply);
        });
        if(!accepted)throw new Error('Activation source changed before enqueue');
      }catch{
        if(!this.#closed&&this.transport.isOpen())this.transport.send({type:'activation-context-result',requestId:item.requestId,error:'activation_context_refused'});
      }
      return;
    }
    if(item.type==='usage-operation'){
      const names=['publishAgentUsageAccount','attachAgentUsageAccount','postAgentUsage'] as const;
      if(!this.usageAccountV1||typeof item.requestId!=='string'||!item.requestId||item.requestId.length>128||
        !names.includes(item.operation as typeof names[number]))return;
      let input:Record<string,unknown>|undefined;
      try{input=helperUsageCodecs(item.operation as typeof names[number]).params.parse(item.input) as unknown as Record<string,unknown>;}catch{
        this.transport.send({type:'usage-result',requestId:item.requestId,error:'usage_operation_invalid'});return;
      }
      const sourceInput=item.operation==='postAgentUsage'?input?.usageSource:input;
      const control=sourceInput&&typeof sourceInput==='object'?sourceInput as Record<string,unknown>:undefined;
      const source=control?.source&&typeof control.source==='object'?control.source as Record<string,unknown>:undefined;
      try{
        if(!input||input.agentId!==this.agentId||source?.connectionId!==this.connectionId||source.epoch!==this.epoch||
          (item.operation!=='attachAgentUsageAccount'&&control?.ownerId!==this.usageOwnerId))throw new Error('Usage registration source mismatch');
        const operation=item.operation as typeof names[number];
        const rawResult=await this.deps.daemon.execute(operation,input as unknown as DaemonOperationMap[typeof operation]['input'],this.agentId);
        const result=helperUsageCodecs(operation).result.parse(rawResult);
        const reply={type:'usage-result',requestId:item.requestId,result};
        if(!this.#closed&&this.transport.isOpen())this.transport.send(reply);
      }catch{
        if(!this.#closed&&this.transport.isOpen())this.transport.send({type:'usage-result',requestId:item.requestId,error:'usage_operation_refused'});
      }
      return;
    }
    if(item.type==='overlay-update'){
      if(!this.overlayV1||typeof item.requestId!=='string'||item.requestId.length>128||this.epoch===undefined)return;
      const result=await applyHelperOverlay(this.deps.database,this.agentId,{connectionId:this.connectionId,epoch:this.epoch},item.frame);
      if(result.event){const event={...result.event,localOrigin:true as const};this.deps.live.publish(event);}
      if(!this.#closed&&this.transport.isOpen())this.transport.send({type:'overlay-ack',requestId:item.requestId,...result.ack});
      return;
    }
    if (item.type === 'unsubscribe' && typeof item.roomId === 'string') {
      this.#overlayReleases.get(item.roomId)?.();this.#overlayReleases.delete(item.roomId);
      this.#releases.get(item.roomId)?.();
      this.#releases.delete(item.roomId);
      return;
    }
    if (item.type !== 'subscribe') return;
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
    if (requestedRoomIds.length > MAX_LIVE_SUBSCRIBE_FRAME_ROOMS ||
        this.#releases.size + requestedRoomIds.filter((id) => !this.#releases.has(id)).length >
          MAX_LIVE_ROOMS_PER_SESSION) {
      this.deps.errors.invalid++;
      this.transport.send({type:'live-refused',reason:'live subscription limit'});
      return;
    }
    const readableRooms = await this.deps.phone.canReadRooms(requestedRoomIds, this.agentId);
    for (const roomId of requestedRoomIds) {
      if (!readableRooms.has(roomId) || this.#releases.has(roomId) || this.#closed ||
          this.#subscriptionIntents.get(roomId) !== item) continue;
      await this.#subscribe(roomId, item);
    }
  }

  async #subscribe(roomId: string, item: Record<string, unknown>): Promise<void> {
    const { live, daemon } = this.deps;
    const transport = this.transport;
    const agentId = this.agentId;
    const requestId = typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 128
      ? item.requestId : undefined;
    const correlation = requestId ? { requestId } : {};
    const wantsInbox = item.inbox !== false;
    let active = true;
    if(this.overlayV1&&!this.#overlayReleases.has(roomId)){
      this.#overlayReleases.set(roomId,subscribeHelperOverlayDemand(this.deps.database,roomId,demand=>{
        if(!this.#closed&&transport.isOpen())transport.send({type:'overlay-demand',...demand});
      }));
    }
    let cursor = isInboxCursor(item.cursor) ? item.cursor : undefined;
    let replaying = false;
    let replayRequested = false;
    let replayTrigger: { reason: string; trace: LiveTrace } | undefined;
    let commandsPushing = false;
    let commandsRequested = false;
    let commandTrigger: { reason: string; trace: LiveTrace } | undefined;
    const replay = async (trigger?: { reason: string; trace: LiveTrace }) => {
      if (!wantsInbox || !active || this.#closed) return;
      replayRequested = true;
      if (trigger) replayTrigger = trigger;
      if (replaying) return;
      replaying = true;
      try {
        while (replayRequested && active && transport.isOpen() && !this.#closed) {
          replayRequested = false;
          const inbox = await daemon.execute(
            'getRoomInbox',
            {
              roomId,
              ...(cursor ? { after: cursor, rewind: true } : { startAtLatest: true }),
              limit: 200,
            },
            agentId,
          );
          if (!active || this.#closed || !transport.isOpen()) return;
          cursor = inbox.cursor ?? cursor;
          const currentTrigger = replayTrigger;
          replayTrigger = undefined;
          transport.send({
            type: 'inbox',
            roomId,
            ...correlation,
            items: inbox.items,
            ...(cursor ? { cursor } : {}),
            ...(currentTrigger ? { trigger: currentTrigger } : {}),
          });
        }
      } catch (error) {
        if (!active || this.#closed) return;
        console.error(
          '[live] daemon replay failed',
          error instanceof Error ? error.message : String(error),
        );

      } finally {
        replaying = false;
      }
    };
    const pushCommands = async (trigger?: { reason: string; trace: LiveTrace }) => {
      if (!active || this.#closed) return;
      commandsRequested = true;
      if (trigger) commandTrigger = trigger;
      if (commandsPushing) return;
      commandsPushing = true;
      try {
        while (commandsRequested && active && transport.isOpen() && !this.#closed) {
          commandsRequested = false;
          const page = await daemon.execute('getAgentCommands', { roomId }, agentId,
            this.turnOwnershipV1 ? this.turnSource : undefined);
          if (!active || this.#closed || !transport.isOpen()) return;
          const currentTrigger = commandTrigger;
          commandTrigger = undefined;
          transport.send({
            type: 'commands',
            roomId,
            ...correlation,
            commandProtocol: page.commandProtocol,
            commands: page.commands,
            ...(currentTrigger ? { trigger: currentTrigger } : {}),
          });
        }
      } catch (error) {
        if (!active || this.#closed) return;
        console.error(
          '[live] daemon command push failed',
          error instanceof Error ? error.message : String(error),
        );

      } finally {
        commandsPushing = false;
      }
    };
    const unsubscribe = live.subscribe(roomId, (event) => {
        if (!active || this.#closed) return;
        // Presence and streaming overlays are not durable inbox
        // invalidations. Replaying for them turns every evidence
        // refresh into an unrelated Room read on every daemon
        // listener. Commands have their own targeted projection;
        // their source message is delivered by its message event.
        if (event.type !== 'invalidate') return;
        // Read marks only reconcile the reader's phone devices.
        if (event.readerId) return;
        // A child corner's status changed; only corner lists read it.
        if (event.reason === 'corner-status') return;
        const trigger = event.trace
          ? { reason: event.reason, trace: event.trace }
          : undefined;
        if (event.reason === 'agent-config') {
          // A phone-side model/effort selection change for this
          // agent. No inbox replay: the durable fact is the
          // agent-model system line, and the daemon needs only the
          // wake to hot-restart its retained sessions.
          if (event.targetAgentId === agentId && transport.isOpen())
            transport.send({ type: 'config-changed', roomId });
          return;
        }
        if (event.reason === 'postgres:agent_commands') {
          // A review wake is held while another agent in the corner holds a
          // live lease. That agent's command ending writes no row for this
          // agent, so its release is the wake.
          if (event.targetAgentId === agentId || event.commandReleased)
            void this.#projection(() => pushCommands(trigger));
          return;
        }
        if (event.reason === 'postgres:rooms' && event.repositoryChanged) {
          if (transport.isOpen())
            transport.send({ type: 'rooms-changed', roomId, repositoryChanged: true });
          return;
        }
        if (event.closeRequested && ['postgres:rooms', 'postgres:corner_facts', 'postgres:corner_github_cache'].includes(event.reason ?? '')) {
          if (transport.isOpen()) transport.send({ type: 'corner-complete', roomId });
          return;
        }
        if (wantsInbox && changesDaemonInbox(event)) void this.#projection(() => replay(trigger));
      });
    this.#releases.set(roomId, () => { active = false; unsubscribe(); });
    const lifecycleId =
      typeof item.lifecycleId === 'string' && item.lifecycleId.length <= 128
        ? item.lifecycleId
        : undefined;
    if (lifecycleId)
      try {
        await this.deps.connectionPresence?.announce(roomId, agentId, {
          lifecycleId,
          ...(typeof item.releaseVersion === 'string'
            ? { releaseVersion: item.releaseVersion }
            : {}),
          ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
          ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
        });
      } catch (error) {
        console.error('[presence] startup announcement failed', error);
      }
    if (!active || !transport.isOpen() || this.#closed) return;
    // Read under the existing admission slot before certifying subscription
    // recovery. A successful control frame alone is never a caught-up owner.
    await replay();
    await pushCommands();
    if (!active || !transport.isOpen() || this.#closed) return;
    transport.send({
      type: 'subscribed',
      roomId,
      ...correlation,
      capabilities: {
        initialSnapshotsV1: true,
        inboxSnapshot: wantsInbox,
        pushIntake: true,
        connectionPresence: Boolean(this.deps.connectionPresence),
        discoveryWake: true,
      },
    });
  }
}


export { MACHINE_SOCKET_PROTOCOL } from './machine-connection.js';
