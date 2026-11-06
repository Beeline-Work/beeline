import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateData } from './database.js';

import { INSTITUTIONAL_CONTEXT_HEADER, tombstoneInstitutionalMemoryForMessage, } from './institutional-memory-shadow.js';

import { PgliteDatabase, migratedDatabase } from './test-support.js';

import { claimAgentCommand, createAgentCommand } from './agent-command.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';


export const WORKSPACE = '10000000-0000-4000-8000-000000000001';

export const OTHER_WORKSPACE = '10000000-0000-4000-8000-000000000002';

export const ROOM = '20000000-0000-4000-8000-000000000001';

export const DM = '20000000-0000-4000-8000-000000000002';

export const OTHER_ROOM = '20000000-0000-4000-8000-000000000003';

export const HUMAN = 'a'.repeat(64);

export const AGENT = 'b'.repeat(64);

export const OTHER_AGENT = 'c'.repeat(64);

export const OTHER_HUMAN = 'f'.repeat(64);

export const MESSAGE = 'd'.repeat(64);

export const DM_MESSAGE = 'e'.repeat(64);

const liveConfig = { enabled: true, live: true } as const;


export let database: PgliteDatabase;


beforeEach(async () => {
  database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Human'),($2,'agent','Bee'),($3,'agent','Wasp')`,
    [HUMAN, AGENT, OTHER_AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Memory')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,machine_id) VALUES
       ($1,$3,'host-1'),($2,$3,'host-1')`,
    [AGENT, OTHER_AGENT, HUMAN],
  );
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants)
       VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text))`,
    [DM, WORKSPACE, HUMAN, AGENT],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),
       ($1,$6,$2,'owner'),($1,$6,$3,'member'),($1,$6,$4,'member')`,
    [WORKSPACE, HUMAN, AGENT, OTHER_AGENT, ROOM, DM],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$2,$3,'Remember that deploy writes the marker last.'),
       ($4,$5,$3,'Please make a mock before you build for me.')`,
    [MESSAGE, ROOM, HUMAN, DM_MESSAGE, DM],
  );
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other human')`, [
    OTHER_HUMAN,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($1,$3,$2,'member')`,
    [WORKSPACE, OTHER_HUMAN, ROOM],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other workspace')`, [
    OTHER_WORKSPACE,
  ]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Unauthorized')`, [
    OTHER_ROOM,
    OTHER_WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [OTHER_WORKSPACE, OTHER_HUMAN, OTHER_AGENT, OTHER_ROOM],
  );
  // Every Workspace starts enrolled in shadow; live tests promote it explicitly.
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage)
     VALUES($1,'shadow'),($2,'shadow')`,
    [WORKSPACE, OTHER_WORKSPACE],
  );
});


afterEach(async () => {
  await database.close();
});


export function liveDaemon(): DaemonService {
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


/** Live memory is per-Workspace enrollment, never the global flag alone. */
export async function enrollLive(workspaceId = WORKSPACE): Promise<void> {
  await database.query(
    `UPDATE institutional_memory_workspace_rollouts SET stage='live' WHERE workspace_id=$1`,
    [workspaceId],
  );
}


/** Claims one live command for `agentId` answering `sourceMessageId`; returns its turn authority. */
export async function openTurn(
  requestId: string,
  sourceMessageId = MESSAGE,
  agentId = AGENT,
  roomId = ROOM,
): Promise<{ roomId: string; requestId: string; generationId: string }> {
  const generationId = `${requestId}-generation`;
  const command = await createAgentCommand(database, {
    roomId,
    agentId,
    sourceMessageId,
    reason: 'human_tag',
    turnRequestId: requestId,
  });
  await claimAgentCommand(database, roomId, agentId, command!.id, generationId);
  return { roomId, requestId, generationId };
}


export async function closeTurn(
  turn: { roomId: string; requestId: string; generationId: string },
  agentId = AGENT,
): Promise<void> {
  await liveDaemon().execute(
    'postAgentTurnReceipt',
    { ...turn, agentId, status: 'complete' },
    agentId,
  );
}
export const rootFixture = {
get database(){return database;}, set database(value: typeof database){database=value;},
};

export { afterEach, beforeEach, describe, expect, it } from 'vitest';
export { migrateData } from './database.js';
export { INSTITUTIONAL_CONTEXT_HEADER, tombstoneInstitutionalMemoryForMessage } from './institutional-memory-shadow.js';
export { PgliteDatabase, migratedDatabase } from './test-support.js';
export { claimAgentCommand, createAgentCommand } from './agent-command.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
