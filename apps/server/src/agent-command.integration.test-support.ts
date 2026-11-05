import { OwnedModelCredentials } from './owned-model-credential.js';

import { randomBytes, randomUUID } from 'node:crypto';

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Pool } from 'pg';

import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';

import { taggedIdentityIdsSql } from './message-mentions.js';

import { PgliteDatabase, seedCornerOpening, insertCornerFacts } from './test-support.js';

import { PhoneService } from './phone-service.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';

import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';

import {
  createAgentCommand,
  renudgeStrandedPendingCommands,
  nextAgentDepth,
  reconcileCornerMergeBlockers,
  reconcileConfiguredCornerReviewers,
  routeSystemCommand,
  readAgentCommands,
} from './agent-command.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { ensureSystemIdentity, systemLine } from './system-line.js';

import { advanceCorner } from './corner-lifecycle.js';

import type { AgentCommand } from '@beeline/api-contract/daemon';

export const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64),
  P = 'd'.repeat(64);

export const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';

export const id = () => randomBytes(32).toString('hex');

export const stopProofPostgresUrl = process.env.BEELINE_STOP_TEST_POSTGRES_URL;

if (stopProofPostgresUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(stopProofPostgresUrl).hostname))
  throw new Error('Stop proofs require an isolated loopback PostgreSQL');

export let db: SqlDatabase, closeDatabase: () => Promise<void>, phone: PhoneService, daemon: DaemonService, live: LiveHub;

export const commands = (agentId = A, roomId = R) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);

export const send = (text: string, roomId = R) => phone.execute('sendRoomMessage', { roomId, text }, H);

export async function disconnectHelper(agentId=A){
  const row=(await db.query<{connection_id:string}>('SELECT connection_id FROM agent_connections WHERE agent_id=$1',[agentId])).rows[0];
  if(row)await releaseAgentConnection(db,live,agentId,row.connection_id);
}



/** Real helper claims carry the currently authenticated machine connection.
 * Tests with an explicit registration keep their source; otherwise admission
 * establishes a fresh test connection before the claim, just as the socket does. */
export const connectingOwners=new Map<string,Promise<{connectionId:string;epoch:number}>>();

export async function helperOwner(agentId:string):Promise<{connectionId:string;epoch:number}>{
  const current=(await db.query<{connectionId:string;epoch:number}>(
    `SELECT COALESCE(turn_connection_id,connection_id) "connectionId",COALESCE(turn_connection_epoch,epoch)::integer epoch
      FROM agent_connections WHERE agent_id=$1 AND released_at IS NULL`,[agentId])).rows[0];
  if(current)return current;
  let pending=connectingOwners.get(agentId);
  if(!pending){
    pending=(async()=>{
      const instanceId='command-integration-helper';
      await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES($1,clock_timestamp())
        ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at`,[instanceId]);
      const connectionId='helper-'+agentId;
      const epoch=await claimAgentConnection(db,live,agentId,{}, {connectionId,instanceId});
      return {connectionId,epoch};
    })().finally(()=>{connectingOwners.delete(agentId);});
    connectingOwners.set(agentId,pending);
  }
  return pending;
}


export async function queuedHumanTags(roomId = R) {
  const started = await send('@hoots Long task', roomId);
  const busy = (await commands(A, roomId)).find(c => c.sourceMessageId === started.messageId)!;
  await claim(busy);
  const messages = [];
  for (const text of ['First question', 'Follow-up question', 'Last detail'])
    messages.push(await send(`@hoots ${text}`, roomId));
  await result(busy, 'Long task finished');
  return messages;
}


export async function queueStopOrders() {
  await send('@goosy delegate work');
  const [root] = await commands(B);
  await claim(root!);
  for (let i = 1; i <= 3; i++) {
    await daemon.execute('order', { roomId: R, address: R, agent: 'hoots', text: `queued task ${i}`,
      requestId: root!.turnRequestId, generationId: 'g1' }, B);
  }
  const queued = await commands();
  expect(queued).toHaveLength(3);
  await claim(queued[0]!);
  return { queued, root: root! };
}

export async function claim(c: AgentCommand, generationId = 'g1') {
  const source=await helperOwner(c.agentId);
  const {capability}=await daemon.negotiateOwnedModel(c.agentId,source,true);
  await daemon.execute(
    'claimAgentCommand',
    { roomId: c.roomId, commandId: c.id, generationId },
    c.agentId, source, capability,
  );

}

export const result = (c: AgentCommand, text: string, generationId = 'g1', extra = {}) =>
  daemon.execute(
    'postRoomMessage',
    {
      roomId: c.roomId,
      requestId: c.turnRequestId,
      generationId,
      text,
      ...extra,
    },
    c.agentId,
  );

beforeAll(async () => {
  if (stopProofPostgresUrl) {
    const schema = `stop_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: stopProofPostgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const postgres = new PostgresDatabase('', 5, { mode: 'migration', pool: new Pool({
      connectionString: stopProofPostgresUrl, options: `-c search_path=${schema},public`,
    }) });
    db = postgres;
    closeDatabase = async () => {
      await postgres.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  } else {
    const pglite = new PgliteDatabase();
    db = pglite;
    closeDatabase = () => pglite.close();
  }
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy'),($4,'human','Person','person')`,
    [H, A, B, P],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Commands')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: B, lifecycle: '{"checks":"unknown"}' });
  for (const who of [H, A, B, P])
    for (const room of [null, R])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  for (const agent of [A, B])
    await db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}') ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [R, agent],
    );
  phone = new PhoneService(db, 'http://test');
  live = new LiveHub();
  daemon = new DaemonService(db, live);
  daemon.setOwnedModel({ready:()=>true,credentials:new OwnedModelCredentials({currentVersion:'test',key:()=>Buffer.alloc(32,7)},()=> 'synthetic/model',()=>15*60_000)});
  Object.assign(daemon, { github: { assertCornerReviewerNotAuthor: async () => {} } });
}, 30_000);

