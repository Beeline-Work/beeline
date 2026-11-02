import { ROUTER_PROTOCOL, ROUTER_MAX_PART_BYTES as PART_BYTES, ROUTER_MAX_PARTS as MAX_PARTS, ROUTER_MAX_BATCH_BYTES as MAX_BYTES } from '@beeline/api-contract/router-protocol';
import { createHash, randomUUID } from 'node:crypto';
import type {
  RouterAuthorityCertificate, RouterCut, RouterFact, RouterFamily, RouterPushFrame,
  RouterSnapshot, RouterSnapshotInput, RouterUnavailable, RouterValues,
} from '@beeline/api-contract/router-protocol';
import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';
import { ROUTER_AUTHORITY_LOCK } from './router-projection-schema.js';

export class RouterProjectionUnavailable extends Error {
  constructor(readonly reason: RouterUnavailable['reason']) { super(`Router projection unavailable: ${reason}`); }
}
export interface RouterValueBuilder {
  (database: SqlDatabase, input: RouterSnapshotInput, viewerId: string): Promise<RouterValues[RouterFamily] | null>;
}
export function routerAuthority(scopes: RouterAuthorityCertificate['scopes']): RouterAuthorityCertificate {
  const ordered = [...scopes].sort((a,b) => a.authorityScope.localeCompare(b.authorityScope));
  if (!ordered.length || ordered.length > 8 || new Set(ordered.map(s => s.authorityScope)).size !== ordered.length)
    throw new RouterProjectionUnavailable('authority');
  return { digest: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'), scopes: ordered };
}
export function routerAtomicGroup(input: RouterSnapshotInput, viewer: string): string {
  return input.family.startsWith('needs-you') ? `needs-you:${input.workspaceId}:${viewer}`
    : input.family === 'room-head' ? `room-head:${input.roomId}:${viewer}` : `room-list:${input.workspaceId}:${viewer}`;
}
export type ResolvedRouterSnapshotInput = { readonly family: RouterFamily; readonly workspaceId:string; readonly roomId?:string };
export async function resolveRouterInput(db: SqlDatabase, input: RouterSnapshotInput | ResolvedRouterSnapshotInput): Promise<ResolvedRouterSnapshotInput> {
  if (input.workspaceId) return {...input,workspaceId:input.workspaceId};
  if (input.family !== 'room-head' || !input.roomId) throw new RouterProjectionUnavailable('dependency');
  const room=(await db.query<{workspace_id:string}>(`SELECT workspace_id FROM rooms WHERE id=$1`,[input.roomId])).rows[0];
  if (!room) throw new RouterProjectionUnavailable('authority');
  return {...input,workspaceId:room.workspace_id};
}
export async function readRouterCertificate(db: SqlDatabase, args: RouterSnapshotInput | ResolvedRouterSnapshotInput, viewer: string): Promise<RouterAuthorityCertificate> {
  const input = await resolveRouterInput(db,args);
  const scopes = [`reader:${viewer}:workspace:${input.workspaceId}`,
    ...(input.roomId ? [`room:${input.roomId}`] : [])];
  const rows = await db.query<{ scope: string; epoch: string }>(
    `SELECT scope,epoch::text FROM router_authority WHERE scope=ANY($1::text[]) ORDER BY scope`, [scopes]);
  if (rows.rows.length !== scopes.length) throw new RouterProjectionUnavailable('authority');
  return routerAuthority(rows.rows.map(row => ({ authorityScope: row.scope, epoch: row.epoch })));
}
export async function readRouterAuthority(db: SqlDatabase, args: RouterSnapshotInput | ResolvedRouterSnapshotInput, viewer: string): Promise<RouterAuthorityCertificate> {
  const input = await resolveRouterInput(db,args);
  const certificate = await readRouterCertificate(db,input,viewer);
  const allowed = await db.query(`SELECT 1 FROM memberships member
    WHERE member.workspace_id=$1 AND member.identity_id=$2 AND member.room_id IS NULL AND member.removed_at IS NULL
    AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rooms room JOIN memberships access
      ON access.room_id=COALESCE(room.parent_id,room.id) AND access.identity_id=$2 AND access.removed_at IS NULL
      WHERE room.id=$3 AND room.workspace_id=$1))`, [input.workspaceId, viewer, input.roomId ?? null]);
  if (!allowed.rowCount) throw new RouterProjectionUnavailable('authority');
  return certificate;
}
/** The logical resource and the exact denied authority domain are distinct.
 * Workspace denial dominates Room denial, even for a Room snapshot. */
export async function deniedRouterAuthorityScope(db: SqlDatabase, args: RouterSnapshotInput | ResolvedRouterSnapshotInput,
  viewer:string):Promise<{scope:string;authorityScope:string}> {
  const input=await resolveRouterInput(db,args);
  const workspace=await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2
    AND room_id IS NULL AND removed_at IS NULL`,[input.workspaceId,viewer]);
  if(!workspace.rowCount)return {scope:input.workspaceId,authorityScope:`reader:${viewer}:workspace:${input.workspaceId}`};
  if(input.roomId)return {scope:input.roomId,authorityScope:`room:${input.roomId}`};
  return {scope:input.workspaceId,authorityScope:`reader:${viewer}:workspace:${input.workspaceId}`};
}
async function currentCertificateScopes(db:SqlDatabase,expected:RouterAuthorityCertificate):Promise<RouterAuthorityCertificate>{
  const rows=await db.query<{scope:string;epoch:string}>(`SELECT scope,epoch::text FROM router_authority WHERE scope=ANY($1::text[]) ORDER BY scope`,
    [expected.scopes.map(s=>s.authorityScope)]);
  if(rows.rows.length!==expected.scopes.length)throw new RouterProjectionUnavailable('authority');
  return routerAuthority(rows.rows.map(row=>({authorityScope:row.scope,epoch:row.epoch})));
}
export async function readRouterCut(db: SqlDatabase, workspace: string): Promise<RouterCut> {
  const stream = `workspace:${workspace}`;
  const row = (await db.query<{ epoch: string; sequence: string }>(
    `SELECT epoch,sequence::text FROM live_streams WHERE id=$1`, [stream])).rows[0];
  const through = Number(row?.sequence);
  if (!row || !Number.isSafeInteger(through) || through < 0) throw new RouterProjectionUnavailable('dependency');
  return { stream, epoch: row.epoch, through, protocol: ROUTER_PROTOCOL };
}

/** All DTO queries, authority and head share this transaction handle. */
export async function buildRouterSnapshot(database: SqlDatabase, input: RouterSnapshotInput, viewer: string,
  build: RouterValueBuilder): Promise<RouterSnapshot> {
  return database.transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const resolved = await resolveRouterInput(db,input);
    const authority = await readRouterAuthority(db, resolved, viewer);
    const value = await build(db, input, viewer);
    if (value === null) throw new RouterProjectionUnavailable('authority');
    const snapshot = { kind: 'snapshot' as const, family: input.family, scope: input.roomId ?? input.workspaceId,
      value, cut: await readRouterCut(db, resolved.workspaceId), atomicGroup: routerAtomicGroup(input, viewer), authority } as RouterSnapshot;
    const limit = input.family === 'needs-you-count' ? 1024 : input.family === 'room-head' ? PART_BYTES : MAX_BYTES;
    if (Buffer.byteLength(JSON.stringify(snapshot)) > limit) throw new RouterProjectionUnavailable('budget');
    return snapshot;
  });
}

/** Separate current snapshot and shared lock through the synchronous send.
 * An async enqueue callback is deliberately rejected by the type contract. */
export async function fenceRouterEnqueue(database: SqlDatabase, input: RouterSnapshotInput, viewer: string,
  expected: RouterAuthorityCertificate, enqueue: () => undefined): Promise<void> {
  await database.transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
    if ((await readRouterAuthority(db, input, viewer)).digest !== expected.digest)
      throw new RouterProjectionUnavailable('authority');
    enqueue();
  });
}

/** Packetization preserves indivisible facts and never truncates a group. */
export function encodeRouterBatch(from: RouterCut, to: RouterCut, facts: readonly RouterFact[]): RouterPushFrame[] {
  if (from.stream !== to.stream || from.epoch !== to.epoch || to.through < from.through)
    throw new RouterProjectionUnavailable('dependency');
  const domains = new Set(facts.flatMap(f => f.authority.scopes.map(s => s.authorityScope)));
  if (domains.size > 256) throw new RouterProjectionUnavailable('budget');
  const batchId = randomUUID();
  const contentDigest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const parts: RouterFact[][] = [[]];
  // Reserve the actual envelope overhead, including the maximum part count.
  const bytes = (part: RouterFact[]) => Buffer.byteLength(JSON.stringify({kind:'push-part',batchId,from,to,
    partIndex:MAX_PARTS-1,partCount:MAX_PARTS,contentDigest,facts:part}));
  for (const fact of facts) {
    if (bytes([fact]) > PART_BYTES) throw new RouterProjectionUnavailable('budget');
    if (bytes([...parts.at(-1)!, fact]) > PART_BYTES) parts.push([]);
    parts.at(-1)!.push(fact);
  }
  if (parts.length > MAX_PARTS) throw new RouterProjectionUnavailable('budget');
  const frames: RouterPushFrame[] = parts.map((part,index) => ({kind:'push-part',batchId,from,to,
    partIndex:index,partCount:parts.length,contentDigest,facts:part}));
  frames.push({kind:'push-commit',batchId,from,to,partCount:parts.length,contentDigest});
  if (frames.reduce((size,f) => size + Buffer.byteLength(JSON.stringify(f)),0) > MAX_BYTES)
    throw new RouterProjectionUnavailable('budget');
  return frames;
}

/** Independent per-server, non-destructive drain. This actor stores delivery
 * positions and DB audience only; it never knows routes or cached client rows. */
export class RouterProjectionDrain {
  constructor(private readonly database: SqlDatabase, private readonly live: LiveHub) {}
  async subscribe(workspace: string,
    project: (db: SqlDatabase, from: RouterCut, to: RouterCut, causes: readonly Record<string, unknown>[]) => Promise<void | (() => Promise<void>)>,
    unavailable: (reason: RouterUnavailable['reason']) => void): Promise<() => void> {
    const stream = `workspace:${workspace}`;
    let stopped = false, dirty = false, running = false, position: RouterCut | undefined;
    const drain = async () => {
      if (stopped || running || !position) return;
      running = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const built = await this.database.transaction(async db => {
            await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const to = await readRouterCut(db, workspace), from = position!;
            if (to.epoch !== from.epoch || to.through < from.through) throw new RouterProjectionUnavailable('retention');
            if (to.through === from.through) return {to,deliver:undefined};
            const entries = await db.query<{sequence: string; event: Record<string, unknown>}>(
              `SELECT sequence::text,event FROM live_journal WHERE stream_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY live_journal.sequence`,
              [stream,from.through,to.through]);
            if (entries.rows.length !== to.through-from.through || entries.rows.some((r,i) => Number(r.sequence)!==from.through+i+1))
              throw new RouterProjectionUnavailable('retention');
            // Builder receives the SAME repeatable-read handle as head/causes.
            const deliver = await project(db, from, to, entries.rows.map(e => e.event));
            return {to,deliver};
          });
          // Release the builder connection before acquiring the independent
          // current-authority fence. A busy pool must not need two slots per
          // queued builder, and PGlite correctly exposes that deadlock.
          if (!stopped && built.deliver) await built.deliver();
          if (!stopped) position = built.to;
        }
      } catch (error) {
        stopped = true;
        unavailable(error instanceof RouterProjectionUnavailable ? error.reason : 'projection');
        release();
      } finally { running = false; }
    };
    const unlisten = this.live.subscribeJournal(streams => { if (streams.includes(stream)) { dirty=true; void drain(); } });
    const unresync = this.live.subscribeResync(() => { dirty=true; void drain(); });
    const release = () => { stopped=true; unlisten(); unresync(); };
    try { position = await readRouterCut(this.database, workspace); void drain(); return release; }
    catch (error) { release(); throw error; }
  }
}

/** One final current-authority fence covers every part in a logical batch. */
export async function fenceRouterBatch(database: SqlDatabase, workspace: string, viewer: string,
  facts: readonly RouterFact[], enqueue: () => undefined): Promise<void> {
  await database.transaction(async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
    for (const fact of facts) {
      const input: ResolvedRouterSnapshotInput = {family: fact.payload.kind === 'authority' ? 'room-list' : fact.payload.family,
        workspaceId:workspace,
        ...(fact.authority.scopes.some(s => s.authorityScope === `room:${fact.payload.scope}`) ? {roomId:fact.payload.scope} : {})};
      const current = fact.payload.kind === 'authority' ? await currentCertificateScopes(db,fact.authority) : await readRouterAuthority(db,input,viewer);
      if(fact.payload.kind==='authority') {
        const target=fact.payload.authorityScope;
        if(!fact.authority.scopes.some(s=>s.authorityScope===target))throw new RouterProjectionUnavailable('authority');
      }
      if (current.digest !== fact.authority.digest)
        throw new RouterProjectionUnavailable('authority');
    }
    enqueue();
  });
}
