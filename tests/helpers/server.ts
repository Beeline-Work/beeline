import { SYSTEM_IDENTITY_ID } from "@beeline/api-contract/system-identity";
import { ensureSystemIdentity, systemLine } from "../../apps/server/src/system-line.js";
import { CORNER_LIFECYCLE_CARD_TYPE } from "../../apps/server/src/room-choice.js";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import type { QueryResultRow } from "pg";
import { migrate, type SqlDatabase, type QueryResult } from "../../apps/server/src/database.js";
import type { ObjectStorage } from "../../apps/server/src/object-storage.js";
import { DatabaseBackgroundWork } from "../../apps/server/src/database-background-work.js";
import { randomUUID } from "node:crypto";

import { OWNED_MODEL_CREDENTIAL_SCHEMA, OwnedModelCredentials, type AuthenticatedOwnedModel } from "../../apps/server/src/owned-model-credential.js";
import { OWNED_MODEL_ATTEMPT_SCHEMA } from "../../apps/server/src/owned-model-attempt.js";
import type { LeaderConnection } from "../../apps/server/src/background-leader.js";
// SENTRY-22: frozen loadCorners/cornerRowsSql templates from release
// 2e6951beb1c06174a9adf4c6af6dbfd27d3f94c6, open list with deck=false.
// Shared corner fact projections stay current; retired app references are frozen.
// The objective, commissioner and owner reads follow the switch release
// (#3341): the [drops data] PR lands only after every replica runs it, so that
// release, not 2e6951be, is the prior image these columns must still serve.
import { cornerFactsSql } from "../../apps/server/src/chat-corner-counts.js";
import { cornerRoomColumnsSql } from "../../apps/server/src/corner-row-projection.js";
import { cornerObjectiveSql } from "../../apps/server/src/corner-objective.js";
import { cornerCommissionerSql } from "../../apps/server/src/corner-opening.js";
import { cornerOwnerSql } from "../../apps/server/src/corner-worker.js";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Vitest global setup: migrates one database per run and shares its snapshot
// file, so each server test database loads the schema instead of migrating
// (see migratedDatabase below).
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalSetupContext } from "vitest/node";
import type {} from 'vitest' with { 'resolution-mode': 'import' };


export class PgliteDatabase implements SqlDatabase {
  readonly backgroundWork = new DatabaseBackgroundWork();
  #client: PGliteInterface | undefined;
  // The vector extension is loaded unconditionally: institutional_memory_items
  // and workspace_skills declare `vector(...)` columns in the shared server
  // schema, so every test that runs `migrate()` needs it available, not only
  // the tests that exercise embeddings.
  constructor(client: PGliteInterface = new PGlite({ extensions: { vector } })) {
    this.#client = client;
  }
  get client(): PGliteInterface {
    if (!this.#client) throw new Error('Test database is closed');
    return this.#client;
  }
  static fromSnapshot(snapshot: Blob | File): PgliteDatabase {
    return new PgliteDatabase(new PGlite({ loadDataDir: snapshot, extensions: { vector } }));
  }
  snapshot(compression?: Parameters<PGliteInterface['dumpDataDir']>[0]): Promise<Blob | File> {
    return this.client.dumpDataDir(compression);
  }
  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (!values.length && sql.split(';').filter((part) => part.trim()).length > 1) {
      await this.client.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const result = values.length
      ? await this.client.query<Row>(sql, values)
      : await this.client.query<Row>(sql);
    return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) };
  }
  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction) => work(this.executor(transaction)));
  }
  async close() {
    await this.backgroundWork.drain();
    const client = this.#client;
    if (!client) return;
    try {
      await client.close();
    } finally {
      // Vitest 2 keeps instance spies in its registry, including restore closures
      // that retain services and this wrapper. PGlite.close() stops PostgreSQL
      // but leaves its WASM heap attached to the engine; release our ownership
      // so every completed test does not retain another engine (~250 MB).
      this.#client = undefined;
    }
  }
  private executor(transaction: Transaction): SqlDatabase {
    return {
      query: async <Row extends QueryResultRow = QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ) => {
        if (!values.length && sql.split(';').filter((part) => part.trim()).length > 1) {
          await transaction.exec(sql);
          return { rows: [], rowCount: 0 };
        }
        const result = values.length
          ? await transaction.query<Row>(sql, values)
          : await transaction.query<Row>(sql);
        return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) };
      },
      transaction: async <T>(work: (database: SqlDatabase) => Promise<T>) =>
        work(this.executor(transaction)),
    };
  }
}

