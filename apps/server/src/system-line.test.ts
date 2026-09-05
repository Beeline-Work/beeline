import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { SCHEDULE_RAN_VERB } from '@beeline/api-contract/scheduled-prompts';
import type { SystemEvent } from '@beeline/api-contract/phone';
import { backfillSystemEventKinds, migrate, type SqlDatabase } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { composeSystemLine, systemLine } from './system-line.js';

describe('composeSystemLine', () => {
  it('phrases subject verb object · consequence and returns the structured event', () => {
    expect(
      composeSystemLine({
        subject: { kind: 'person', id: 'owner', name: 'Owner' },
        verb: 'turned yolo on for',
        object: { text: 'Bee', id: 'bee' },
        consequence: 'grant requests are now approved automatically',
      }),
    ).toEqual({
      text: 'Owner turned yolo on for Bee · grant requests are now approved automatically',
      event: {
        subject: { kind: 'person', id: 'owner', name: 'Owner' },
        verb: 'turned yolo on for',
        object: { text: 'Bee', id: 'bee' },
        consequence: 'grant requests are now approved automatically',
      },
    });
  });

  it('keeps a URL out of the text and on the object', () => {
    const line = composeSystemLine({
      subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check',
      object: { text: 'Beeline CI', url: 'https://github.com/acme/w/runs/1' },
    });
    expect(line.text).toBe('GitHub passed a check Beeline CI');
    expect(line.event.object).toEqual({ text: 'Beeline CI', url: 'https://github.com/acme/w/runs/1' });
  });

  it('collapses whitespace and drops an empty object or consequence', () => {
    expect(
      composeSystemLine({
        subject: { kind: 'agent', id: 'bee', name: ' Bee ' },
        verb: 'could not answer',
        object: '  ',
        consequence: 'provider  error\n429',
      }),
    ).toEqual({
      text: 'Bee could not answer · provider error 429',
      event: {
        subject: { kind: 'agent', id: 'bee', name: 'Bee' },
        verb: 'could not answer',
        consequence: 'provider error 429',
      },
    });
  });

  it('composes the grant decision the daemon parses structurally', () => {
    const line = composeSystemLine({
      subject: { kind: 'person', id: 'charles', name: 'Charles Bee' },
      verb: 'approved once',
      object: 'command fly deploy -a beeline-preview --with FLY_TOKEN',
    });
    expect(parseGrantDecisionLine(line.text)).toEqual({
      deciderName: 'Charles Bee',
      decision: 'once',
      kind: 'command',
      target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
    });
  });
});

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const ROOM = '44444444-4444-4444-8444-444444444444';
const HUMAN = 'a'.repeat(64);
const GREETER = 'b'.repeat(64);
const QUIET_AGENT = 'c'.repeat(64);

describe('who an event line mentions', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Ada'),($2,'agent','Owl'),($3,'agent','Quiet')`,
      [HUMAN, GREETER, QUIET_AGENT],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
       VALUES($1,$2,$3,'member','[]'::jsonb),($1,$2,$4,'member','["joined"]'::jsonb),
             ($1,$2,$5,'member','["merged"]'::jsonb)`,
      [WORKSPACE, ROOM, HUMAN, GREETER, QUIET_AGENT],
    );
  });
  afterEach(() => database.close());

  const mentionsOf = async (id: string) =>
    (
      await database.query<{ mention_ids: string[] }>(
        `SELECT mention_ids FROM messages WHERE id=$1`,
        [id],
      )
    ).rows[0]!.mention_ids;

  it('adds the Room members subscribed to the kind, keeping the explicit mentions', async () => {
    const written = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
      mentions: [QUIET_AGENT],
    });
    // The explicit mention survives; the subscriber is added beside it. The
    // agent subscribed to a different kind hears nothing from this line.
    expect((await mentionsOf(written.id)).sort()).toEqual([QUIET_AGENT, GREETER].sort());
  });

  it('mentions nobody extra when nothing subscribes, and nothing at all with no kind', async () => {
    const unsubscribed = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'left',
      kind: 'corner-opened',
      mentions: [QUIET_AGENT],
    });
    expect(await mentionsOf(unsubscribed.id)).toEqual([QUIET_AGENT]);
    const plain = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
    });
    expect(await mentionsOf(plain.id)).toEqual([]);
  });

  it('never mentions a human or a member who left', async () => {
    await database.query(
      `UPDATE memberships SET event_subscriptions='["joined"]'::jsonb WHERE identity_id=$1`,
      [HUMAN],
    );
    await database.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [GREETER]);
    const written = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
    });
    expect(await mentionsOf(written.id)).toEqual([]);
  });

  it('still writes the line when the subscriber lookup fails', async () => {
    // The caller is a real membership write. Losing a join to a subscription
    // lookup would be a silent partial join, so the fill is best-effort.
    const failing: SqlDatabase = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('event_subscriptions')) throw new Error('column is gone');
        return database.query(sql, values ?? []);
      },
      transaction: (work) => database.transaction(work),
    };
    const written = await systemLine(failing, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
      mentions: [QUIET_AGENT],
    });
    expect(written.inserted).toBe(true);
    expect(await mentionsOf(written.id)).toEqual([QUIET_AGENT]);
  });
});

describe('the scheduled-prompt kind backfill', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Ada')`, [HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
      ROOM,
      WORKSPACE,
    ]);
  });
  afterEach(() => database.close());

  it('stamps an old scheduler line once, and changes nothing on a second run', async () => {
    const legacy: SystemEvent = {
      subject: { kind: 'system', name: 'Beeline Scheduler' },
      verb: SCHEDULE_RAN_VERB,
      consequence: 'ping',
    };
    const untouched: SystemEvent = { subject: { kind: 'person', name: 'Ada' }, verb: 'joined' };
    for (const [id, event] of [
      ['1'.repeat(64), legacy],
      ['2'.repeat(64), untouched],
    ] as const) {
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,system_event)
         VALUES($1,$2,$3,'x','system',$4::jsonb)`,
        [id, ROOM, HUMAN, JSON.stringify(event)],
      );
    }
    const kinds = async () =>
      (
        await database.query<{ id: string; kind: string | null }>(
          `SELECT id,system_event->>'kind' kind FROM messages ORDER BY id`,
        )
      ).rows;
    await backfillSystemEventKinds(database);
    expect(await kinds()).toEqual([
      { id: '1'.repeat(64), kind: 'schedule-ran' },
      // A past join is nothing a subscriber can want; it is left alone.
      { id: '2'.repeat(64), kind: null },
    ]);
    await backfillSystemEventKinds(database);
    expect(await kinds()).toEqual([
      { id: '1'.repeat(64), kind: 'schedule-ran' },
      { id: '2'.repeat(64), kind: null },
    ]);
  });
});
