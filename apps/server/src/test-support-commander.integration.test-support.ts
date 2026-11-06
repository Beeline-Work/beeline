import { cornerImplementerSql } from './corner-worker.js';

import { readCornerObjective, writeCornerObjective } from './corner-objective.js';

import { cornerOpenedFromSql } from './corner-opening.js';

import { activeCornerHolds } from './corner-holds.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { cornerMergeGate } from './corner-lifecycle.js';

import quotedTagPosts from './test-fixtures/quoted-tag-posts.json';

import { AgentScheduleLoop } from './agent-schedules.js';

import { advanceCorner } from './corner-lifecycle.js';

import { randomUUID, randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

import { migrate } from './database.js';

import { PgliteDatabase, migratedDatabase, insertCornerFacts } from './test-support.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { PhoneService } from './phone-service.js';

import { LiveHub } from './live.js';

import { GitHubOperations } from './github-operations.js';

import { createAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';

import { GITHUB_SUBJECT, systemLine } from './system-line.js';

import { unreadMessageSql } from './read-cursor.js';

import type { AgentCommand } from '@beeline/api-contract/daemon';

import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';


export const HUMAN = 'a'.repeat(64), RUBY = 'b'.repeat(64), WORKER = 'c'.repeat(64);

export const WS = '11111111-1111-4111-8111-111111111111';

export const ROOM = 'bb91a1c7-7cad-4fde-aafc-94fccb651ac8';

export const DM = '33333333-3333-4333-8333-333333333333';

export let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;

export let order: AgentCommand;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Captain','captain'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`,
    [HUMAN, RUBY, WORKER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [RUBY, WORKER, HUMAN]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);

afterAll(async () => db.close());

beforeEach(async () => {
  Object.assign(daemon, { github: undefined });
  await db.query(`DELETE FROM agent_commands`);
  await db.query('DELETE FROM agent_connections');
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Review command proof')`, [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
    VALUES($1,$3,'Target Room',NULL,$4),($2,$3,'Captain and Ruby',jsonb_build_array($4::text,$5::text),$4)`, [ROOM, DM, WS, HUMAN, RUBY]);
  for (const person of [HUMAN, RUBY, WORKER]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, person, ROOM]);
    if (person !== WORKER) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [WS, DM, person]);
  }
  await phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text: 'Build the widget in the target Room' }, HUMAN);
  order = (await daemon.execute('getAgentCommands', { roomId: DM }, RUBY)).commands[0]!;
  await claim(order);
});

export const claim = (command: AgentCommand) => daemon.execute('claimAgentCommand', {
  roomId: command.roomId, commandId: command.id, generationId: 'proof-generation',
}, command.agentId);

export const authority = (command: AgentCommand) => ({ roomId: command.roomId,
  requestId: command.turnRequestId, generationId: 'proof-generation' });

export const commands = async (roomId: string, agentId: string) => {


  return (await readAgentCommands(db, roomId, agentId)).commands;
};

export async function open() {
  return daemon.execute('createCorner', { ...authority(order), requestId: order.turnRequestId,
    targetRoomId: ROOM, name: 'Widget', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
  }, RUBY);
}

export async function worker(cornerId: string) {
  const command = (await commands(cornerId, WORKER))[0]!;
  await claim(command);
  return command;
}


// Failure visibility uses the real receipt, silence owner and private transport.
export async function privateAssignment() {
  const receipt = await daemon.execute('order', { ...authority(order), address: ROOM, agent: WORKER, text: 'Sign into the saved Amazon login' }, RUBY);
  const turn = (await commands(ROOM, WORKER)).find(c => c.id === receipt.id)!;
  await claim(turn);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'working' }, WORKER);
  return { turn, receipt };
}


// Orders stay open until the worker reports; the server checks corner state, not every turn.
export async function cornerTurnWithPendingChecks() {
  const opened = await open();
  const lifecycle = { lifecycle: 'in-review', checks: 'pending', pr: { number: 2545, headSha: 'd'.repeat(40) } };
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [opened.cornerId, JSON.stringify(lifecycle)]);
  const turn = await worker(opened.cornerId);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'working' }, WORKER);
  await daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  return { opened, turn, lifecycle };
}


export const duplicateReproduction = '572a0de1c06be02cb120b38294e3d9b80b9bdfa8cdf6e53dcb708819b41393c3';


export const currentPlaceReminder = 'Posted to your current place. Queued files are attached to this post. Closing text is kept in turn activity.';
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get order(){return order;}, set order(value: typeof order){order=value;},
};
export function fixtureScope1() {

  const STRANGER = 'd'.repeat(64), OUTSIDER = 'e'.repeat(64);

  const revise = async (turn: AgentCommand, cornerId: string, expectedRevision: number, sourceMessageId: string) => {
    // Self-revision now returns to a Room/DM turn; exercise approval membership from a reachable turn.
    const source = (await rootFixture.db.query<{ parent_id: string | null }>(`SELECT parent_id FROM rooms WHERE id=$1`, [turn.roomId])).rows[0];
    if (source?.parent_id) turn = await dmTurn(await directMessage(HUMAN, HUMAN, 'Revise the assigned widget brief'));
    return rootFixture.daemon.execute('reviseCornerBrief', { ...authority(turn), cornerId, expectedRevision,
      brief: { spec: 'Build the widget; the proof is waived', repositoryWork: false,
        approval: { sourceMessageId }, change: 'Record the waiver' } }, WORKER);
  };

  const approval = async (cornerId: string) => (await rootFixture.db.query<{ approval_basis: Record<string, unknown> }>(
    `SELECT approval_basis FROM corner_brief_revisions WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`,
    [cornerId])).rows[0]!.approval_basis;

  const rooms = new Map<string, string>();

  /** The worker's claimed turn on a DM message, so the DM is its command Room. */
  async function dmTurn(messageId: string) {
    const command = await createAgentCommand(rootFixture.db, { roomId: rooms.get(messageId)!, agentId: WORKER,
      sourceMessageId: messageId, reason: 'direct_message' });
    const [turn] = (await commands(command!.room_id, WORKER)).filter((item) => item.id === command!.id);
    await claim(turn!);
    return turn!;
  }

  /** A DM between the worker and `person`, holding one message from `author`. */
  async function directMessage(person: string, author: string, text: string) {
    const room = randomUUID(), id = randomBytes(32).toString('hex');
    rooms.set(id, room);
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
      VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text),$3)`, [room, WS, person, WORKER]);
    for (const member of [person, WORKER])
      await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WS, room, member]);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [id, room, author, text]);
    return id;
  }

  beforeAll(async () => {
    await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Stranger','stranger'),($2,'agent','Outsider','outsider') ON CONFLICT DO NOTHING`, [STRANGER, OUTSIDER]);
  });

  beforeEach(async () => {
    for (const person of [STRANGER, OUTSIDER])
      await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`, [WS, person]);
  });
return {
STRANGER,
OUTSIDER,
revise,
approval,
rooms,
dmTurn,
directMessage,
};
}
export { cornerImplementerSql } from './corner-worker.js';
export { readCornerObjective, writeCornerObjective } from './corner-objective.js';
export { cornerOpenedFromSql } from './corner-opening.js';
export { activeCornerHolds } from './corner-holds.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { cornerMergeGate, advanceCorner } from './corner-lifecycle.js';
export { default as quotedTagPosts } from './test-fixtures/quoted-tag-posts.json';
export { AgentScheduleLoop } from './agent-schedules.js';
export { randomUUID, randomBytes } from 'node:crypto';
export { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
export { migrate } from './database.js';
export { PgliteDatabase, migratedDatabase, insertCornerFacts } from './test-support.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { PhoneService } from './phone-service.js';
export { LiveHub } from './live.js';
export { GitHubOperations } from './github-operations.js';
export { createAgentCommand, readAgentCommands } from './agent-command.js';
export { GITHUB_SUBJECT, systemLine } from './system-line.js';
export { unreadMessageSql } from './read-cursor.js';
export type { CommandRow } from './agent-command.js';
export type { AgentCommand } from '@beeline/api-contract/daemon';
export type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