// A migrated schema, copied into each new test database. Vitest's global setup
// migrates once per run (scripts/test-database-setup.ts); without it, or while
// a coverage map is recorded, the first call in each file migrates, so the map
// still sees every test run migrate().
let migratedSnapshot: Promise<Blob> | undefined;
const sharedSnapshotKey = Symbol.for('beeline.server-test-database-snapshot');

declare module 'vitest' {
  export interface ProvidedContext {
    serverTestDatabaseSnapshot?: string;
  }
}

async function loadMigratedSnapshot(): Promise<Blob> {
  // Proof scripts also import this file outside Vitest.
  const shared = process.env.VITEST && !process.env.SERVER_COVERAGE_MAP_DIR
    ? (await import('vitest')).inject('serverTestDatabaseSnapshot') : undefined;
  if (shared) {
    // An immutable template can survive Vitest's per-file module resets.
    // Each PGlite instance still gets its own filesystem and mutable database.
    // Keep only the current run's path so watch reruns cannot accumulate images.
    const state = globalThis as typeof globalThis & {
      [sharedSnapshotKey]?: { path: string; image: Promise<Blob> };
    };
    if (state[sharedSnapshotKey]?.path !== shared) state[sharedSnapshotKey] = {
      path: shared,
      image: readFile(shared).then(bytes => new Blob([bytes])),
    };
    return state[sharedSnapshotKey]!.image;
  }
  const template = new PgliteDatabase();
  try {
    await migrate(template);
    return await template.snapshot('none');
  } finally {
    await template.close();
  }
}

/** A new database with the current schema; each call is an independent copy. */
export async function migratedDatabase(): Promise<PgliteDatabase> {
  migratedSnapshot ??= loadMigratedSnapshot();
  const database = PgliteDatabase.fromSnapshot(await migratedSnapshot);
  // Some callers snapshot or close it before any query; both need it loaded.
  await (database.client as PGlite).waitReady;
  return database;
}

/**
 * In-process object storage for tests: put/get/delete against a map, and a
 * tiny HTTP server so a 302 from `/v1/media/<id>` can follow to real bytes.
 */
export class MemoryObjectStorage {
  readonly blobs = new Map<string, { bytes: Buffer; type: string }>();
  #server?: Server;
  #origin = '';

  get origin(): string {
    return this.#origin;
  }

  asStorage(): ObjectStorage {
    return this as unknown as ObjectStorage;
  }

