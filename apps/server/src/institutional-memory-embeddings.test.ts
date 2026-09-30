import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import {
  createDefaultEmbedFn,
  createDefaultEmbedBatchFn,
  pgvectorLiteral,
  withDeadline,
  embedOneInstitutionalMemoryItem,
  embedOneWorkspaceSkillVersion,
  scheduleEmbedInstitutionalMemoryItem,
  scheduleEmbedWorkspaceSkillVersion,
  hasPendingEmbedRetry,
  backfillInstitutionalMemoryEmbeddingsOnce,
  EMBED_RETRY_BACKOFF_MS,
  OPENROUTER_EMBEDDINGS_URL,
  type EmbedBatchFn,
} from './institutional-memory-embeddings.js';

const DIM = 1024;
const VECTOR = new Array(DIM).fill(0.5);

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  delete process.env.OPENROUTER_EMBEDDING_API_KEY;
  vi.useRealTimers();
});

describe('createDefaultEmbedFn', () => {
  it('matches batch entries without indexes by array position', async () => {
    const first = new Array(DIM).fill(0.1);
    const second = new Array(DIM).fill(0.2);
    const fetchImpl = vi.fn(async () => okResponse({ data: [
      { embedding: first }, { embedding: second },
    ] }));
    const result = await createDefaultEmbedBatchFn({
      env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' }, fetchImpl,
    })(['first', 'second'], 'document');
    expect(result).toEqual([first, second]);
  });
  it('reports disabled and makes no network call when no key is configured', async () => {
    const fetchImpl = vi.fn();
    const embed = createDefaultEmbedFn({ env: {}, fetchImpl });
    const result = await embed('some text', 'query');
    expect(result.outcome).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('embeds one text via OpenRouter with the right model, dimensions, and input_type', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(OPENROUTER_EMBEDDINGS_URL);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('voyageai/voyage-4-lite');
      expect(body.dimensions).toBe(DIM);
      expect(body.input_type).toBe('query');
      expect(body.input).toEqual(['find my thing']);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      return okResponse({ data: [{ embedding: VECTOR, index: 0 }] });
    });
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' }, fetchImpl });
    const result = await embed('find my thing', 'query');
    expect(result.outcome).toBe('served');
    expect(result.vector).toEqual(VECTOR);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports error on a non-200 response, never throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' }, fetchImpl });
    const result = await embed('x', 'query');
    expect(result.outcome).toBe('error');
  });

  it('reports error when the model returns the wrong dimension count', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
    );
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' }, fetchImpl });
    const result = await embed('x', 'query');
    expect(result.outcome).toBe('error');
  });

  it('reports error (never throws) on a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' }, fetchImpl });
    const result = await embed('x', 'query');
    expect(result.outcome).toBe('error');
  });
});

describe('withDeadline', () => {
  it('aborts the underlying embedding request at its deadline', async () => {
    let aborted = false;
    const bounded = withDeadline((_text, _type, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => {
        aborted = true;
        resolve({ outcome: 'timed-out', ms: 1 });
      }, { once: true })), 10);
    expect((await bounded('text', 'query')).outcome).toBe('timed-out');
    expect(aborted).toBe(true);
  });
  it('passes through a fast, successful embed unchanged', async () => {
    const fast = async () => ({ outcome: 'served' as const, vector: VECTOR, ms: 1 });
    const bounded = withDeadline(fast, 1_000);
    const result = await bounded('x', 'query');
    expect(result.outcome).toBe('served');
  });

  it('reports timed-out when the embedder takes longer than the deadline, and never rejects', async () => {
    const slow = () =>
      new Promise<{ outcome: 'served'; vector: number[]; ms: number }>((resolve) =>
        setTimeout(() => resolve({ outcome: 'served', vector: VECTOR, ms: 500 }), 500),
      );
    const bounded = withDeadline(slow, 20);
    const result = await bounded('x', 'query');
    expect(result.outcome).toBe('timed-out');
  });
});

