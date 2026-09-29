import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS } from '@beeline/api-contract/daemon';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { OPENROUTER_EMBEDDINGS_URL, pgvectorLiteral } from './institutional-memory-embeddings.js';

// The per-turn snapshot (getInstitutionalContext) is hybrid the same way
// search_memory is: its keyword/word-overlap candidates UNION the nearest
// vector matches under the same scope filters. Its own embedding call is
// bounded to a slice of the snapshot's 200ms budget (INSTITUTIONAL_CONTEXT_
// EMBEDDING_TIMEOUT_MS) — a slow call degrades to keyword-only, never to an
// empty snapshot.

const WORKSPACE = '10000000-0000-4000-8000-00000000ce11';
const ROOM = '20000000-0000-4000-8000-00000000ce11';
const CAPTAIN = 'a'.repeat(64);
const RONNIE = 'b'.repeat(64);
const MESSAGE = 'd'.repeat(64);

let database: PgliteDatabase;

const liveConfig = { enabled: true, dailyJobLimit: 20, leaseMs: 60_000, live: true } as const;

function liveDaemon(): DaemonService {
  return new DaemonService(
    database,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    liveConfig,
  );
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Captain'),($2,'agent','Ronnie')`,
    [CAPTAIN, RONNIE],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Captain WS')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [
    RONNIE,
    CAPTAIN,
  ]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Personal')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [WORKSPACE, CAPTAIN, RONNIE, ROOM],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$2,$3,'where does my wife live')`,
    [MESSAGE, ROOM, CAPTAIN],
  );
  await database.query(
    `UPDATE institutional_memory_workspace_rollouts SET stage='live' WHERE workspace_id=$1`,
    [WORKSPACE],
  );
});

afterEach(() => {
  delete process.env.OPENROUTER_EMBEDDING_API_KEY;
  vi.unstubAllGlobals();
});

async function openCommand(requestId: string, generationId: string) {
  const command = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: RONNIE,
    sourceMessageId: MESSAGE,
    reason: 'human_tag',
    turnRequestId: requestId,
  });
  await claimAgentCommand(database, ROOM, RONNIE, command!.id, generationId);
}

const DIM = INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS;
function conceptVector(concept: number): number[] {
  const vector = new Array(DIM).fill(0);
  vector[concept % DIM] = 1;
  return vector;
}
const WIFE_CONCEPT = 0;

function stubEmbeddingFetch(delayMs = 0): void {
  process.env.OPENROUTER_EMBEDDING_API_KEY = 'test-key';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(OPENROUTER_EMBEDDINGS_URL);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const data = body.input.map((_, index) => ({ embedding: conceptVector(WIFE_CONCEPT), index }));
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('getInstitutionalContext hybrid vector snapshot', () => {
  it('surfaces an item the keyword path alone would miss, and reports a served embedding outcome', async () => {
    stubEmbeddingFetch();
    const daemon = liveDaemon();
    await openCommand('turn-1', 'gen-1');
    const saved = await daemon.execute(
      'proposeInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'turn-1',
        generationId: 'gen-1',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.spouse.daeun_lee.japan_residence',
        body: "Daeun's Tokyo residence is Motoazabu Hills 3-2-1 #402.",
        keywords: ['daeun', 'tokyo', 'residence'],
        sourceMessageIds: [MESSAGE],
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
      },
      RONNIE,
    );
    await database.query(
      `UPDATE institutional_memory_items SET embedding=$2::vector,embedding_model='voyageai/voyage-4-lite',embedded_at=now() WHERE id=$1`,
      [saved.itemId, pgvectorLiteral(conceptVector(WIFE_CONCEPT))],
    );

    const context = await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-1', generationId: 'gen-1' },
      RONNIE,
    );
    expect(context.itemIds).toContain(saved.itemId);
    expect(context.embeddingOutcome).toBe('served');
    expect(context.embeddingMs).toBeGreaterThanOrEqual(0);
  });

  it('degrades to keyword-only and reports timed-out when the embedding call exceeds its budget', async () => {
    stubEmbeddingFetch(5_000); // far past INSTITUTIONAL_CONTEXT_EMBEDDING_TIMEOUT_MS
    const daemon = liveDaemon();
    await openCommand('turn-2', 'gen-2');
    // A keyword-matched item, so the snapshot still serves something even
    // though the vector pass never resolves in time.
    const saved = await daemon.execute(
      'proposeInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'turn-2',
        generationId: 'gen-2',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.spouse.daeun_lee.wife_fact',
        body: 'Her name is Daeun.',
        keywords: ['wife', 'daeun'],
        sourceMessageIds: [MESSAGE],
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
      },
      RONNIE,
    );
    const context = await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-2', generationId: 'gen-2' },
      RONNIE,
    );
    expect(context.embeddingOutcome).toBe('timed-out');
    expect(context.itemIds).toContain(saved.itemId);
  });

  it('reports disabled and makes no network call when no embedding key is configured', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const daemon = liveDaemon();
    await openCommand('turn-3', 'gen-3');
    const context = await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-3', generationId: 'gen-3' },
      RONNIE,
    );
    expect(context.embeddingOutcome).toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a workspace skill by meaning alone, matching neither its slug nor its description', async () => {
    stubEmbeddingFetch();
    const daemon = liveDaemon();
    await openCommand('turn-4', 'gen-4');
    const jobId = 'ffffffff-ffff-4fff-8fff-ffffffffff01';
    const skillId = 'ffffffff-ffff-4fff-8fff-ffffffffff02';
    await database.query(
      `INSERT INTO institutional_memory_jobs
         (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,requester_identity_id,
          source_audience_kind,idempotency_key,status)
       VALUES($1::uuid,$2,'merge_review','live',$3,$4,$5,'workspace_candidate','idem-hybrid-1','completed')`,
      [jobId, WORKSPACE, ROOM, MESSAGE, CAPTAIN],
    );
    await database.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,embedding,embedding_model,embedding_version,embedded_at)
       VALUES($1::uuid,$2,'gift-shopping','Buy a present for someone','active',1,1,$3,'org/repo','abc',
              $4::vector,'voyageai/voyage-4-lite',1,now())`,
      [skillId, WORKSPACE, ROOM, pgvectorLiteral(conceptVector(WIFE_CONCEPT))],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,
          target_commit,extractor_version,model)
       VALUES($1::uuid,1,'Check her preferences.',$2,$3::uuid,$4,'org/repo','abc','v1','model')`,
      [skillId, 'c'.repeat(64), jobId, [MESSAGE]],
    );
    const context = await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-4', generationId: 'gen-4' },
      RONNIE,
    );
    expect(context.text).toContain('gift-shopping');
  });
});
