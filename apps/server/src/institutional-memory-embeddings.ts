/**
 * Meaning-based recall for institutional memory and workspace skills.
 *
 * One embedding model, one endpoint, one env var: `voyage-4-lite` (OpenRouter,
 * paid — never a `:free` model, whose inputs a provider may train on) via
 * `OPENROUTER_EMBEDDING_API_KEY`. This is the server's own key, separate from
 * any agent-side OpenRouter routing (`apps/body/src/openrouter-routing.ts`),
 * because embedding happens at save time and search time here, not inside a
 * harness turn.
 *
 * Voyage's asymmetric retrieval mode matters: a stored item is embedded with
 * `input_type: "document"`, a search or snapshot query with
 * `input_type: "query"`. Verified against the live endpoint (see the PR body
 * for the recorded cosine similarities) — without this distinction, an
 * unrelated fact can out-score the right one; with it, the right fact wins.
 *
 * Every embedding call here is best-effort: a failure or timeout returns
 * `outcome` instead of throwing, so a caller never blocks a save or a turn on
 * this network round trip. `embedOne`'s `embed` parameter lets a test replace
 * the network call with a deterministic fake without touching env or fetch.
 *
 * NO POLLING: there is no timer that scans the database for unembedded rows.
 * A save schedules its OWN row's embed (`scheduleEmbedInstitutionalMemoryItem`
 * / `scheduleEmbedWorkspaceSkillVersion`), retried with in-process backoff
 * bounded to that one row; the only scan is `backfillInstitutionalMemory
 * EmbeddingsOnce`, run exactly once at server start (see `index.ts`) to catch
 * rows saved before this feature shipped, or whose in-process retry died with
 * a restarted process. It never re-runs on its own.
 */
import {
  INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS,
  INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR,
  INSTITUTIONAL_MEMORY_EMBEDDING_MODEL,
} from '@beeline/api-contract/daemon';
import type { QueryResultRow } from 'pg';
import type { SqlDatabase } from './database.js';

export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
export const EMBEDDING_FETCH_TIMEOUT_MS = 10_000;
export const EMBEDDING_BACKFILL_BATCH = 20;
/** Bounded in-process retry for one row's embed, never a database scan. */
export const EMBED_RETRY_BACKOFF_MS = [5_000, 15_000, 60_000];

export function memoryEnvLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type EmbeddingInputType = 'query' | 'document';
export type EmbeddingOutcome = 'served' | 'timed-out' | 'disabled' | 'error';

export interface EmbedResult {
  readonly vector?: readonly number[];
  readonly outcome: EmbeddingOutcome;
  readonly ms: number;
}

/** One text in, one vector (or a reason it did not come back) out. */
export type EmbedFn = (text: string, inputType: EmbeddingInputType, signal?: AbortSignal) => Promise<EmbedResult>;
/** Several texts in, one vector (or undefined) per input, in order. Batching
 *  one HTTP call over N rows is why the startup backfill stays cheap. */
export type EmbedBatchFn = (
  texts: readonly string[],
  inputType: EmbeddingInputType,
) => Promise<(readonly number[] | undefined)[] | undefined>;

/** Bounded so a dead key or outage cannot flood logs: the first failure
 *  always logs, afterward only every Nth. Never logs input text or the key —
 *  only the HTTP status / error reason and the input type. */
const EMBEDDING_FAILURE_LOG_PERIOD = 100;
let embeddingFailureCount = 0;

function noteEmbeddingFailure(reason: string, inputType: EmbeddingInputType): void {
  embeddingFailureCount += 1;
  if (embeddingFailureCount === 1 || embeddingFailureCount % EMBEDDING_FAILURE_LOG_PERIOD === 0) {
    console.error(
      `[institutional-memory] embedding call failed: ${reason} (input_type=${inputType}, failure #${embeddingFailureCount} since startup)`,
    );
  }
}

/** Only for tests: reset the bounded failure-log counter between cases. */
export function resetEmbeddingFailureLogForTests(): void {
  embeddingFailureCount = 0;
}

function describeEmbeddingFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError' ? 'timed out' : error.name;
  }
  return 'unknown error';
}

