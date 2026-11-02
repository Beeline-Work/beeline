import { expect, it } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { migrate } from './database.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

it('ARCHIVE-FACT-1 bootstrap supplies inherited archived corner facts without direct corner memberships', async () => {
  const db = new PgliteDatabase();
  try {
    await migrate(db);
    const agent = 'a'.repeat(64), human = 'b'.repeat(64);
    const ws = '11111111-1111-4111-8111-111111111111';
    const room = '22222222-2222-4222-8222-222222222222';
    const corner = '33333333-3333-4333-8333-333333333333';
    const other = '44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent'),($2,'human','Owner')`, [agent,human]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent,human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [ws]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$3,'Parent',$4),($2,$3,'Other',$4)`, [room,other,ws,human]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [ws,agent,room]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by,archived_at) VALUES($1,$2,$3,'Archived',$4,now())`, [corner,ws,room,human]);
    const daemon = new DaemonService(db,new LiveHub());
    const result = await daemon.execute('getDaemonBootstrap',{agentId:agent},agent);
    expect(result.storageRooms).toContainEqual(expect.objectContaining({roomId:corner,archived:true}));
    expect(result.rooms.map(r=>r.roomId)).toEqual([room]);
    expect(result.storageRooms?.some(r=>r.roomId===other)).toBe(false);
    expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1`,[corner])).rows).toHaveLength(0);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [room,agent]);
    const departed = await daemon.execute('getDaemonBootstrap',{agentId:agent},agent);
    expect(departed.storageRooms?.some(r=>r.roomId===corner)).toBe(false);
  } finally { await db.close(); }
},30_000);