describe('pgvectorLiteral', () => {
  it('renders a pgvector-parseable bracketed literal', () => {
    expect(pgvectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
});

describe('createDefaultEmbedBatchFn', () => {
  it('sends every text in one request and returns one vector per input in order', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toEqual(['a', 'b', 'c']);
      return okResponse({
        data: [
          { embedding: VECTOR.map((v) => v + 2), index: 2 },
          { embedding: VECTOR, index: 0 },
          { embedding: VECTOR.map((v) => v + 1), index: 1 },
        ],
      });
    });
    const embedBatch = createDefaultEmbedBatchFn({
      env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' },
      fetchImpl,
    });
    const result = await embedBatch(['a', 'b', 'c'], 'document');
    expect(result?.[0]).toEqual(VECTOR);
    expect(result?.[1]).toEqual(VECTOR.map((v) => v + 1));
    expect(result?.[2]).toEqual(VECTOR.map((v) => v + 2));
  });

  it('returns undefined (never throws) with no key configured', async () => {
    const embedBatch = createDefaultEmbedBatchFn({ env: {} });
    expect(await embedBatch(['a'], 'document')).toBeUndefined();
  });
});

const WORKSPACE = '10000000-0000-4000-8000-0000000000e1';
const ROOM = '20000000-0000-4000-8000-0000000000e1';
const CAPTAIN = 'a'.repeat(64);
const MESSAGE = 'b'.repeat(64);

