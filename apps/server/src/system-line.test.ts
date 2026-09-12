import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { SCHEDULE_RAN_VERB } from '@beeline/api-contract/scheduled-prompts';
import type { SystemEvent } from '@beeline/api-contract/phone';
import {
  SYSTEM_IDENTITY_HANDLE,
  SYSTEM_IDENTITY_ID,
  SYSTEM_IDENTITY_NAME,
} from '@beeline/api-contract/system-identity';
import { PushDeliveryLoop } from './background.js';
import { backfillSystemEventKinds, migrate, type SqlDatabase } from './database.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase } from './test-support.js';
import { composeSystemLine, systemLine, workspaceSystemLine } from './system-line.js';

describe('composeSystemLine', () => {
  it('keeps a join subject while naming its inviter in the attribution slot', () => {
    expect(
      composeSystemLine({
        subject: { kind: 'agent', id: 'foxy', name: '@foxy' },
        verb: 'joined',
        attribution: {
          verb: 'invited by',
          actor: { kind: 'person', id: 'moon', name: '@moonscannerai' },
        },
      }),
    ).toEqual({
      text: '@foxy joined · invited by @moonscannerai',
      event: {
        subject: { kind: 'agent', id: 'foxy', name: '@foxy' },
        verb: 'joined',
        consequence: 'invited by @moonscannerai',
      },
    });
  });

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
    expect(line.event.object).toEqual({
      text: 'Beeline CI',
      url: 'https://github.com/acme/w/runs/1',
    });
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

  const wokenBy = async (id: string) =>
    (
      await database.query<{ woke: string[] }>(
        `SELECT ARRAY(SELECT agent_id FROM agent_commands WHERE source_message_id=$1) woke`,
        [id],
      )
    ).rows[0]!.woke;

  it('adds the Room members subscribed to the kind, keeping the explicit mentions', async () => {
    const written = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
      kind: 'joined',
      wakes: [QUIET_AGENT],
    });
    // The explicit mention survives; the subscriber is added beside it. The
    // agent subscribed to a different kind hears nothing from this line.
    expect((await wokenBy(written.id)).sort()).toEqual([QUIET_AGENT, GREETER].sort());
  });

  it('mentions nobody extra when nothing subscribes, and nothing at all with no kind', async () => {
    const unsubscribed = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'left',
      kind: 'corner-opened',
      wakes: [QUIET_AGENT],
    });
    expect(await wokenBy(unsubscribed.id)).toEqual([QUIET_AGENT]);
    const plain = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'joined',
    });
    expect(await wokenBy(plain.id)).toEqual([]);
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
    expect(await wokenBy(written.id)).toEqual([]);
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
      wakes: [QUIET_AGENT],
    });
    expect(written.inserted).toBe(true);
    expect(await wokenBy(written.id)).toEqual([QUIET_AGENT]);
  });
});

describe('workspace system lines', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Ada')`, [HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,
      [WORKSPACE, HUMAN],
    );
  });
  afterEach(() => database.close());

  it('repairs a legacy System identity before rendering a lifecycle announcement', async () => {
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,hidden_from_roster)
       VALUES($1,'human','Cato',NULL,true)`,
      [SYSTEM_IDENTITY_ID],
    );

    await workspaceSystemLine(database, {
      workspaceId: WORKSPACE,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'changed workspace visibility to',
      object: 'public',
    });

    const roomId = (
      await database.query<{ room_id: string }>(
        `SELECT room_id FROM memberships
         WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NOT NULL`,
        [WORKSPACE, HUMAN],
      )
    ).rows[0]!.room_id;
    const view = await new PhoneService(database, 'http://local.test').readRoom(roomId, HUMAN);
    expect(view?.messages[0]?.author).toEqual({
      pubkey: SYSTEM_IDENTITY_ID,
      kind: 'human',
      name: SYSTEM_IDENTITY_NAME,
      handle: SYSTEM_IDENTITY_HANDLE,
    });
  });

  it('restores a rejoined recipient to their existing @system DM', async () => {
    await workspaceSystemLine(database, {
      workspaceId: WORKSPACE,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'changed workspace visibility to',
      object: 'public',
    });
    const room = await database.query<{ room_id: string }>(
      `SELECT room_id FROM memberships
       WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NOT NULL`,
      [WORKSPACE, HUMAN],
    );
    const roomId = room.rows[0]!.room_id;
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('system-dm-device-token-123456789012345',$1,'android','physical')`,
      [HUMAN],
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(0);
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
      [WORKSPACE, HUMAN],
    );
    await database.query(
      `UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,
      [roomId, HUMAN],
    );
    expect(await new PhoneService(database, 'http://local.test').canReadRoom(roomId, HUMAN)).toBe(
      false,
    );
    await systemLine(database, {
      roomId,
      authorId: SYSTEM_IDENTITY_ID,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'changed workspace visibility to',
      object: 'invite-only',
      cardType: 'workspace-visibility',
    });
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await database.query(
      `UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,
      [WORKSPACE, HUMAN],
    );

    await workspaceSystemLine(database, {
      workspaceId: WORKSPACE,
      subject: { kind: 'person', id: HUMAN, name: 'Ada' },
      verb: 'changed workspace visibility to',
      object: 'invite-only',
    });

    const restored = await database.query<{ removed_at: Date | null }>(
      `SELECT removed_at FROM memberships WHERE room_id=$1 AND identity_id=$2`,
      [roomId, HUMAN],
    );
    expect(restored.rows).toEqual([{ removed_at: null }]);
    expect(await new PhoneService(database, 'http://local.test').canReadRoom(roomId, HUMAN)).toBe(
      true,
    );
    expect(
      (await database.query(`SELECT 1 FROM messages WHERE room_id=$1`, [roomId])).rowCount,
    ).toBe(3);
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

