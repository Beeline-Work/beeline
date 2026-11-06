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
 * / `scheduleEmbedWorkspaceSkillVersion`), attempted once for that save.
 */
import {
  INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS,
  INSTITUTIONAL_MEMORY_EMBEDDING_ENV_VAR,
  INSTITUTIONAL_MEMORY_EMBEDDING_MODEL,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

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
      signal: options.signal ?? undefined,
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
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
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
      return { outcome: 'error', ms };
    }
    return { vector, outcome: 'served', ms };
  };
}

/** The production batch embedder: many texts, one HTTP call, via OpenRouter. */
export function createDefaultEmbedBatchFn(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): EmbedBatchFn {
  return (texts, inputType) => callOpenRouterEmbeddings(texts, inputType, options);
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
 * the save). Failure ends this attempt; a later actual save can admit another.
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
  void embedOneInstitutionalMemoryItem(database, itemId, batch).catch(() => false);
}

/** Same as above, for a `workspace_skills` row whose current version just changed. */
export function scheduleEmbedWorkspaceSkillVersion(
  database: SqlDatabase,
  skillId: string,
  embedBatch?: EmbedBatchFn,
): void {
  if (!embedBatch && embeddingDisabled()) return;
  const batch = embedBatch ?? createDefaultEmbedBatchFn();
  void embedOneWorkspaceSkillVersion(database, skillId, batch).catch(() => false);
}
