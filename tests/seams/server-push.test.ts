import { describe } from 'vitest';
import { setRoomEventSubscriptions } from "../../apps/server/src/agent-subscriptions.js";
/**
 * How far an event may travel, and how many turns it may pay for.
 *
 * The whole guard lives at write time in `systemLine`, so this file drives it
 * the way the server does: a root event with no cause, then lines that cite one.
 * The refusal must leave NOTHING behind — a guard that posts the line and then
 * complains is worse than no guard, because the receiving agent has already
 * been woken by the time the emitter reads the error.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAX_EVENT_DEPTH, MAX_TURNS_PER_ROOT } from "@beeline/api-contract/phone";
import { PgliteDatabase, migratedDatabase } from "../../apps/server/src/test-support.js";
import { EventCascadeRefusedError, systemLine } from "../../apps/server/src/system-line.js";
import { TURN_OWNERSHIP_SCHEMA } from "../../apps/server/src/turn-ownership.js";
import { afterAll, beforeAll } from "vitest";
import { appendHelperOverlay, type HelperOverlayFrame } from "@beeline/api-contract/helper-overlay";
import { HELPER_OVERLAY_SCHEMA, HelperOverlayViewer, applyHelperOverlay, fenceHelperOverlayEnqueue, helperOverlayDemand, type HelperOverlayLiveEvent } from "../../apps/server/src/helper-overlay.js";
import type { WebSocket } from "ws";
import { phoneLiveOutput } from "../../apps/server/src/phone-live-output.js";
import { migrate } from "../../apps/server/src/database.js";
import { PushDeliveryLoop } from "../../apps/server/src/background.js";
import { seedCornerOpening, insertCornerFacts } from "../../apps/server/src/test-support.js";
import { vi } from 'vitest';
import '../../apps/server/scripts/test-event-loop.js';
vi.setConfig({ fakeTimers: { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] } });


describe("event-cascade", () => {
/**
 * How far an event may travel, and how many turns it may pay for.
 *
 * The whole guard lives at write time in `systemLine`, so this file drives it
 * the way the server does: a root event with no cause, then lines that cite one.
 * The refusal must leave NOTHING behind — a guard that posts the line and then
 * complains is worse than no guard, because the receiving agent has already
 * been woken by the time the emitter reads the error.
 */





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

  it('leaves a line with no kind out of every cascade, so nothing spends a budget on it', async () => {
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

  it('stops an A→B→A chain at the depth cap, with the reason the emitter reads', async () => {
    let cause = (
      await systemLine(database, {
        roomId: ROOM,
        subject: { kind: 'person', id: HUMAN, name: 'Ada' },
        verb: 'joined',
        kind: 'joined',
        wakes: [AGENT_A],
      })
    ).id;
    // A wakes B, B wakes A, A wakes B… each hop is one event citing the last.
    for (let hop = 1; hop <= MAX_EVENT_DEPTH; hop += 1) {
      const written = await emit(cause, [hop % 2 === 1 ? AGENT_B : AGENT_A]);
      expect((await cascadeOf(written.id))?.event_depth).toBe(hop);
      cause = written.id;
    }
    const before = await rowCount();
    await expect(emit(cause, [AGENT_B])).rejects.toThrow(
      new RegExp(
        `would sit ${MAX_EVENT_DEPTH + 1} events deep and the limit is ${MAX_EVENT_DEPTH}`,
      ),
    );
    expect(await rowCount()).toBe(before);
  });

  it('refuses the emit that would push one root past its turn budget', async () => {
    // A wide root: one event with three mentions per hop spends the budget
    // before the depth cap can.
    const root = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
      wakes: [AGENT_A, AGENT_B, HUMAN],
    });
    let cause = root.id;
    for (let hop = 0; hop < 3; hop += 1) {
      cause = (await emit(cause, [AGENT_A, AGENT_B, HUMAN])).id;
    }
    // 4 lines × 3 mentions = 12 turns woken, exactly the budget.
    const spent = await database.query<{ woken: number }>(
      `SELECT COALESCE(SUM(event_woken),0)::int woken
       FROM messages WHERE event_root_cause_id=$1`,
      [root.id],
    );
    expect(spent.rows[0]?.woken).toBe(MAX_TURNS_PER_ROOT);
    const before = await rowCount();
    await expect(emit(cause, [AGENT_A])).rejects.toThrow(
      new RegExp(`already woken ${MAX_TURNS_PER_ROOT} turns`),
    );
    expect(await rowCount()).toBe(before);
  });

  it('never refuses a server-authored root, however many agents subscribe to it', async () => {
    // The join must survive: a greeting Room with more subscribers than the
    // per-chain budget is a Room, not an attack, and losing the membership
    // write to a guard meant for agents is the silent failure this forbids.
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

  it('counts a subscriber fan-out toward the same budget its emits spend', async () => {
    for (const agent of [AGENT_A, AGENT_B])
      await setRoomEventSubscriptions(database, ROOM, agent, ['joined']);
    const root = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    const first = await emit(root.id, [AGENT_B]);
    const spent = await database.query<{ woken: number }>(
      `SELECT COALESCE(SUM(event_woken),0)::int woken
       FROM messages WHERE event_root_cause_id=$1`,
      [root.id],
    );
    // Two subscribers woken by the join, one agent woken by the emit.
    expect(spent.rows[0]?.woken).toBe(3);
    expect((await cascadeOf(first.id))?.event_root_cause_id).toBe(root.id);
  });
});
});


