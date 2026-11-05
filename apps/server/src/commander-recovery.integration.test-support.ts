import { releaseAgentConnection } from './connection-presence.js';

import { advanceCorner } from './corner-lifecycle.js';

import { createHash, randomUUID, randomBytes } from 'node:crypto';

import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';

import { MemoryObjectStorage, PgliteDatabase, migratedDatabase } from './test-support.js';

import { ObjectService } from './object-service.js';

import { callAgentTool, postArtifact } from '../../body/src/read-only-mcp.js';

import { createServer } from 'node:http';

import { spawn } from 'node:child_process';

import { createInterface } from 'node:readline';

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { PhoneService } from './phone-service.js';

import { LiveHub } from './live.js';

import { PushDeliveryLoop } from './background.js';

import { createAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';

import { GITHUB_SUBJECT, systemLine } from './system-line.js';

import type { AgentCommand } from '@beeline/api-contract/daemon';

import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';

import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';


export const HUMAN = 'a'.repeat(64),
  RUBY = 'b'.repeat(64),
  WORKER = 'c'.repeat(64);

export const WS = '11111111-1111-4111-8111-111111111111';

export const ROOM = '22222222-2222-4222-8222-222222222222';

export const DM = '33333333-3333-4333-8333-333333333333';

export let db: PgliteDatabase, daemon: DaemonService, phone: PhoneService;

export let order: AgentCommand;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Captain','captain'),($2,'agent','Ruby','ruby'),($3,'agent','Worker','worker')`,
    [HUMAN, RUBY, WORKER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    RUBY,
    WORKER,
    HUMAN,
  ]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);

afterAll(async () => db.close());

beforeEach(async () => {

  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM workspaces`);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Review command proof')`, [WS]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
    VALUES($1,$3,'Target Room',NULL,$4),($2,$3,'Captain and Ruby',jsonb_build_array($4::text,$5::text),$4)`,
    [ROOM, DM, WS, HUMAN, RUBY],
  );
  for (const person of [HUMAN, RUBY, WORKER]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,
      [WS, person, ROOM],
    );
    if (person !== WORKER)
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`,
        [WS, DM, person],
      );
  }
  await phone.execute(
    'sendRoomMessage',
    {
      roomId: DM,
      messageId: randomBytes(32).toString('hex'),
      text: 'Build the widget in the target Room',
    },
    HUMAN,
  );
  order = (await daemon.execute('getAgentCommands', { roomId: DM }, RUBY)).commands[0]!;
  await claim(order);
});

export const claim = (command: AgentCommand) =>
  daemon.execute(
    'claimAgentCommand',
    {
      roomId: command.roomId,
      commandId: command.id,
      generationId: 'proof-generation',
    },
    command.agentId,
  );

export const authority = (command: AgentCommand) => ({
  roomId: command.roomId,
  requestId: command.turnRequestId,
  generationId: 'proof-generation',
});

export const commands = async (roomId: string, agentId: string) => {

  return (await readAgentCommands(db, roomId, agentId)).commands;
};

export async function open(name = 'Widget') {
  return daemon.execute(
    'createCorner',
    {
      ...authority(order),
      requestId: order.turnRequestId,
      targetRoomId: ROOM,
      name,
      ...(name !== 'Widget' ? { idempotencyKey: name } : {}),
      objective: 'Build the widget',
      implementer: 'worker',
      brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: order.sourceMessageId } },
    },
    RUBY,
  );
}

export async function worker(cornerId: string) {
  const command = (await commands(cornerId, WORKER))[0]!;
  await claim(command);
  return command;
}
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get order(){return order;}, set order(value: typeof order){order=value;},
};

export { releaseAgentConnection } from './connection-presence.js';
export { advanceCorner } from './corner-lifecycle.js';
export { createHash, randomUUID, randomBytes } from 'node:crypto';
export { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
export { MemoryObjectStorage, PgliteDatabase, migratedDatabase } from './test-support.js';
export { ObjectService } from './object-service.js';
export { callAgentTool, postArtifact } from '../../body/src/read-only-mcp.js';
export { createServer } from 'node:http';
export { spawn } from 'node:child_process';
export { createInterface } from 'node:readline';
export { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { PhoneService } from './phone-service.js';
export { LiveHub } from './live.js';
export { PushDeliveryLoop } from './background.js';
export { createAgentCommand, readAgentCommands } from './agent-command.js';
export { GITHUB_SUBJECT, systemLine } from './system-line.js';
export { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
export type { CommandRow } from './agent-command.js';
export type { AgentCommand } from '@beeline/api-contract/daemon';
export type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