  async listen(): Promise<string> {
    this.#server = createServer((request, response) => {
      const key = decodeURIComponent((request.url ?? '/').slice(1));
      const blob = this.blobs.get(key);
      if (!blob) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': blob.type,
        'content-length': String(blob.bytes.length),
      });
      response.end(blob.bytes);
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address() as AddressInfo;
    this.#origin = `http://127.0.0.1:${address.port}`;
    return this.#origin;
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) =>
      this.#server!.close((error) => (error ? reject(error) : resolve())),
    );
    this.#server = undefined;
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(key, { bytes: Buffer.from(body), type: contentType });
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    const blob = this.blobs.get(key);
    return blob ? new Uint8Array(blob.bytes) : null;
  }

  presignPost(): { url: string; fields: Record<string, string> } {
    return { url: `${this.#origin}/post`, fields: {} };
  }

  async presignGet(key: string): Promise<string> {
    return `${this.#origin}/${encodeURIComponent(key)}`;
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    const blob = this.blobs.get(key);
    return blob ? { size: blob.bytes.length } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

/** Supply required human metadata when a test saves an older execution fixture anew. */
export function describedWorkflow(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const contract = value as Record<string, unknown>;
  const states = contract.handoffs;
  const terminals = states && typeof states === 'object' && !Array.isArray(states)
    ? Object.entries(states as Record<string, Record<string, unknown>>)
        .filter(([, state]) => state?.kind === 'terminal')
    : [];
  const timeoutTarget =
    (terminals.find(([, state]) => state.status === 'failed') ?? terminals[0])?.[0];
  /** A step or gate with no timeout of its own gets a long one, as the save rules require. */
  const timed = (state: Record<string, unknown>): Record<string, unknown> => {
    const on = state.on && typeof state.on === 'object' ? (state.on as Record<string, string>) : undefined;
    if (state.timeoutSeconds !== undefined || !on || !Object.keys(on).length) return state;
    if (state.kind === undefined && timeoutTarget)
      return { ...state, on: { ...on, timeout: on.timeout ?? timeoutTarget }, timeoutSeconds: 86400 };
    if (state.kind === 'gate' && state.default === undefined)
      return { ...state, timeoutSeconds: 86400, default: Object.keys(on)[0] };
    return state;
  };
  return {
    ...contract,
    summary: contract.summary ?? contract.description,
    ...(states && typeof states === 'object' && !Array.isArray(states) ? {
      handoffs: Object.fromEntries(Object.entries(states).map(([name, state]) => [name,
        state && typeof state === 'object' && !Array.isArray(state)
          ? timed({ does: `Perform ${name.replace(/[_-]/g, ' ')}.`, ...state }) : state])),
    } : {}),
  };
}


/**
 * Records a corner run state as its newest handoff card, the way
 * `corner-lifecycle.ts` writes one; the card is the run state (`corner-run.ts`).
 */
export async function recordCornerRun(
  db: SqlDatabase, cornerId: string, toState: string, outcome?: string,
): Promise<void> {
  await ensureSystemIdentity(db);
  const seq = (await db.query<{ seq: number }>(
    `SELECT COALESCE(max((card->>'seq')::int),0)+1 seq FROM messages WHERE room_id=$1 AND card_type=$2`,
    [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
  )).rows[0]!.seq;
  await systemLine(db, {
    roomId: cornerId, authorId: SYSTEM_IDENTITY_ID,
    subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: '@system' },
    verb: 'handed off', object: toState, presentation: 'card', cardType: CORNER_LIFECYCLE_CARD_TYPE,
    card: { runId: cornerId, toState, outcome: outcome ?? null, seq },
  });
}

/**
 * A corner row plus the facts older fixtures stored on it, written where the
 * code now derives them. An owner with a commissioner is an opening order. An
 * owner alone becomes the corner's creator, or a person's first tag when the
 * corner already has a creator: either names it the worker without making the
 * corner agent-opened. A different worker is a later tag; the run state is a
 * handoff card. Objectives live on briefs and opening orders (`writeCornerObjective`).
 */
export async function insertCornerFacts(db: SqlDatabase, input: {
  cornerId: string;
  lifecycle?: unknown;
  locked?: boolean;
  reviewerAgentId?: string | null;
  ownerAgentId?: string | null;
  workerAgentId?: string | null;
  commissionedBy?: string | null;
  human?: boolean;
  workflowState?: string | null;
  workflowOutcome?: string | null;
}): Promise<void> {
  const lifecycle = input.lifecycle === undefined || input.lifecycle === null ? null
    : typeof input.lifecycle === 'string' ? input.lifecycle : JSON.stringify(input.lifecycle);
  await seedCornerFactsRow(db, input.cornerId, lifecycle, input.locked ?? false, input.reviewerAgentId ?? null);
  if (input.ownerAgentId && input.commissionedBy && !input.human) {
    await seedCornerOpening(db, { cornerId: input.cornerId, agentId: input.ownerAgentId, commissionedBy: input.commissionedBy });
  } else {
    // A person-opened corner's commissioner is the person who created it.
    if (input.commissionedBy)
      await db.query(`UPDATE rooms SET created_by=$2 WHERE id=$1`, [input.cornerId, input.commissionedBy]);
    if (input.ownerAgentId) {
      const created = await db.query(
        `UPDATE rooms SET created_by=$2 WHERE id=$1 AND created_by IS NULL`, [input.cornerId, input.ownerAgentId]);
      const creator = (await db.query<{ created_by: string | null }>(
        `SELECT created_by FROM rooms WHERE id=$1`, [input.cornerId])).rows[0]?.created_by;
      if (!created.rowCount && creator !== input.ownerAgentId) await assignCornerWorker(db, input.cornerId, input.ownerAgentId);
    }
  }
  if (input.workerAgentId && input.workerAgentId !== input.ownerAgentId)
    await assignCornerWorker(db, input.cornerId, input.workerAgentId);
  if (input.workflowState) await recordCornerRun(db, input.cornerId, input.workflowState, input.workflowOutcome ?? undefined);
}

/**
 * Replace a corner's owner the way older fixtures wrote `owner_agent_id`: its
 * first assignment names the new agent (a person's tag when it has none);
 * `null` removes the assignments and an agent creator, leaving no worker.
 */
export async function setCornerOwner(db: SqlDatabase, cornerId: string, agentId: string | null): Promise<void> {
  if (!agentId) {
    await db.query(`DELETE FROM agent_commands WHERE room_id=$1 AND reason IN ('corner_objective','human_tag')`, [cornerId]);
    // An agent creator is how `insertCornerFacts` recorded an owner alone.
    await db.query(`UPDATE rooms SET created_by=NULL WHERE id=$1
      AND created_by IN (SELECT id FROM identities WHERE kind='agent')`, [cornerId]);
    return;
  }
  const moved = await db.query(
    `UPDATE agent_commands SET agent_id=$2 WHERE id=(SELECT id FROM agent_commands
       WHERE room_id=$1 AND reason IN ('corner_objective','human_tag') ORDER BY inbox_sequence LIMIT 1)`,
    [cornerId, agentId],
  );
  if (!moved.rowCount) await assignCornerWorker(db, cornerId, agentId);
}


// Fixture command rows. Real code creates commands only through
// createAgentCommand (agent-command.ts); these seed completed history.

/**
 * A person's tag that assigned `agentId` in a corner, as `routeHumanMessage`
 * records it. The worker is derived from these commands (`cornerImplementerSql`);
 * the row is complete, so it wakes nobody.
 */
export async function assignCornerWorker(db: SqlDatabase, cornerId: string, agentId: string): Promise<void> {
  const id = `assign-${randomUUID()}`;
  await db.query(
    `INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
       root_source_message_id,agent_depth,state,completed_at)
     VALUES($1,$2,$3,$1,'input','human_tag',$1,$1,0,'complete',now())`,
    [id, cornerId, agentId],
  );
}

/** Seed durable opening provenance without queueing work or a visible transcript. */
export async function seedCornerOpening(database: SqlDatabase, input: {
  cornerId: string;
  agentId?: string | null;
  commissionedBy?: string | null;
  fromRoomId?: string;
  requestId?: string;
  openKey?: string;
}): Promise<string> {
  const id = randomUUID();
  const root = randomUUID();
  if (input.commissionedBy) await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,deleted_at)
     SELECT $1,COALESCE(parent_id,id),$3,'Opening fixture',now() FROM rooms WHERE id=$2`,
    [root, input.cornerId, input.commissionedBy],
  );
  await database.query(
    `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,
       action,reason,root_command_id,root_source_message_id,agent_depth,state,private_payload)
     SELECT $1,corner.id,COALESCE($3,(SELECT id FROM identities WHERE kind='agent' ORDER BY id LIMIT 1),corner.created_by),
       NULL,$4,'input','corner_objective',$1,$5,0,'complete',
       jsonb_build_object('text','Opening fixture','authorId',corner.created_by,
         'fromRoomId',COALESCE($6,corner.parent_id::text),'kind','order')
         || CASE WHEN $7::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('openKey',$7::text) END
     FROM rooms corner WHERE corner.id=$2`,
    [id,input.cornerId,input.agentId ?? null,input.requestId ?? id,root,input.fromRoomId ?? null,input.openKey ?? null],
  );
  return id;
}

/** A fixture corner row with exactly the facts a test names. */
export async function seedCornerFactsRow(
  db: SqlDatabase, cornerId: string, lifecycle: string | null, locked: boolean, reviewerAgentId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO corner_facts(corner_id,lifecycle,locked,reviewer_agent_id)
     VALUES($1,COALESCE($2::jsonb,'{"lifecycle":"unknown","checks":"unknown"}'::jsonb),$3,$4)`,
    [cornerId, lifecycle, locked, reviewerAgentId],
  );
  await db.query(
    `INSERT INTO corner_github_cache(corner_id,lifecycle)
     VALUES($1,COALESCE($2::jsonb,'{"lifecycle":"unknown","checks":"unknown"}'::jsonb))
     ON CONFLICT(corner_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle`,
    [cornerId, lifecycle],
  );
}