async function callOpenRouterEmbeddings(
  texts: readonly string[],
  inputType: EmbeddingInputType,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<(readonly number[] | undefined)[] | undefined> {
  const env = options.env ?? process.env;
  const apiKey = env[INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR]?.trim();
  if (!apiKey || !texts.length) return undefined;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: INSTITUTIONAL_MEMORY_EMBEDDING_MODEL,
        input: texts,
        dimensions: INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS,
        input_type: inputType,
      }),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? EMBEDDING_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      noteEmbeddingFailure(`HTTP ${response.status}`, inputType);
      return undefined;
    }
    const body = (await response.json()) as {
      data?: readonly { embedding?: readonly number[]; index?: number }[];
    };
    if (!Array.isArray(body.data)) {
      noteEmbeddingFailure('malformed response body', inputType);
      return undefined;
    }
    const byIndex = new Map(body.data.map((entry, position) => [entry.index ?? position, entry.embedding]));
    return texts.map((_, index) => {
      const vector = byIndex.get(index);
      return Array.isArray(vector) && vector.length === INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS
        ? vector
        : undefined;
    });
  } catch (error) {
    noteEmbeddingFailure(describeEmbeddingFailure(error), inputType);
    return undefined;
  }
}

/** The production embedder: one text, via OpenRouter, best-effort. */
export function createDefaultEmbedFn(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): EmbedFn {
  return async (text, inputType, signal) => {
    const env = options.env ?? process.env;
    if (!env[INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR]?.trim()) {
      return { outcome: 'disabled', ms: 0 };
    }
    const startedAt = performance.now();
    const result = await callOpenRouterEmbeddings([text], inputType, { ...options, signal });
    const ms = performance.now() - startedAt;
    const vector = result?.[0];
    if (!vector) {
      const timedOut = ms >= (options.timeoutMs ?? EMBEDDING_FETCH_TIMEOUT_MS) - 5;
      return { outcome: timedOut ? 'timed-out' : 'error', ms };
    }
    return { vector, outcome: 'served', ms };
  };
}

/** The production batch embedder: many texts, one HTTP call, via OpenRouter. */
export function createDefaultEmbedBatchFn(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): EmbedBatchFn {
  return (texts, inputType) => callOpenRouterEmbeddings(texts, inputType, options);
}

/** A snapshot-scoped embedder that never spends more than `timeoutMs` of the
 *  caller's own budget: past that, it reports `timed-out` and the caller
 *  falls back to keyword-only candidates for this turn. */