describe('a caused line sorts after its cause', () => {
  let database: PgliteDatabase;
  const CAUSE = 'd'.repeat(64);
  const wokenBy = async (id: string) =>
    (
      await database.query<{ woke: string[] }>(
        `SELECT ARRAY(SELECT agent_id FROM agent_commands WHERE source_message_id=$1) woke`,
        [id],
      )
    ).rows[0]!.woke;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Ada'),($2,'agent','Lumen')`,
      [HUMAN, GREETER],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'welcome')`, [
      ROOM,
      WORKSPACE,
    ]);
    // The provoking message, pinned INSIDE the current second: any line written
    // right after it would share its second, which is exactly the tie a
    // whole-second transcript breaks on the random row id.
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
       VALUES($1,$2,$3,'@lumen sup','message',date_trunc('second', now()))`,
      [CAUSE, ROOM, HUMAN],
    );
  });
  afterEach(() => database.close());

  const stampOf = async (id: string) =>
    (
      await database.query<{ created_at: Date; cause: string | null }>(
        `SELECT created_at,event_cause_id cause FROM messages WHERE id=$1`,
        [id],
      )
    ).rows[0]!;

  it('stamps a kinded caused line strictly past the second of its cause, keeping the cascade', async () => {
    const written = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'agent', id: GREETER, name: 'Lumen' },
      verb: 'could not answer',
      consequence: 'the helper named no live model',
      kind: 'joined',
      causeId: CAUSE,
    });
    const cause = await stampOf(CAUSE);
    const line = await stampOf(written.id);
    expect(Math.floor(line.created_at.getTime() / 1000)).toBe(
      Math.floor(cause.created_at.getTime() / 1000) + 1,
    );
    expect(line.cause).toBe(CAUSE);
  });

  it('stamps an unkinded ordering-only line past its cause without a cascade', async () => {
    const written = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'agent', id: GREETER, name: 'Lumen' },
      verb: 'did not answer',
      consequence: 'only the owner may address Lumen',
      afterMessageId: CAUSE,
    });
    const cause = await stampOf(CAUSE);
    const line = await stampOf(written.id);
    expect(Math.floor(line.created_at.getTime() / 1000)).toBe(
      Math.floor(cause.created_at.getTime() / 1000) + 1,
    );
    // Ordering only: the line cites nothing, wakes nobody, mentions nobody.
    expect(line.cause).toBeNull();
    expect(await wokenBy(written.id)).toEqual([]);
  });

  it('keeps the natural time once the second has already passed', async () => {
    await database.query(
      `UPDATE messages SET created_at=now() - interval '10 seconds' WHERE id=$1`,
      [CAUSE],
    );
    const written = await systemLine(database, {
      roomId: ROOM,
      subject: { kind: 'agent', id: GREETER, name: 'Lumen' },
      verb: 'did not answer',
      consequence: 'only the owner may address Lumen',
      afterMessageId: CAUSE,
    });
    const line = await stampOf(written.id);
    // GREATEST keeps now(): the row is never pulled back toward its cause.
    expect(line.created_at.getTime()).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });
});