export const MODEL_OWNER = 'a'.repeat(64), MODEL_AGENT = 'b'.repeat(64);
export const MODEL_WORKSPACE = '11111111-1111-4111-8111-111111111111', MODEL_ROOM = '22222222-2222-4222-8222-222222222222';
export const MODEL = 'synthetic/model', MODEL_TOKEN_HASH = 'c'.repeat(64);
export const MODEL_KEY = Buffer.alloc(32, 7);
export const MODEL_SOURCE = { connectionId: 'synthetic-connection', epoch: 1 };
export const MODEL_CLAIM = { agentId: MODEL_AGENT, commandId: 'synthetic-command', generationId: 'synthetic-generation', source: MODEL_SOURCE };
export interface OwnedModelFixture<T extends SqlDatabase> {
  db: T;
  credentials: OwnedModelCredentials;
  issued: Awaited<ReturnType<OwnedModelCredentials['issueInTransaction']>>;
  actor: AuthenticatedOwnedModel;
}
export async function ownedModelFixture(): Promise<OwnedModelFixture<PgliteDatabase>> {
  const db = await migratedDatabase();
  return seedOwnedModelFixture(db, { installSchema: false });
}
export async function seedOwnedModelFixture<T extends SqlDatabase>(db: T,
  options: { installSchema?: boolean } = {}): Promise<OwnedModelFixture<T>> {
  // Minimal contention fixtures install their own schema. Migrated databases
  // must exercise release wiring without silently repairing missing tables.
  if (options.installSchema !== false) {
    await db.query(OWNED_MODEL_CREDENTIAL_SCHEMA); await db.query(OWNED_MODEL_ATTEMPT_SCHEMA);
  }
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic model agent')`, [MODEL_OWNER, MODEL_AGENT]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [MODEL_AGENT, MODEL_OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic models')`, [MODEL_WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`, [MODEL_ROOM, MODEL_WORKSPACE]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [MODEL_WORKSPACE, MODEL_ROOM, MODEL_AGENT]);
  await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,model_token_hash,state,model)
    VALUES($1,$2,$3,'synthetic sealed fixture',$4,'running',$5)`, [MODEL_AGENT, MODEL_WORKSPACE, MODEL_OWNER, MODEL_TOKEN_HASH, MODEL]);
  await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('synthetic-server',clock_timestamp())`);
  await db.query(`INSERT INTO agent_connections(agent_id,connection_id,epoch,instance_id)
    VALUES($1,$2,$3,'synthetic-server')`, [MODEL_AGENT, MODEL_SOURCE.connectionId, MODEL_SOURCE.epoch]);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,
    agent_depth,state,generation_id,claimed_at,turn_owner_connection_id,turn_owner_epoch)
    VALUES($1,$2,$3,'synthetic-request','input','human_tag',$1,'synthetic-source',0,'claimed',$4,clock_timestamp(),$5,$6)`,
  [MODEL_CLAIM.commandId, MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.generationId, MODEL_SOURCE.connectionId, MODEL_SOURCE.epoch]);
  await db.query(`CREATE TABLE owned_model_test_accounting(id text PRIMARY KEY,amount integer NOT NULL)`);
  const credentials = new OwnedModelCredentials({ currentVersion: 'test-v1', key: version => version === 'test-v1' ? MODEL_KEY : undefined },
    () => MODEL, () => 15 * 60_000);
  const issued = await db.transaction(tx => credentials.issueInTransaction(tx, MODEL_CLAIM));
  const actor = await credentials.authenticate(db, issued.token);
  return { db, credentials, issued, actor };
}


/** PGlite has no real dedicated PostgreSQL backend/session lock. This explicit
 * fixture overrides only the real backend guard; real-PG suites must NEVER
 * import/install it. Production schema contains no bypass or fake-proof hook. */
export async function installBackgroundOwnerTestProof(db:SqlDatabase):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS background_owner_test_backends(pid integer PRIMARY KEY,started_at timestamptz NOT NULL,held boolean NOT NULL);
    CREATE OR REPLACE FUNCTION beeline_background_backend_holds(owner_pid integer,owner_started timestamptz)
    RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM background_owner_test_backends
      WHERE pid=owner_pid AND started_at=owner_started AND held) $$;`);
}
let nextPid=1_000_000;
export async function backgroundOwnerTestLock(db:SqlDatabase,held=true):Promise<Pick<LeaderConnection,'query'>&{lose():Promise<void>}>{
  const pid=++nextPid;
  const row=(await db.query<{backend_pid:number;backend_start:string;held:boolean}>(`INSERT INTO background_owner_test_backends(pid,started_at,held)
    VALUES($1,clock_timestamp(),$2) RETURNING pid backend_pid,started_at::text backend_start,held`,[pid,held])).rows[0]!;
  return {query:async<Row>()=>({rows:[row as unknown as Row]}),lose:async()=>{row.held=false;await db.query(`UPDATE background_owner_test_backends SET held=false WHERE pid=$1`,[pid]);}};
}


