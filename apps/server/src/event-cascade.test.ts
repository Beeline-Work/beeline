/**
 * How far an event may travel, and how many turns it may pay for.
 *
 * The whole guard lives at write time in `systemLine`, so this file drives it
 * the way the server does: a root event with no cause, then lines that cite one.
 * The refusal must leave NOTHING behind — a guard that posts the line and then
 * complains is worse than no guard, because the receiving agent has already
 * been woken by the time the emitter reads the error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EVENT_DEPTH, MAX_TURNS_PER_ROOT } from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { EventCascadeRefusedError, systemLine } from './system-line.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const HUMAN = 'a'.repeat(64);
const AGENT_A = 'b'.repeat(64);
const AGENT_B = 'c'.repeat(64);

describe('an event cascade', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
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

  const emit = (causeId: string | undefined, mentions: string[] = [], kind = 'agent:ping') =>
    systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'agent', id: AGENT_A, name: 'Owl' },
      verb: 'emitted',
      object: 'ping',
      consequence: 'again',
      kind: kind as 'joined',
      mentions,
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
      mentions: [AGENT_A],
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
        mentions: [AGENT_A],
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
      mentions: [AGENT_A, AGENT_B, HUMAN],
    });
    let cause = root.id;
    for (let hop = 0; hop < 3; hop += 1) {
      cause = (await emit(cause, [AGENT_A, AGENT_B, HUMAN])).id;
    }
    // 4 lines × 3 mentions = 12 turns woken, exactly the budget.
    const spent = await database.query<{ woken: number }>(
      `SELECT COALESCE(SUM(jsonb_array_length(mention_ids)),0)::int woken
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
    await database.query(
      `UPDATE memberships SET event_subscriptions='["joined"]'::jsonb WHERE identity_id=ANY($1::text[])`,
      [[AGENT_A, AGENT_B]],
    );
    const join = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    expect(join.inserted).toBe(true);
    const mentions = (
      await database.query<{ mention_ids: string[] }>(
        `SELECT mention_ids FROM messages WHERE id=$1`,
        [join.id],
      )
    ).rows[0]?.mention_ids;
    expect(mentions?.sort()).toEqual([AGENT_A, AGENT_B].sort());
  });

  it('counts a subscriber fan-out toward the same budget its emits spend', async () => {
    await database.query(
      `UPDATE memberships SET event_subscriptions='["joined"]'::jsonb WHERE identity_id=ANY($1::text[])`,
      [[AGENT_A, AGENT_B]],
    );
    const root = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    const first = await emit(root.id, [AGENT_B]);
    const spent = await database.query<{ woken: number }>(
      `SELECT COALESCE(SUM(jsonb_array_length(mention_ids)),0)::int woken
       FROM messages WHERE event_root_cause_id=$1`,
      [root.id],
    );
    // Two subscribers woken by the join, one agent woken by the emit.
    expect(spent.rows[0]?.woken).toBe(3);
    expect((await cascadeOf(first.id))?.event_root_cause_id).toBe(root.id);
  });
});
