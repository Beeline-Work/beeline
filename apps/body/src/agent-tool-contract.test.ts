import { describe, expect, it } from 'vitest';
import {
  BEELINE_AGENT_TOOL_DEFINITIONS,
  BEELINE_AGENT_TOOL_NAMES,
  BEELINE_MANDATE_DEFAULTS,
  BEELINE_SCHEDULE_OPERATIONS,
  cornerFrozenForPendingClose,
} from './agent-tool-contract.js';

describe('Beeline agent tool contract', () => {
  it('advertises the locked verbs, corner truth reads, and both artifact input modes', () => {
    expect(BEELINE_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(
      BEELINE_AGENT_TOOL_NAMES,
    );
    const deliver = BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'deliver');
    expect(deliver?.inputSchema).toMatchObject({ oneOf: expect.any(Array) });
    expect(deliver?.inputSchema.oneOf as unknown[]).toHaveLength(2);
    expect(BEELINE_AGENT_TOOL_NAMES).toEqual([
      'read_mandate',
      'read_corner',
      'list_corners',
      'request_mandate',
      'open_corner',
      'close_corner',
      'schedule',
      'deliver',
    ]);
    expect(BEELINE_SCHEDULE_OPERATIONS).toEqual([
      'create',
      'list',
      'get',
      'update',
      'pause',
      'resume',
      'cancel',
      'run_now',
    ]);
  });

  it('enumerates every known action default and leaves no wildcard schedule grant', () => {
    expect(BEELINE_MANDATE_DEFAULTS.map((entry) => entry.action)).toEqual([
      'corner.open',
      'corner.close',
      'schedule.create',
      'schedule.list',
      'schedule.get',
      'schedule.update',
      'schedule.pause',
      'schedule.resume',
      'schedule.cancel',
      'schedule.run_now',
      'artifact.deliver',
    ]);
    expect(BEELINE_MANDATE_DEFAULTS.find((entry) => entry.action === 'corner.close')?.effect).toBe(
      'approval_required',
    );
    expect(BEELINE_MANDATE_DEFAULTS.find((entry) => entry.action === 'corner.open')?.effect).toBe(
      'approval_required',
    );
    expect(
      BEELINE_MANDATE_DEFAULTS.filter((entry) => entry.action.startsWith('schedule.')).every(
        (entry) => entry.effect === 'allow',
      ),
    ).toBe(true);
  });

  it('publishes closed typed schemas for mandate scopes and scheduled operations', () => {
    const request = BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'request_mandate')!;
    const requestProperties = request.inputSchema.properties as Record<string, unknown>;
    expect(requestProperties.scope).toMatchObject({ oneOf: expect.any(Array) });
    expect((requestProperties.scope as { oneOf: unknown[] }).oneOf).toHaveLength(11);

    const schedule = BEELINE_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'schedule')!;
    const scheduleProperties = schedule.inputSchema.properties as Record<string, unknown>;
    const configuration = scheduleProperties.schedule as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(configuration.required).toContain('operation');
    expect(configuration.properties.operation).toMatchObject({
      required: ['type', 'prompt'],
      properties: { type: { const: 'agent_turn' } },
      additionalProperties: false,
    });
    expect(configuration.properties.cadence).toMatchObject({ oneOf: expect.any(Array) });
    expect((configuration.properties.cadence as { oneOf: unknown[] }).oneOf).toHaveLength(3);
  });

  it('freezes the exact pending close until a verified approval advances it', () => {
    const pending = {
      turnId: 'turn',
      sourceSha: 'a'.repeat(40),
      targetRef: 'refs/heads/main',
      requestId: 'request',
      eventId: 'event',
    };
    expect(cornerFrozenForPendingClose({ pending })).toBe(true);
    expect(cornerFrozenForPendingClose({ pending, approved: true })).toBe(false);
    expect(cornerFrozenForPendingClose({})).toBe(false);
  });
});
