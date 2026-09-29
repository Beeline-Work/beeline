import { describe, expect, it, beforeEach } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

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

const liveConfig = { enabled: true, dailyJobLimit: 20, leaseMs: 60_000, live: true } as const;

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
}

describe('search_memory recall (institutional memory)', () => {
  it("finds the active requester profile fact for every one of Ronnie's real natural-language queries", async () => {
    const daemon = liveDaemon();
    await openCommand('cake-order-turn', 'cake-order-generation');

    const saved = await daemon.execute(
      'proposeInstitutionalMemory',
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
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
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
      'proposeInstitutionalMemory',
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
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
      },
      RONNIE,
    );
    await database.query(`UPDATE institutional_memory_items SET state='stale' WHERE id=$1`, [
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
      'proposeInstitutionalMemory',
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
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
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
      'proposeInstitutionalMemory',
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
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
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
      'proposeInstitutionalMemory',
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
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
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
