import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToDatabase } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type SqlDatabase } from './database.js';
import { PgliteDatabase, migratedDatabase, insertCornerFacts } from './test-support.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { createAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';
import { systemLine } from './system-line.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const HUMAN = 'a'.repeat(64), AGENT = 'b'.repeat(64), WORKER = 'c'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService, humanCommand: AgentCommand;
const id = () => randomBytes(32).toString('hex');
const authority = (command: AgentCommand) => ({ roomId: command.roomId,
  requestId: command.turnRequestId, generationId: 'inbox-proof' });
const inbox = (database: SqlDatabase = db, roomId = ROOM, agentId = AGENT) =>
  readAgentCommands(database, roomId, agentId).then(result => result.commands);
const claim = (command: AgentCommand) => daemon.execute('claimAgentCommand', {
  roomId: command.roomId, commandId: command.id, generationId: 'inbox-proof',
}, command.agentId);
async function wake(text: string, reason = 'corner_brief', roomId = ROOM, agentId = AGENT) {
  return createAgentCommand(db, { id: id(), roomId, agentId, sourceMessageId: null, reason,
    privatePayload: { text, authorId: WORKER, fromRoomId: roomId, kind: 'lifecycle' } });
}
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Inbox','inbox'),($3,'agent','Worker','worker')`, [HUMAN, AGENT, WORKER]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [AGENT, WORKER, HUMAN]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM workspaces');
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Inbox proof')", [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES
    ($1,$3,'Inbox Room',$4),($2,$3,'Other Room',$4)`, [ROOM, OTHER, WS, HUMAN]);
  for (const member of [HUMAN, AGENT, WORKER]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$4,$2,'member')`, [WS, member, ROOM, OTHER]);
  }
  await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id(), text: '@inbox Review the queue' }, HUMAN);
  humanCommand = (await inbox())[0]!;
  await claim(humanCommand);
});
it('delivers each lifecycle source independently and completing one preserves the others', async () => {
  const first = await wake('First lifecycle source');
  const second = await wake('Second lifecycle source');
  const queued = (await inbox()).filter(command => command.id !== humanCommand.id);
  expect(queued.map(command => command.id)).toEqual([first!.id, second!.id]);
  expect(queued.map(command => command.source.body)).toEqual(['First lifecycle source', 'Second lifecycle source']);
  await claim(queued[0]!);
  await daemon.execute('postAgentTurnReceipt', { ...authority(queued[0]!), status: 'complete' }, AGENT);
  expect((await inbox()).map(command => command.id)).toContain(second!.id);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [second!.id])).rows).toEqual([{ state: 'pending' }]);
});
it('keeps source attachments and Room authority separate', async () => {
  const own = { url: 'https://files.test/own', name: 'own.txt', mimeType: 'text/plain', size: 1 };
  const other = { url: 'https://files.test/other', name: 'other.txt', mimeType: 'text/plain', size: 2 };
  for (const [roomId, attachment] of [[ROOM, own], [OTHER, other]] as const)
    await createAgentCommand(db, { id: id(), roomId, agentId: AGENT, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: WORKER, fromRoomId: roomId, text: attachment.name, attachments: [attachment] } });
  const local = (await inbox()).filter(command => command.id !== humanCommand.id);
  expect(local).toHaveLength(1);
  expect(local[0]!.source.attachments).toEqual([own]);
  expect((await inbox(db, OTHER))[0]!.source.attachments).toEqual([other]);
});
