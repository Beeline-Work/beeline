import { BackgroundWorkQueue } from './background-work.js';
import { retryRolledBackWork } from './background-work.js';
import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import type { LeaderConnection } from './background-leader.js';

/** Matches the existing production advisory-lock key. No alternate leader. */
export const BACKGROUND_LEADER_LOCK_KEY = 0x0bee11;
const LEASE_MS = 90_000;
const epochBrand: unique symbol = Symbol('background-owner');
const attemptBrand: unique symbol = Symbol('background-attempt');

/** Initial closed core vocabulary. Other jobs require an explicit adapter and
 * schema review before opt-in. These types are never public protocol fields. */
export type BackgroundJobId = 'schedule.fire' | 'systemDm.deliver' | 'push.deliver' | 'checkin.deliver' | 'tray.expire' | 'tray.readiness';
export type BackgroundProviderJob = 'push.deliver' | 'checkin.deliver';
type Provider<J extends BackgroundProviderJob> = J extends 'push.deliver' ? 'apns' | 'fcm' | 'webpush' : 'email';
export type BackgroundEffectRequest<J extends BackgroundProviderJob = BackgroundProviderJob> = {
  [K in BackgroundProviderJob]: Readonly<{ job: K; effectId: string; sourceClaimId: string;
    sourceClaimVersion: string; provider: Provider<K>; canonicalRequest: string }>
}[J];
export type BackgroundEpoch = Readonly<{
  instanceId: string; generation: string; signal: AbortSignal; [epochBrand]: true;
}>;
export type BackgroundAttempt<J extends BackgroundProviderJob = BackgroundProviderJob> = Readonly<{
  id: string; job: J; effectId: string; [attemptBrand]: true;
}>;
export type BackgroundEffectReceipt = Readonly<{
  id: string; job: BackgroundProviderJob; effectId: string;
  state: 'unknown' | 'succeeded' | 'failed'; outcome: string | null;
}>;
export type BackgroundPreparation<J extends BackgroundProviderJob> =
  | { kind: 'new'; attempt: BackgroundAttempt<J> }
  | { kind: 'existing'; receipt: BackgroundEffectReceipt };

export class BackgroundOwnershipLost extends Error {
  constructor() { super('Background ownership changed or expired'); this.name = 'BackgroundOwnershipLost'; }
}
export class BackgroundEffectConflict extends Error {
  constructor() { super('Background effect identity has different immutable bytes'); this.name = 'BackgroundEffectConflict'; }
}
export class BackgroundEnqueueContractError extends Error {
  constructor() { super('Background enqueue must finish synchronously and return undefined'); this.name = 'BackgroundEnqueueContractError'; }
}

/** Installed by the release migration. Job-specific composition supplies
 * readiness outside this core. No recurring scan or outbox. */