/**
 * A corner's worker, derived from its commands: the agent of the latest
 * assignment in the corner — the opening order (`corner_objective`) or a
 * person's tag (`human_tag`) — never the corner's reviewer. Agent tags invite
 * conversation and assign nothing. Without an assignment the opener stands.
 * A newly assigned agent simply receives the next wakes; nobody is stopped.
 * All worker-scoped reads use this expression.
 */
export function priorReleaseCornerImplementerSql(factAlias: string, cornerAlias: string): string {
  // An owner from an assignment is itself an assignment, so the latest one
  // already covers it; only the legacy owner column and the opener remain.
  return `COALESCE((SELECT assignment.agent_id FROM agent_commands assignment
      WHERE assignment.room_id=${cornerAlias}.id AND assignment.reason IN ('corner_objective','human_tag')
        AND assignment.agent_id IS DISTINCT FROM COALESCE(${factAlias}.reviewer_agent_id,
          (SELECT assignment_parent.reviewer_agent_id FROM rooms assignment_parent
           WHERE assignment_parent.id=${cornerAlias}.parent_id))
      ORDER BY assignment.inbox_sequence DESC LIMIT 1),
    ${factAlias}.owner_agent_id,${cornerAlias}.created_by)`;
}

/**
 * A corner's owner: the agent of its opening order (even when that agent is
 * also the Room's reviewer), else (for corners whose commands are gone) the
 * legacy `corner_facts.owner_agent_id`, else the first agent a person tagged in
 * a person-opened corner, never the reviewer. Nothing stores it for new
 * corners; the legacy column is read until it drops. `cornerId` is a SQL
 * expression.
 */
