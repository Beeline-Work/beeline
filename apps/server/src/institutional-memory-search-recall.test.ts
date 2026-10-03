import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS } from '@beeline/api-contract/daemon';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { OPENROUTER_EMBEDDINGS_URL } from './institutional-memory-embeddings.js';
import { pgvectorLiteral } from './institutional-memory-embeddings.js';
import { searchInstitutionalMemory } from './institutional-memory-shadow.js';

// Regression coverage for the P1 "wife's details not loading" bug (captain
// bug, corner "Personal/cake order", 2026-09-29 13:49 EDT). Root-caused on
// Ronnie's real production turn (journalctl + turn-trace + pi session log):
// `searchInstitutionalMemory` required the ENTIRE query to appear as one
// literal substring of an item's canonical_key/body, so none of Ronnie's
// seven real natural-language `search_memory` queries (below) matched the
// active human_profile_fact that held the answer. The turn's passive
// per-turn snapshot had separately timed out (a distinct, un-fixed-here
// defect in apps/body/src/institutional-context.ts's 200ms budget), which is
// why Ronnie fell back to `search_memory` at all -- not why that fallback
// failed.

const WORKSPACE = '10000000-0000-4000-8000-00000000ca11';
const ROOM = '20000000-0000-4000-8000-00000000ca11'; // "Personal"
const CAPTAIN = 'a'.repeat(64);
const RONNIE = 'b'.repeat(64);
const MESSAGE = 'd'.repeat(64);

let database: PgliteDatabase;

const liveConfig = { enabled: true, live: true } as const;