async function seed(database: PgliteDatabase) {
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Captain')`, [
    CAPTAIN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'WS')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`, [
    MESSAGE,
    ROOM,
    CAPTAIN,
  ]);
}

async function insertItem(database: PgliteDatabase, id: string) {
  await database.query(
    `INSERT INTO institutional_memory_items
       (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
        audience_kind,confidence,version,keywords)
     VALUES($1::uuid,$2,'workspace_fact',$1,'A fact.','active',$3,$4,'workspace',0.9,1,'{}')`,
    [id, WORKSPACE, ROOM, MESSAGE],
  );
}

async function insertSkill(database: PgliteDatabase, skillId: string, jobId: string) {
  await database.query(
    `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,requester_identity_id,
        source_audience_kind,idempotency_key,status)
     VALUES($1::uuid,$2,'merge_review','live',$3,$4,$5,'workspace_candidate',$6,'completed')`,
    [jobId, WORKSPACE, ROOM, MESSAGE, CAPTAIN, `idem-${jobId}`],
  );
  await database.query(
    `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
        repository,target_commit)
     VALUES($1::uuid,$2,'deploy-app','How to deploy the app','active',1,1,$3,'org/repo','abc')`,
    [skillId, WORKSPACE, ROOM],
  );
  await database.query(
    `INSERT INTO workspace_skill_versions
       (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,
        target_commit,extractor_version,model)
     VALUES($1::uuid,1,'Run npm run deploy.',$2,$3::uuid,$4,'org/repo','abc','v1','model')`,
    [skillId, 'c'.repeat(64), jobId, [MESSAGE]],
  );
}

describe('embed-on-save (event-driven, no scan)', () => {
  it('does not let an older in-flight vector overwrite a newer item version', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
    await insertItem(database, itemId);
    let release!: (vectors: number[][]) => void;
    const pending = embedOneInstitutionalMemoryItem(database, itemId,
      () => new Promise((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await database.query(`UPDATE institutional_memory_items
      SET version=2,body='Newer fact.',updated_at=now() WHERE id=$1`, [itemId]);
    release([VECTOR]);
    await pending;
    expect((await database.query<{ embedding: string | null }>(
      `SELECT embedding::text embedding FROM institutional_memory_items WHERE id=$1`, [itemId]))
      .rows[0]?.embedding).toBeNull();
  });
  it('embeds a freshly saved institutional_memory_items row', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    await insertItem(database, itemId);
    const ok = await embedOneInstitutionalMemoryItem(database, itemId, async (texts) => {
      expect(texts).toEqual([`${itemId}: A fact.`]);
      return texts.map(() => VECTOR);
    });
    expect(ok).toBe(true);
    const row = (
      await database.query<{ embedding_model: string; embedded_at: Date | null }>(
        `SELECT embedding_model,embedded_at FROM institutional_memory_items WHERE id=$1`,
        [itemId],
      )
    ).rows[0];
    expect(row?.embedding_model).toBe('voyageai/voyage-4-lite');
    expect(row?.embedded_at).toBeTruthy();
  });

  it('embeds a freshly saved workspace_skills version', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const skillId = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
    await insertSkill(database, skillId, 'ffffffff-ffff-4fff-8fff-fffffffffff3');
    const ok = await embedOneWorkspaceSkillVersion(database, skillId, async (texts) => {
      expect(texts[0]).toContain('deploy app');
      return texts.map(() => VECTOR);
    });
    expect(ok).toBe(true);
    const row = (
      await database.query<{ embedding_version: number }>(
        `SELECT embedding_version FROM workspace_skills WHERE id=$1`,
        [skillId],
      )
    ).rows[0];
    expect(row?.embedding_version).toBe(1);
  });

  it('schedules no work at all (not even a read) when disabled and no embedder override is given', async () => {
    // Regression: `saveSkill`/`proposeInstitutionalMemory` schedule with no
    // override, so with no key configured this must never touch the
    // database — a stray query racing an unrelated caller's own transaction
    // on the same row crashed pglite (memory access out of bounds) before
    // this guard existed.
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffffa';
    await insertItem(database, itemId);
    const querySpy = vi.spyOn(database, 'query');
    scheduleEmbedInstitutionalMemoryItem(database, itemId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(querySpy).not.toHaveBeenCalled();
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(false);
  });

  it('a row already gone or inactive is treated as done, not a failure to retry', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const embedBatch = vi.fn();
    const ok = await embedOneInstitutionalMemoryItem(
      database,
      'ffffffff-ffff-4fff-8fff-fffffffffff9',
      embedBatch,
    );
    expect(ok).toBe(true);
    expect(embedBatch).not.toHaveBeenCalled();
  });
});

describe('per-row retry with in-process backoff (no database scan)', () => {
  it('retries only the failing row, on backoff, until the embedder succeeds', async () => {
    vi.useFakeTimers();
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff4';
    await insertItem(database, itemId);
    const embedBatch: EmbedBatchFn = vi
      .fn()
      .mockResolvedValueOnce(undefined) // attempt 1: fails
      .mockResolvedValueOnce(undefined) // attempt 2: fails
      .mockResolvedValueOnce([VECTOR]); // attempt 3: succeeds
    scheduleEmbedInstitutionalMemoryItem(database, itemId, embedBatch);

    await vi.advanceTimersByTimeAsync(0); // attempt 1 runs synchronously-ish
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(true);
    let row = (
      await database.query<{ embedding_model: string | null }>(
        `SELECT embedding_model FROM institutional_memory_items WHERE id=$1`,
        [itemId],
      )
    ).rows[0];
    expect(row?.embedding_model).toBeNull();

    await vi.advanceTimersByTimeAsync(EMBED_RETRY_BACKOFF_MS[0]); // attempt 2
    expect(embedBatch).toHaveBeenCalledTimes(2);
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(true);

    await vi.advanceTimersByTimeAsync(EMBED_RETRY_BACKOFF_MS[1]); // attempt 3: succeeds
    expect(embedBatch).toHaveBeenCalledTimes(3);
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(false);
    row = (
      await database.query<{ embedding_model: string | null }>(
        `SELECT embedding_model FROM institutional_memory_items WHERE id=$1`,
        [itemId],
      )
    ).rows[0];
    expect(row?.embedding_model).toBe('voyageai/voyage-4-lite');
  });

  it('gives up after exhausting the bounded backoff, with no further timer left pending', async () => {
    vi.useFakeTimers();
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff5';
    await insertItem(database, itemId);
    const embedBatch = vi.fn().mockResolvedValue(undefined);
    scheduleEmbedInstitutionalMemoryItem(database, itemId, embedBatch);
    await vi.advanceTimersByTimeAsync(0);
    for (const backoff of EMBED_RETRY_BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(backoff);
    }
    expect(embedBatch).toHaveBeenCalledTimes(EMBED_RETRY_BACKOFF_MS.length + 1);
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(false);
    // Advancing far past every backoff triggers no further attempt: the
    // retry is bounded and terminates, never becoming a recurring sweep.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(embedBatch).toHaveBeenCalledTimes(EMBED_RETRY_BACKOFF_MS.length + 1);
  });

  it('a second save for the same row supersedes its own pending retry rather than piling one up', async () => {
    vi.useFakeTimers();
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
    await insertItem(database, itemId);
    const firstEmbedBatch = vi.fn().mockResolvedValue(undefined);
    scheduleEmbedInstitutionalMemoryItem(database, itemId, firstEmbedBatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(true);

    const secondEmbedBatch = vi.fn().mockResolvedValue([VECTOR]);
    scheduleEmbedInstitutionalMemoryItem(database, itemId, secondEmbedBatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(secondEmbedBatch).toHaveBeenCalledTimes(1);
    expect(hasPendingEmbedRetry(`item:${itemId}`)).toBe(false);

    // The superseded first attempt's own backoff timer must not fire later.
    await vi.advanceTimersByTimeAsync(EMBED_RETRY_BACKOFF_MS[0]);
    expect(firstEmbedBatch).toHaveBeenCalledTimes(1);
  });
});

describe('backfillInstitutionalMemoryEmbeddingsOnce (one pass, never repeats itself)', () => {
  it('runs only one embedding pass when this process starts it twice', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId='ffffffff-ffff-4fff-8fff-fffffffffeff';
    await insertItem(database,itemId);
    let release!: () => void;
    const embedBatch=vi.fn(async () => {
      await new Promise<void>((resolve) => { release=resolve; });
      return [VECTOR];
    });
    const first=backfillInstitutionalMemoryEmbeddingsOnce(database,embedBatch,1);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second=backfillInstitutionalMemoryEmbeddingsOnce(database,embedBatch,1);
    release();
    const results=await Promise.all([first,second]);
    expect(results.reduce((sum,result) => sum+result.itemsEmbedded,0)).toBe(1);
    expect(embedBatch).toHaveBeenCalledTimes(1);
  });
  it('skips when another machine holds the backfill lock, and releases its own lock and session', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    await insertItem(database, 'ffffffff-ffff-4fff-8fff-fffffffffefe');
    const statements: string[] = [];
    let released = 0;
    const withSession = (lockHeldElsewhere: boolean) => Object.assign(database, {
      connectDedicated: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          if (lockHeldElsewhere && sql.includes('pg_try_advisory_lock')) {
            return { rows: [{ acquired: false }], rowCount: 1 };
          }
          return database.query(sql, values);
        },
        release: () => { released += 1; },
      }),
    });
    const embedBatch = vi.fn(async (texts: readonly string[]) => texts.map(() => VECTOR));
    expect(await backfillInstitutionalMemoryEmbeddingsOnce(withSession(true), embedBatch))
      .toEqual({ itemsEmbedded: 0, skillsEmbedded: 0, skipped: true });
    expect(embedBatch).not.toHaveBeenCalled();
    expect(released).toBe(1);
    statements.length = 0;
    expect(await backfillInstitutionalMemoryEmbeddingsOnce(withSession(false), embedBatch))
      .toMatchObject({ itemsEmbedded: 1 });
    expect(statements.some((sql) => sql.includes('pg_try_advisory_lock('))).toBe(true);
    expect(statements.at(-1)).toContain('pg_advisory_unlock(');
    expect(statements.some((sql) => /\bBEGIN\b/i.test(sql))).toBe(false);
    expect(released).toBe(2);
  });
  it('stops after three batches in a row fail entirely', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    for (const suffix of ['b1', 'b2', 'b3', 'b4', 'b5']) {
      await insertItem(database, `ffffffff-ffff-4fff-8fff-ffffffffff${suffix}`);
    }
    const embedBatch = vi.fn(async () => undefined);
    expect(await backfillInstitutionalMemoryEmbeddingsOnce(database, embedBatch, 1))
      .toMatchObject({ itemsEmbedded: 0 });
    expect(embedBatch).toHaveBeenCalledTimes(3);
  });
  it('continues past a failed row to embed later rows', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    for (const suffix of ['a1','a2','a3']) {
      await insertItem(database, `ffffffff-ffff-4fff-8fff-ffffffffff${suffix}`);
    }
    let calls = 0;
    const counts = await backfillInstitutionalMemoryEmbeddingsOnce(database, async () => {
      calls++;
      return calls === 1 ? [undefined] : [VECTOR];
    }, 1);
    expect(counts.itemsEmbedded).toBe(2);
    expect(calls).toBe(3);
  });
  it('embeds every row missing a current embedding, across more than one batch, then stops', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const ids = Array.from(
      { length: 3 },
      (_, index) => `ffffffff-ffff-4fff-8fff-fffffffffe0${index}`,
    );
    for (const id of ids) await insertItem(database, id);
    const embedBatch = vi.fn(async (texts: readonly string[]) => texts.map(() => VECTOR));
    const counts = await backfillInstitutionalMemoryEmbeddingsOnce(database, embedBatch, 2);
    expect(counts.itemsEmbedded).toBe(3);
    // batchSize=2 over 3 rows: two calls (2 then 1), never a third scan once empty.
    expect(embedBatch).toHaveBeenCalledTimes(2);
    for (const id of ids) {
      const row = (
        await database.query<{ embedding_model: string | null }>(
          `SELECT embedding_model FROM institutional_memory_items WHERE id=$1`,
          [id],
        )
      ).rows[0];
      expect(row?.embedding_model).toBe('voyageai/voyage-4-lite');
    }
  });

  it('does not repeat: a second call finds nothing left and makes no embedder call', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff7';
    await insertItem(database, itemId);
    await backfillInstitutionalMemoryEmbeddingsOnce(database, async (texts) =>
      texts.map(() => VECTOR),
    );
    const secondPass = vi.fn();
    const counts = await backfillInstitutionalMemoryEmbeddingsOnce(database, secondPass);
    expect(counts).toEqual({ itemsEmbedded: 0, skillsEmbedded: 0 });
    expect(secondPass).not.toHaveBeenCalled();
  });

  it('covers workspace_skills too, re-embedding a version bump', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const skillId = 'ffffffff-ffff-4fff-8fff-fffffffffff8';
    await insertSkill(database, skillId, 'ffffffff-ffff-4fff-8fff-ffffffffffe1');
    const counts = await backfillInstitutionalMemoryEmbeddingsOnce(database, async (texts) =>
      texts.map(() => VECTOR),
    );
    expect(counts.skillsEmbedded).toBe(1);
  });
});

describe('no timer-driven or periodic database sweep', () => {
  it('the embeddings module sets no interval anywhere', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./institutional-memory-embeddings.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
    // A recurring scan class/loop must not exist at all: only the one-shot
    // backfill and per-row event-driven scheduling remain.
    expect(source).not.toMatch(/class\s+\w*Loop\b/);
    expect(source).not.toMatch(/runIfDue/);
  });

  it("index.ts wires the backfill as a one-shot call, not a recurring background job", () => {
    const source = readFileSync(
      fileURLToPath(new URL('./index.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/InstitutionalMemoryEmbeddingLoop/);
    expect(source).not.toMatch(/institutional-memory-embedding['"]/);
    // Only the ordinary server start runs a network backfill.
    expect(source.match(/backfillInstitutionalMemoryEmbeddingsOnce\(/g)).toHaveLength(1);
  });
});
