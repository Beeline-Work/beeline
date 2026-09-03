import { describe, expect, it } from 'vitest';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
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

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
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
  it('creates, lists, and deletes a Room schedule', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      const startsAt = Math.floor(Date.now() / 1_000) + 120;
      const created = await phone.execute(
        'createRoomSchedule',
        {
          workspaceId: WORKSPACE,
          roomId: ROOM,
          agentId: AGENT,
          cadence: { kind: 'interval', everyMinutes: 15, startsAt },
          message: 'Review the launch queue.',
        },
        OWNER,
      );
      expect(created).toMatchObject({
        workspaceId: WORKSPACE,
        roomId: ROOM,
        agentId: AGENT,
        creatorId: OWNER,
        message: 'Review the launch queue.',
        nextRunAt: startsAt,
      });
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).resolves.toEqual({
        schedules: [created],
      });
      await phone.execute('deleteRoomSchedule', { roomId: ROOM, scheduleId: created.id }, OWNER);
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, OWNER)).resolves.toEqual({
        schedules: [],
      });
    } finally {
      await database.close();
    }
  });

  it('requires Room manager authority for every schedule operation', async () => {
    const database = await fixture();
    try {
      const phone = new PhoneService(database, 'http://local.test');
      await expect(
        phone.execute(
          'createRoomSchedule',
          {
            workspaceId: WORKSPACE,
            roomId: ROOM,
            agentId: AGENT,
            cadence: { kind: 'interval', everyMinutes: 1 },
            message: 'Run this.',
          },
          MEMBER,
        ),
      ).rejects.toThrow('room manager required');
      await expect(phone.execute('listRoomSchedules', { roomId: ROOM }, MEMBER)).rejects.toThrow(
        'room manager required',
      );
      const created = await phone.execute(
        'createRoomSchedule',
        {
          workspaceId: WORKSPACE,
          roomId: ROOM,
          agentId: AGENT,
          cadence: { kind: 'interval', everyMinutes: 1 },
          message: 'Run this.',
        },
        OWNER,
      );
      await expect(
        phone.execute('deleteRoomSchedule', { roomId: ROOM, scheduleId: created.id }, MEMBER),
      ).rejects.toThrow('room manager required');
    } finally {
      await database.close();
    }
  });
});

describe('agent schedule background posting', () => {
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
            mention_ids: string[];
          }>(`SELECT author_id,text,mention_ids FROM messages`)
        ).rows,
      ).toEqual([{ author_id: OWNER, text: 'Post the status update.', mention_ids: [AGENT] }]);
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
        {
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
        mention_ids: string[];
        system_event: unknown;
      }>(`SELECT author_id,text,presentation,mention_ids,system_event FROM messages ORDER BY created_at`);
      expect(messages.rowCount).toBe(2);
      // Never authored by the agent itself: the scheduler identity posts a
      // system-presentation line mentioning the agent.
      expect(messages.rows[0]).toEqual({
        author_id: SCHEDULE_SCHEDULER_ID,
        text: 'Beeline Scheduler ran a schedule for Worker · Post exactly: hello @methoxine-debug',
        presentation: 'system',
        mention_ids: [AGENT],
        system_event: {
          subject: { kind: 'system', id: SCHEDULE_SCHEDULER_ID, name: 'Beeline Scheduler' },
          verb: SCHEDULE_RAN_VERB,
          object: { text: 'Worker', id: AGENT },
          consequence: 'Post exactly: hello @methoxine-debug',
        },
      });
      expect(messages.rows[1]).toEqual(messages.rows[0]);
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
      const inbox = await daemon.execute(
        'getRoomInbox',
        { roomId: ROOM, limit: 50 },
        AGENT,
      );
      const scheduledItems = inbox.items.filter(
        (item) =>
          item.type === 'system' &&
          item.systemEvent?.verb === SCHEDULE_RAN_VERB &&
          item.mentionIds.includes(AGENT),
      );
      expect(scheduledItems).toHaveLength(2);
      await daemon.execute(
        'postRoomMessage',
        {
          roomId: ROOM,
          text: 'hello @methoxine-debug',
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
  it('creates, lists, and deletes via daemon operations with agent scoping', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      const created = await daemon.execute(
        'createAgentSchedule',
        {
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
          scheduleId: created.scheduleId,
          prompt: 'Ping the Room.',
          cadence: { kind: 'interval', everyMinutes: 3 },
          maxRuns: 5,
          runCount: 0,
          nextRunAt: created.nextRunAt,
        },
      ]);
      // Another agent cannot see or delete it.
      const rivalList = await daemon.execute(
        'listAgentSchedules',
        { agentId: OTHER_AGENT, roomId: ROOM },
        OTHER_AGENT,
      );
      expect(rivalList.schedules).toEqual([]);
      await expect(
        daemon.execute(
          'deleteAgentSchedule',
          { agentId: OTHER_AGENT, roomId: ROOM, scheduleId: created.scheduleId },
          OTHER_AGENT,
        ),
      ).rejects.toThrow('schedule not found');
      await expect(
        daemon.execute(
          'deleteAgentSchedule',
          { agentId: AGENT, roomId: ROOM, scheduleId: created.scheduleId },
          AGENT,
        ),
      ).resolves.toBeTruthy();
      expect(
        (await daemon.execute('listAgentSchedules', { agentId: AGENT, roomId: ROOM }, AGENT))
          .schedules,
      ).toEqual([]);
      // A daemon token cannot create schedules on behalf of another agent.
      await expect(
        daemon.execute(
          'createAgentSchedule',
          {
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

  it('validates prompt, cadence floor, and maxRuns', async () => {
    const database = await fixture();
    try {
      const daemon = new DaemonService(database, new LiveHub());
      await expect(
        daemon.execute(
          'createAgentSchedule',
          {
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
          {
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
          {
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
          {
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
