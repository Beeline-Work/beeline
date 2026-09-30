import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

/**
 * An agent working a corner can open another corner. Corners do not nest, so
 * the new corner opens beside the calling one, in the parent Room, while the
 * command that authorizes it is the corner turn's own.
 */

const HUMAN = 'a'.repeat(64),
  AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111',
  ROOM = '22222222-2222-4222-8222-222222222222';

let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;

beforeAll(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Hoots','hoots')`,
    [HUMAN, AGENT],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Nesting')`, [WORKSPACE]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,repository_target_branch)
     VALUES($1,$2,'Widgets','owner/widgets','https://github.com/owner/widgets.git','repository','main')`,
    [ROOM, WORKSPACE],
  );
  for (const who of [HUMAN, AGENT])
    for (const room of [null, ROOM])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [WORKSPACE, room, who],
      );
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`,
    [ROOM, AGENT],
  );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db?.close());

async function commissioned(roomId: string, text: string): Promise<AgentCommand> {
  await phone.execute(
    'sendRoomMessage',
    { roomId, messageId: randomBytes(32).toString('hex'), text },
    HUMAN,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId }, AGENT)).commands.at(-1);
  await daemon.execute(
    'claimAgentCommand',
    { roomId, commandId: command!.id, generationId: 'g1' },
    AGENT,
  );
  return command!;
}

function brief(sourceMessageId: string, snapshot: string) {
  const intent = { sourceMessageId, snapshot };
  return {
    buildSpec: snapshot,
    intentVerbatim: [intent],
    criteria: [{ id: 'AC-1', text: snapshot }],
    references: [],
    approvalBasis: { kind: 'initiating-command' as const, ...intent },
  };
}

async function openCorner(roomId: string, text: string, name: string) {
  const command = await commissioned(roomId, text);
  const input = {
    roomId,
    requestId: command.turnRequestId,
    generationId: 'g1',
    idempotencyKey: `open-${name}`,
    name,
    objective: text,
    repository: 'owner/widgets',
    targetBranch: 'main',
    brief: brief(command.sourceMessageId, text),
  };
  return { input, created: await daemon.execute('createCorner', input, AGENT) };
}

it('opens a sibling corner in the parent Room from a corner turn', async () => {
  const { created: first } = await openCorner(ROOM, '@hoots fix the header', 'Header fix');
  const { input, created: second } = await openCorner(
    first.cornerId,
    '@hoots open another corner for the footer',
    'Footer fix',
  );

  expect(second.cornerId).not.toBe(first.cornerId);
  const room = (
    await db.query<{ parent_id: string; repository_key: string }>(
      `SELECT parent_id,repository_key FROM rooms WHERE id=$1`,
      [second.cornerId],
    )
  ).rows[0];
  expect(room).toEqual({ parent_id: ROOM, repository_key: 'owner/widgets' });

  // The open card lands in the parent Room, where the corner list lives.
  const cards = (
    await db.query<{ room_id: string }>(
      `SELECT room_id FROM messages WHERE card->>'type'='corner-open' AND card->>'cornerId'=$1`,
      [second.cornerId],
    )
  ).rows;
  expect(cards).toEqual([{ room_id: ROOM }]);

  // The new corner's agent gets its objective as a pending command.
  const commands = (await daemon.execute('getAgentCommands', { roomId: second.cornerId }, AGENT))
    .commands;
  expect(commands.map((command) => command.reason)).toContain('corner_objective');

  // A retried tool call returns the same corner rather than opening another.
  expect(await daemon.execute('createCorner', input, AGENT)).toEqual(second);
}, 30_000);
