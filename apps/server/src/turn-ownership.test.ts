import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import {
  TURN_OWNERSHIP_SCHEMA, assertCurrentTurnOwner, commandOwnerExpiredSql, commandOwnerLiveSql, turnOwnershipEnabled, workingTurnFreshSql,
} from './turn-ownership.js';

describe('effective command ownership', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await db.query(`CREATE TABLE agent_commands(id text PRIMARY KEY,agent_id text,state text,lease_expires_at timestamptz,generation_id text,room_id text,turn_request_id text);
      CREATE TABLE agent_turns(room_id text,request_id text,agent_id text,generation_id text,created_at timestamptz);
      CREATE TABLE agent_connections(agent_id text PRIMARY KEY,connection_id text,epoch bigint,instance_id text,released_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz);`);
    await db.query(TURN_OWNERSHIP_SCHEMA);
    await db.query(`INSERT INTO live_server_instances VALUES('server',clock_timestamp());
      INSERT INTO agent_connections VALUES('agent','connection',1,'server',NULL);
      INSERT INTO agent_commands(id,agent_id,state,lease_expires_at) VALUES
        ('legacy-live','agent','claimed',now()+interval '1 day'),
        ('legacy-dead','agent','claimed',now()-interval '1 day'),('legacy-null','agent','pending',NULL);
      INSERT INTO agent_commands(id,agent_id,state,lease_expires_at,generation_id,turn_owner_connection_id,turn_owner_epoch)
        VALUES('owned','agent','claimed',NULL,'generation','connection',1);`);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await db.close(); });
  const active = async (db: PgliteDatabase) => (await db.query<{ id: string; active: boolean | null; expired: boolean | null }>(
    `SELECT command.id,${commandOwnerLiveSql('command')} active,${commandOwnerExpiredSql('command')} expired
      FROM agent_commands command ORDER BY command.id`)).rows;

  it('keeps legacy null/expiry semantics and a disabled admission gate cannot reinterpret an owned row', async () => {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', '0'); expect(turnOwnershipEnabled()).toBe(false);
    expect(await active(db)).toEqual([
      { id: 'legacy-dead', active: false, expired: true }, { id: 'legacy-live', active: true, expired: false },
      { id: 'legacy-null', active: null, expired: null }, { id: 'owned', active: true, expired: false },
    ]);
  });
  it('fences replacement epoch, explicit release and actual server lease expiry', async () => {
    await db.transaction(tx => assertCurrentTurnOwner(tx, 'agent', { connectionId: 'connection', epoch: 1 }));
    await db.query(`UPDATE agent_connections SET connection_id='replacement',epoch=2`);
    expect((await active(db)).find(row => row.id === 'owned')!.active).toBe(false);
    await expect(db.transaction(tx => assertCurrentTurnOwner(tx, 'agent', { connectionId: 'connection', epoch: 1 }))).rejects.toThrow('source changed');
    await db.query(`UPDATE agent_commands SET generation_id='replacement-generation',turn_owner_connection_id='replacement',turn_owner_epoch=2 WHERE id='owned'`);
    expect((await active(db)).find(row => row.id === 'owned')!.active).toBe(true);
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'`);
    expect((await active(db)).find(row => row.id === 'owned')!.active).toBe(false);
    await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp(); UPDATE agent_connections SET released_at=clock_timestamp()`);
    expect((await active(db)).find(row => row.id === 'owned')!.active).toBe(false);
  });
  it('rejects a partial owner pair and arbitrary SQL aliases', async () => {
    await expect(db.query(`UPDATE agent_commands SET turn_owner_epoch=NULL WHERE id='owned'`)).rejects.toThrow();
    expect(() => commandOwnerLiveSql('command; SELECT 1')).toThrow('alias');
  });
  it('retains generation ownership across requeue and cleans only with its command', async () => {
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='owned'`);
    await expect(db.query(`UPDATE agent_commands SET state='claimed',generation_id='generation',
      turn_owner_connection_id='replacement',turn_owner_epoch=2 WHERE id='owned'`)).rejects.toThrow('generation owner changed');
    await expect(db.query(`UPDATE agent_commands SET state='claimed',generation_id='generation' WHERE id='owned'`)).rejects.toThrow('generation owner changed');
    expect((await db.query(`SELECT * FROM agent_command_generation_owners WHERE command_id='owned'`)).rowCount).toBe(1);
    await expect(db.query(`UPDATE agent_command_generation_owners SET connection_id='replacement' WHERE command_id='owned'`)).rejects.toThrow('immutable');
    await expect(db.query(`DELETE FROM agent_command_generation_owners WHERE command_id='owned'`)).rejects.toThrow('immutable');
    await db.query(`DELETE FROM agent_commands WHERE id='owned'`);
    expect((await db.query(`SELECT * FROM agent_command_generation_owners WHERE command_id='owned'`)).rowCount).toBe(0);
  });
  it('keeps an old healthy owned turn visible and never borrows legacy freshness after owner loss/requeue', async () => {
    await db.query(`UPDATE agent_commands SET room_id='room',turn_request_id='request' WHERE id='owned';
      INSERT INTO agent_turns VALUES('room','request','agent','generation',now()-interval '10 minutes');`);
    const fresh = async () => (await db.query<{ fresh: boolean }>(`SELECT ${workingTurnFreshSql('turn')} fresh FROM agent_turns turn`)).rows[0]!.fresh;
    expect(await fresh()).toBe(true);
    await db.query(`UPDATE agent_connections SET released_at=clock_timestamp();UPDATE agent_turns SET created_at=now()`);
    expect(await fresh()).toBe(false);
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL WHERE id='owned'`);
    expect(await fresh()).toBe(false);
  });
});
