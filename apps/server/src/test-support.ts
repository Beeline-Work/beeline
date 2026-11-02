import { randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { ensureSystemIdentity } from './system-line.js';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { QueryResultRow } from 'pg';
import { migrate, type SqlDatabase, type QueryResult } from './database.js';
import type { ObjectStorage } from './object-storage.js';
import { DatabaseBackgroundWork } from './database-background-work.js';

export class PgliteDatabase implements SqlDatabase {
  readonly backgroundWork = new DatabaseBackgroundWork();
  // The vector extension is loaded unconditionally: institutional_memory_items
  // and workspace_skills declare `vector(...)` columns in the shared server
  // schema, so every test that runs `migrate()` needs it available, not only
  // the tests that exercise embeddings.
  constructor(readonly client: PGliteInterface = new PGlite({ extensions: { vector } })) {}
  static fromSnapshot(snapshot: Blob | File): PgliteDatabase {
    return new PgliteDatabase(new PGlite({ loadDataDir: snapshot, extensions: { vector } }));
  }
  snapshot(): Promise<Blob | File> {
    return this.client.dumpDataDir();
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
    await this.client.close();
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

declare module 'vitest' {
  export interface ProvidedContext {
    serverTestDatabaseSnapshot?: string;
  }
}

async function loadMigratedSnapshot(): Promise<Blob> {
  // Proof scripts also import this file outside Vitest.
  const shared = process.env.VITEST && !process.env.SERVER_COVERAGE_MAP_DIR
    ? (await import('vitest')).inject('serverTestDatabaseSnapshot') : undefined;
  if (shared) return new Blob([await readFile(shared)]);
  const template = new PgliteDatabase();
  try {
    await migrate(template);
    return await template.snapshot();
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

/**
 * Records a corner run state as its newest handoff card, the way
 * `corner-lifecycle.ts` writes one; the card is the run state (`corner-run.ts`).
 */
export async function recordCornerRun(
  db: SqlDatabase, cornerId: string, toState: string, outcome?: string,
): Promise<void> {
  await ensureSystemIdentity(db);
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
     SELECT $1,corner.id,$5,'handed off','card','corner-workflow-handoff',
       jsonb_build_object('runId',corner.id::text,'toState',$3::text,'outcome',$4::text,
         'seq',COALESCE((SELECT max((card->>'seq')::int) FROM messages
           WHERE room_id=corner.id AND card_type='corner-workflow-handoff'),0)+1)
     FROM rooms corner WHERE corner.id=$2`,
    [`run-${randomUUID()}`, cornerId, toState, outcome ?? null, SYSTEM_IDENTITY_ID],
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
