import { systemLine } from './system-line.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { migrateCornerPersonState, setRoomEventSubscriptions } from './corner-person-state.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { resolveCurrentMemberMentions } from './message-mentions.js';

it('copies sparse state twice, preserves owed items and read marks, and derives every corner access from its Room', async () => {
  const db = new PgliteDatabase();
  try {
    // Expand only, to seed the shape written by the preceding server image.
    await migrate(db, { deferData: true });
    const workspace = randomUUID(),
      room = randomUUID(),
      corner = randomUUID();
    const person = 'a'.repeat(64),
      agent = 'b'.repeat(64),
      outsider = 'c'.repeat(64);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Person','person'),($2,'agent','Agent','agent'),($3,'agent','Outsider','outsider')`,
      [person, agent, outsider],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$2)`, [
      agent,
      person,
      outsider,
    ]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
      ($1,$3,NULL,'Room'),($2,$3,$1,'Corner')`,
      [room, corner, workspace],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$6,$2,'owner')`,
      [workspace, person, agent, outsider, room, corner],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
      VALUES($1,$2,$3,'member','["joined"]')`,
      [workspace, corner, agent],
    );
    await db.query(
      `UPDATE memberships SET push_muted=true,generation=7,joined_at='2020-01-01T00:00:00Z',identity_profile='{"fixture":true}' WHERE room_id=$1 AND identity_id=$2`,
      [corner, agent],
    );
    await db.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by) VALUES($1,$2,$3)`,
      [corner, agent, person],
    );
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('ask',$1,$2,'@person can you check?')`,
      [corner, agent],
    );
    await db.query(
      `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id)
      SELECT room_id,$1,created_at,id FROM messages WHERE id='ask'`,
      [person],
    );
    const owed = (await db.query('SELECT * FROM corner_owed')).rows;
    const readMarks = (await db.query('SELECT * FROM room_read_marks')).rows;
    expect(owed).toHaveLength(1);
    expect(await migrateCornerPersonState(db)).toBe(1);
    expect(await migrateCornerPersonState(db)).toBe(0);
    expect((await db.query('SELECT * FROM corner_person_state')).rows).toEqual([
      {
        corner_id: corner,
        identity_id: agent,
        event_subscriptions: ['joined'],
        identity_profile: { fixture: true },
        generation: 7,
        push_muted: true,
        created_at: new Date('2020-01-01T00:00:00Z'),
      },
    ]);
    expect((await db.query('SELECT * FROM corner_owed')).rows).toEqual(owed);
    expect((await db.query('SELECT * FROM room_read_marks')).rows).toEqual(readMarks);
    // The old image still authorizes existing members against the physical roster during rollout.
    expect((await db.query('SELECT * FROM memberships WHERE room_id=$1', [corner])).rowCount).toBe(2);
    expect((await db.query(
      `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [corner, person],
    )).rowCount).toBe(1);
    await db.query(`UPDATE memberships SET event_subscriptions='["schedule-ran"]' WHERE room_id=$1 AND identity_id=$2`, [corner, agent]);
    expect((await db.query('SELECT event_subscriptions FROM corner_person_state WHERE corner_id=$1 AND identity_id=$2', [corner, agent])).rows[0]!.event_subscriptions).toEqual(['schedule-ran']);
    await setRoomEventSubscriptions(db, corner, agent, ['joined']);
    expect((await db.query('SELECT event_subscriptions FROM memberships WHERE room_id=$1 AND identity_id=$2', [corner, agent])).rows[0]!.event_subscriptions).toEqual(['joined']);
    const phone = new PhoneService(db, 'https://server.example');
    const daemon = new DaemonService(db, new LiveHub());
    expect(await phone.canReadRoom(corner, person)).toBe(true);
    expect(await phone.canReadRoom(corner, outsider)).toBe(false);
    expect(await daemon.execute('listEventSubscriptions', { roomId: corner }, agent)).toEqual({
      kinds: ['joined'],
    });
    expect(await resolveCurrentMemberMentions(db, corner, '@agent hello', person)).toEqual([
      { id: agent, kind: 'agent', handle: 'agent' },
    ]);
    await systemLine(db, {
      roomId: corner,
      subject: { kind: 'person', id: person, name: 'Person' },
      verb: 'joined',
      kind: 'joined',
    });
    expect(
      (
        await db.query(
          `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='subscribed_event'`,
          [corner, agent],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      daemon.execute('ensureAgentMembership', { roomId: corner }, outsider),
    ).rejects.toThrow();
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
      VALUES($1,$2,$3,'member','["joined"]')`,
      [workspace, room, outsider],
    );
    expect(
      (await db.query('SELECT 1 FROM corner_person_state WHERE identity_id=$1', [outsider]))
        .rowCount,
    ).toBe(0);
    expect(await daemon.execute('listEventSubscriptions', { roomId: corner }, outsider)).toEqual({
      kinds: ['joined'],
    });
    await daemon.execute('setEventSubscriptions', { roomId: corner, kinds: [] }, outsider);
    expect(
      (
        await db.query('SELECT event_subscriptions FROM corner_person_state WHERE identity_id=$1', [
          outsider,
        ])
      ).rows,
    ).toEqual([{ event_subscriptions: [] }]);
    expect(await daemon.execute('listEventSubscriptions', { roomId: corner }, outsider)).toEqual({
      kinds: [],
    });
    await setRoomEventSubscriptions(db, corner, agent, ['schedule-ran']);
    await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1', [room]);
    expect(await phone.canReadRoom(corner, person)).toBe(false);
    await expect(
      daemon.execute('listEventSubscriptions', { roomId: corner }, agent),
    ).rejects.toThrow();
    expect(await resolveCurrentMemberMentions(db, corner, '@agent hello', person)).toEqual([]);
    expect((await db.query('SELECT * FROM corner_owed')).rowCount).toBe(0);
    await db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1', [room]);
    expect(await daemon.execute('listEventSubscriptions', { roomId: corner }, agent)).toEqual({
      kinds: ['schedule-ran'],
    });
  } finally {
    await db.close();
  }
}, 30_000);