export const BACKGROUND_OWNERSHIP_SCHEMA = `
CREATE TABLE IF NOT EXISTS background_leader_owners (
  name text PRIMARY KEY CHECK(name='background'),
  instance_id text NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  claim_nonce uuid NOT NULL,
  lock_backend_pid integer NOT NULL,
  lock_backend_start timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz
);
-- Prior private-schema rows have no valid backend proof until a new claim.
ALTER TABLE background_leader_owners ADD COLUMN IF NOT EXISTS lock_backend_pid integer;
ALTER TABLE background_leader_owners ADD COLUMN IF NOT EXISTS lock_backend_start timestamptz;
CREATE OR REPLACE FUNCTION beeline_background_backend_holds(owner_pid integer,owner_started timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF owner_pid IS NULL OR owner_started IS NULL THEN RETURN false;END IF;
  -- A transaction may have inspected this backend before the final callback.
  -- Never let a cached activity snapshot turn PID reuse into valid ownership.
  PERFORM pg_catalog.pg_stat_clear_snapshot();
  RETURN EXISTS(SELECT 1 FROM pg_catalog.pg_locks held JOIN pg_catalog.pg_stat_activity backend ON backend.pid=held.pid
    WHERE held.locktype='advisory' AND held.pid=owner_pid AND backend.backend_start=owner_started
      AND held.granted AND held.mode='ExclusiveLock' AND held.classid=0
      AND held.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND backend.datid=held.database
      AND held.objid=${BACKGROUND_LEADER_LOCK_KEY}::oid AND held.objsubid=1);
END;
$$;
CREATE TABLE IF NOT EXISTS background_effect_attempts (
  id uuid PRIMARY KEY,
  job_id text NOT NULL CHECK(job_id IN ('push.deliver','checkin.deliver')),
  effect_id text NOT NULL CHECK(length(effect_id) BETWEEN 1 AND 128),
  source_claim_id text NOT NULL CHECK(length(source_claim_id) BETWEEN 1 AND 128),
  source_claim_version text NOT NULL CHECK(length(source_claim_version) BETWEEN 1 AND 128),
  provider text NOT NULL,
  canonical_request text NOT NULL CHECK(octet_length(canonical_request)<=65536),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  instance_id text NOT NULL,
  owner_generation bigint NOT NULL,
  owner_nonce uuid NOT NULL,
  state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','succeeded','failed')),
  outcome text CHECK(outcome IS NULL OR octet_length(outcome)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((job_id='push.deliver' AND provider IN ('apns','fcm','webpush')) OR
    (job_id='checkin.deliver' AND provider='email')),
  CHECK((state='unknown')=(outcome IS NULL)),
  UNIQUE(job_id,effect_id)
);
`;

type LeaseRow = { renewed_ms: number | string; remaining_ms: number | string };
type EpochState = { epoch: BackgroundEpoch; controller: AbortController; nonce: string;
  backendPid:number;backendStart:string;
  until: number; renewedAt: number; timer?: ReturnType<typeof setTimeout>; pending: number };
type AttemptState = { epoch: EpochState; request: BackgroundEffectRequest; digest: string; spent: boolean; entered: boolean };
type AttemptRow = { id: string; job_id: BackgroundProviderJob; effect_id: string; state: BackgroundEffectReceipt['state'];
  outcome: string | null; request_digest: string };
const receipt = (row: AttemptRow): BackgroundEffectReceipt => Object.freeze({ id: row.id, job: row.job_id,
  effectId: row.effect_id, state: row.state, outcome: row.outcome });
const idValid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128;

/** Server-private control/effect primitives, intentionally not wired into a
 * route, barrel or production runner. Concrete adapters must prove their
 * existing due-claim authority and synchronous provider enqueue boundary.
 * Owning an epoch never grants domain permission or provider idempotence. */
export class BackgroundOwnership {
  private readonly epochs = new WeakMap<BackgroundEpoch, EpochState>();
  private readonly attempts = new WeakMap<BackgroundAttempt, AttemptState>();
  private active?: EpochState;
  private readonly preparations = new BackgroundWorkQueue(128);
  constructor(private readonly database: SqlDatabase, readonly instanceId: string,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly wallNow: () => number = Date.now) {
    if (!idValid(instanceId)) throw new Error('Invalid background server instance');
  }

