import { randomBytes, randomUUID } from 'node:crypto';
import { createAgentCommand } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { describe, expect, it, vi } from 'vitest';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import { migratedDatabase } from './test-support.js';
import {
  AgentScheduleLoop,
  nextScheduleOccurrence,
  validateScheduleCadence,
} from './agent-schedules.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { SCHEDULE_RAN_VERB, SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';

const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const OTHER_AGENT = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

/**
 * An active agent turn started by `authorId`'s message. Editing or deleting a
 * saved schedule is workspace-admin-only, judged by that person.
 */
async function turnFrom(
  database: SqlDatabase,
  daemon: DaemonService,
  roomId: string,
  agentId: string,
  authorId = OWNER,
) {
  const id = randomBytes(32).toString('hex');
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Change the schedule')`, [
    id,
    roomId,
    authorId,
  ]);
  const command = await createAgentCommand(database, { roomId, agentId, sourceMessageId: id, reason: 'human_message' });
  const generationId = randomUUID();
  await daemon.execute('claimAgentCommand', { roomId, commandId: command!.id, generationId }, agentId);
  return { requestId: command!.turn_request_id, generationId };
}

async function fixture() {
  const database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Owner'),($2,'human','Member'),($3,'agent','Worker'),($4,'agent','Rival')`,
    [OWNER, MEMBER, AGENT, OTHER_AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Scheduled Room')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$6,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),($1,$5,$6,'member')`,
    [WORKSPACE, OWNER, MEMBER, AGENT, ROOM, OTHER_AGENT],
  );
  return database;
}

describe('agent schedule cadence', () => {
  it('keeps interval cadence while skipping missed occurrences', () => {
    const cadence: RoomScheduleCadence = { kind: 'interval', everyMinutes: 5 };
    expect(
      nextScheduleOccurrence(
        cadence,
        new Date('2026-09-01T12:17:00Z'),
        new Date('2026-09-01T12:00:00Z'),
      ).toISOString(),
    ).toBe('2026-09-01T12:20:00.000Z');
  });

  it('accepts five-field cron and rejects second-level schedules', () => {
    expect(() =>
      validateScheduleCadence({ kind: 'cron', expression: '30 9 * * 1-5' }),
    ).not.toThrow();
    expect(() => validateScheduleCadence({ kind: 'cron', expression: '0 30 9 * * 1-5' })).toThrow(
      'five fields',
    );
  });
});