export function priorReleaseCornerOwnerSql(cornerId: string): string {
  // The opener owns its corner even when it is also the Room's reviewer, as
  // createCorner always recorded; a person's tag never hands ownership to it.
  const earliest = (reason: string, skipReviewer: boolean) => `(SELECT opening.agent_id FROM agent_commands opening
        WHERE opening.room_id=owner_corner.id AND opening.reason='${reason}'
          ${skipReviewer ? 'AND opening.agent_id IS DISTINCT FROM owner_corner.reviewer_id' : ''}
        ORDER BY opening.inbox_sequence LIMIT 1)`;
  return `(SELECT COALESCE(${earliest('corner_objective', false)},owner_corner.legacy_owner_id,${earliest('human_tag', true)})
    FROM (SELECT owner_room.id,owner_fact.owner_agent_id legacy_owner_id,
        COALESCE(owner_fact.reviewer_agent_id,owner_parent.reviewer_agent_id) reviewer_id
      FROM rooms owner_room LEFT JOIN corner_facts owner_fact ON owner_fact.corner_id=owner_room.id
      LEFT JOIN rooms owner_parent ON owner_parent.id=owner_room.parent_id
      WHERE owner_room.id=${cornerId}) owner_corner)`;
}


// SENTRY-22: frozen loadCorners/cornerRowsSql templates from release
// 2e6951beb1c06174a9adf4c6af6dbfd27d3f94c6, open list with deck=false.
// Shared corner fact projections stay current; retired app references are frozen.
// The objective, commissioner and owner reads follow the switch release
// (#3341): the [drops data] PR lands only after every replica runs it, so that
// release, not 2e6951be, is the prior image these columns must still serve.