afterAll(async () => closeDatabase?.());

beforeEach(async () => {
  connectingOwners.clear();
  await db.query('DELETE FROM free_agents');
  await db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`, [R]);
  await db.query(`DELETE FROM agent_connections`);
  await db.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
     VALUES($1,$2,'presence','presence','{"status":"online"}'),
           ($1,$3,'presence','presence','{"status":"online"}')
     ON CONFLICT(room_id,agent_id,turn_id,kind)
     DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
    [R, A, B],
  );
  await db.query(`DELETE FROM live_outputs WHERE kind<>'presence'`);
  await db.query(`DELETE FROM agent_commands`);
  // The corner's workflow run and its wakes commit together; resetting one
  // resets the other.
  await db.query(`DELETE FROM messages WHERE card_type='corner-workflow-handoff'`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM corner_merge_approvals`);
  await db.query(`DELETE FROM corner_brief_revisions`);
  await db.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`DELETE FROM agent_subscriptions WHERE source='room'`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL`);
  await db.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [C]);
  await db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"unknown"}'::jsonb`,
  );
});

// The merge webhook writes the parent card, then reports the landing to the
// corner workflow. Only the card's `merged` subscribers are woken by it.
export const landCorner = async (title: string) => {
  const card = await systemLine(db, {
    id: id(),
    roomId: R,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'merged',
    kind: 'merged',
    object: { text: title, url: 'https://github.com/owner/widgets/pull/42' },
    presentation: 'card',
    cardType: 'daemon-fact',
    durableFact: 'merge',
    card: {
      type: 'corner-complete',
      cornerId: C,
      name: 'Corner',
      objective: 'Do work',
      outcome: 'landed',
      pullRequest: { number: 42, title, url: 'https://github.com/owner/widgets/pull/42' },
    },
  });
  await advanceCorner(db, C, {
    kind: 'merged',
    contents: {
      mergeVerdict: 'merged',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    },
  });
  return card;
};
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get closeDatabase(){return closeDatabase;}, set closeDatabase(value: typeof closeDatabase){closeDatabase=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
get live(){return live;}, set live(value: typeof live){live=value;},
};
export function fixtureScope1(room: string) {

return {
room,
};
}
export { OwnedModelCredentials } from './owned-model-credential.js';
export { randomBytes, randomUUID } from 'node:crypto';
export { readFileSync } from 'node:fs';
export { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
export { Pool } from 'pg';
export { migrate, PostgresDatabase } from './database.js';
export { taggedIdentityIdsSql } from './message-mentions.js';
export { PgliteDatabase, seedCornerOpening, insertCornerFacts } from './test-support.js';
export { PhoneService } from './phone-service.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
export { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
export { createAgentCommand, renudgeStrandedPendingCommands, nextAgentDepth, reconcileCornerMergeBlockers, reconcileConfiguredCornerReviewers, routeSystemCommand, readAgentCommands } from './agent-command.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { ensureSystemIdentity, systemLine } from './system-line.js';
export { advanceCorner } from './corner-lifecycle.js';
export type { SqlDatabase } from './database.js';
export type { AgentCommand } from '@beeline/api-contract/daemon';
