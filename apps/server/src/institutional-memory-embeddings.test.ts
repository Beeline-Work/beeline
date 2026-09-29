import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import {
  createDefaultEmbedFn,
  createDefaultEmbedBatchFn,
  pgvectorLiteral,
  withDeadline,
  runInstitutionalMemoryEmbeddingCycle,
  InstitutionalMemoryEmbeddingLoop,
  OPENROUTER_EMBEDDINGS_URL,
  type EmbedFn,
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
});

describe('createDefaultEmbedFn', () => {
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
  it('passes through a fast, successful embed unchanged', async () => {
    const fast: EmbedFn = async () => ({ outcome: 'served', vector: VECTOR, ms: 1 });
    const bounded = withDeadline(fast, 1_000);
    const result = await bounded('x', 'query');
    expect(result.outcome).toBe('served');
  });

  it('reports timed-out when the embedder takes longer than the deadline, and never rejects', async () => {
    const slow: EmbedFn = () => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'served', vector: VECTOR, ms: 500 }), 500));
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

describe('runInstitutionalMemoryEmbeddingCycle', () => {
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
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'hello')`,
      [MESSAGE, ROOM, CAPTAIN],
    );
  }

  it('embeds an unembedded active item and records the model and timestamp', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
          audience_kind,confidence,version,keywords)
       VALUES($1::uuid,$2,'workspace_fact','a.fact','A fact.','active',$3,$4,'workspace',0.9,1,'{}')`,
      [itemId, WORKSPACE, ROOM, MESSAGE],
    );
    const embedBatch = vi.fn(async (texts: readonly string[]) => texts.map(() => VECTOR));
    const counts = await runInstitutionalMemoryEmbeddingCycle(database, embedBatch);
    expect(counts.itemsEmbedded).toBe(1);
    expect(embedBatch).toHaveBeenCalledWith(['a.fact: A fact.'], 'document');
    const row = (
      await database.query<{ embedding_model: string; embedded_at: Date | null }>(
        `SELECT embedding_model,embedded_at FROM institutional_memory_items WHERE id=$1`,
        [itemId],
      )
    ).rows[0];
    expect(row?.embedding_model).toBe('voyageai/voyage-4-lite');
    expect(row?.embedded_at).toBeTruthy();
  });

  it('does not re-embed a row already embedded with the current model', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
          audience_kind,confidence,version,keywords,embedding,embedding_model,embedded_at)
       VALUES($1::uuid,$2,'workspace_fact','a.fact','A fact.','active',$3,$4,'workspace',0.9,1,'{}',
              $5::vector,'voyageai/voyage-4-lite',now())`,
      [itemId, WORKSPACE, ROOM, MESSAGE, pgvectorLiteral(VECTOR)],
    );
    const embedBatch = vi.fn(async (texts: readonly string[]) => texts.map(() => VECTOR));
    const counts = await runInstitutionalMemoryEmbeddingCycle(database, embedBatch);
    expect(counts.itemsEmbedded).toBe(0);
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('re-embeds a workspace_skills row whose current_version moved past its stored embedding_version', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const skillId = 'ffffffff-ffff-4fff-8fff-fffffffffff3';
    const jobId = 'ffffffff-ffff-4fff-8fff-fffffffffff4';
    await database.query(
      `INSERT INTO institutional_memory_jobs
         (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,requester_identity_id,
          source_audience_kind,idempotency_key,status)
       VALUES($1::uuid,$2,'merge_review','live',$3,$4,$5,'workspace_candidate','idem-1','completed')`,
      [jobId, WORKSPACE, ROOM, MESSAGE, CAPTAIN],
    );
    await database.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,embedding,embedding_model,embedding_version,embedded_at)
       VALUES($1::uuid,$2,'deploy-app','How to deploy the app','active',2,1,$3,'org/repo','abc',
              $4::vector,'voyageai/voyage-4-lite',1,now())`,
      [skillId, WORKSPACE, ROOM, pgvectorLiteral(VECTOR)],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,
          target_commit,extractor_version,model)
       VALUES($1::uuid,2,'Run npm run deploy.','${'a'.repeat(64)}',$2::uuid,$3,'org/repo','abc','v1','model')`,
      [skillId, jobId, [MESSAGE]],
    );
    const embedBatch = vi.fn(async (texts: readonly string[]) => texts.map(() => VECTOR));
    const counts = await runInstitutionalMemoryEmbeddingCycle(database, embedBatch);
    expect(counts.skillsEmbedded).toBe(1);
    expect(embedBatch.mock.calls[0]?.[0][0]).toContain('deploy app');
    const row = (
      await database.query<{ embedding_version: number }>(
        `SELECT embedding_version FROM workspace_skills WHERE id=$1`,
        [skillId],
      )
    ).rows[0];
    expect(row?.embedding_version).toBe(2);
  });

  it('leaves rows unembedded (for the next pass) when the batch embedder returns nothing', async () => {
    const database = new PgliteDatabase();
    await seed(database);
    const itemId = 'ffffffff-ffff-4fff-8fff-fffffffffff5';
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
          audience_kind,confidence,version,keywords)
       VALUES($1::uuid,$2,'workspace_fact','a.fact','A fact.','active',$3,$4,'workspace',0.9,1,'{}')`,
      [itemId, WORKSPACE, ROOM, MESSAGE],
    );
    const counts = await runInstitutionalMemoryEmbeddingCycle(
      database,
      async () => undefined,
    );
    expect(counts.itemsEmbedded).toBe(0);
    const row = (
      await database.query<{ embedding_model: string | null }>(
        `SELECT embedding_model FROM institutional_memory_items WHERE id=$1`,
        [itemId],
      )
    ).rows[0];
    expect(row?.embedding_model).toBeNull();
  });
});

describe('InstitutionalMemoryEmbeddingLoop', () => {
  it('throttles: a second runIfDue before the interval elapses is a no-op', async () => {
    const database = new PgliteDatabase();
    await migrate(database);
    let now = 0;
    const embedBatch = vi.fn(async () => undefined);
    const loop = new InstitutionalMemoryEmbeddingLoop(database, embedBatch, 1_000, 20, () => now);
    expect(await loop.runIfDue()).toBeDefined();
    now = 500;
    expect(await loop.runIfDue()).toBeUndefined();
    now = 1_100;
    expect(await loop.runIfDue()).toBeDefined();
  });
});
