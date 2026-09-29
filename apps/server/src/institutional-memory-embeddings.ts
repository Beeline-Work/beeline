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
import type { SqlDatabase } from './database.js';

export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
export const EMBEDDING_FETCH_TIMEOUT_MS = 10_000;
export const EMBEDDING_BACKFILL_BATCH = 20;
/** Bounded in-process retry for one row's embed, never a database scan. */
export const EMBED_RETRY_BACKOFF_MS = [5_000, 15_000, 60_000];

export type EmbeddingInputType = 'query' | 'document';
export type EmbeddingOutcome = 'served' | 'timed-out' | 'disabled' | 'error';

export interface EmbedResult {
  readonly vector?: readonly number[];
  readonly outcome: EmbeddingOutcome;
  readonly ms: number;
}

/** One text in, one vector (or a reason it did not come back) out. */
export type EmbedFn = (text: string, inputType: EmbeddingInputType) => Promise<EmbedResult>;
/** Several texts in, one vector (or undefined) per input, in order. Batching
 *  one HTTP call over N rows is why the startup backfill stays cheap. */
export type EmbedBatchFn = (
  texts: readonly string[],
  inputType: EmbeddingInputType,
) => Promise<(readonly number[] | undefined)[] | undefined>;

async function callOpenRouterEmbeddings(
  texts: readonly string[],
  inputType: EmbeddingInputType,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
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
      signal: AbortSignal.timeout(options.timeoutMs ?? EMBEDDING_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      data?: readonly { embedding?: readonly number[]; index?: number }[];
    };
    if (!Array.isArray(body.data)) return undefined;
    const byIndex = new Map(body.data.map((entry) => [entry.index ?? 0, entry.embedding]));
    return texts.map((_, index) => {
      const vector = byIndex.get(index);
      return Array.isArray(vector) && vector.length === INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS
        ? vector
        : undefined;
    });
  } catch {
    return undefined;
  }
}

/** The production embedder: one text, via OpenRouter, best-effort. */
export function createDefaultEmbedFn(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): EmbedFn {
  return async (text, inputType) => {
    const env = options.env ?? process.env;
    if (!env[INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR]?.trim()) {
      return { outcome: 'disabled', ms: 0 };
    }
    const startedAt = performance.now();
    const result = await callOpenRouterEmbeddings([text], inputType, options);
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
  return async (text, inputType) => {
    const startedAt = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        embed(text, inputType),
        new Promise<EmbedResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ outcome: 'timed-out', ms: performance.now() - startedAt }),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
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
    await database.query<{ canonical_key: string; body: string }>(
      `SELECT canonical_key,body FROM institutional_memory_items
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
     WHERE id=$1`,
    [itemId, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL],
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
     WHERE id=$1`,
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

/**
 * Embed one just-saved/updated `institutional_memory_items` row. Fire-and-
 * forget from the caller's perspective (never awaited, never blocks or fails
 * the save); a failure retries this one row on a bounded in-process backoff.
 */
export function scheduleEmbedInstitutionalMemoryItem(
  database: SqlDatabase,
  itemId: string,
  embedBatch: EmbedBatchFn = createDefaultEmbedBatchFn(),
): void {
  scheduleWithRetry(`item:${itemId}`, () =>
    embedOneInstitutionalMemoryItem(database, itemId, embedBatch),
  );
}

/** Same as above, for a `workspace_skills` row whose current version just changed. */
export function scheduleEmbedWorkspaceSkillVersion(
  database: SqlDatabase,
  skillId: string,
  embedBatch: EmbedBatchFn = createDefaultEmbedBatchFn(),
): void {
  scheduleWithRetry(`skill:${skillId}`, () =>
    embedOneWorkspaceSkillVersion(database, skillId, embedBatch),
  );
}

export interface EmbeddingBackfillCounts {
  itemsEmbedded: number;
  skillsEmbedded: number;
}

/**
 * The ONE-TIME startup sweep: embeds every active row missing a current
 * embedding, a batch at a time, until none remain, then returns. Call this
 * exactly once, right after `migrate()` at server start (see `index.ts`) —
 * never on an interval, never again afterward. It exists only to cover rows
 * saved before this feature shipped, or whose in-process retry died with an
 * earlier process; every row saved from here on embeds itself on save.
 */
export async function backfillInstitutionalMemoryEmbeddingsOnce(
  database: SqlDatabase,
  embedBatch: EmbedBatchFn = createDefaultEmbedBatchFn(),
  batchSize = EMBEDDING_BACKFILL_BATCH,
): Promise<EmbeddingBackfillCounts> {
  let itemsEmbedded = 0;
  for (;;) {
    const embedded = await backfillInstitutionalMemoryItemsBatch(database, embedBatch, batchSize);
    itemsEmbedded += embedded;
    if (embedded < batchSize) break;
  }
  let skillsEmbedded = 0;
  for (;;) {
    const embedded = await backfillWorkspaceSkillsBatch(database, embedBatch, batchSize);
    skillsEmbedded += embedded;
    if (embedded < batchSize) break;
  }
  return { itemsEmbedded, skillsEmbedded };
}

async function backfillInstitutionalMemoryItemsBatch(
  database: SqlDatabase,
  embedBatch: EmbedBatchFn,
  batchSize: number,
): Promise<number> {
  const rows = (
    await database.query<{ id: string; canonical_key: string; body: string }>(
      `SELECT id,canonical_key,body FROM institutional_memory_items
       WHERE state='active' AND deleted_at IS NULL
         AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
       ORDER BY updated_at ASC LIMIT $2`,
      [INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, batchSize],
    )
  ).rows;
  if (!rows.length) return 0;
  const vectors = await embedBatch(
    rows.map((row) => `${row.canonical_key}: ${row.body}`),
    'document',
  );
  if (!vectors) return 0;
  let embedded = 0;
  for (const [index, row] of rows.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    await database.query(
      `UPDATE institutional_memory_items
       SET embedding=$2::vector,embedding_model=$3,embedded_at=now()
       WHERE id=$1`,
      [row.id, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL],
    );
    embedded += 1;
  }
  return embedded;
}

async function backfillWorkspaceSkillsBatch(
  database: SqlDatabase,
  embedBatch: EmbedBatchFn,
  batchSize: number,
): Promise<number> {
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
       ORDER BY skill.updated_at ASC LIMIT $2`,
      [INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, batchSize],
    )
  ).rows;
  if (!rows.length) return 0;
  const vectors = await embedBatch(
    rows.map(
      (row) =>
        `${row.slug.replace(/-/g, ' ')}: ${row.description}\n${row.markdown.slice(0, 600)}`,
    ),
    'document',
  );
  if (!vectors) return 0;
  let embedded = 0;
  for (const [index, row] of rows.entries()) {
    const vector = vectors[index];
    if (!vector) continue;
    await database.query(
      `UPDATE workspace_skills
       SET embedding=$2::vector,embedding_model=$3,embedding_version=$4,embedded_at=now()
       WHERE id=$1`,
      [row.id, pgvectorLiteral(vector), INSTITUTIONAL_MEMORY_EMBEDDING_MODEL, row.current_version],
    );
    embedded += 1;
  }
  return embedded;
}
