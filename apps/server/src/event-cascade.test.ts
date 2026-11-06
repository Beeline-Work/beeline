import { setRoomEventSubscriptions } from './agent-subscriptions.js';
/** Server-derived causal trace and source validation for committed events. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { EventCascadeRefusedError, systemLine } from './system-line.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const HUMAN = 'a'.repeat(64);
const AGENT_A = 'b'.repeat(64);
const AGENT_B = 'c'.repeat(64);

describe('an event cascade', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Ada'),($2,'agent','Owl'),($3,'agent','Bat')`,
      [HUMAN, AGENT_A, AGENT_B],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
      [WORKSPACE, ROOM, HUMAN, AGENT_A, AGENT_B],
    );
  });
  afterEach(() => database.close());

  const emit = (causeId: string | undefined, wakes: string[] = [], kind = 'agent:ping') =>
    systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'agent', id: AGENT_A, name: 'Owl' },
      verb: 'emitted',
      object: 'ping',
      consequence: 'again',
      kind: kind as 'joined',
      wakes,
      ...(causeId === undefined ? {} : { causeId }),
    });

  const cascadeOf = async (id: string) =>
    (
      await database.query<{
        event_cause_id: string | null;
        event_root_cause_id: string | null;
        event_depth: number | null;
      }>(`SELECT event_cause_id,event_root_cause_id,event_depth FROM messages WHERE id=$1`, [id])
    ).rows[0];

  const rowCount = async () =>
    Number((await database.query<{ n: string }>(`SELECT count(*) n FROM messages`)).rows[0]?.n);

  it('starts a server-authored event as its own root at depth 0', async () => {
    const join = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    expect(await cascadeOf(join.id)).toEqual({
      event_cause_id: null,
      event_root_cause_id: join.id,
      event_depth: 0,
    });
  });

  it('leaves an unkinded line outside causal event traces', async () => {
    const note = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
    });
    expect(await cascadeOf(note.id)).toEqual({
      event_cause_id: null,
      event_root_cause_id: null,
      event_depth: null,
    });
  });

  it('inherits the root and sits one deeper than its cause', async () => {
    const root = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
      wakes: [AGENT_A],
    });
    const first = await emit(root.id, [AGENT_B]);
    const second = await emit(first.id, [AGENT_A]);
    expect(await cascadeOf(first.id)).toEqual({
      event_cause_id: root.id,
      event_root_cause_id: root.id,
      event_depth: 1,
    });
    expect(await cascadeOf(second.id)).toEqual({
      event_cause_id: first.id,
      event_root_cause_id: root.id,
      event_depth: 2,
    });
  });

  it('refuses an emit whose cause is no longer in the Room, and writes nothing', async () => {
    const before = await rowCount();
    await expect(emit('f'.repeat(64))).rejects.toBeInstanceOf(EventCascadeRefusedError);
    await expect(emit('f'.repeat(64))).rejects.toThrow(/no longer in the Room/);
    expect(await rowCount()).toBe(before);
  });

  it('retains causal depth beyond the former depth cap',async()=>{
    const root=await systemLine(database,{roomId:ROOM,subject:{kind:'person',id:HUMAN,name:'Ada'},
      verb:'joined',kind:'joined',wakes:[AGENT_A]});
    let cause=root.id;
    for(let hop=1;hop<=8;hop++){
      const written=await emit(cause,[hop%2?AGENT_B:AGENT_A]);
      expect(await cascadeOf(written.id)).toEqual({event_cause_id:cause,event_root_cause_id:root.id,event_depth:hop});
      cause=written.id;
    }
  });

  it('keeps wide event chains without a shared turn budget',async()=>{
    const root=await systemLine(database,{roomId:ROOM,subject:{kind:'person',id:HUMAN,name:'Ada'},
      verb:'joined',kind:'joined',wakes:[AGENT_A,AGENT_B]});
    let cause=root.id;
    for(let hop=0;hop<8;hop++) cause=(await emit(cause,[AGENT_A,AGENT_B])).id;
    expect((await cascadeOf(cause))?.event_depth).toBe(8);
    expect((await cascadeOf(cause))?.event_root_cause_id).toBe(root.id);
  });

  it('fans out server-authored roots to every current subscriber', async () => {
    for (const agent of [AGENT_A, AGENT_B])
      await setRoomEventSubscriptions(database, ROOM, agent, ['joined']);
    const join = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    expect(join.inserted).toBe(true);
    const woke = (
      await database.query<{ woke: string[] }>(
        `SELECT ARRAY(SELECT agent_id FROM agent_commands WHERE source_message_id=$1) woke`,
        [join.id],
      )
    ).rows[0]?.woke;
    expect(woke?.sort()).toEqual([AGENT_A, AGENT_B].sort());
  });

  it('keeps subscriber wakes and emitted facts on one root without granting new authority', async () => {
    for (const agent of [AGENT_A, AGENT_B])
      await setRoomEventSubscriptions(database, ROOM, agent, ['joined']);
    const root = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    const first = await emit(root.id, [AGENT_B]);
    expect((await database.query('SELECT agent_id FROM agent_commands WHERE source_message_id=$1 ORDER BY agent_id',[root.id])).rows)
      .toEqual([AGENT_A,AGENT_B].sort().map(agent_id=>({agent_id})));
    // The emitted fact has no owned parent command, so its requested target
    // acquires no execution authority from the causal metadata alone.
    expect((await database.query('SELECT id FROM agent_commands WHERE source_message_id=$1',[first.id])).rows).toEqual([]);
    expect((await cascadeOf(first.id))?.event_root_cause_id).toBe(root.id);
  });
});