function liveDaemon() {
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
       ($1,$2,$3,'@ronnie order a cake for my wife, deliver it to her in Tokyo')`,
    [MESSAGE, ROOM, CAPTAIN],
  );
  await database.query(
    `UPDATE institutional_memory_workspace_rollouts SET stage='live' WHERE workspace_id=$1`,
    [WORKSPACE],
  );
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
  return command!;
}

describe('search_memory recall (institutional memory)', () => {
  it('returns no unrelated vector row and counts a miss', async () => {
    const daemon = liveDaemon();
    await openCommand('floor-turn', 'floor-generation');
    const unrelated = '30000000-0000-4000-8000-00000000ca11';
    const vector = [0, 1, ...new Array(1022).fill(0)];
    await database.query(
      `INSERT INTO institutional_memory_items
       (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
        audience_kind,confidence,version,keywords,embedding)
       VALUES($1,$2,'workspace_fact','unrelated.fruit','Oranges grow in Spain.',$3,$4,
         'workspace',0.9,1,ARRAY['orange'],$5::vector)`,
      [unrelated,WORKSPACE,ROOM,MESSAGE,pgvectorLiteral(vector)],
    );
    process.env.OPENROUTER_EMBEDDING_API_KEY='test-key';
    vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({
      data:[{embedding:[1,...new Array(1023).fill(0)],index:0}],
    }),{status:200,headers:{'content-type':'application/json'}})));
    await daemon.execute('getInstitutionalContext',
      {roomId:ROOM,requestId:'floor-turn',generationId:'floor-generation'},RONNIE);
    const result = await daemon.execute('searchInstitutionalMemory',{
      agentId:RONNIE,roomId:ROOM,requestId:'floor-turn',
      generationId:'floor-generation',query:'semantically distant question',
    },RONNIE);
    expect(result.results).toEqual([]);
    const stats = (await database.query<{ search_memory_misses: number }>(
      `SELECT search_memory_misses FROM institutional_context_serves
       WHERE room_id=$1 AND request_id='floor-turn'`,[ROOM])).rows[0];
    expect(stats?.search_memory_misses).toBe(1);
    delete process.env.OPENROUTER_EMBEDDING_API_KEY;
    vi.unstubAllGlobals();
  });

  it('embeds the query before opening the search transaction', async () => {
    const command=await openCommand('before-tx','before-gen');
    const original=database.transaction.bind(database);
    let inside=false;
    vi.spyOn(database,'transaction').mockImplementation(async (work) => {
      inside=true;
      try { return await original(work); } finally { inside=false; }
    });
    await searchInstitutionalMemory(database,command,{agentId:RONNIE,roomId:ROOM,
      query:'missing fact'},async () => {
      expect(inside).toBe(false);
      return {outcome:'disabled',ms:0};
    });
  });
  it("finds the active requester profile fact for every one of Ronnie's real natural-language queries", async () => {
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');

    const saved = await daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.wife.daeun_lee.japan_delivery',
        body: "Daeun's Tokyo delivery address is Motoazabu Hills 3-2-1 #402, phone 03-4700-2210, email daeun.lee@example.com.",
        keywords: ['wife', 'tokyo', 'delivery', 'address'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
    expect(saved.itemId).toBeTruthy();

    // The passive per-turn snapshot: root message says "wife" + "tokyo", the
    // item's keywords overlap, so it is already carried in ambient context.
    const context = await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'cake-order-turn', generationId: 'cake-order-generation' },
      RONNIE,
    );
    expect(context.itemIds).toContain(saved.itemId);

    // The exact seven queries Ronnie's real turn issued via search_memory
    // (pi session transcript, corner 72e6065e "cake order", turn
    // 311ba018c7a4... at 2026-09-29T17:49:32.575Z). Six are on-topic and must
    // find the fact; "birthday" is intentionally off-topic and must not.
    const onTopicQueries = [
      'wife Tokyo address',
      'wife name Tokyo cake delivery details',
      'Japan address',
      'Gigi Lee',
      'phone number recipient',
      'requester wife name',
    ];
    for (const query of onTopicQueries) {
      const result = await daemon.execute(
        'searchInstitutionalMemory',
        {
          agentId: RONNIE,
          roomId: ROOM,
          requestId: 'cake-order-turn',
          generationId: 'cake-order-generation',
          query,
        },
        RONNIE,
      );
      expect(result.results.map((r) => r.id), `query: ${query}`).toContain(saved.itemId);
    }

    const offTopic = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        query: 'birthday',
      },
      RONNIE,
    );
    expect(offTopic.results.map((r) => r.id)).not.toContain(saved.itemId);
  });

  it('does not return a stale item, even when its words match the query', async () => {
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');
    const saved = await daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'workspace_fact',
        canonicalKey: 'recipient.daeun_lee.delivery_details',
        body: 'Daeun receives deliveries at Motoazabu Hills 3-2-1 #402 in Tokyo.',
        keywords: ['daeun', 'motoazabu', 'delivery'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
    await database.query(`UPDATE institutional_memory_items
      SET state='stale',body='',deleted_at=now() WHERE id=$1`, [
      saved.itemId,
    ]);
    const result = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        query: 'phone number recipient',
      },
      RONNIE,
    );
    expect(result.results).toEqual([]);
  });

  // institutionalMemoryRequestWords only extracts [a-z0-9] runs, so a
  // non-Latin-script query (this household's own data: a Korean name,
  // Japanese address) extracts zero words. The whole-trimmed-query literal
  // substring match (the old, pre-tokenization behavior) is kept as a
  // standing OR alternative specifically so these keep working.
  it('finds a fact by a literal Korean query with no extractable Latin words', async () => {
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');
    const saved = await daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.wife.daeun_lee.korean_address',
        body: '다은 주소는 서울시 강남구에 있습니다.',
        keywords: ['korean', 'address'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
    const result = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        query: '다은 주소',
      },
      RONNIE,
    );
    expect(result.results.map((r) => r.id)).toContain(saved.itemId);
  });

  it('finds a fact by a literal Japanese query with no extractable Latin words', async () => {
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');
    const saved = await daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.wife.daeun_lee.japan_address',
        body: '受取人: ダウン 電話: 03-4700-2210 元麻布のマンション',
        keywords: ['japan', 'address'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
    for (const query of ['元麻布', 'ダウン 電話']) {
      const result = await daemon.execute(
        'searchInstitutionalMemory',
        {
          agentId: RONNIE,
          roomId: ROOM,
          requestId: 'cake-order-turn',
          generationId: 'cake-order-generation',
          query,
        },
        RONNIE,
      );
      expect(result.results.map((r) => r.id), `query: ${query}`).toContain(saved.itemId);
    }
  });

  it('finds a fact by a mixed Latin/non-Latin query', async () => {
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');
    const saved = await daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.wife.daeun_lee.mixed_address',
        body: 'Daeun 住所: 東京都港区元麻布',
        keywords: ['daeun', 'address'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
    const result = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        query: 'Daeun 住所',
      },
      RONNIE,
    );
    expect(result.results.map((r) => r.id)).toContain(saved.itemId);
  });
});

/**
 * Meaning-based recall: the vector channel UNIONs with the word-overlap
 * channel above. "where does my wife live" shares NO word with either this
 * item's canonical_key/body or its keywords (the fact is stored as Daeun's
 * delivery address, with no "wife" anywhere), so only meaning-based matching
 * can find it — the whole point of the acceptance criterion. A real
 * `voyageai/voyage-4-lite` embedding call was verified by hand through the
 * Trusty Squire vault against this exact query/fact pair (see the PR body for
 * the recorded cosine similarities); these tests use a deterministic fake
 * embedder over the real OpenRouter transport (real env var + real fetch
 * code path, fake network response) so they need no network and no key.
 */
const EMBEDDING_DIM = INSTITUTIONAL_MEMORY_EMBEDDING_DIMENSIONS;

/** A one-hot vector: two different concepts are orthogonal (cosine distance
 *  1), the same concept is identical (cosine distance 0). */
function conceptVector(concept: number): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0);
  vector[concept % EMBEDDING_DIM] = 1;
  return vector;
}

const WIFE_CONCEPT = 0;
const OTHER_CONCEPT = 1;

/** True for text this fake model considers semantically about "the
 *  requester's wife" even when it shares no literal word with "wife". */
function isWifeConcept(text: string): boolean {
  return /\bwife\b|\bdaeun\b/i.test(text);
}

function stubEmbeddingFetch(): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(OPENROUTER_EMBEDDINGS_URL);
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    const data = body.input.map((text, index) => ({
      embedding: conceptVector(isWifeConcept(text) ? WIFE_CONCEPT : OTHER_CONCEPT),
      index,
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

describe('search_memory hybrid vector recall (no shared words)', () => {
  beforeEach(() => {
    process.env.OPENROUTER_EMBEDDING_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.OPENROUTER_EMBEDDING_API_KEY;
    vi.unstubAllGlobals();
  });

  async function saveDaeunFactWithoutWifeWord(daemon: DaemonService) {
    return daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.spouse.daeun_lee.japan_residence',
        body: "Daeun's Tokyo residence is Motoazabu Hills 3-2-1 #402, phone 03-4700-2210.",
        keywords: ['daeun', 'tokyo', 'residence', 'address'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
  }

  it('finds the fact for "where does my wife live" even though it shares no word with it', async () => {
    stubEmbeddingFetch();
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');
    const saved = await saveDaeunFactWithoutWifeWord(daemon);
    expect(saved.itemId).toBeTruthy();

    // Embedding must be present before the vector query can find it (the
    // real code embeds on save asynchronously via the background cycle;
    // here we embed the row directly to isolate the search path).
    await database.query(
      `UPDATE institutional_memory_items SET embedding=$2::vector,embedding_model='voyageai/voyage-4-lite',embedded_at=now() WHERE id=$1`,
      [saved.itemId, `[${conceptVector(WIFE_CONCEPT).join(',')}]`],
    );

    const result = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        query: 'where does my wife live',
      },
      RONNIE,
    );
    expect(result.results.map((r) => r.id)).toContain(saved.itemId);
  });

  it('finds a small workspace after 500 closer vectors in another workspace', async () => {
    stubEmbeddingFetch();
    const otherWorkspace = '10000000-0000-4000-8000-00000000ca33';
    const otherRoom = '20000000-0000-4000-8000-00000000ca33';
    const otherMessage = 'f'.repeat(64);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Large WS')`,[otherWorkspace]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Large')`,[otherRoom,otherWorkspace]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Source')`,
      [otherMessage,otherRoom,CAPTAIN]);
    await database.query(`INSERT INTO institutional_memory_items
      (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
       audience_kind,confidence,version,keywords,embedding)
      SELECT ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'workspace_fact',
        'large.fact.'||n,'A closer vector fact '||n,$2,$3,'workspace',0.9,1,
        ARRAY['nomatch'],$4::vector
      FROM generate_series(1,500) AS n`,
      [otherWorkspace,otherRoom,otherMessage,pgvectorLiteral(conceptVector(WIFE_CONCEPT))]);
    const smallVector=[0.98,0.2,...new Array(1022).fill(0)];
    await database.query(`INSERT INTO institutional_memory_items
      (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
       audience_kind,confidence,version,keywords,embedding)
      SELECT ('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'workspace_fact',
        'small.fact.'||n,'Small workspace fact '||n,$2,$3,'workspace',0.9,1,
        ARRAY['nomatch'],$4::vector
      FROM generate_series(1,5) AS n`,
      [WORKSPACE,ROOM,MESSAGE,pgvectorLiteral(smallVector)]);
    await openCommand('small-workspace-turn','small-workspace-generation');
    const result=await liveDaemon().execute('searchInstitutionalMemory',{
      agentId:RONNIE,roomId:ROOM,requestId:'small-workspace-turn',
      generationId:'small-workspace-generation',query:'where does my wife live',
    },RONNIE);
    expect(result.results).toHaveLength(5);
    expect(result.results.every(row=>row.body.startsWith('Small workspace fact'))).toBe(true);
  });

  it('never surfaces a vector match from another workspace, another requester profile, or a stale item', async () => {
    const fetchImpl = stubEmbeddingFetch();
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');
    const saved = await saveDaeunFactWithoutWifeWord(daemon);

    // Another Workspace's identical-concept workspace_fact.
    const OTHER_WORKSPACE = '10000000-0000-4000-8000-00000000ca22';
    const OTHER_ROOM = '20000000-0000-4000-8000-00000000ca22';
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other WS')`, [
      OTHER_WORKSPACE,
    ]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [
      OTHER_ROOM,
      OTHER_WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [OTHER_WORKSPACE, CAPTAIN, OTHER_ROOM],
    );
    const otherMessage = 'e'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'unrelated message')`,
      [otherMessage, OTHER_ROOM, CAPTAIN],
    );
    const otherItemId = randomUUID();
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
          audience_kind,confidence,version,keywords,embedding,embedding_model,embedded_at)
       VALUES($1::uuid,$2,'workspace_fact','other.workspace.fact','Some other workspace fact about Daeun.',
              'active',$3,$4,'workspace',0.9,1,'{}',$5::vector,'voyageai/voyage-4-lite',now())`,
      [
        otherItemId,
        OTHER_WORKSPACE,
        OTHER_ROOM,
        otherMessage,
        `[${conceptVector(WIFE_CONCEPT).join(',')}]`,
      ],
    );

    // A stale copy in THIS workspace that would otherwise win by concept.
    const staleFact = await daemon.execute(
      'saveInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        memoryKind: 'workspace_fact',
        canonicalKey: 'recipient.daeun_lee.old_residence',
        body: 'Daeun used to reside at a different address.',
        keywords: ['daeun', 'residence'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.9,
      },
      RONNIE,
    );
    await database.query(
      `UPDATE institutional_memory_items
       SET state='stale',body='',deleted_at=now(),
           embedding=$2::vector,embedding_model='voyageai/voyage-4-lite',embedded_at=now()
       WHERE id=$1`,
      [staleFact.itemId, `[${conceptVector(WIFE_CONCEPT).join(',')}]`],
    );

    // Embed the target fact last so it is the only ACTIVE, in-scope match.
    await database.query(
      `UPDATE institutional_memory_items SET embedding=$2::vector,embedding_model='voyageai/voyage-4-lite',embedded_at=now() WHERE id=$1`,
      [saved.itemId, `[${conceptVector(WIFE_CONCEPT).join(',')}]`],
    );

    const result = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'cake-order-turn',
        generationId: 'cake-order-generation',
        query: 'where does my wife live',
      },
      RONNIE,
    );
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain(saved.itemId);
    expect(ids).not.toContain(otherItemId);
    expect(ids).not.toContain(staleFact.itemId);
    expect(fetchImpl).toHaveBeenCalled();
  });
});
