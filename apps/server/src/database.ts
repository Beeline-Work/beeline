import { recordPostgresStatementError } from './postgres-error.js';
export { messageSearchDocumentSql, MESSAGE_SEARCH_DOCUMENT_MAX_BYTES } from './message-search-document-sql.js';
import { DATABASE_SCHEMA_WORKFLOW_BACKFILLS } from './database-schema-workflow-backfills.js';
import { DATABASE_SCHEMA_INSTITUTIONAL_MEMORY_ITEMS } from './database-schema-institutional-memory-items.js';
import { DATABASE_SCHEMA_CORNER_FACTS } from './database-schema-corner-facts.js';
import { DATABASE_SCHEMA_AGENT_GRANTS } from './database-schema-agent-grants.js';
import { DATABASE_SCHEMA_TABLES } from './database-schema-tables.js';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import { QueryProfiler } from './query-profile.js';
import { DatabaseBackgroundWork } from './database-background-work.js';
import { migrate, migrateData } from './database-migrate.js';
import { backfillSquireApprovalExpiry, keywordsFromBody, retireStandingPreferences, MESSAGE_SEARCH_BACKFILL_BATCH, backfillMessageSearchDocuments, backfillConnectorMachineId, compactWebhookDeliveries, compactPushClaims, backfillInstitutionalMemoryRollout, backfillSystemEventKinds, backfillPerItemEventSubscriptions, backfillCornerOwed, measureDatabase, measureDatabaseBreakdown } from './database-backfill-squire-approval-expiry.js';






export const SCHEMA = DATABASE_SCHEMA_WORKFLOW_BACKFILLS + DATABASE_SCHEMA_INSTITUTIONAL_MEMORY_ITEMS + DATABASE_SCHEMA_CORNER_FACTS + DATABASE_SCHEMA_AGENT_GRANTS + DATABASE_SCHEMA_TABLES;


export const JOB_STATEMENT_TIMEOUT_MS = 2_000;

export const JOB_LOCK_TIMEOUT_MS = 500;

export const APP_STATEMENT_TIMEOUT_MS = 5_000;

export const APP_POOL_WAIT_TIMEOUT_MS = 2_000;

export const ENRICHMENT_STATEMENT_TIMEOUT_MS = 750;

export const ENRICHMENT_POOL_WAIT_TIMEOUT_MS = 500;

export const HEALTH_STATEMENT_TIMEOUT_MS = 2_000;

export const HEALTH_POOL_WAIT_TIMEOUT_MS = 1_000;

export const MIGRATION_LOCK_TIMEOUT_MS = 1_000;

export const MIGRATION_STATEMENT_TIMEOUT_MS = 10 * 60_000;

export const APP_DATABASE_NAME = 'beeline_app';

export const ENRICHMENT_DATABASE_NAME = 'beeline_enrichment';

export const LONG_RUNNING_DATABASE_NAME = 'beeline_long_running';

export const DIAGNOSTICS_DATABASE_NAME = 'beeline_diagnostics';

export const MIGRATION_DATABASE_NAME = 'beeline_migration';


export function postgresPoolConfig(
  connectionString: string,
  maximumConnections: number,
  mode: 'app' | 'enrichment' | 'long-running' | 'diagnostics' | 'migration' = 'app',
): PoolConfig {
  return {
    connectionString,
    max: maximumConnections,
    // These latency-sensitive connections should not compile each complex read.
    options: '-c jit=off',
    // Half-open TCP connections (peer/NAT dropped without FIN/RST) never emit
    // an error on their own; keepalive probes eventually fail and surface the
    // dead connection so the pool can reclaim it instead of wedging.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name:
      mode === 'enrichment'
        ? ENRICHMENT_DATABASE_NAME
        : mode === 'long-running'
          ? LONG_RUNNING_DATABASE_NAME
          : mode === 'diagnostics'
            ? DIAGNOSTICS_DATABASE_NAME
            : mode === 'migration'
              ? MIGRATION_DATABASE_NAME
            : APP_DATABASE_NAME,
    ...(mode === 'app'
      ? {
          statement_timeout: APP_STATEMENT_TIMEOUT_MS,
          connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
        }
      : mode === 'enrichment'
        ? {
            statement_timeout: ENRICHMENT_STATEMENT_TIMEOUT_MS,
            connectionTimeoutMillis: ENRICHMENT_POOL_WAIT_TIMEOUT_MS,
          }
        : mode === 'diagnostics'
          ? {
              statement_timeout: HEALTH_STATEMENT_TIMEOUT_MS,
              connectionTimeoutMillis: HEALTH_POOL_WAIT_TIMEOUT_MS,
            }
          : mode === 'migration'
            ? {
                connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
                options: `-c jit=off -c lock_timeout=${MIGRATION_LOCK_TIMEOUT_MS}ms -c statement_timeout=${MIGRATION_STATEMENT_TIMEOUT_MS}ms`,
              }
            : {
              statement_timeout: JOB_STATEMENT_TIMEOUT_MS,
              options: `-c jit=off -c lock_timeout=${JOB_LOCK_TIMEOUT_MS}ms`,
              connectionTimeoutMillis: APP_POOL_WAIT_TIMEOUT_MS,
            }),
  };
}


