import { describe, expect, it, beforeEach } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

// getInstitutionalMemoryTurnStats reads back the search_memory call/miss
// counters `searchInstitutionalMemory` accumulates on the turn's own
// institutional_context_serves row, for the daemon's turn trace to record
// after the turn settles (measurement #4 in the captain's intent).

const WORKSPACE = '10000000-0000-4000-8000-0000000075e1';
const ROOM = '20000000-0000-4000-8000-0000000075e1';
const CAPTAIN = 'a'.repeat(64);
const RONNIE = 'b'.repeat(64);
const OUTSIDER = 'c'.repeat(64);
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
    `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Captain'),($2,'agent','Ronnie'),($3,'agent','Outsider')`,
    [CAPTAIN, RONNIE, OUTSIDER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Captain WS')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1'),($3,$2,'host-1')`,
    [RONNIE, CAPTAIN, OUTSIDER],
  );
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
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'order a cake')`,
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

describe('getInstitutionalMemoryTurnStats', () => {
  it('counts every search_memory call and every one that came back empty', async () => {
    const daemon = liveDaemon();
    await openCommand('turn-1', 'gen-1');
    await daemon.execute(
      'proposeInstitutionalMemory',
      {
        agentId: RONNIE,
        roomId: ROOM,
        requestId: 'turn-1',
        generationId: 'gen-1',
        memoryKind: 'human_profile_fact',
        canonicalKey: 'requester.wife.name',
        body: 'Her name is Daeun.',
        keywords: ['wife', 'name'],
        sourceMessageIds: [MESSAGE],
        correction: false,
        confidence: 0.9,
        cas: { baseVersion: null },
      },
      RONNIE,
    );
    // The passive snapshot writes the serve row this turn's stats ride on.
    await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-1', generationId: 'gen-1' },
      RONNIE,
    );
    for (const query of ['wife name', 'birthday', 'phone number']) {
      await daemon.execute(
        'searchInstitutionalMemory',
        { agentId: RONNIE, roomId: ROOM, requestId: 'turn-1', generationId: 'gen-1', query },
        RONNIE,
      );
    }
    const stats = await daemon.execute(
      'getInstitutionalMemoryTurnStats',
      { roomId: ROOM, agentId: RONNIE, requestId: 'turn-1' },
      RONNIE,
    );
    expect(stats.searchCalls).toBe(3);
    // "wife name" hits, "birthday" and "phone number" miss.
    expect(stats.searchMisses).toBe(2);
  });

  it('reads zero for a request nobody called search_memory on', async () => {
    const daemon = liveDaemon();
    await openCommand('turn-2', 'gen-2');
    await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-2', generationId: 'gen-2' },
      RONNIE,
    );
    const stats = await daemon.execute(
      'getInstitutionalMemoryTurnStats',
      { roomId: ROOM, agentId: RONNIE, requestId: 'turn-2' },
      RONNIE,
    );
    expect(stats).toEqual({ searchCalls: 0, searchMisses: 0 });
  });

  it("refuses to read another agent's turn stats (the daemon token's own agentId check, ahead of the handler)", async () => {
    const daemon = liveDaemon();
    await openCommand('turn-3', 'gen-3');
    await daemon.execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: 'turn-3', generationId: 'gen-3' },
      RONNIE,
    );
    await daemon.execute(
      'searchInstitutionalMemory',
      { agentId: RONNIE, roomId: ROOM, requestId: 'turn-3', generationId: 'gen-3', query: 'wife' },
      RONNIE,
    );
    await expect(
      daemon.execute(
        'getInstitutionalMemoryTurnStats',
        { roomId: ROOM, agentId: RONNIE, requestId: 'turn-3' },
        OUTSIDER,
      ),
    ).rejects.toThrow('daemon token does not own requested agent');
  });
});
