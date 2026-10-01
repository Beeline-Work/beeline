import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

// Reproduction for the daily feedback sweep's "corner turns cannot load
// institutional memory/history" reports (fb_fe0b34c4c5ccdfe257d9e8f1,
// fb_5c241d071a4117526e45f34c, fb_70b33d53ed1be7eb36f75e09,
// fb_981f2a78501a06ecb8105687, fb_52faddfbdd9900efb4117c81,
// fb_079ce16ab69664cb55704b2a). The per-turn snapshot, search_memory and
// search_history all derive "requester authority" from the turn command's
// root_source_message_id; a corner lifecycle turn (checks verdict, review
// wake, merge refusal/conflict) has no parent command, so its root is the
// @system/GitHub note that woke it, and the authority query's
// `requester.kind='human'` join drops it -> 503 requester authority is
// unavailable. The corner's own durable requester is
// corner_facts.commissioned_by; this test locks the fix to that.

const WORKSPACE = '10000000-0000-4000-8000-00000000ca11';
const ROOM = '20000000-0000-4000-8000-00000000ca11';
const CORNER = '30000000-0000-4000-8000-00000000ca11';
const OTHER_CORNER = '40000000-0000-4000-8000-00000000ca11';
const CAPTAIN = 'a'.repeat(64);
const NIGLET = 'b'.repeat(64);
const ROOT = 'c'.repeat(64);
const NOTE = 'd'.repeat(64);
const CARD = 'e'.repeat(64);

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
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Captain'),($2,'agent','Niglet'),($3,'human','@system')`,
    [CAPTAIN, NIGLET, SYSTEM_IDENTITY_ID],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Captain WS')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [
    NIGLET,
    CAPTAIN,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`,
    [ROOM, WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Fix login'),($4,$2,$3,'Triage')`,
    [CORNER, WORKSPACE, ROOM, OTHER_CORNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member'),
       ($1,$6,$2,'owner'),($1,$6,$3,'member')`,
    [WORKSPACE, CAPTAIN, NIGLET, ROOM, CORNER, OTHER_CORNER],
  );
  // ROOT: the human request in the parent Room (the corner objective's root).
  // NOTE: the @system checks note that wakes a corner fix/review turn.
  // CARD: a human answer inside a sibling corner (corner opened from a corner).
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$2,$3,'@niglet please fix the login screen'),
       ($4,$5,$6,'checks passed on the current head'),
       ($7,$8,$3,'@niglet picked A · dispatch')`,
    [ROOT, ROOM, CAPTAIN, NOTE, CORNER, SYSTEM_IDENTITY_ID, CARD, OTHER_CORNER],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,commissioned_by,objective,lane,kind,lifecycle,title_generated)
     VALUES($1,$2,'Fix login','code','human','{"lifecycle":"working","checks":"passing"}',false),
           ($3,$2,'Triage','code','human','{"lifecycle":"working","checks":"passing"}',false)`,
    [CORNER, CAPTAIN, OTHER_CORNER],
  );
  await database.query(
    `UPDATE institutional_memory_workspace_rollouts SET stage='live' WHERE workspace_id=$1`,
    [WORKSPACE],
  );
});

afterEach(async () => {
  await database.close();
  vi.unstubAllGlobals();
});

async function claim(roomId: string, requestId: string, generationId: string) {
  const command = await createAgentCommand(database, {
    roomId,
    agentId: NIGLET,
    sourceMessageId: requestId,
    reason: 'corner_objective',
    turnRequestId: requestId,
  });
  await claimAgentCommand(database, roomId, NIGLET, command!.id, generationId);
  return command!;
}

describe('corner turn institutional authority', () => {
  it('serves search_memory and search_history on a corner objective turn whose durable root is the human Room request', async () => {
    const daemon = liveDaemon();
    const roomCommand = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: NIGLET,
      sourceMessageId: ROOT,
      reason: 'human_tag',
      turnRequestId: 'room-turn',
    });
    const corner = await createAgentCommand(database, {
      roomId: CORNER,
      agentId: NIGLET,
      sourceMessageId: ROOT,
      reason: 'corner_objective',
      parent: roomCommand!,
      retainDepth: true,
      turnRequestId: 'corner-turn',
    });
    await claimAgentCommand(database, CORNER, NIGLET, corner!.id, 'corner-generation');
    const memory = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: NIGLET,
        roomId: CORNER,
        requestId: 'corner-turn',
        generationId: 'corner-generation',
        query: 'anything',
      },
      NIGLET,
    );
    expect(memory.results).toEqual([]);
    const history = await daemon.execute(
      'searchInstitutionalHistory',
      {
        agentId: NIGLET,
        roomId: CORNER,
        requestId: 'corner-turn',
        generationId: 'corner-generation',
        query: 'login',
        limit: 5,
      },
      NIGLET,
    );
    expect(history.results).toBeDefined();
  });

  it('serves a corner opened from a corner whose durable root is a human message inside the sibling corner', async () => {
    const daemon = liveDaemon();
    // The dispatch turn inside OTHER_CORNER is woken by the human's
    // choice-answered line (CARD); open_corner parents the new corner's
    // objective command on it.
    const dispatch = await createAgentCommand(database, {
      roomId: OTHER_CORNER,
      agentId: NIGLET,
      sourceMessageId: CARD,
      reason: 'subscribed_event',
      turnRequestId: 'dispatch-turn',
    });
    const corner = await createAgentCommand(database, {
      roomId: CORNER,
      agentId: NIGLET,
      sourceMessageId: CARD,
      reason: 'corner_objective',
      parent: dispatch!,
      retainDepth: true,
      turnRequestId: 'corner-from-corner-turn',
    });
    await claimAgentCommand(database, CORNER, NIGLET, corner!.id, 'corner-from-corner-generation');
    const memory = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: NIGLET,
        roomId: CORNER,
        requestId: 'corner-from-corner-turn',
        generationId: 'corner-from-corner-generation',
        query: 'anything',
      },
      NIGLET,
    );
    expect(memory.results).toEqual([]);
  });

  it('serves a corner checks turn whose wake note is authored by @system (regression)', async () => {
    const daemon = liveDaemon();
    // The corner workflow's checks transition creates the fix/review command
    // with the checks note as its source and NO parent command, so the
    // command's root_source_message_id is the @system-authored note itself.
    await claim(CORNER, NOTE, 'checks-generation');
    const memory = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: NIGLET,
        roomId: CORNER,
        requestId: NOTE,
        generationId: 'checks-generation',
        query: 'anything',
      },
      NIGLET,
    );
    expect(memory.results).toEqual([]);
    const history = await daemon.execute(
      'searchInstitutionalHistory',
      {
        agentId: NIGLET,
        roomId: CORNER,
        requestId: NOTE,
        generationId: 'checks-generation',
        query: 'login',
        limit: 5,
      },
      NIGLET,
    );
    expect(history.results).toBeDefined();
    // The per-turn snapshot fails in the same turns; it must serve the corner
    // fallback too, not just the search tools.
    const snapshot = await daemon.execute(
      'getInstitutionalContext',
      { roomId: CORNER, requestId: NOTE, generationId: 'checks-generation' },
      NIGLET,
    );
    expect(snapshot.snapshotRevision).toBe(0);
    expect(snapshot.itemIds).toEqual([]);
  });
});