export function priorReleaseCornerListSql(): string {
  const facts = cornerFactsSql('$2');
  const archivedMicros = '(extract(epoch FROM c.archived_at)*1000000)::bigint';
  const createdMicros = '(extract(epoch FROM c.created_at)*1000000)::bigint';
  const archived = false;
  const keyset = '';
  const order = 'ORDER BY c.created_at DESC,c.id DESC';
  const limit = 'LIMIT 31';
  const cornerQuery = `
      SELECT ${cornerRoomColumnsSql},${facts.columns},${cornerObjectiveSql('c')} objective,lm.id latest_id,lm.text latest_text,lm.author_id latest_author_id,
        initiator.id initiator_id,initiator.name initiator_name,
        initiator.handle initiator_handle,initiator.avatar initiator_avatar,
        initiator.face_id initiator_face,
        li.kind latest_author_kind,li.name latest_author_name,agent.identity_id agent_id,
        agent.name agent_name,agent.handle agent_handle,agent.avatar agent_avatar,
        app_binding.installation_id app_installation_id,
        app_binding.instance_id app_instance_id,app_installation.manifest app_manifest,
        ${archivedMicros}::text archived_us,
        ${createdMicros}::text created_us,
        (SELECT max(brief.revision) FROM corner_brief_revisions brief WHERE brief.corner_id=c.id) brief_revision
      FROM rooms c ${facts.joins}
      LEFT JOIN identities initiator
        ON initiator.id=${cornerCommissionerSql('c.id')} AND initiator.kind='human'
      LEFT JOIN identities li ON li.id=lm.author_id
      LEFT JOIN LATERAL (
        SELECT i.id identity_id,
          i.name,i.handle,i.avatar
        FROM identities i
        LEFT JOIN memberships member ON member.room_id=c.id AND member.identity_id=i.id
          AND member.removed_at IS NULL
        WHERE i.id=${cornerOwnerSql('c.id')}
          AND i.kind='agent' LIMIT 1
      ) agent ON true
      LEFT JOIN corner_app_bindings app_binding ON app_binding.corner_id=c.id
      LEFT JOIN corner_app_installations app_installation ON app_installation.id=app_binding.installation_id
      WHERE c.parent_id=$1 AND c.archived_at IS ${archived ? 'NOT NULL' : 'NULL'} AND ${facts.member}
        AND EXISTS (SELECT 1 FROM authorized) ${keyset} ${order} ${limit}`;
  return `WITH authorized AS (
        SELECT r.*,workspace_member.role workspace_role
        FROM rooms r JOIN memberships m ON m.room_id=r.id
        JOIN memberships workspace_member ON workspace_member.workspace_id=r.workspace_id
          AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
          AND workspace_member.removed_at IS NULL
        WHERE r.id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL
      ), selected_corners AS (${cornerQuery})
      SELECT to_jsonb(authorized) room_row,
        COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY ${archived
          ? 'c.archived_at DESC,c.id DESC' : 'c.created_at DESC,c.id DESC'})
          FROM selected_corners c),'[]'::jsonb) corner_rows,
        jsonb_build_object('id',viewer.id,'kind',viewer.kind,'name',viewer.name,
          'handle',viewer.handle,'avatar',viewer.avatar,'face_id',viewer.face_id) viewer_row,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',app.id,'manifest',app.manifest)
          ORDER BY app.connected_at DESC,app.id)
          FROM corner_app_installations app WHERE app.workspace_id=authorized.workspace_id),'[]'::jsonb) app_rows,
        NULL::jsonb deck
      FROM authorized JOIN identities viewer ON viewer.id=$2`;
}