  /** The actual dedicated backend must hold the existing advisory lock. A
   * caller-provided readiness flag or a request ID cannot mint an epoch. */
  async claim(lockConnection: Pick<LeaderConnection, 'query'>): Promise<BackgroundEpoch> {
    const proof = await lockConnection.query<{ held: boolean;backend_pid:number;backend_start:string }>(`SELECT pg_backend_pid() backend_pid,backend.backend_start::text backend_start,EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND granted AND mode='ExclusiveLock' AND classid=0 AND objid=$1::oid AND objsubid=1) held
      FROM pg_catalog.pg_stat_activity backend WHERE backend.pid=pg_backend_pid()`, [BACKGROUND_LEADER_LOCK_KEY]);
    const backend=proof.rows[0];
    if (backend?.held !== true||!Number.isInteger(backend.backend_pid)||backend.backend_pid<=0||backend.backend_pid>2_147_483_647||
      typeof backend.backend_start!=='string'||!backend.backend_start||backend.backend_start.length>128) throw new BackgroundOwnershipLost();
    if (this.active) this.revoke(this.active.epoch);
    const nonce = randomUUID(), started = this.monotonicNow();
    const claimed = await this.database.transaction(async db => {
      const lease = await this.serverLease(db);
      const row = await db.query<{ generation: string }>(`INSERT INTO background_leader_owners(name,instance_id,generation,claim_nonce,lock_backend_pid,lock_backend_start)
        SELECT 'background',$1,1,$2,$3,$4::timestamptz WHERE beeline_background_backend_holds($3,$4::timestamptz)
        ON CONFLICT(name) DO UPDATE SET
          instance_id=EXCLUDED.instance_id,generation=background_leader_owners.generation+1,
          claim_nonce=EXCLUDED.claim_nonce,lock_backend_pid=EXCLUDED.lock_backend_pid,lock_backend_start=EXCLUDED.lock_backend_start,
          acquired_at=clock_timestamp(),released_at=NULL
        RETURNING generation::text`, [this.instanceId, nonce,backend.backend_pid,backend.backend_start]);
      if(!row.rows[0])throw new BackgroundOwnershipLost();
      await this.serverLease(db);
      return { generation: row.rows[0]!.generation, lease };
    });
    if (!/^[1-9][0-9]*$/.test(claimed.generation)) throw new BackgroundOwnershipLost();
    const controller = new AbortController();
    const epoch: BackgroundEpoch = Object.freeze({ instanceId: this.instanceId, generation: claimed.generation,
      signal: controller.signal, [epochBrand]: true as const });
    const state: EpochState = { epoch, controller, nonce,backendPid:backend.backend_pid,backendStart:backend.backend_start,until: 0, renewedAt: 0, pending: 0 };
    this.epochs.set(epoch, state); this.active = state;
    this.acceptDatabaseLease(state, claimed.lease, started);
    this.requireCurrent(state);
    return epoch;
  }

  /** Root's existing committed aggregate-lease feed may extend only the
   * current generation. No read, renewal timer or resurrection is created. */
  observeServerLease(instanceId: string, renewedAt: number, removed = false): void {
    const state = this.active;
    if (!state || state.controller.signal.aborted || instanceId !== this.instanceId ||
      !Number.isSafeInteger(renewedAt) || renewedAt < state.renewedAt) return;
    if (removed) { this.revoke(state.epoch); return; }
    if (renewedAt === state.renewedAt) return;
    state.renewedAt = renewedAt;
    state.until = this.monotonicNow() + Math.max(0, Math.min(LEASE_MS, renewedAt + LEASE_MS - this.wallNow()));
    this.armExpiry(state);
  }

  /** Loss is synchronous. Root's runner listens to this signal to cancel
   * armed jobs; late source evidence cannot revive this object. */
  revoke(epoch: BackgroundEpoch): void {
    const state = this.epochs.get(epoch);
    if (!state) return;
    clearTimeout(state.timer); state.timer = undefined;
    state.controller.abort(new BackgroundOwnershipLost());
    this.preparations.cancel(new BackgroundOwnershipLost());
    if (this.active === state) this.active = undefined;
  }

  async release(epoch: BackgroundEpoch): Promise<void> {
    const state = this.state(epoch); this.revoke(epoch);
    await this.database.query(`UPDATE background_leader_owners SET released_at=clock_timestamp()
      WHERE name='background' AND instance_id=$1 AND generation=$2 AND claim_nonce=$3 AND released_at IS NULL`,
    [this.instanceId, epoch.generation, state.nonce]);
  }