export const TRANSIENT_CONNECTION_CODES = ['57P01', '57P03', '53300', '08006', '08003', '08000', 'ETIMEDOUT', 'EAI_AGAIN'] as const;

export const transientConnectionCodes = new Set<string>(TRANSIENT_CONNECTION_CODES);

/** Named handled states; arbitrary driver details retain the generic error path. */
export type DatabaseFailureKind = typeof TRANSIENT_CONNECTION_CODES[number] | '40P01' | '55P03' | '57014' | 'unknown';

export const TRANSIENT_CONNECTION_MESSAGE =
  /Connection terminated|ECONNRESET|server closed the connection|terminating connection|timeout exceeded when trying to connect/i;


export function isTransientDatabaseConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    (typeof candidate.code === 'string' && transientConnectionCodes.has(candidate.code)) ||
    (typeof candidate.message === 'string' && TRANSIENT_CONNECTION_MESSAGE.test(candidate.message))
  );
}


/** The callback never ran; another admitted boundary may try the durable work. */
export class DatabaseTransactionStartError extends Error {
  readonly code?: string;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'database transaction could not start', { cause });
    this.name = 'DatabaseTransactionStartError';
    if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string')
      this.code = cause.code;
  }
}


export interface PostgresDatabaseOptions {
  pool?: Pool;
  /** Deterministic test override; production uses the pool class limit. */
}


export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}


export interface SqlDatabase {
  backgroundWork?: DatabaseBackgroundWork;
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
    preparedName?: string,
  ): Promise<QueryResult<Row>>;
  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T>;
  poolCounts?(): { total: number; idle: number; waiting: number };
  poolTelemetry?(): PoolTelemetry;
  /** Age of the oldest query this process still has in flight, or null when it
   *  has none. Measured here rather than read from `pg_stat_activity`, which
   *  needs `pg_read_all_stats`: without it Postgres blanks `state` on every
   *  backend, so the old probe's `state='active'` predicate matched nothing and
   *  the field was permanently null in production — a monitor that could not
   *  fail. This one is scoped to this process's own pool and says so. */
  oldestActiveQueryAgeMs?(): Promise<number | null>;
  queryProfiles?(): ReturnType<QueryProfiler['snapshot']>;
  queryWindow?(): ReturnType<QueryProfiler['window']>;
  oldestActiveTransactionAgeMs?(): number | null;
  /** Fires once after an app-pool failure is followed by a successful read.
   * Live subscribers use it to retry discovery without closing their socket. */
  onRecovery?(listener: () => void): () => void;
}


export interface PoolTelemetry {
  checkouts: number;
  checkoutFailures: number;
  statementTimeouts: number;
  deadlocks: number;
  waitMs: number;
  maxWaitMs: number;
  activeMs: number;
  maxActiveMs: number;
  /** Cumulative checkout waits at or below 1, 10, 100, 500, 2000 ms, then above. */
  waitBuckets: readonly number[];
}


export const WAIT_BUCKETS_MS = [1, 10, 100, 500, 2_000];


export interface ClosableDatabase extends SqlDatabase {
  close(): Promise<void>;
  connectDedicated(): Promise<PoolClient>;
}