describe("helper-overlay", () => {
const room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
const identity={agentId:'agent',roomId:room,commandId:'command',turnId:'turn',turnGeneration:'generation',runGeneration:0,kind:'draft' as const};
const frame=(input:Partial<HelperOverlayFrame>={}):HelperOverlayFrame=>({...identity,v:1,type:'baseline',revision:1,offset:0,text:'🌍',viewingRevision:1,...input});
const owner={connectionId:'connection',epoch:1};

describe('helper overlay source ownership and final enqueue',()=>{
  let db:PgliteDatabase;
  beforeAll(async()=>{
    db=new PgliteDatabase();
    await db.query(`CREATE TABLE rooms(id uuid PRIMARY KEY,workspace_id uuid,archived_at timestamptz);
      CREATE TABLE room_access(room_id uuid,identity_id text,removed_at timestamptz);
      CREATE TABLE memberships(workspace_id uuid,room_id uuid,identity_id text,role text,removed_at timestamptz);
      CREATE TABLE room_push_views(room_id uuid,identity_id text,session_id text,instance_id text,expires_at timestamptz);
      CREATE TABLE live_server_instances(instance_id text,renewed_at timestamptz);
      CREATE TABLE agent_connections(agent_id text,connection_id text,epoch bigint,released_at timestamptz,instance_id text);
      CREATE TABLE agent_commands(id text PRIMARY KEY,room_id uuid,agent_id text,turn_request_id text,action text,generation_id text,state text,created_at timestamptz DEFAULT now(),lease_expires_at timestamptz);
      CREATE TABLE agent_turns(room_id uuid,agent_id text,request_id text,generation_id text,status text);
      CREATE TABLE live_outputs(room_id uuid,agent_id text,turn_id text,kind text,body jsonb,updated_at timestamptz DEFAULT now(),PRIMARY KEY(room_id,agent_id,turn_id,kind));`);
    await db.query(TURN_OWNERSHIP_SCHEMA);
    await db.query(HELPER_OVERLAY_SCHEMA);
    await db.query(`INSERT INTO rooms VALUES($1,$2,NULL)`,[room,workspace]);
    await db.query(`INSERT INTO room_access VALUES($1,'agent',NULL),($1,'reader',NULL)`,[room]);
    await db.query(`INSERT INTO memberships VALUES($1,NULL,'agent','member',NULL),($1,NULL,'reader','member',NULL)`,[workspace]);
    await db.query(`INSERT INTO room_push_views VALUES($1,'reader','session',NULL,NULL)`,[room]);
    await db.query(`INSERT INTO live_server_instances VALUES('owner-server',clock_timestamp());
      INSERT INTO agent_connections VALUES('agent','connection',1,NULL,'owner-server');
      INSERT INTO agent_turns VALUES('${room}','agent','turn','generation','working');
      INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,generation_id,state) VALUES('command','${room}','agent','turn','input','generation','claimed');`);
  },30000);
  afterAll(async()=>{await db.close();});
  it('validates UTF-8 offsets, monotone revision/run generation, and stale baseline rejection',async()=>{
    expect((await applyHelperOverlay(db,'agent',owner,frame())).ack).toEqual({accepted:true,revision:1});
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'append',revision:2,offset:2,text:'é'}))).ack).toEqual({accepted:false,reason:'gap'});
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'append',revision:2,offset:4,text:'é'}))).ack).toEqual({accepted:true,revision:2});
    expect((await db.query<{body:{text:string}}>('SELECT body FROM live_outputs')).rows[0]?.body.text).toBe('🌍é');
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:1,text:'older'}))).ack).toEqual({accepted:false,reason:'stale'});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:3,runGeneration:1,text:'fresh'}))).ack).toEqual({accepted:true,revision:3});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:4,runGeneration:0,text:'late old run'}))).ack).toEqual({accepted:false,reason:'stale'});
    expect(appendHelperOverlay('🌍',2,'x')).toBeUndefined();expect(appendHelperOverlay('',0,'\ud800')).toBeUndefined();
  });
  it('requires a new helper baseline for a changed actual viewer source and refuses zero-viewer writes',async()=>{
    await db.query(`DELETE FROM room_push_views`);expect((await helperOverlayDemand(db,room)).viewing).toBe(false);
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:4,runGeneration:1}))).ack).toEqual({accepted:false,reason:'unviewed'});
    await db.query(`INSERT INTO room_push_views VALUES($1,'reader','fresh-session',NULL,NULL)`,[room]);
    const demand=await helperOverlayDemand(db,room);expect(demand.viewingRevision).toBe(3);
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'append',revision:4,runGeneration:1,offset:5,text:'x',viewingRevision:3}))).ack).toEqual({accepted:false,reason:'gap'});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:4,runGeneration:1,text:'fresh-view',viewingRevision:3}))).ack).toEqual({accepted:true,revision:4});
  });
  it('checks current helper connection and reader authority through synchronous enqueue',async()=>{
    const result=await applyHelperOverlay(db,'agent',owner,frame({revision:5,runGeneration:1,text:'current',viewingRevision:3}));
    const enqueue=vi.fn();await fenceHelperOverlayEnqueue(db,result.event!,enqueue,'reader');expect(enqueue).toHaveBeenCalledOnce();
    await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id='reader'`);
    await fenceHelperOverlayEnqueue(db,result.event!,enqueue,'reader');expect(enqueue).toHaveBeenCalledOnce();
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id='reader'`);
    await db.query(`UPDATE agent_connections SET epoch=2,connection_id='replacement'`);
    await fenceHelperOverlayEnqueue(db,result.event!,enqueue,'reader');expect(enqueue).toHaveBeenCalledOnce();
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:6,runGeneration:1,viewingRevision:5}))).ack).toEqual({accepted:false,reason:'stale'});
    await db.query(`UPDATE agent_connections SET epoch=1,connection_id='connection'`);
  });
  it('keeps an end tombstone and durable terminal state prevents late resurrection',async()=>{
    const viewingRevision=(await helperOverlayDemand(db,room)).viewingRevision;
    // A new viewing revision requires a current baseline before the terminal frame.
    await applyHelperOverlay(db,'agent',owner,frame({revision:6,runGeneration:1,viewingRevision}));
    expect((await applyHelperOverlay(db,'agent',owner,frame({type:'end',revision:7,runGeneration:1,text:'',viewingRevision}))).ack).toEqual({accepted:true,revision:7});
    expect((await applyHelperOverlay(db,'agent',owner,frame({revision:8,runGeneration:1,viewingRevision}))).ack).toEqual({accepted:false,reason:'stale'});
    await db.query(`UPDATE agent_commands SET state='complete';UPDATE agent_turns SET status='complete'`);
    const enqueue=vi.fn(),body=(await db.query<{body:Record<string,unknown>}>('SELECT body FROM live_outputs')).rows[0]!.body;
    const {helperOverlayEvent}=await import("../../apps/server/src/helper-overlay.js");await fenceHelperOverlayEnqueue(db,helperOverlayEvent(body)!,enqueue,'reader');expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('phone fresh-helper viewing barrier',()=>{
  const event=(revision:number,viewingRevision:number,type:HelperOverlayFrame['type']='baseline'):HelperOverlayLiveEvent=>({type:'draft',roomId:room,agentId:'agent',turnId:'turn',text:'current',
    overlayV1:{...frame({revision,viewingRevision,type}),text:'',connectionId:'connection',connectionEpoch:1}});
  it('buffers one actual fresh baseline before viewing commit and rejects stale snapshots or late revisions',()=>{
    const enqueue=vi.fn(),viewer=new HelperOverlayViewer(value=>{enqueue(value);viewer.delivered(value);});viewer.enter(room);
    expect(viewer.accept(event(5,3))).toBe(false);viewer.commit(room,3);expect(enqueue).toHaveBeenCalledOnce();
    expect(viewer.accept(event(4,3))).toBe(false);expect(viewer.accept(event(6,3,'append'))).toBe(true);
    viewer.delivered(event(6,3,'append'));
    expect(viewer.normalize(event(9,3,'append'))).toMatchObject({overlayV1:{type:'replace',offset:0}});
    viewer.leave(room);expect(viewer.accept(event(7,3,'append'))).toBe(false);
    viewer.enter(room);viewer.commit(room,4);expect(viewer.accept(event(6,3))).toBe(false);
    expect(viewer.accept(event(8,4,'append'))).toBe(false);expect(viewer.accept(event(9,4))).toBe(true);
    // An accepted baseline denied by the final DB/socket fence is not delivered.
    expect(viewer.accept(event(10,4,'append'))).toBe(false);
    viewer.delivered(event(9,4));expect(viewer.accept(event(10,4,'append'))).toBe(true);
  });
  it('retains multiple pre-view baselines and a latest append until its baseline actually enqueues',async()=>{
    const enqueued:HelperOverlayLiveEvent[]=[];
    const viewer=new HelperOverlayViewer(value=>{enqueued.push(value);});
    viewer.enter(room);
    const first=event(1,1),second={...event(1,1),agentId:'agent-2',overlayV1:{...event(1,1).overlayV1,agentId:'agent-2'}} as HelperOverlayLiveEvent;
    viewer.accept(first);viewer.accept(second);viewer.commit(room,1);expect(enqueued).toHaveLength(2);
    expect(viewer.accept(event(2,1,'append'))).toBe(false);expect(enqueued).toHaveLength(2);
    viewer.delivered(first);await Promise.resolve();expect(enqueued).toHaveLength(3);
    expect(enqueued[2]?.overlayV1.revision).toBe(2);viewer.delivered(enqueued[2]!);
    // An older fence that completes after revision2 must not paint backwards.
    expect(viewer.canDeliver(first)).toBe(false);
  });

  it('refuses a physically oversized canonical phone frame before any final DB query or enqueue',async()=>{
    const enqueue=vi.fn(),query=vi.fn(),transaction=vi.fn();
    const oversized={...event(1,1),text:'\u0000'.repeat(50_000)} as HelperOverlayLiveEvent;
    await fenceHelperOverlayEnqueue({query,transaction},oversized,enqueue,'reader');
    expect(query).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
  });

});
});


