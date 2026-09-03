import { describe, expect, it } from 'vitest';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  type AgentScheduleDeps,
} from './read-only-mcp.js';

function deps(ops: Array<{ name: string; input: Record<string, unknown> }>): AgentScheduleDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      if (name === 'createAgentSchedule') {
        return { scheduleId: 'sched-1', nextRunAt: 1_800_000_000 };
      }
      if (name === 'listAgentSchedules') {
        return {
          schedules: [
            {
              scheduleId: 'sched-1',
              prompt: 'message hello',
              cadence: { kind: 'interval', everyMinutes: 1 },
              maxRuns: 5,
              runCount: 2,
              nextRunAt: 1_800_000_000,
            },
          ],
        };
      }
      return { id: 'w', createdAt: 1 };
    },
  };
}

describe('beeline-agent schedule tools', () => {
  it('create_schedule calls createAgentSchedule and reports the 1-minute floor', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await createSchedule(
      {
        prompt: "message 'hello @bananaman614305'",
        cadence: { kind: 'interval', everyMinutes: 0.5 },
        maxRuns: 5,
      },
      deps(ops),
    );
    expect(ops).toEqual([
      {
        name: 'createAgentSchedule',
        input: {
          roomId: 'room-1',
          prompt: "message 'hello @bananaman614305'",
          cadence: { kind: 'interval', everyMinutes: 1 },
          maxRuns: 5,
        },
      },
    ]);
    expect(result).toContain('sched-1');
    expect(result).toContain('The minimum cadence is 1 minute');
    expect(result).toContain('every 1 minute');
    expect(result).toContain('5 runs');
  });

  it('create_schedule accepts cron cadences without a floor note', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await createSchedule(
      { prompt: 'Ping.', cadence: { kind: 'cron', expression: '*/5 * * * *' } },
      deps(ops),
    );
    expect(ops[0]?.input.cadence).toEqual({ kind: 'cron', expression: '*/5 * * * *' });
    expect(result).not.toContain('minimum');
    expect(result).toContain('cron');
  });

  it('create_schedule rejects invalid arguments', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await expect(
      createSchedule({ prompt: ' ', cadence: { kind: 'interval', everyMinutes: 5 } }, deps(ops)),
    ).rejects.toThrow('prompt must be a non-empty string');
    await expect(
      createSchedule({ prompt: 'p', cadence: { kind: 'interval', everyMinutes: 0 } }, deps(ops)),
    ).rejects.toThrow('everyMinutes');
    await expect(
      createSchedule({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * *' } }, deps(ops)),
    ).rejects.toThrow('five fields');
    await expect(
      createSchedule(
        { prompt: 'p', cadence: { kind: 'interval', everyMinutes: 5 }, maxRuns: 0 },
        deps(ops),
      ),
    ).rejects.toThrow('maxRuns');
    expect(ops).toEqual([]);
  });

  it('list_schedules formats the daemon list', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await listSchedules(deps(ops));
    expect(ops).toEqual([{ name: 'listAgentSchedules', input: { roomId: 'room-1' } }]);
    expect(result).toContain('sched-1');
    expect(result).toContain('every 1 minute(s)');
    expect(result).toContain('(2/5 runs)');
    expect(result).toContain('message hello');
    expect(
      await listSchedules({
        roomId: 'room-1',
        execute: async () => ({ schedules: [] }),
      }),
    ).toBe('No schedules in this Room.');
  });

  it('delete_schedule calls deleteAgentSchedule scoped to this Room', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await deleteSchedule({ scheduleId: 'sched-1' }, deps(ops));
    expect(ops).toEqual([
      { name: 'deleteAgentSchedule', input: { roomId: 'room-1', scheduleId: 'sched-1' } },
    ]);
    expect(result).toBe('Schedule sched-1 deleted.');
  });
});