  /** Only bounded database work belongs here. The existing job transaction
   * still owns its due/version claim and domain authorization. Owner/lease
   * locks remain held through immediate pre-commit validation. */
  async withTransaction<T>(epoch: BackgroundEpoch, job: BackgroundJobId, work: (db: SqlDatabase) => Promise<T>): Promise<T> {
    if (!['schedule.fire','systemDm.deliver','push.deliver','checkin.deliver','tray.expire','tray.readiness'].includes(job)) throw new BackgroundOwnershipLost();
    return retryRolledBackWork(() => this.transactionOnce(epoch, job, work), epoch.signal);
  }

  private async transactionOnce<T>(epoch: BackgroundEpoch, job: BackgroundJobId, work: (db: SqlDatabase) => Promise<T>): Promise<T> {
    const state = this.state(epoch); this.requireCurrent(state);
    return this.database.transaction(async db => {
      await this.lockEpoch(db, state);
      // This exact DB-only leaf also validates at actual COMMIT, including a
      // driver delay after the final SELECT. Its uninstalled schema owns one
      // ephemeral transaction fence, never a retained per-expiry ledger.
      if (job === 'tray.expire' || job === 'tray.readiness') await db.query('SELECT beeline_register_tray_clock_owner($1,$2::bigint,$3::uuid)',
        [this.instanceId, epoch.generation, state.nonce]);
      const value = await work(db);
      await this.lockEpoch(db, state);
      return value;
    });
  }

  /** This prior transaction commits UNKNOWN and immutable prepared bytes.
   * A duplicate never produces another dispatch handle. Provider-specific
   * reconciliation/retry policy is a future exact-leaf integration requirement. */
  async prepareEffect<J extends BackgroundProviderJob>(epoch: BackgroundEpoch,
    input: BackgroundEffectRequest<J>): Promise<BackgroundPreparation<J>> {
    const state = this.state(epoch); this.requireCurrent(state);
    this.validateRequest(input);
    state.pending++;
    let held = false;
    const request = Object.freeze({ ...input }) as BackgroundEffectRequest;
    const digest = createHash('sha256').update(JSON.stringify([request.job, request.effectId, request.sourceClaimId,
      request.sourceClaimVersion, request.provider, request.canonicalRequest])).digest('hex');
    try {
      const result = await this.preparations.run(() => retryRolledBackWork(() => this.transactionOnce(epoch, input.job, async db => {
        const inserted = await db.query<AttemptRow>(`INSERT INTO background_effect_attempts
          (id,job_id,effect_id,source_claim_id,source_claim_version,provider,canonical_request,request_digest,
           instance_id,owner_generation,owner_nonce,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unknown') ON CONFLICT(job_id,effect_id) DO NOTHING
          RETURNING id,job_id,effect_id,state,outcome,request_digest`,
        [randomUUID(), request.job, request.effectId, request.sourceClaimId, request.sourceClaimVersion,
          request.provider, request.canonicalRequest, digest, this.instanceId, epoch.generation, state.nonce]);
        if (inserted.rows[0]) return { fresh: true, row: inserted.rows[0] };
        const existing = (await db.query<AttemptRow & { source_claim_id: string; source_claim_version: string; canonical_request: string }>(
          `SELECT id,job_id,effect_id,state,outcome,request_digest,source_claim_id,source_claim_version,canonical_request
          FROM background_effect_attempts WHERE job_id=$1 AND effect_id=$2 FOR SHARE`, [request.job, request.effectId])).rows[0];
        if (!existing || existing.request_digest !== digest || existing.source_claim_id !== request.sourceClaimId ||
          existing.source_claim_version !== request.sourceClaimVersion || existing.canonical_request !== request.canonicalRequest)
          throw new BackgroundEffectConflict();
        return { fresh: false, row: existing };
      }), epoch.signal));
      if (!result.fresh) return { kind: 'existing', receipt: receipt(result.row) };
      this.requireCurrent(state);
      const attempt: BackgroundAttempt<J> = Object.freeze({ id: result.row.id, job: input.job,
        effectId: input.effectId, [attemptBrand]: true as const });
      this.attempts.set(attempt, { epoch: state, request, digest, spent: false, entered: false }); held = true;
      return { kind: 'new', attempt };
    } finally { if (!held) state.pending--; }
  }