describe('manager schedule phone operations', () => {
  it('rejects missing and blank names before creating a schedule', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      for (const title of [undefined, '', '   ']) {
        await expect(daemon.execute('createAgentSchedule', {
          title, roomId: ROOM, agentId: AGENT, prompt: 'Check work.',
          cadence: { kind: 'interval', everyMinutes: 60 },
        }, AGENT)).rejects.toThrow(/title/);
      }
      expect((await database.query('SELECT id FROM agent_schedules')).rowCount).toBe(0);
    } finally { await database.close(); }
  });

  it('lists and deletes an agent-created Room schedule', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      const daemon = new DaemonService(database, new LiveHub());
      const startsAt = Math.floor(Date.now() / 1_000) + 120;
      const created = await daemon.execute(
        'createAgentSchedule',
        { title: 'Scheduled check',
          roomId: ROOM,
          agentId: AGENT,
          cadence: { kind: 'interval', everyMinutes: 15, startsAt },
          prompt: 'Review the launch queue.',
        },
        AGENT,
      );
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).resolves.toEqual({
        schedules: [
          expect.objectContaining({
            id: created.scheduleId,
            workspaceId: WORKSPACE,
            roomId: ROOM,
            agentId: AGENT,
            creatorId: AGENT,
            message: 'Review the launch queue.',
            nextRunAt: startsAt,
          }),
        ],
      });
      await phone.execute(
        'deleteRoomSchedule',
        { roomId: ROOM, scheduleId: created.scheduleId },
        OWNER,
      );
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).resolves.toEqual({
        schedules: [],
      });
    } finally {
      await database.close();
    }
  });

  it('Reproduction R-schedule-titles: nameless agent schedules read as what they run', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      const daemon = new DaemonService(database, new LiveHub());
      const cadence = { kind: 'interval' as const, everyMinutes: 60 };
      for (const prompt of ['Post the daily launch report to the Room.', 'Replay the nightly prompt log.']) {
        await database.query(
          `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
           VALUES($1,$2,$3,$4,$4,$5::jsonb,$6,'2030-01-01')`,
          [randomUUID(), WORKSPACE, ROOM, AGENT, JSON.stringify(cadence), prompt]);
      }
      // A row that already stored the generic label before this derivation.
      await database.query(
        `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,title)
         VALUES($1,$2,$3,$4,$4,$5::jsonb,'Check the Play release downloads.','2030-01-01','Scheduled task')`,
        ['99999999-9999-4999-8999-999999999999', WORKSPACE, ROOM, AGENT, JSON.stringify(cadence)],
      );
      const titles = (await phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER))
        .schedules.map((row) => row.title);
      expect(titles).toEqual(expect.arrayContaining([
        'Post the daily launch',
        'Replay the nightly prompt',
        'Check the Play release',
      ]));
      expect(titles).not.toContain('Scheduled task');
      for (const title of titles) expect(title.split(' ').length).toBeLessThanOrEqual(4);
      console.log('Demonstrated R-schedule-titles:', JSON.stringify(titles));
    } finally {
      await database.close();
    }
  });

  it('Reproduction closed-corner-schedules: a closed corner schedule stops listing in its Room', async () => {
    const database = await fixture();
    try {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,archived_at)
         VALUES($1,$2,$3,$4,'Closed corner','2026-10-21T00:23:25Z')`,
        [CORNER, WORKSPACE, ROOM, OWNER],
      );
      const scheduleId = '88888888-8888-4888-8888-888888888888';
      await database.query(
        `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,title)
         VALUES($1,$2,$3,$4,$4,$5::jsonb,'Collect the runners.','2030-01-01','Collect runners')`,
        [scheduleId, WORKSPACE, CORNER, AGENT, JSON.stringify({ kind: 'interval', everyMinutes: 65 })],
      );
      const phone = new PhoneService(database, 'http://local.test');
      // The scheduler skips archived Rooms, so their schedules must not read as active.
      expect((await phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).schedules).toEqual([]);
      await database.query(`UPDATE rooms SET archived_at=NULL WHERE id=$1`, [CORNER]);
      expect((await phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).schedules.map(
        (row) => row.id,
      )).toEqual([scheduleId]);
      console.log('Demonstrated closed-corner-schedules: an archived corner schedule is hidden from its Room and returns when the corner reopens');
    } finally {
      await database.close();
    }
  });

  it('lists a corner-created schedule from its parent Room with its corner identity', async () => {
    const database = await fixture();
    try {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
         VALUES($1,$2,$3,$4,'Launch review')`,
        [CORNER, WORKSPACE, ROOM, OWNER],
      );

      const daemon = new DaemonService(database, new LiveHub());
      const created = await daemon.execute(
        'createAgentSchedule',
        { title: 'Scheduled check',
          agentId: AGENT,
          roomId: CORNER,
          prompt: 'Check the launch candidate.',
          cadence: { kind: 'interval', everyMinutes: 10 },
        },
        AGENT,
      );

      const phone = new PhoneService(database, 'http://local.test');
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).resolves.toEqual({
        schedules: [
          expect.objectContaining({
            id: created.scheduleId,
            roomId: CORNER,
            message: 'Check the launch candidate.',
            corner: { id: CORNER, name: 'Launch review' },
          }),
        ],
      });

      await phone.execute(
        'deleteRoomSchedule',
        { roomId: ROOM, scheduleId: created.scheduleId },
        OWNER,
      );
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).resolves.toEqual({
        schedules: [],
      });
    } finally {
      await database.close();
    }
  });

  it('requires Workspace admin authority for every schedule operation', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, MEMBER)).rejects.toThrow(
        'workspace admins only',
      );
      const daemon = new DaemonService(database, new LiveHub());
      const created = await daemon.execute(
        'createAgentSchedule',
        { title: 'Scheduled check',
          roomId: ROOM,
          agentId: AGENT,
          cadence: { kind: 'interval', everyMinutes: 1 },
          prompt: 'Run this.',
        },
        AGENT,
      );
      await expect(
        phone.execute(
          'deleteRoomSchedule',
          { roomId: ROOM, scheduleId: created.scheduleId },
          MEMBER,
        ),
      ).rejects.toThrow('workspace admins only');
    } finally {
      await database.close();
    }
  });
});

