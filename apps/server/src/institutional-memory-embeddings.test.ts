import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import {
  createDefaultEmbedFn,
  createDefaultEmbedBatchFn,
  pgvectorLiteral,
  embedOneInstitutionalMemoryItem,
  embedOneWorkspaceSkillVersion,
  scheduleEmbedInstitutionalMemoryItem,
  scheduleEmbedWorkspaceSkillVersion,
  warnIfEmbeddingKeyMissing,
  resetEmbeddingFailureLogForTests,
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
  resetEmbeddingFailureLogForTests();
});

describe('warnIfEmbeddingKeyMissing', () => {
  it('logs one loud console.error naming the variable when no key is configured', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnIfEmbeddingKeyMissing({});
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('OPENROUTER_EMBEDDING_API_KEY');
    expect(errorSpy.mock.calls[0]?.[0]).toContain('OFF');
    errorSpy.mockRestore();
  });

  it('logs when the key is set but blank', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnIfEmbeddingKeyMissing({ OPENROUTER_EMBEDDING_API_KEY: '   ' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('stays silent when a key is configured', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnIfEmbeddingKeyMissing({ OPENROUTER_EMBEDDING_API_KEY: 'test-key' });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
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

  it('logs a non-200 response with the HTTP status and input type, never the key or text', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'super-secret-key' }, fetchImpl });
    await embed('this memory text must never be logged', 'document');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('503');
    expect(message).toContain('document');
    expect(message).not.toContain('super-secret-key');
    expect(message).not.toContain('this memory text must never be logged');
    errorSpy.mockRestore();
  });

  it('logs a network failure reason without leaking the key or text', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'super-secret-key' }, fetchImpl });
    await embed('private memory contents', 'query');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('query');
    expect(message).not.toContain('super-secret-key');
    expect(message).not.toContain('private memory contents');
    errorSpy.mockRestore();
  });

  it('bounds repeated failure logging: logs the first failure, stays quiet, then logs again periodically', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    const embed = createDefaultEmbedFn({ env: { OPENROUTER_EMBEDDING_API_KEY: 'test-key' }, fetchImpl });
    for (let i = 0; i < 100; i++) await embed('x', 'query');
    // First failure (#1) and the 100th both log; the 98 in between stay quiet.
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
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
    // Regression: `saveSkill`/`saveInstitutionalMemory` schedule with no
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

describe('one embedding attempt per actual save', () => {
  it.each(['unavailable', 'throws'])('parks a %s provider result for an idle day', async mode => {
    vi.useFakeTimers();
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff5';
    await insertItem(database, itemId);
    const embedBatch = mode === 'throws' ? vi.fn().mockRejectedValue(new Error('provider unavailable')) : vi.fn().mockResolvedValue(undefined);
    scheduleEmbedInstitutionalMemoryItem(database, itemId, embedBatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(embedBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(embedBatch).toHaveBeenCalledOnce();
    expect((await database.query<{ embedding_model: string | null }>(
      `SELECT embedding_model FROM institutional_memory_items WHERE id=$1`, [itemId],
    )).rows[0]?.embedding_model).toBeNull();
  });

  it('a later actual save admits a fresh attempt without reviving the failed one', async () => {
    vi.useFakeTimers();
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
    await insertItem(database, itemId);
    const failed = vi.fn().mockResolvedValue(undefined);
    scheduleEmbedInstitutionalMemoryItem(database, itemId, failed);
    await vi.advanceTimersByTimeAsync(0);
    await database.query(`UPDATE institutional_memory_items SET body='Changed document',version=version+1 WHERE id=$1`, [itemId]);
    const next = vi.fn().mockResolvedValue([VECTOR]);
    scheduleEmbedInstitutionalMemoryItem(database, itemId, next);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(failed).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]?.[0]).toContain('Changed document');
    expect((await database.query<{ embedding_model: string | null }>(
      `SELECT embedding_model FROM institutional_memory_items WHERE id=$1`, [itemId],
    )).rows[0]?.embedding_model).toBe('voyageai/voyage-4-lite');
  });
});

it('startup performs no embedding scan or network backfill',()=>{
  const startup=readFileSync(fileURLToPath(new URL('./index.ts',import.meta.url)),'utf8');
  expect(startup).not.toMatch(/backfillInstitutionalMemoryEmbeddingsOnce|InstitutionalMemoryEmbeddingLoop/);
});