/** Production artifact byte path; Node supplies native disk, session and identity seams. */
export async function phoneArtifactHost(principal: string, origin: string, root: string) {
  const mobile = path.join(root, 'apps/mobile/sources');
  const proof = path.join(root, '.beeline-proof');
  await mkdir(proof, { recursive: true });
  const directory = await mkdtemp(path.join(proof, 'phone-artifact-'));
  const stubs: Record<string, string> = {
    'phone-proof-host': `export const host={bytes:new Map(),requests:[],fetch:async(url,options)=>{host.requests.push(url);return globalThis.fetch(url,options);}};`,
    'react-native': `export const Platform={OS:'android'};`,
    'auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:${JSON.stringify(principal)}});`,
    'auth/monolith-session': `export const monolithSession={fetch:(url,options)=>host.fetch(url,options)};`,
    'buzz/runtime-config': `export const getBuzzRuntimeConfig=()=>({monolithUrl:${JSON.stringify(origin)}});`,
    'buzz/router-owner': `export const routerOwnerArtifactAction=()=>{};`,
    'buzz/artifact-byte-store': `export const createArtifactByteStore=()=>({get:async key=>host.bytes.get(key)??null,set:async(key,value)=>host.bytes.set(key,value),
      remove:async key=>host.bytes.delete(key),clear:async()=>host.bytes.clear(),revoke:async()=>[],localUri:async key=>host.bytes.has(key)?'file:///synthetic/image.png':null});`,
    'modal': `export const Modal={alert(){throw Error('Unexpected modal')}};`,
    'utils/open-external-url': `export const openExternalUrl=()=>{throw Error('Unexpected browser')};`,
  };
  const outfile = path.join(directory, 'phone.mjs');
  try {
    const result = await build({
      stdin: { contents: `export {host} from 'phone-proof-host';
        export {artifactImageSource,artifactLocalUri} from './apps/mobile/sources/buzz/artifact-link';
        export {installMediaCacheConnection} from './apps/mobile/sources/buzz/media-cache-connection';`, resolveDir: root },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
      plugins: [{ name: 'artifact-native-host', setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          let name = args.path;
          if (name.startsWith('@/')) name = name.slice(2);
          else if (name.startsWith('.')) name = path.relative(mobile, path.resolve(args.resolveDir, name)).replace(/\.ts$/, '');
          if (Object.hasOwn(stubs, name)) return { path: name, namespace: 'host' };
          if (args.path.startsWith('@/')) return { path: path.join(mobile, `${name}.ts`) };
        });
        context.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents:
          (args.path === 'phone-proof-host' ? '' : "import {host} from 'phone-proof-host';\n") + stubs[args.path]!, loader: 'js' }));
      } }],
    });
    for (const name of ['immutable-byte-cache.ts', 'artifact-byte-owner.ts', 'artifact-link.ts', 'media-cache-connection.ts'])
      if (!Object.keys(result.metafile!.inputs).some(input => input.endsWith(`/` + name))) throw new Error(`Missing production source ${name}`);
    return { phone: await import(/* @vite-ignore */ pathToFileURL(outfile).href), close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}


// Vitest global setup: migrates one database per run and shares its snapshot
// file, so each server test database loads the schema instead of migrating
// (see migratedDatabase below).







export default async function setup({ provide }: GlobalSetupContext) {
  // A coverage map run migrates inside each file so the map records it.
  if (process.env.SERVER_COVERAGE_MAP_DIR) return;
  const directory = await mkdtemp(join(tmpdir(), 'server-test-database-'));
  const template = new PgliteDatabase();
  try {
    await migrate(template);
    // Workers repeatedly clone this local template. Avoid decompressing the
    // same schema for every test database; this is never a published artifact.
    const path = join(directory, 'migrated.tar');
    await writeFile(path, Buffer.from(await (await template.snapshot('none')).arrayBuffer()));
    provide('serverTestDatabaseSnapshot', path);
  } finally {
    await template.close();
  }
  return () => rm(directory, { recursive: true, force: true });
}