  /** Strict undefined return rejects async functions statically; runtime
   * rejects known AsyncFunction before invoking it. A thenable returned by a
   * regular function is an adapter fault AFTER entry: UNKNOWN survives and
   * the handle cannot replay. This does not sandbox malicious internal code. */
  async enqueue<J extends BackgroundProviderJob>(epoch: BackgroundEpoch, attempt: BackgroundAttempt<J>,
    synchronousEnqueue: (request: BackgroundEffectRequest<J>) => undefined): Promise<BackgroundEffectReceipt> {
    const state = this.state(epoch), prepared = this.attempts.get(attempt);
    if (!prepared || prepared.epoch !== state || prepared.spent) throw new BackgroundOwnershipLost();
    prepared.spent = true; state.pending--;
    if (Object.prototype.toString.call(synchronousEnqueue) === '[object AsyncFunction]' ||
      Object.prototype.toString.call(synchronousEnqueue) === '[object AsyncGeneratorFunction]')
      throw new BackgroundEnqueueContractError();
    return this.transactionOnce(epoch, attempt.job, async db => {
      const row = (await db.query<AttemptRow>(`SELECT id,job_id,effect_id,state,outcome,request_digest
        FROM background_effect_attempts WHERE id=$1 AND instance_id=$2 AND owner_generation=$3 AND owner_nonce=$4 FOR UPDATE`,
      [attempt.id, this.instanceId, epoch.generation, state.nonce])).rows[0];
      if (!row || row.request_digest !== prepared.digest || row.state !== 'unknown') throw new BackgroundOwnershipLost();
      this.requireCurrent(state);
      prepared.entered = true;
      const returned: unknown = synchronousEnqueue(prepared.request as BackgroundEffectRequest<J>);
      if (returned !== undefined) {
        // Observe rejection without waiting for a provider result under locks.
        if (returned && typeof (returned as { then?: unknown }).then === 'function') void Promise.resolve(returned).catch(() => {});
        throw new BackgroundEnqueueContractError();
      }
      // UNKNOWN remains durable until a verified exact-attempt outcome.
      return receipt(row);
    });
  }

  /** Settlement records the outcome of an already-admitted immutable attempt;
   * it never admits another dispatch. Root must wire verified provider evidence
   * through an exact adapter; arbitrary provider delivery is not exactly once. */
  async recordOutcome(attempt: BackgroundAttempt, status: 'succeeded' | 'failed', outcome: string): Promise<BackgroundEffectReceipt> {
    const prepared = this.attempts.get(attempt);
    if (!prepared || !prepared.spent || !prepared.entered || !outcome || Buffer.byteLength(outcome) > 8192) throw new BackgroundEffectConflict();
    return this.database.transaction(async db => {
      const row = (await db.query<AttemptRow>(`SELECT id,job_id,effect_id,state,outcome,request_digest
        FROM background_effect_attempts WHERE id=$1 FOR UPDATE`, [attempt.id])).rows[0];
      if (!row || row.request_digest !== prepared.digest) throw new BackgroundEffectConflict();
      if (row.state !== 'unknown') {
        if (row.state !== status || row.outcome !== outcome) throw new BackgroundEffectConflict();
        return receipt(row);
      }
      const changed = (await db.query<AttemptRow>(`UPDATE background_effect_attempts SET state=$2,outcome=$3
        WHERE id=$1 AND state='unknown' RETURNING id,job_id,effect_id,state,outcome,request_digest`, [attempt.id, status, outcome])).rows[0]!;
      return receipt(changed);
    });
  }

