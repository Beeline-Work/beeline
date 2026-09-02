import { describe, expect, it } from 'vitest';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import {
  AgentScheduleLoop,
  nextScheduleOccurrence,
  validateScheduleCadence,
} from './agent-schedules.js';
import { PhoneService } from './phone-service.js';

const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
      ($1,'human','Owner'),($2,'human','Member'),($3,'agent','Worker')`,
    [OWNER, MEMBER, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Scheduled Room')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`,
    [WORKSPACE, OWNER, MEMBER, AGENT, ROOM],
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
});