export function withDeadline(embed: EmbedFn, timeoutMs: number): EmbedFn {
  return async (text, inputType, parentSignal) => {
    const startedAt = performance.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await Promise.race([
        embed(text, inputType, controller.signal),
        new Promise<EmbedResult>((resolve) => {
          controller.signal.addEventListener('abort', () =>
            resolve({ outcome: 'timed-out', ms: performance.now() - startedAt }), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * Work that must wait until the caller's transaction commits, run against the
 * pool rather than the transaction's connection. Callers outside a command
 * transaction omit it, and the work runs at once on their own handle.
 */
export type AfterCommit = (task: (database: SqlDatabase) => void | Promise<void>) => void;

/** Run now on `database` when no transaction owner collected the task. */
export function runAfterCommit(
  afterCommit: AfterCommit | undefined,
  database: SqlDatabase,
  task: (database: SqlDatabase) => void | Promise<void>,
): void {
  if (afterCommit) afterCommit(task);
  else void Promise.resolve(task(database)).catch(() => undefined);
}

/**
 * An embedder that serves one result computed earlier, before a transaction
 * opened. Any other text reports `error` instead of going to the network, so
 * the caller falls back to keyword-only candidates.
 */
export function precomputedEmbedFn(text: string, result: EmbedResult): EmbedFn {
  return async (candidate) => (candidate === text ? result : { outcome: 'error', ms: 0 });
}

/** `[0.1,0.2,...]`, the literal pgvector accepts cast as `$n::vector`. */
export function pgvectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export async function embedOneInstitutionalMemoryItem(
  database: SqlDatabase,
  itemId: string,
  embedBatch: EmbedBatchFn,
): Promise<boolean> {
  const row = (
    await database.query<{ canonical_key: string; body: string; version: number }>(
      `SELECT canonical_key,body,version FROM institutional_memory_items
       WHERE id=$1 AND state='active' AND deleted_at IS NULL`,
      [itemId],
    )
  ).rows[0];
  if (!row) return true; // gone or no longer active: nothing to embed, not a failure to retry
  const vectors = await embedBatch([`${row.canonical_key}: ${row.body}`], 'document');
  const vector = vectors?.[0];
  if (!vector) return false;
  await database.query(
    `UPDATE institutional_memory_items
     SET embedding=$2::vector,embedding_model=$3,embedded_at=now()
     WHERE id=$1 AND version=$4 AND state='active' AND deleted_at IS NULL`,
    [itemId, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, row.version],
  );
  return true;
}

export async function embedOneWorkspaceSkillVersion(
  database: SqlDatabase,
  skillId: string,
  embedBatch: EmbedBatchFn,
): Promise<boolean> {
  const row = (
    await database.query<{
      slug: string;
      description: string;
      current_version: number;
      markdown: string;
    }>(
      `SELECT skill.slug,skill.description,skill.current_version,COALESCE(version.markdown,'') markdown
       FROM workspace_skills skill
       LEFT JOIN workspace_skill_versions version
         ON version.skill_id=skill.id AND version.version=skill.current_version
       WHERE skill.id=$1 AND skill.state='active'`,
      [skillId],
    )
  ).rows[0];
  if (!row) return true; // gone or no longer active: nothing to embed, not a failure to retry
  const vectors = await embedBatch(
    [`${row.slug.replace(/-/g, ' ')}: ${row.description}\n${row.markdown.slice(0, 600)}`],
    'document',
  );
  const vector = vectors?.[0];
  if (!vector) return false;
  await database.query(
    `UPDATE workspace_skills
     SET embedding=$2::vector,embedding_model=$3,embedding_version=$4,embedded_at=now()
     WHERE id=$1 AND current_version=$4 AND state='active'`,
    [skillId, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, row.current_version],
  );
  return true;
}

/** Pending in-process retry timers, keyed `item:<id>` / `skill:<id>`. A save
 *  arriving again for the same row (a rapid edit) supersedes its own pending
 *  retry rather than piling up a second one. Never persisted, never scanned —
 *  a process restart simply drops whatever was pending; the next server-start
 *  backfill picks up anything left unembedded. */
const pendingEmbedRetries = new Map<string, NodeJS.Timeout>();

function scheduleWithRetry(
  key: string,
  attemptOnce: () => Promise<boolean>,
  backoffMs: readonly number[] = EMBED_RETRY_BACKOFF_MS,
): void {
  const existing = pendingEmbedRetries.get(key);
  if (existing) clearTimeout(existing);
  pendingEmbedRetries.delete(key);
  const run = (attemptIndex: number): void => {
    attemptOnce()
      .catch(() => false)
      .then((ok) => {
        if (ok || attemptIndex >= backoffMs.length) {
          pendingEmbedRetries.delete(key);
          return;
        }
        const timer = setTimeout(() => run(attemptIndex + 1), backoffMs[attemptIndex]);
        timer.unref?.();
        pendingEmbedRetries.set(key, timer);
      });
  };
  run(0);
}

/** Only for tests: true while a row still has a pending retry scheduled. */
export function hasPendingEmbedRetry(key: string): boolean {
  return pendingEmbedRetries.has(key);
}

function embeddingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env[INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR]?.trim();
}

/** Call once at server start. Loud and unmissable, because a missing key
 *  silently degrades meaning-based recall to keyword-only with no other
 *  signal (this is exactly the outage that shipped unembedded for three days
 *  in production before this warning existed). */
export function warnIfEmbeddingKeyMissing(env: NodeJS.ProcessEnv = process.env): void {
  if (!embeddingDisabled(env)) return;
  console.error(
    `[institutional-memory] ${INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR} is not set: meaning-based recall is OFF, falling back to keyword-only recall.`,
  );
}

/**
 * Embed one just-saved/updated `institutional_memory_items` row. Fire-and-
 * forget from the caller's perspective (never awaited, never blocks or fails
 * the save); a failure retries this one row on a bounded in-process backoff.
 *
 * With no `embedBatch` override and no key configured, this schedules
 * nothing at all — not even the row's own read: a save every ordinary
 * caller makes must never pay for a query whose answer is already known to
 * be "disabled" before it runs.
 */
export function scheduleEmbedInstitutionalMemoryItem(
  database: SqlDatabase,
  itemId: string,
  embedBatch?: EmbedBatchFn,
): void {
  if (!embedBatch && embeddingDisabled()) return;
  const batch = embedBatch ?? createDefaultEmbedBatchFn();
  scheduleWithRetry(`item:${itemId}`, () => embedOneInstitutionalMemoryItem(database, itemId, batch));
}

/** Same as above, for a `workspace_skills` row whose current version just changed. */
export function scheduleEmbedWorkspaceSkillVersion(
  database: SqlDatabase,
  skillId: string,
  embedBatch?: EmbedBatchFn,
): void {
  if (!embedBatch && embeddingDisabled()) return;
  const batch = embedBatch ?? createDefaultEmbedBatchFn();
  scheduleWithRetry(`skill:${skillId}`, () => embedOneWorkspaceSkillVersion(database, skillId, batch));
}

export interface EmbeddingBackfillCounts {
  itemsEmbedded: number;
  itemsAttempted: number;
  itemsFailed: number;
  skillsEmbedded: number;
  skillsAttempted: number;
  skillsFailed: number;
  /** True when another pass (this process or another machine) held the lock. */
  skipped?: boolean;
}

const EMPTY_BACKFILL_COUNTS = {
  itemsEmbedded: 0,
  itemsAttempted: 0,
  itemsFailed: 0,
  skillsEmbedded: 0,
  skillsAttempted: 0,
  skillsFailed: 0,
} as const;

const EMBEDDING_BACKFILL_LOCK = `hashtext('institutional-memory-embedding-backfill')`;
let embeddingBackfillRunning = false;

/** A pooled session (`pg.PoolClient`) that can hold a session-level advisory lock. */
interface BackfillSession {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}

function sessionDatabase(session: BackfillSession, database: SqlDatabase): SqlDatabase {
  return {
    query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
      const result = await session.query(sql, values);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
    },
    transaction: (work) => database.transaction(work),
  };
}

/**
 * The ONE-TIME startup sweep: embeds every active row missing a current
 * embedding, a batch at a time, until none remain, then returns. Call this
 * exactly once, right after `migrate()` at server start (see `index.ts`) —
 * never on an interval, never again afterward. It exists only to cover rows
 * saved before this feature shipped, or whose in-process retry died with an
 * earlier process; every row saved from here on embeds itself on save.
 *
 * A session advisory lock on one dedicated connection makes it single-machine.
 * Each batch's reads and writes autocommit on that connection, so no
 * transaction or row lock is held while the embedder is on the network, and a
 * failure keeps the batches already written.
 */
export async function backfillInstitutionalMemoryEmbeddingsOnce(
  database: SqlDatabase & { connectDedicated?(): Promise<BackfillSession> },
  embedBatch: EmbedBatchFn = createDefaultEmbedBatchFn(),
  batchSize = EMBEDDING_BACKFILL_BATCH,
): Promise<EmbeddingBackfillCounts> {
  if (embeddingBackfillRunning) return { ...EMPTY_BACKFILL_COUNTS, skipped: true };
  embeddingBackfillRunning = true;
  let session: BackfillSession | undefined;
  let sessionError: Error | undefined;
  try {
    session = database.connectDedicated ? await database.connectDedicated() : undefined;
    const locked = session ? sessionDatabase(session, database) : database;
    const acquired = (await locked.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${EMBEDDING_BACKFILL_LOCK}) acquired`,
    )).rows[0]?.acquired;
    if (!acquired) return { ...EMPTY_BACKFILL_COUNTS, skipped: true };
    try {
      const attemptedItems: string[] = [];
      const attemptedSkills: string[] = [];
      let itemsEmbedded = 0;
      let skillsEmbedded = 0;
      let failedBatches = 0;
      for (;;) {
        const batch = await backfillInstitutionalMemoryItemsBatch(
          locked, embedBatch, batchSize, attemptedItems);
        attemptedItems.push(...batch.ids);
        itemsEmbedded += batch.embedded;
        if (!batch.ids.length) break;
        failedBatches = batch.embedded === 0 ? failedBatches + 1 : 0;
        if (failedBatches >= 3) break;
      }
      failedBatches = 0;
      for (;;) {
        const batch = await backfillWorkspaceSkillsBatch(
          locked, embedBatch, batchSize, attemptedSkills);
        attemptedSkills.push(...batch.ids);
        skillsEmbedded += batch.embedded;
        if (!batch.ids.length) break;
        failedBatches = batch.embedded === 0 ? failedBatches + 1 : 0;
        if (failedBatches >= 3) break;
      }
      return {
        itemsEmbedded,
        itemsAttempted: attemptedItems.length,
        itemsFailed: attemptedItems.length - itemsEmbedded,
        skillsEmbedded,
        skillsAttempted: attemptedSkills.length,
        skillsFailed: attemptedSkills.length - skillsEmbedded,
      };
    } finally {
      try {
        await locked.query(`SELECT pg_advisory_unlock(${EMBEDDING_BACKFILL_LOCK})`);
      } catch (error) {
        // Destroying the connection releases its session lock.
        sessionError = error instanceof Error ? error : new Error(String(error));
      }
    }
  } finally {
    session?.release(sessionError ?? false);
    embeddingBackfillRunning = false;
  }
}

async function backfillInstitutionalMemoryItemsBatch(
  database: SqlDatabase,
  embedBatch: EmbedBatchFn,
  batchSize: number,
  attempted: readonly string[],
): Promise<{ ids: string[]; embedded: number }> {
  const rows = (
    await database.query<{ id: string; canonical_key: string; body: string; version: number }>(
      `SELECT id,canonical_key,body,version FROM institutional_memory_items
       WHERE state='active' AND deleted_at IS NULL
         AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
         AND NOT (id=ANY($3::uuid[]))
       ORDER BY updated_at ASC LIMIT $2`,
      [INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, batchSize, attempted],
    )
  ).rows;
  if (!rows.length) return { ids: [], embedded: 0 };
  const vectors = await embedBatch(
    rows.map((row) => `${row.canonical_key}: ${row.body}`),
    'document',
  );
  if (!vectors) return { ids: rows.map((row) => row.id), embedded: 0 };
  let embedded = 0;
  for (const [index, row] of rows.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    await database.query(
      `UPDATE institutional_memory_items
       SET embedding=$2::vector,embedding_model=$3,embedded_at=now()
       WHERE id=$1 AND version=$4 AND state='active' AND deleted_at IS NULL`,
      [row.id, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, row.version],
    );
    embedded += 1;
  }
  return { ids: rows.map((row) => row.id), embedded };
}

async function backfillWorkspaceSkillsBatch(
  database: SqlDatabase,
  embedBatch: EmbedBatchFn,
  batchSize: number,
  attempted: readonly string[],
): Promise<{ ids: string[]; embedded: number }> {
  const rows = (
    await database.query<{
      id: string;
      slug: string;
      description: string;
      current_version: number;
      markdown: string;
    }>(
      `SELECT skill.id,skill.slug,skill.description,skill.current_version,
              COALESCE(version.markdown,'') markdown
       FROM workspace_skills skill
       LEFT JOIN workspace_skill_versions version
         ON version.skill_id=skill.id AND version.version=skill.current_version
       WHERE skill.state='active'
         AND (skill.embedding IS NULL OR skill.embedding_model IS DISTINCT FROM $1
              OR skill.embedding_version IS DISTINCT FROM skill.current_version)
         AND NOT (skill.id=ANY($3::uuid[]))
       ORDER BY skill.updated_at ASC LIMIT $2`,
      [INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, batchSize, attempted],
    )
  ).rows;
  if (!rows.length) return { ids: [], embedded: 0 };
  const vectors = await embedBatch(
    rows.map(
      (row) =>
        `${row.slug.replace(/-/g, ' ')}: ${row.description}\n${row.markdown.slice(0, 600)}`,
    ),
    'document',
  );
  if (!vectors) return { ids: rows.map((row) => row.id), embedded: 0 };
  let embedded = 0;
  for (const [index, row] of rows.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    await database.query(
      `UPDATE workspace_skills
       SET embedding=$2::vector,embedding_model=$3,embedding_version=$4,embedded_at=now()
       WHERE id=$1 AND current_version=$4 AND state='active'`,
      [row.id, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, row.current_version],
    );
    embedded += 1;
  }
  return { ids: rows.map((row) => row.id), embedded };
}