  private validateRequest(request: BackgroundEffectRequest): void {
    if (!request || !idValid(request.effectId) || !idValid(request.sourceClaimId) || !idValid(request.sourceClaimVersion) ||
      typeof request.canonicalRequest !== 'string' || Buffer.byteLength(request.canonicalRequest) > 65536 ||
      !(request.job === 'push.deliver' && ['apns','fcm','webpush'].includes(request.provider) ||
        request.job === 'checkin.deliver' && request.provider === 'email')) throw new BackgroundEffectConflict();
  }
  private state(epoch: BackgroundEpoch): EpochState {
    const state = this.epochs.get(epoch); if (!state) throw new BackgroundOwnershipLost(); return state;
  }
  private requireCurrent(state: EpochState): void {
    if (state.controller.signal.aborted || this.active !== state || this.monotonicNow() >= state.until) {
      this.revoke(state.epoch); throw new BackgroundOwnershipLost();
    }
  }
  private async serverLease(db: SqlDatabase): Promise<LeaseRow> {
    const lease = (await db.query<LeaseRow>(`SELECT floor(extract(epoch FROM renewed_at)*1000)::float8 renewed_ms,
      extract(epoch FROM renewed_at+interval '90 seconds'-clock_timestamp())*1000 remaining_ms
      FROM live_server_instances WHERE instance_id=$1 AND renewed_at>clock_timestamp()-interval '90 seconds' FOR SHARE`,
    [this.instanceId])).rows[0];
    if (!lease) throw new BackgroundOwnershipLost(); return lease;
  }
  private async lockEpoch(db: SqlDatabase, state: EpochState): Promise<void> {
    this.requireCurrent(state); const started = this.monotonicNow();
    const lease = (await db.query<LeaseRow>(`SELECT floor(extract(epoch FROM server.renewed_at)*1000)::float8 renewed_ms,
      extract(epoch FROM server.renewed_at+interval '90 seconds'-clock_timestamp())*1000 remaining_ms
      FROM background_leader_owners owner JOIN live_server_instances server ON server.instance_id=owner.instance_id
      WHERE owner.name='background' AND owner.instance_id=$1 AND owner.generation=$2 AND owner.claim_nonce=$3
        AND owner.lock_backend_pid=$4 AND owner.lock_backend_start=$5::timestamptz
        AND beeline_background_backend_holds(owner.lock_backend_pid,owner.lock_backend_start)
        AND owner.released_at IS NULL AND server.renewed_at>clock_timestamp()-interval '90 seconds'
      FOR SHARE OF owner,server`, [this.instanceId, state.epoch.generation, state.nonce,state.backendPid,state.backendStart])).rows[0];
    if (!lease) { this.revoke(state.epoch); throw new BackgroundOwnershipLost(); }
    this.acceptDatabaseLease(state, lease, started); this.requireCurrent(state);
  }
  private acceptDatabaseLease(state: EpochState, lease: LeaseRow, started: number): void {
    const remaining = Number(lease.remaining_ms), renewed = Number(lease.renewed_ms);
    if (!Number.isFinite(remaining) || remaining <= 0 || !Number.isSafeInteger(renewed) || state.controller.signal.aborted) {
      this.revoke(state.epoch); throw new BackgroundOwnershipLost();
    }
    state.renewedAt = Math.max(state.renewedAt, renewed);
    state.until = started + Math.min(LEASE_MS, remaining);
    this.armExpiry(state);
  }
  private armExpiry(state: EpochState): void {
    clearTimeout(state.timer);
    if (state.controller.signal.aborted) return;
    const remaining = state.until - this.monotonicNow();
    if (remaining <= 0) { this.revoke(state.epoch); return; }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.monotonicNow() >= state.until) this.revoke(state.epoch); else this.armExpiry(state);
    }, Math.ceil(remaining));
    state.timer.unref?.();
  }
}