describe("phone-live-output", () => {
describe('slow phone output', () => {
  it('drops updates and sends one scoped recovery note after drain, retaining replies and pong', () => {
    const completions: Array<() => void> = [];
    const sent: object[] = [];
    const client = { readyState: 1, OPEN: 1, bufferedAmount: 0,
      send: (payload: string, done?: () => void) => { sent.push(JSON.parse(payload)); if (done) completions.push(done); },
      close: vi.fn() };
    const send = phoneLiveOutput(client as unknown as WebSocket, 100, vi.fn());
    send(JSON.stringify({ type: 'invalidate', roomId: 'a', reason: 'message' }));
    client.bufferedAmount = 100;
    send(JSON.stringify({ type: 'invalidate', roomId: 'a', reason: 'message' }));
    send(JSON.stringify({ type: 'invalidate', roomId: 'b', reason: 'message' }));
    send(JSON.stringify({ kind: 'push-commit', to: { stream: 'workspace:w' } }));
    send(JSON.stringify({ t: 'res', id: 'req', ok: false, error: { code: 'unavailable' } }));
    send(JSON.stringify({ type: 'pong' }));
    expect(sent).toHaveLength(3);
    expect(client.close).not.toHaveBeenCalled();
    client.bufferedAmount = 0;
    for (const complete of completions) complete();
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toEqual({ type: 'missed-updates', roomIds: ['a', 'b'], streams: ['workspace:w'], workspace: false });
    send(JSON.stringify({ type: 'invalidate', roomId: 'b', reason: 'message' }));
    expect(sent).toHaveLength(5);
    expect(client.close).not.toHaveBeenCalled();
  });
});
});


