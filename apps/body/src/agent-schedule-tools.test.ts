import { describe, expect, it } from 'vitest';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
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
              agentId: 'agent-2',
              agentHandle: 'rival',
              prompt: 'message hello',
              cadence: { kind: 'interval', everyMinutes: 1 },
              maxRuns: 5,
              runCount: 2,
              nextRunAt: 1_800_000_000,
            },
          ],
        };
      }
      if (name === 'updateAgentSchedule') {
        return { scheduleId: 'sched-1', nextRunAt: 1_800_000_000 };
      }
      return { id: 'w', createdAt: 1 };
    },
  };
}

describe('beeline-agent schedule tools', () => {
  it('carries the workflow target through create/update and exposes its owner and active IDs', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await createSchedule(
      { prompt: 'Scan', workflowName: 'daily', cadence: { kind: 'interval', everyMinutes: 1 } },
      deps(ops),
    );
    await updateSchedule({ scheduleId: 'sched-1', workflowName: 'daily' }, deps(ops));
    expect(ops.map((op) => op.input.workflowName)).toEqual(['daily', 'daily']);
    const activeRunId = 'b'.repeat(64);
    const listed = await listSchedules({
      roomId: 'room-1',
      execute: async () => ({
        schedules: [
          {
            scheduleId: 'sched-1',
            agentId: 'agent-1',
            prompt: 'Scan',
            cadence: { kind: 'interval', everyMinutes: 1 },
            workflowName: 'daily',
            owner: { id: 'agent-1', name: 'Scanner' },
            activeRunIds: [activeRunId],
          },
        ],
      }),
    });
    expect(listed).toContain('Owner Scanner');
    expect(listed).toContain(`Active run IDs: ${activeRunId}`);
  });

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
    expect(result).toContain('sched-1 (@rival)');
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

  it('update_schedule sends only the fields given, scoped to this Room', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await updateSchedule(
      {
        scheduleId: 'sched-1',
        prompt: ' Summarize. ',
        cadence: { kind: 'interval', everyMinutes: 60 },
      },
      deps(ops),
    );
    expect(ops).toEqual([
      {
        name: 'updateAgentSchedule',
        input: {
          roomId: 'room-1',
          scheduleId: 'sched-1',
          prompt: 'Summarize.',
          cadence: { kind: 'interval', everyMinutes: 60 },
        },
      },
    ]);
    expect(result).toBe('Schedule sched-1 updated. Next run 2027-01-15T08:00:00.000Z.');
    await expect(updateSchedule({ scheduleId: 'sched-1' }, deps(ops))).rejects.toThrow(
      'give a prompt, cadence, or maxRuns to change',
    );
    await expect(updateSchedule({ scheduleId: 'sched-1', maxRuns: 0 }, deps(ops))).rejects.toThrow(
      'maxRuns',
    );
    expect(ops).toHaveLength(1);
  });
});
