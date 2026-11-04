import { migratedDatabase, type PgliteDatabase } from '../test-support.js';
import { OWNED_MODEL_CREDENTIAL_SCHEMA, OwnedModelCredentials, type AuthenticatedOwnedModel } from '../owned-model-credential.js';
import { OWNED_MODEL_ATTEMPT_SCHEMA } from '../owned-model-attempt.js';
import type { SqlDatabase } from '../database.js';

export const MODEL_OWNER = 'a'.repeat(64), MODEL_AGENT = 'b'.repeat(64);
export const MODEL_WORKSPACE = '11111111-1111-4111-8111-111111111111', MODEL_ROOM = '22222222-2222-4222-8222-222222222222';
export const MODEL = 'synthetic/model', MODEL_TOKEN_HASH = 'c'.repeat(64);
export const MODEL_KEY = Buffer.alloc(32, 7);
export const MODEL_SOURCE = { connectionId: 'synthetic-connection', epoch: 1 };
export const MODEL_CLAIM = { agentId: MODEL_AGENT, commandId: 'synthetic-command', generationId: 'synthetic-generation', source: MODEL_SOURCE };
export interface OwnedModelFixture<T extends SqlDatabase> {
  db: T;
  credentials: OwnedModelCredentials;
  issued: Awaited<ReturnType<OwnedModelCredentials['issueInTransaction']>>;
  actor: AuthenticatedOwnedModel;
}
export async function ownedModelFixture(): Promise<OwnedModelFixture<PgliteDatabase>> {
  const db = await migratedDatabase();
  return seedOwnedModelFixture(db, { installSchema: false });
}
export async function seedOwnedModelFixture<T extends SqlDatabase>(db: T,
  options: { installSchema?: boolean } = {}): Promise<OwnedModelFixture<T>> {
  // Minimal contention fixtures install their own schema. Migrated databases
  // must exercise release wiring without silently repairing missing tables.
  if (options.installSchema !== false) {
    await db.query(OWNED_MODEL_CREDENTIAL_SCHEMA); await db.query(OWNED_MODEL_ATTEMPT_SCHEMA);
  }
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic model agent')`, [MODEL_OWNER, MODEL_AGENT]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [MODEL_AGENT, MODEL_OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic models')`, [MODEL_WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`, [MODEL_ROOM, MODEL_WORKSPACE]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [MODEL_WORKSPACE, MODEL_ROOM, MODEL_AGENT]);
  await db.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys,model_token_hash,state,model)
    VALUES($1,$2,$3,'synthetic sealed fixture',$4,'running',$5)`, [MODEL_AGENT, MODEL_WORKSPACE, MODEL_OWNER, MODEL_TOKEN_HASH, MODEL]);
  await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('synthetic-server',clock_timestamp())`);
  await db.query(`INSERT INTO agent_connections(agent_id,connection_id,epoch,instance_id)
    VALUES($1,$2,$3,'synthetic-server')`, [MODEL_AGENT, MODEL_SOURCE.connectionId, MODEL_SOURCE.epoch]);
  await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,
    agent_depth,state,generation_id,claimed_at,turn_owner_connection_id,turn_owner_epoch)
    VALUES($1,$2,$3,'synthetic-request','input','human_tag',$1,'synthetic-source',0,'claimed',$4,clock_timestamp(),$5,$6)`,
  [MODEL_CLAIM.commandId, MODEL_ROOM, MODEL_AGENT, MODEL_CLAIM.generationId, MODEL_SOURCE.connectionId, MODEL_SOURCE.epoch]);
  await db.query(`CREATE TABLE owned_model_test_accounting(id text PRIMARY KEY,amount integer NOT NULL)`);
  const credentials = new OwnedModelCredentials({ currentVersion: 'test-v1', key: version => version === 'test-v1' ? MODEL_KEY : undefined },
    () => MODEL, () => 15 * 60_000);
  const issued = await db.transaction(tx => credentials.issueInTransaction(tx, MODEL_CLAIM));
  const actor = await credentials.authenticate(db, issued.token);
  return { db, credentials, issued, actor };
}