describe("push-follow", () => {
const person = 'a'.repeat(64),
  teammate = 'b'.repeat(64),
  agent = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase;
const send = vi.fn().mockResolvedValue(undefined);
let loop: PushDeliveryLoop;
let sequence = 0;
async function post(text: string, author: string, channel = corner) {
  const id = (++sequence).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    id,
    channel,
    author,
    text,
  ]);
  return id;
}
async function delivered() {
  await loop.runOnce();
  return send.mock.calls.map(([, message]) => message.messageId as string);
}
beforeEach(async () => {
  db = await migratedDatabase();
  sequence = 0;
  send.mockClear();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Owner','owner'),($2,'human','Teammate','teammate'),($3,'agent','Bee','bee')`,
    [person, teammate, agent],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
  // The teammate opened and commissioned the corner; the person did neither.
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,created_by) VALUES($1,$3,'Room',NULL,$4),($2,$3,'Corner',$1,$4)`,
    [room, corner, workspace, teammate],
  );
  await insertCornerFacts(db, { cornerId: corner, ownerAgentId: agent, commissionedBy: teammate });
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member')`,
    [workspace, person, teammate, agent],
  );
  for (const channel of [room]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'owner'),($1,$2,$5,'member')`,
      [workspace, channel, person, teammate, agent],
    );
  }
  await db.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
    [person],
  );
  loop = new PushDeliveryLoop(db, { send });
  await loop.runOnce();
});
afterEach(() => db.close());

describe('Attention does not follow corners', () => {
  it('stays quiet in a corner the person never touched', async () => {
    await post('Untagged update', teammate);
    expect(await delivered()).toEqual([]);
  });

  it('stays quiet after the person posts in a corner', async () => {
    await post('I have a thought', person);
    const update = await post('Untagged update', teammate);
    expect(await delivered()).toEqual([]);
  });

  it('stays quiet after the person orders work in a corner', async () => {
    const ask = await post('@bee tell the corner to use Postgres', person, room);
    await db.query(
      `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth)
       VALUES('order',$1,$2,NULL,'turn','input','order','root',$3,1)`,
      [corner, agent, ask],
    );
    send.mockClear();
    const update = await post('Untagged update', teammate);
    expect(await delivered()).not.toContain(update);
  });

  it('delivers the tag without following subsequent corner messages', async () => {
    const tag = await post('@owner can you look', teammate);
    const update = await post('Untagged update', teammate);
    expect(await delivered()).toEqual([tag]);
  });

  it('stays quiet when the corner is archived', async () => {
    await post('I have a thought', person);
    await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
    await post('Untagged update', teammate);
    expect(await delivered()).toEqual([]);
  });
});

describe('Room mute', () => {
  it("silences the Room and its corners but lets the person's tags through", async () => {
    await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [person]);
    await db.query(`UPDATE memberships SET push_muted=true WHERE room_id=$1 AND identity_id=$2`, [
      room,
      person,
    ]);
    await post('Room chatter', teammate, room);
    await post('Corner chatter', teammate);
    const roomTag = await post('@owner in the Room', teammate, room);
    const cornerTag = await post('@owner in the corner', teammate);
    expect(await delivered()).toEqual([roomTag, cornerTag]);
  });

  it('ignores and clears a corner-level mute', async () => {
    await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [person]);
    await db.query(`UPDATE memberships SET push_muted=true WHERE room_id=$1 AND identity_id=$2`, [
      corner,
      person,
    ]);
    const update = await post('Corner chatter', teammate);
    expect(await delivered()).toEqual([update]);
    await migrate(db);
    const muted = await db.query<{ push_muted: boolean }>(
      `SELECT push_muted FROM room_access WHERE room_id=$1 AND identity_id=$2`,
      [corner, person],
    );
    expect(muted.rows[0]?.push_muted).toBe(false);
  });
});
});
