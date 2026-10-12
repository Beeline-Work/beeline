import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentConnection, releaseAgentConnection, releaseStaleServerConnections } from './connection-presence.js';
import { noteCornerAgentUnreachable } from './agent-command.js';
import { PushDeliveryLoop } from './background.js';
import { LiveHub } from './live.js';

const OWNER = '1'.repeat(64);
const CAPTAIN = '2'.repeat(64);
const AGENTS = ['a', 'b', 'c', 'd', 'e'].map(char => char.repeat(64));
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

describe('machine disconnect notices', () => {
  let db: PgliteDatabase;
  let live: LiveHub;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
    live = new LiveHub();
    await db.query(`INSERT INTO identities(id,kind,name,handle)
      VALUES($1,'human','Machine owner','owner'),($2,'human','Captain','captain')`, [OWNER, CAPTAIN]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,NULL,$3,'owner'),($1,$4,$2,'member'),($1,$4,$3,'owner')`,
      [WORKSPACE, OWNER, CAPTAIN, ROOM]);
    for (const [index, id] of AGENTS.entries()) {
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Bee',$2)`, [id, `bee${index}`]);
      await db.query(`INSERT INTO agents(agent_id,owner_id,machine_id,machine_name)
        VALUES($1,$2,'machine-chad','Chad')`, [id, OWNER]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [WORKSPACE, id, ROOM]);
    }
  });
  afterEach(async () => { await db.close(); });
  const claim = (id: string, connectionId: string, instanceId = 'server') =>
    claimAgentConnection(db, live, id, { lifecycleId: connectionId }, { connectionId, instanceId });
  const notices = async () => (await db.query<{ text: string; card: Record<string, any>; direct_participants: string[] }>(
    `SELECT message.text,message.card,room.direct_participants FROM messages message
     JOIN rooms room ON room.id=message.room_id WHERE message.card_type='machine-offline' ORDER BY message.created_at`,
  )).rows;

  it('notifies only the machine owner once on the last connection; reconnect clears and re-arms it', async () => {
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
      VALUES('owner-device-token-12345678901234567890',$1,'android','physical'),
        ('captain-device-token-12345678901234567890',$2,'android','physical')`, [OWNER, CAPTAIN]);
    const send = vi.fn(async () => undefined);
    const push = new PushDeliveryLoop(db, { send });
    await push.runOnce();
    await claim(AGENTS[0]!, 'first');
    await claim(AGENTS[1]!, 'second');
    await releaseAgentConnection(db, live, AGENTS[0]!, 'first');
    expect(await notices()).toHaveLength(0);
    await releaseAgentConnection(db, live, AGENTS[1]!, 'second');
    const [notice] = await notices();
    expect(notice?.direct_participants).toContain(OWNER);
    expect(notice?.direct_participants).not.toContain(CAPTAIN);
    expect(notice?.text).toBe("Chad's helper went offline · @bee0, @bee1, @bee2 and 2 more can't respond");
    expect(notice?.card.status).toBe('open');
    expect(await push.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('owner-device-token-12345678901234567890',
      expect.objectContaining({ text: notice?.text }));
    // Further wakes, repeated disconnects and inactive sibling releases stay silent.
    for (let i = 0; i < 10; i++) {
      await noteCornerAgentUnreachable(db, ROOM, AGENTS[0]!, `wake-${i}`);
      await releaseAgentConnection(db, live, AGENTS[1]!, 'second');
    }
    expect(await notices()).toHaveLength(1);
    expect(await push.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.query(`SELECT 1 FROM messages WHERE card_type='corner-agent-unreachable'`)).rowCount).toBe(0);
    await claim(AGENTS[0]!, 'new');
    expect((await notices())[0]?.card.status).toBe('resolved');
    await releaseAgentConnection(db, live, AGENTS[0]!, 'new');
    expect(await notices()).toHaveLength(2);
    expect((await notices())[1]?.card.status).toBe('open');
    expect(await push.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps the open-notice lookup indexed', async () => {
    const index = (await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname='messages_machine_offline_open_idx'`,
    )).rows[0]?.indexdef;
    expect(index).toContain("card ->> 'machineId'");
    expect(index).toContain("card ->> 'ownerId'");
    expect(index).toContain("'open'");
  });

  it('ignores a replaced connection closing after the new one registers', async () => {
    await claim(AGENTS[0]!, 'old');
    await claim(AGENTS[0]!, 'new');
    expect(await releaseAgentConnection(db, live, AGENTS[0]!, 'old')).toBe(false);
    expect(await notices()).toHaveLength(0);
    await releaseAgentConnection(db, live, AGENTS[0]!, 'new');
    expect(await notices()).toHaveLength(1);
  });

  it('keeps another machine separate and handles the existing expired-server disconnect path', async () => {
    await db.query(`UPDATE agents SET machine_id='machine-squire',machine_name='squire' WHERE agent_id=$1`, [AGENTS[2]]);
    await claim(AGENTS[0]!, 'chad', 'dead-server');
    await claim(AGENTS[2]!, 'squire', 'healthy-server');
    await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('healthy-server',clock_timestamp())`);
    await releaseStaleServerConnections(db, 90_000);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]?.card.machineId).toBe('machine-chad');
    await releaseStaleServerConnections(db, 90_000);
    expect(await notices()).toHaveLength(1);
  });
});