describe('agent schedule background posting', () => {
  it('Reproduction SCHEDULE-ISOLATION: isolates a poisoned ordinary schedule and retries it without duplicate posts', async () => {
    const database = await fixture();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failedId = '44444444-4444-4444-8444-444444444444';
    const healthyId = '55555555-5555-4555-8555-555555555555';
    const now = new Date('2026-09-01T12:00:30Z');
    try {
      for (const [id, minutes, due] of [
        [failedId, 0, '2026-09-01T12:00:00Z'],
        [healthyId, 5, '2026-09-01T12:00:01Z'],
      ] as const) {
        await database.query(
          `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
          [id, WORKSPACE, ROOM, AGENT, OWNER,
            JSON.stringify({ kind: 'interval', everyMinutes: minutes }), id, new Date(due)],
        );
      }
      const loop = new AgentScheduleLoop(database);
      await expect(loop.runOnce(now)).resolves.toBe(1);
      const daemon = new DaemonService(database, new LiveHub());
      const inbox = await daemon.execute('getRoomInbox', { roomId: ROOM, limit: 50 }, AGENT);
      expect(inbox.items.map((item) => item.body)).toContain(healthyId);
      expect((await daemon.execute('getAgentCommands', { roomId: ROOM }, AGENT)).commands).toHaveLength(1);
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining(failedId), expect.any(Error),
      );
      expect((await database.query(`SELECT text FROM messages`)).rows).toEqual([{ text: healthyId }]);
      expect((await database.query(`SELECT schedule_id FROM agent_schedule_occurrences`)).rows)
        .toEqual([{ schedule_id: healthyId }]);
      expect((await database.query(`SELECT next_run_at,run_count FROM agent_schedules WHERE id=$1`, [failedId])).rows)
        .toEqual([{ next_run_at: new Date(now.getTime() + 60_000), run_count: 0 }]);
      expect((await database.query(`SELECT count(*)::int count FROM agent_commands`)).rows).toEqual([{ count: 1 }]);
      await expect(loop.runOnce(new Date(now.getTime() + 1_000))).resolves.toBe(0);
      await database.query(`UPDATE agent_schedules SET cadence=$2::jsonb WHERE id=$1`,
        [failedId, JSON.stringify({ kind: 'interval', everyMinutes: 5 })]);
      await expect(loop.runOnce(new Date(now.getTime() + 60_000))).resolves.toBe(1);
      expect((await database.query(`SELECT text FROM messages ORDER BY text`)).rows)
        .toEqual([{ text: failedId }, { text: healthyId }]);
      expect((await database.query(`SELECT count(*)::int count FROM agent_commands`)).rows).toEqual([{ count: 2 }]);
      console.log('Demonstrated SCHEDULE-ISOLATION: later prompt reached the agent inbox and command queue; failed occurrence rolled back, backed off 60 seconds, and retried once without duplicate posts');
    } finally {
      errors.mockRestore();
      await database.close();
    }
  });

  it.each(['edit', 'delete', 'backoff failure'] as const)(
    'continues after a failure while preserving a concurrent %s', async (race) => {
      const database = await fixture();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failedId = '44444444-4444-4444-8444-444444444444';
      const healthyId = '55555555-5555-4555-8555-555555555555';
      const now = new Date('2026-09-01T12:00:30Z');
      let querySpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        for (const [id, minutes] of [[failedId, 0], [healthyId, 5]] as const) {
          await database.query(
            `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
            [id, WORKSPACE, ROOM, AGENT, OWNER,
              JSON.stringify({ kind: 'interval', everyMinutes: minutes }), id, now],
          );
        }
        const query = database.query.bind(database);
        querySpy = vi.spyOn(database, 'query').mockImplementation(async (sql, values) => {
          if (sql.includes('UPDATE agent_schedules SET next_run_at=$2,updated_at=now()')) {
            if (race === 'backoff failure') throw new Error('backoff unavailable');
            if (race === 'delete') await query(`DELETE FROM agent_schedules WHERE id=$1`, [failedId]);
            else await query(
              `UPDATE agent_schedules SET message='edited',updated_at=updated_at + interval '1 second' WHERE id=$1`,
              [failedId],
            );
          }
          return query(sql, values);
        });
        await expect(new AgentScheduleLoop(database).runOnce(now)).resolves.toBe(1);
        expect((await query(`SELECT text FROM messages`)).rows).toEqual([{ text: healthyId }]);
        const failed = (await query(`SELECT message,next_run_at FROM agent_schedules WHERE id=$1`, [failedId])).rows;
        expect(failed).toEqual(race === 'delete' ? [] : [{ message: race === 'edit' ? 'edited' : failedId, next_run_at: now }]);
        if (race === 'backoff failure') {
          expect(errors).toHaveBeenCalledWith(`schedule ${failedId} retry backoff failed`, expect.any(Error));
        }
      } finally {
        querySpy?.mockRestore();
        errors.mockRestore();
        await database.close();
      }
    },
  );

  it('atomically claims one occurrence across competing server loops', async () => {
    const database = await fixture();
    try {
      const due = new Date('2026-09-01T12:00:00Z');
      await database.query(
        `INSERT INTO agent_schedules(
          id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          '33333333-3333-4333-8333-333333333333',
          WORKSPACE,
          ROOM,
          AGENT,
          OWNER,
          JSON.stringify({ kind: 'interval', everyMinutes: 1 }),
          'Post the status update.',
          due,
        ],
      );
      const postedRooms: string[] = [];
      const first = new AgentScheduleLoop(database, (roomId) => postedRooms.push(roomId));
      const second = new AgentScheduleLoop(database, (roomId) => postedRooms.push(roomId));
      const results = await Promise.all([
        first.runOnce(new Date('2026-09-01T12:00:30Z')),
        second.runOnce(new Date('2026-09-01T12:00:30Z')),
      ]);
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(postedRooms).toEqual([ROOM]);
      expect(
        (
          await database.query<{
            author_id: string;
            text: string;
            woke: string[];
          }>(`SELECT author_id,text,
                ARRAY(SELECT agent_id FROM agent_commands
                      WHERE source_message_id=messages.id) woke
              FROM messages`)
        ).rows,
      ).toEqual([{ author_id: OWNER, text: 'Post the status update.', woke: [AGENT] }]);
      expect((await database.query(`SELECT 1 FROM agent_schedule_occurrences`)).rowCount).toBe(1);
    } finally {
      await database.close();
    }
  });

  it('fires an agent-created schedule as a scheduler-authored system prompt and auto-deletes after maxRuns', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      const created = await daemon.execute(
        'createAgentSchedule',
        { title: 'Scheduled check',
          agentId: AGENT,
          roomId: ROOM,
          prompt: 'Post exactly: hello @methoxine-debug',
          cadence: { kind: 'interval', everyMinutes: 1 },
          maxRuns: 2,
        },
        AGENT,
      );
      expect(created.scheduleId).toMatch(/[0-9a-f-]{36}/);
      // Force the schedule due so the loop can run both occurrences now.
      const forceDue = async () =>
        database.query(
          `UPDATE agent_schedules SET next_run_at=now() - interval '1 second' WHERE id=$1`,
          [created.scheduleId],
        );
      const loop = new AgentScheduleLoop(database);
      for (let run = 0; run < 2; run += 1) {
        await forceDue();
        expect(await loop.runOnce()).toBe(1);
      }
      const messages = await database.query<{
        author_id: string;
        text: string;
        presentation: string;
        woke: string[];
        system_event: unknown;
      }>(
        `SELECT author_id,text,presentation,system_event,
           ARRAY(SELECT agent_id FROM agent_commands
                 WHERE source_message_id=messages.id) woke
         FROM messages ORDER BY created_at`,
      );
      expect(messages.rowCount).toBe(3);
      // Never authored by the agent itself: the scheduler identity posts a
      // system-presentation line mentioning the agent.
      expect(messages.rows[0]).toEqual({
        author_id: SCHEDULE_SCHEDULER_ID,
        text: '@scheduler ran a schedule for @worker · Post exactly: hello @methoxine-debug',
        presentation: 'system',
        woke: [AGENT],
        system_event: {
          subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: '@scheduler' },
          verb: SCHEDULE_RAN_VERB,
          // The machine half beside the prose: the daemon matches this, never
          // the verb, and the text above is unchanged by its presence.
          kind: 'schedule-ran',
          scheduleId: created.scheduleId,
          object: { text: '@worker', id: AGENT },
          consequence: 'Post exactly: hello @methoxine-debug',
        },
      });
      expect(messages.rows[1]).toEqual(messages.rows[0]);
      expect(messages.rows[2]).toMatchObject({
        text: 'The schedule expired · reached its limit of 2 runs',
        presentation: 'system',
        woke: [],
      });
      // The scheduler identity is hidden from rosters.
      expect(
        (
          await database.query<{ hidden_from_roster: boolean }>(
            `SELECT hidden_from_roster FROM identities WHERE id=$1`,
            [SCHEDULE_SCHEDULER_ID],
          )
        ).rows[0],
      ).toEqual({ hidden_from_roster: true });
      // The agent's daemon inbox contains the scheduled prompt (the own-author
      // drop would have hidden a self-authored row) and a simulated turn reply.
      const inbox = await daemon.execute('getRoomInbox', { roomId: ROOM, limit: 50 }, AGENT);
      // An inbox item is already addressed to this agent by the fact it was
      // delivered here, so there is nothing on the row left to check it against.
      const scheduledItems = inbox.items.filter(
        (item) => item.type === 'system' && item.systemEvent?.verb === SCHEDULE_RAN_VERB,
      );
      expect(scheduledItems).toHaveLength(2);
      const [command] = (await daemon.execute('getAgentCommands', { roomId: ROOM }, AGENT))
        .commands;
      await daemon.execute(
        'claimAgentCommand',
        { roomId: ROOM, commandId: command!.id, generationId: 'g1' },
        AGENT,
      );
      await daemon.execute(
        'postRoomMessage',
        {
          roomId: ROOM,
          text: 'hello @methoxine-debug',
          requestId: command!.turnRequestId,
          generationId: 'g1',
          replyToMessageId: scheduledItems[0]!.id,
        },
        AGENT,
      );
      const replies = await database.query<{ text: string }>(
        `SELECT text FROM messages WHERE author_id=$1`,
        [AGENT],
      );
      expect(replies.rows).toEqual([{ text: 'hello @methoxine-debug' }]);
      // The schedule deleted itself after the second run.
      expect(
        (await database.query(`SELECT 1 FROM agent_schedules WHERE id=$1`, [created.scheduleId]))
          .rowCount,
      ).toBe(0);
    } finally {
      await database.close();
    }
  });
});

describe('agent tool schedule daemon operations', () => {
  it.each(['Room', 'corner', 'DM'])('manages only its own schedules across places from a %s (cross-place-schedules-1)', async (surface) => {
    const database = await fixture();
    const elsewhere = '55555555-5555-4555-8555-555555555555';
    try {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Other place')`,
        [elsewhere, WORKSPACE, OWNER],
      );
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
          ($1,$2,$3,'member'),($1,$2,$4,'member')`,
        [WORKSPACE, elsewhere, AGENT, OTHER_AGENT],
      );
      if (surface === 'corner') {
        await database.query(`DELETE FROM memberships WHERE room_id=$1`, [elsewhere]);
        await database.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [elsewhere, ROOM]);
      } else if (surface === 'DM') {
        await database.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`,
          [elsewhere, JSON.stringify([OWNER, AGENT])]);
      }
      const daemon = new DaemonService(database, new LiveHub());
      const create = (agentId: string, roomId: string) => daemon.execute('createAgentSchedule', { title: 'Scheduled check',
        agentId, roomId, prompt: 'Audit velocity.',
        cadence: { kind: 'interval', everyMinutes: 60 },
      }, agentId);
      const own = await create(AGENT, ROOM);
      const local = await create(AGENT, elsewhere);
      const rival = await create(OTHER_AGENT, ROOM);
      const otherWorkspace = '66666666-6666-4666-8666-666666666666';
      const otherRoom = '77777777-7777-4777-8777-777777777777';
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other Workspace')`, [otherWorkspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Outside Workspace')`,
        [otherRoom, otherWorkspace, OWNER]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,NULL,$4,'owner')`, [otherWorkspace, AGENT, otherRoom, OWNER]);
      const outside = await create(AGENT, otherRoom);

      const listed = await daemon.execute('listAgentSchedules', {
        agentId: AGENT, roomId: elsewhere, selfOnly: true,
      }, AGENT);
      // Own schedules in every Workspace the agent belongs to, not just this one.
      expect(listed.schedules).toEqual([
        expect.objectContaining({ scheduleId: own.scheduleId, roomId: ROOM, roomName: 'Scheduled Room' }),
        expect.objectContaining({ scheduleId: local.scheduleId, roomId: elsewhere, roomName: 'Other place' }),
        expect.objectContaining({ scheduleId: outside.scheduleId, roomId: otherRoom, roomName: 'Outside Workspace' }),
      ]);
      const cadence = { kind: 'cron' as const, expression: '0 19 * * *', timeZone: 'America/New_York' };
      await daemon.execute('updateAgentSchedule', {
        agentId: AGENT, roomId: elsewhere, selfOnly: true,
        scheduleId: own.scheduleId, prompt: 'Evening audit.', cadence,
        ...await turnFrom(database, daemon, elsewhere, AGENT),
      }, AGENT);
      // The other-Workspace schedule is editable from here too.
      await daemon.execute('updateAgentSchedule', {
        agentId: AGENT, roomId: elsewhere, selfOnly: true,
        scheduleId: outside.scheduleId, prompt: 'Outside evening audit.',
        ...await turnFrom(database, daemon, elsewhere, AGENT),
      }, AGENT);
      expect((await daemon.execute('listAgentSchedules', {
        agentId: AGENT, roomId: elsewhere, selfOnly: true,
      }, AGENT)).schedules).toContainEqual(expect.objectContaining({
        scheduleId: own.scheduleId, roomId: ROOM, prompt: 'Evening audit.', cadence,
      }));
      for (const operation of ['updateAgentSchedule', 'deleteAgentSchedule'] as const) {
        await expect(daemon.execute(operation, {
          agentId: AGENT, roomId: elsewhere, selfOnly: true,
          scheduleId: rival.scheduleId, prompt: 'Forbidden.',
        }, AGENT)).rejects.toThrow('schedule not found');
      }
      await daemon.execute('deleteAgentSchedule', {
        agentId: AGENT, roomId: elsewhere, selfOnly: true, scheduleId: own.scheduleId,
        ...await turnFrom(database, daemon, elsewhere, AGENT),
      }, AGENT);
      expect((await daemon.execute('listAgentSchedules', {
        agentId: AGENT, roomId: elsewhere, selfOnly: true,
      }, AGENT)).schedules.map(schedule => schedule.scheduleId)).toEqual([local.scheduleId, outside.scheduleId]);
      console.info('Demonstrated cross-place-schedules-1: own schedules listed with Room names across Workspaces; remote cadence/prompt updated and deleted; rival mutations refused.');
    } finally {
      await database.close();
    }
  });

  it('creates, lists, and deletes via daemon operations with agent scoping', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      const created = await daemon.execute(
        'createAgentSchedule',
        { title: 'Ping the Room',
          agentId: AGENT,
          roomId: ROOM,
          prompt: 'Ping the Room.',
          cadence: { kind: 'interval', everyMinutes: 3 },
          maxRuns: 5,
        },
        AGENT,
      );
      expect(created.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      const listed = await daemon.execute(
        'listAgentSchedules',
        { agentId: AGENT, roomId: ROOM },
        AGENT,
      );
      expect(listed.schedules).toEqual([
        {
          title: 'Ping the Room',
          scheduleId: created.scheduleId,
          agentId: AGENT,
          prompt: 'Ping the Room.',
          cadence: { kind: 'interval', everyMinutes: 3 },
          maxRuns: 5,
          runCount: 0,
          nextRunAt: created.nextRunAt,
        },
      ]);
      // Another agent in the Room sees it and may delete it for a Workspace admin,
      // but not for a member or with no person behind the turn.
      const rivalList = await daemon.execute(
        'listAgentSchedules',
        { agentId: OTHER_AGENT, roomId: ROOM },
        OTHER_AGENT,
      );
      expect(rivalList.schedules).toEqual(listed.schedules);
      for (const context of [{}, await turnFrom(database, daemon, ROOM, OTHER_AGENT, MEMBER)])
        await expect(
          daemon.execute(
            'deleteAgentSchedule',
            { agentId: OTHER_AGENT, roomId: ROOM, scheduleId: created.scheduleId, ...context },
            OTHER_AGENT,
          ),
        ).rejects.toThrow('workspace admins only');
      await expect(
        daemon.execute(
          'deleteAgentSchedule',
          { agentId: OTHER_AGENT, roomId: ROOM, scheduleId: created.scheduleId,
            ...await turnFrom(database, daemon, ROOM, OTHER_AGENT) },
          OTHER_AGENT,
        ),
      ).resolves.toBeTruthy();
      expect(
        (await daemon.execute('listAgentSchedules', { agentId: AGENT, roomId: ROOM }, AGENT))
          .schedules,
      ).toEqual([]);
      await expect(
        daemon.execute(
          'deleteAgentSchedule',
          { agentId: AGENT, roomId: ROOM, scheduleId: created.scheduleId },
          AGENT,
        ),
      ).rejects.toThrow('schedule not found');
      // A daemon token cannot create schedules on behalf of another agent.
      await expect(
        daemon.execute(
          'createAgentSchedule',
          { title: 'Scheduled check',
            agentId: OTHER_AGENT,
            roomId: ROOM,
            prompt: 'Impersonation.',
            cadence: { kind: 'interval', everyMinutes: 1 },
          },
          AGENT,
        ),
      ).rejects.toThrow('daemon token does not own requested agent');
    } finally {
      await database.close();
    }
  });

  it("lets another agent modify an agent's schedule, but not a person's", async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      const created = await daemon.execute(
        'createAgentSchedule',
        { title: 'Scheduled check',
          agentId: AGENT,
          roomId: ROOM,
          prompt: 'Ping the Room.',
          cadence: { kind: 'interval', everyMinutes: 3 },
        },
        AGENT,
      );
      const change = {
        agentId: OTHER_AGENT,
        roomId: ROOM,
        scheduleId: created.scheduleId,
        prompt: 'Summarize the Room.',
        cadence: { kind: 'interval' as const, everyMinutes: 60 },
        maxRuns: 2,
      };
      // A Workspace member is refused even with a Room admin role, and nothing changes.
      await database.query(`UPDATE memberships SET role='admin' WHERE room_id=$1 AND identity_id=$2`, [ROOM, MEMBER]);
      await expect(daemon.execute('updateAgentSchedule',
        { ...change, ...await turnFrom(database, daemon, ROOM, OTHER_AGENT, MEMBER) }, OTHER_AGENT,
      )).rejects.toThrow('workspace admins only');
      expect((await database.query(`SELECT message FROM agent_schedules WHERE id=$1`, [created.scheduleId])).rows)
        .toEqual([{ message: 'Ping the Room.' }]);
      const updated = await daemon.execute(
        'updateAgentSchedule',
        { ...change, ...await turnFrom(database, daemon, ROOM, OTHER_AGENT) },
        OTHER_AGENT,
      );
      expect(updated.scheduleId).toBe(created.scheduleId);
      expect(updated.nextRunAt).toBeGreaterThan(created.nextRunAt);
      expect(
        (await daemon.execute('listAgentSchedules', { agentId: AGENT, roomId: ROOM }, AGENT))
          .schedules,
      ).toEqual([
        {
          title: 'Summarize the Room',
          scheduleId: created.scheduleId,
          agentId: AGENT,
          prompt: 'Summarize the Room.',
          cadence: { kind: 'interval', everyMinutes: 60 },
          maxRuns: 2,
          runCount: 0,
          nextRunAt: updated.nextRunAt,
        },
      ]);
      await expect(
        daemon.execute(
          'updateAgentSchedule',
          { agentId: OTHER_AGENT, roomId: ROOM, scheduleId: created.scheduleId },
          OTHER_AGENT,
        ),
      ).rejects.toThrow('give a prompt, cadence, or maxRuns to change');

      // A person's schedule for an agent runs in that person's name, so no
      // agent may rewrite it, and only the agent it mentions may see or delete it.
      const managerSchedule = { id: '44444444-4444-4444-8444-444444444444' };
      await database.query(
        `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,'Daily digest.',now() + interval '1 day')`,
        [
          managerSchedule.id,
          WORKSPACE,
          ROOM,
          AGENT,
          OWNER,
          JSON.stringify({ kind: 'interval', everyMinutes: 1440 }),
        ],
      );
      for (const agentId of [AGENT, OTHER_AGENT]) {
        await expect(
          daemon.execute(
            'updateAgentSchedule',
            { agentId, roomId: ROOM, scheduleId: managerSchedule.id, prompt: 'Rewritten.' },
            agentId,
          ),
        ).rejects.toThrow('schedule not found');
      }
      expect(
        (
          await daemon.execute(
            'listAgentSchedules',
            { agentId: OTHER_AGENT, roomId: ROOM },
            OTHER_AGENT,
          )
        ).schedules.map((schedule) => schedule.scheduleId),
      ).toEqual([created.scheduleId]);
      await expect(
        daemon.execute(
          'deleteAgentSchedule',
          { agentId: OTHER_AGENT, roomId: ROOM, scheduleId: managerSchedule.id },
          OTHER_AGENT,
        ),
      ).rejects.toThrow('schedule not found');
    } finally {
      await database.close();
    }
  });

  it('validates prompt, cadence floor, and maxRuns', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      await expect(
        daemon.execute(
          'createAgentSchedule',
          { title: 'Scheduled check',
            agentId: AGENT,
            roomId: ROOM,
            prompt: '   ',
            cadence: { kind: 'interval', everyMinutes: 1 },
          },
          AGENT,
        ),
      ).rejects.toThrow('prompt is required');
      await expect(
        daemon.execute(
          'createAgentSchedule',
          { title: 'Scheduled check',
            agentId: AGENT,
            roomId: ROOM,
            prompt: 'Ping.',
            cadence: { kind: 'interval', everyMinutes: 0 },
          },
          AGENT,
        ),
      ).rejects.toThrow('interval must be between 1 minute and 366 days');
      await expect(
        daemon.execute(
          'createAgentSchedule',
          { title: 'Scheduled check',
            agentId: AGENT,
            roomId: ROOM,
            prompt: 'Ping.',
            cadence: { kind: 'interval', everyMinutes: 1 },
            maxRuns: 0,
          },
          AGENT,
        ),
      ).rejects.toThrow('maxRuns must be a positive integer');
      await expect(
        daemon.execute(
          'createAgentSchedule',
          { title: 'Scheduled check',
            agentId: AGENT,
            roomId: ROOM,
            prompt: 'Ping.',
            cadence: { kind: 'cron', expression: '* * * *' },
          },
          AGENT,
        ),
      ).rejects.toThrow('five fields');
    } finally {
      await database.close();
    }
  });
});