export const MESSAGE_CURSOR_MS_SQL =
  "floor(extract(epoch FROM (created_at AT TIME ZONE 'UTC'))*1000)::bigint";


// Bump only after every server and auth migration required by that image has
// completed. Machine boot reads this marker; it never mutates the schema.
export const REQUIRED_SCHEMA_VERSION = 48;


export async function markSchemaCurrent(database: SqlDatabase): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS beeline_schema_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      version integer NOT NULL,
      migrated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO beeline_schema_state(singleton, version, migrated_at)
    VALUES (true, ${REQUIRED_SCHEMA_VERSION}, now())
    ON CONFLICT (singleton) DO UPDATE
      SET version=EXCLUDED.version, migrated_at=EXCLUDED.migrated_at;
  `);
}


export async function assertSchemaCurrent(database: SqlDatabase): Promise<void> {
  let result: QueryResult<{ version: number }>;
  try {
    result = await database.query<{ version: number }>(
      `SELECT version FROM beeline_schema_state WHERE singleton=true`,
    );
  } catch (error) {
    // Unavailability is not a schema mismatch and grants no timed observation.
    if (isTransientDatabaseConnectionError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `database schema is not ready for this server image (${detail}); run the release migration step`,
      { cause: error },
    );
  }
  const version = result.rows[0]?.version;
  if (version !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(
      `database schema is not ready for this server image (expected schema version ${REQUIRED_SCHEMA_VERSION}, found ${version ?? 'no marker'}); run the release migration step`,
    );
  }

}


/** Include final SQL so optional filters and inherited-membership rewrites cannot
 * bind a different statement to a name already parsed on this connection. */
export function preparedQuery(name: string, text: string, values: unknown[]) {
  return { name: `${name}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`, text, values };
}


export class PostgresDatabase implements ClosableDatabase {
  readonly backgroundWork = new DatabaseBackgroundWork();
  readonly #pool: Pool;
  #closePromise?: Promise<void>;
  readonly #profiler = new QueryProfiler();
  readonly #transactions = new Map<number, number>();
  /** Start time of every query this process currently has in flight, keyed by
   *  a monotonic ticket so identical concurrent statements cannot collide. */
  readonly #inFlight = new Map<number, number>();
  readonly #recoveryListeners = new Set<() => void>();
  #unavailable = false;
  #nextTicket = 0;
  readonly #telemetry = {
    checkouts: 0, checkoutFailures: 0, statementTimeouts: 0, deadlocks: 0,
    waitMs: 0, maxWaitMs: 0,
    activeMs: 0, maxActiveMs: 0, waitBuckets: [0, 0, 0, 0, 0, 0],
  };

  poolTelemetry(): PoolTelemetry {
    return { ...this.#telemetry, waitBuckets: [...this.#telemetry.waitBuckets] };
  }

  #recordWait(durationMs: number, waiters: number): void {
    this.#profiler.recordCheckout(durationMs, waiters);
    this.#telemetry.checkouts++;
    this.#telemetry.waitMs += durationMs;
    this.#telemetry.maxWaitMs = Math.max(this.#telemetry.maxWaitMs, durationMs);
    const bucket = WAIT_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
    this.#telemetry.waitBuckets[bucket < 0 ? WAIT_BUCKETS_MS.length : bucket]!++;
  }

  #recordActive(durationMs: number): void {
    this.#telemetry.activeMs += durationMs;
    this.#telemetry.maxActiveMs = Math.max(this.#telemetry.maxActiveMs, durationMs);
  }

  onRecovery(listener: () => void): () => void {
    this.#recoveryListeners.add(listener);
    return () => this.#recoveryListeners.delete(listener);
  }

  #noteFailure(error: unknown): void {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code === '57014') this.#telemetry.statementTimeouts++;
    if (code === '40P01') this.#telemetry.deadlocks++;
    if (isTransientDatabaseConnectionError(error) || code === '57014' || code === '53300')
      this.#unavailable = true;
  }

  #noteSuccess(): void {
    if (!this.#unavailable) return;
    this.#unavailable = false;
    for (const listener of this.#recoveryListeners) {
      try {
        listener();
      } catch (error) {
        console.error('postgres recovery listener failed', error);
      }
    }
  }

  async #timed<T>(sql: string, work: () => Promise<T>): Promise<T> {
    const ticket = this.#nextTicket++;
    const startedAt = Date.now();
    this.#inFlight.set(ticket, startedAt);
    let error: unknown;
    try {
      return await work();
    } catch (caught) {
      recordPostgresStatementError(caught,sql);
      error = caught;
      throw caught;
    } finally {
      this.#inFlight.delete(ticket);
      this.#profiler.record(sql, Date.now() - startedAt, error);
    }
  }

  queryProfiles() {
    return this.#profiler.snapshot();
  }

  queryWindow() {
    return this.#profiler.window();
  }

  constructor(
    connectionString: string,
    maximumConnections = 5,
    options: PostgresDatabaseOptions & {
      mode?: 'app' | 'enrichment' | 'long-running' | 'diagnostics' | 'migration';
    } = {},
  ) {
    this.#pool =
      options.pool ??
      new Pool(postgresPoolConfig(connectionString, maximumConnections, options.mode));
    this.#pool.on('error', (error) => {
      console.error('postgres idle client error', error);
    });
  }

  poolCounts() {
    return {
      total: this.#pool.totalCount,
      idle: this.#pool.idleCount,
      waiting: this.#pool.waitingCount,
    };
  }

  async oldestActiveQueryAgeMs(): Promise<number | null> {
    let oldest: number | undefined;
    for (const startedAt of this.#inFlight.values())
      if (oldest === undefined || startedAt < oldest) oldest = startedAt;
    return oldest === undefined ? null : Date.now() - oldest;
  }

  oldestActiveTransactionAgeMs(): number | null {
    let oldest: number | undefined;
    for (const startedAt of this.#transactions.values())
      if (oldest === undefined || startedAt < oldest) oldest = startedAt;
    return oldest === undefined ? null : Date.now() - oldest;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
    preparedName?: string,
  ): Promise<QueryResult<Row>> {
    try {
      const raw = await this.#timed(sql, async () => {
        const { client, release } = await this.#connectCheckedOut();
        try {
          const result = preparedName
            ? await client.query<Row>(preparedQuery(preparedName, sql, values))
            : values.length ? await client.query<Row>(sql, values) : await client.query<Row>(sql);
          release();
          return result;
        } catch (error) {
          release(error instanceof Error ? error : new Error('query failed'));
          throw error;
        }
      });
      this.#noteSuccess();
      const result = Array.isArray(raw) ? raw.at(-1) : raw;
      return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? result?.rows.length ?? 0 };
    } catch (error) {
      this.#noteFailure(error);
      throw error;
    }
  }

  // pg-pool removes its idle error listener while a client is checked out, so
  // a checked-out client that errors with no pending query (or whose query
  // promise never settles) would stay checked out forever and wedge the pool.
  // Arm our own guard that destroys it and frees the slot. `release` is safe
  // to call more than once: later calls are no-ops after the guard fired.
  async #connectCheckedOut(): Promise<{
    client: PoolClient;
    release: (error?: Error) => void;
  }> {
    const startedAt = performance.now();
    let client: PoolClient;
    let waiters = 0;
    try {
      const checkout = this.#pool.connect();
      waiters = this.#pool.waitingCount;
      client = await checkout;
    } catch (error) {
      this.#telemetry.checkoutFailures++;
      throw error;
    }
    this.#recordWait(performance.now() - startedAt, waiters);
    const acquiredAt = performance.now();
    let released = false;
    const onError = (error: Error) => {
      console.error('postgres checked-out client error', error);
      release(error);
    };
    const release = (error?: Error) => {
      if (released) return;
      released = true;
      this.#recordActive(performance.now() - acquiredAt);
      client.removeListener('error', onError);
      try {
        client.release(error);
      } catch {
        // The guard already returned this client to the pool.
      }
    };
    client.once('error', onError);
    return { client, release };
  }

  async transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    const { client, release } = await this.#beginTransaction().catch((error: unknown) => {
      this.#noteFailure(error);
      if (isTransientDatabaseConnectionError(error)) throw new DatabaseTransactionStartError(error);
      throw error;
    });
    const ticket = this.#nextTicket++;
    this.#transactions.set(ticket, Date.now());
    let releaseError: Error | undefined;
    try {
      const database: SqlDatabase = {
        query: async <Row extends QueryResultRow = QueryResultRow>(
          sql: string,
          values: unknown[] = [],
          preparedName?: string,
        ) => {
          const raw = await this.#timed(sql, () =>
            preparedName ? client.query<Row>(preparedQuery(preparedName, sql, values))
              : values.length ? client.query<Row>(sql, values) : client.query<Row>(sql));
          const result = Array.isArray(raw) ? raw.at(-1) : raw;
          return {
            rows: result?.rows ?? [],
            rowCount: result?.rowCount ?? result?.rows.length ?? 0,
          };
        },
        transaction: async <Result>(nested: (database: SqlDatabase) => Promise<Result>) =>
          nested(database),
      };
      const result = await work(database);
      await client.query('COMMIT');
      this.#noteSuccess();
      return result;
    } catch (error) {
      recordPostgresStatementError(error,'COMMIT');
      this.#noteFailure(error);
      if (isTransientDatabaseConnectionError(error))
        releaseError = error instanceof Error ? error : new Error('transaction connection failed');
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The original error is more useful than a rollback failure on a dead connection.
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error('transaction rollback failed');
      }
      throw error;
    } finally {
      this.#transactions.delete(ticket);
      release(releaseError);
    }
  }

  /** One physical acquisition. The listener/leader owns recovery admission. */
  async connectDedicated(): Promise<PoolClient> {
    const startedAt = performance.now();
    let client: PoolClient;
    let waiters = 0;
    try {
      const checkout = this.#pool.connect();
      waiters = this.#pool.waitingCount;
      client = await checkout;
    } catch (error) {
      this.#telemetry.checkoutFailures++;
      this.#noteFailure(error);
      throw error;
    }
    this.#recordWait(performance.now() - startedAt, waiters);
    const acquiredAt = performance.now();
    const onError = (error: Error) => {
      this.#noteFailure(error);
      console.error('dedicated postgres client error', error);
    };
    client.on('error', onError);
    const release = client.release.bind(client);
    let released = false;
    client.release = ((destroy?: boolean | Error) => {
      if (released) return;
      released = true;
      this.#recordActive(performance.now() - acquiredAt);
      client.removeListener('error', onError);
      release(destroy);
    }) as PoolClient['release'];
    return client;
  }

  close(): Promise<void> {
    return this.#closePromise ??= this.backgroundWork.isEmpty
      ? this.#pool.end()
      : this.backgroundWork.drain().then(() => this.#pool.end());
  }

  async #beginTransaction(): Promise<{
    client: PoolClient;
    release: (error?: Error) => void;
  }> {
    const checkedOut = await this.#connectCheckedOut();
    try {
      await checkedOut.client.query('BEGIN');
      return checkedOut;
    } catch (error) {
      checkedOut.release(error instanceof Error ? error : new Error('transaction begin failed'));
      throw error;
    }
  }
}
export { migrate } from './database-migrate.js';
export { migrateData } from './database-migrate.js';
export { backfillSquireApprovalExpiry } from './database-backfill-squire-approval-expiry.js';
export { keywordsFromBody } from './database-backfill-squire-approval-expiry.js';
export { retireStandingPreferences } from './database-backfill-squire-approval-expiry.js';
export { MESSAGE_SEARCH_BACKFILL_BATCH } from './database-backfill-squire-approval-expiry.js';
export { backfillMessageSearchDocuments } from './database-backfill-squire-approval-expiry.js';
export { backfillConnectorMachineId } from './database-backfill-squire-approval-expiry.js';
export { compactWebhookDeliveries } from './database-backfill-squire-approval-expiry.js';
export { compactPushClaims } from './database-backfill-squire-approval-expiry.js';
export { backfillInstitutionalMemoryRollout } from './database-backfill-squire-approval-expiry.js';
export { backfillSystemEventKinds } from './database-backfill-squire-approval-expiry.js';
export { backfillPerItemEventSubscriptions } from './database-backfill-squire-approval-expiry.js';
export { backfillCornerOwed } from './database-backfill-squire-approval-expiry.js';
export { measureDatabase } from './database-backfill-squire-approval-expiry.js';
export { measureDatabaseBreakdown } from './database-backfill-squire-approval-expiry.js';
