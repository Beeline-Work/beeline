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
/** Throttle between embedding-cycle passes; the cycle covers both freshly
 *  saved rows (embed on save) and pre-existing ones (backfill) alike. */
export const EMBEDDING_CYCLE_INTERVAL_MS = 5_000;

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
 *  one HTTP call over N rows is why the backfill/embed-on-save cycle stays cheap. */
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

interface EmbeddingCycleCounts {
  itemsEmbedded: number;
  skillsEmbedded: number;
}

/**
 * One pass of the embedding cycle: embed whatever `institutional_memory_items`
 * and `workspace_skills` rows are missing a current embedding, a small batch
 * at a time. This single query covers both jobs the task asked for as one
 * mechanism — a freshly saved/updated row has no embedding yet (embed on
 * save), and a pre-existing row from before this feature shipped looks
 * identical to the query (backfill) — so there is nothing else to schedule.
 * A row whose embedding failed stays without one and is picked up again next
 * pass; nothing here can fail a save or throw out of this cycle.
 */
export async function runInstitutionalMemoryEmbeddingCycle(
  database: SqlDatabase,
  embedBatch: EmbedBatchFn = createDefaultEmbedBatchFn(),
  batchSize = EMBEDDING_BACKFILL_BATCH,
): Promise<EmbeddingCycleCounts> {
  const itemsEmbedded = await embedInstitutionalMemoryItems(database, embedBatch, batchSize);
  const skillsEmbedded = await embedWorkspaceSkills(database, embedBatch, batchSize);
  return { itemsEmbedded, skillsEmbedded };
}

async function embedInstitutionalMemoryItems(
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

/**
 * A workspace_skills row is re-embedded whenever its CURRENT_VERSION moves:
 * `embedding_version` records which version the stored vector answers for,
 * so a new revision (or a future `kind='workflow'` row landing in this same
 * table — see AGENTS.md) is picked up by this same query with no extra code.
 */
async function embedWorkspaceSkills(
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

/** Throttled `runOnce`, wired into the server's per-tick background section
 *  like `PushDeliveryLoop`/`MediaExpiryLoop` (see `background.ts`). */
export class InstitutionalMemoryEmbeddingLoop {
  #lastCompletedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: SqlDatabase,
    private readonly embedBatch: EmbedBatchFn = createDefaultEmbedBatchFn(),
    private readonly intervalMs = EMBEDDING_CYCLE_INTERVAL_MS,
    private readonly batchSize = EMBEDDING_BACKFILL_BATCH,
    private readonly now: () => number = Date.now,
  ) {}

  async runIfDue(): Promise<EmbeddingCycleCounts | undefined> {
    const now = this.now();
    if (now - this.#lastCompletedAt < this.intervalMs) return undefined;
    this.#lastCompletedAt = now;
    return runInstitutionalMemoryEmbeddingCycle(this.database, this.embedBatch, this.batchSize);
  }
}
