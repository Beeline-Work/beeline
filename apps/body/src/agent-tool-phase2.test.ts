import { afterEach, describe, expect, it, vi } from 'vitest';
import { newIdentity } from '@beeline/gate';
import { Body } from './body.js';
import {
  BEELINE_MANDATE_DEFAULTS,
  BEELINE_MANDATE_DEFAULTS_VERSION,
  type ReadMandateResult,
} from './agent-tool-contract.js';

function config() {
  return {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot: '/tmp/beeline-agent-tool-phase2',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http' as const,
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: false,
  };
}

function mandate(): ReadMandateResult {
  return {
    schema_version: 2,
    generation: { event_id: 'a'.repeat(64), generation: 42 },
    grants: [],
    defaults: BEELINE_MANDATE_DEFAULTS.map((entry) => ({ ...entry })),
    blockers: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Phase 2 agent tools', () => {
  it('defaults request_mandate beneficiary to the authenticated caller and reserves granted', async () => {
    const agent = newIdentity('phase2-mandate-agent');
    const body = new Body(config(), undefined, agent);
    vi.spyOn(body as never, 'currentAgentToolMandate' as never).mockResolvedValue(
      mandate() as never,
    );
    Reflect.get(body, 'activePermissionTurns').set('room', { requestId: 'turn' });

    await expect(
      Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'room', roomId: 'room', workspaceId: 'room' },
        'request_mandate',
        {
          action: 'schedule.list',
          scope: { type: 'schedule.list' },
        },
      ),
    ).resolves.toEqual({
      status: 'granted',
      event_id: 'a'.repeat(64),
      generation: { event_id: 'a'.repeat(64), generation: 42 },
      beneficiary: agent.publicKey,
      action: 'schedule.list',
      scope: {
        type: 'schedule.list',
        workspaceId: 'room',
        roomId: 'room',
      },
    });
  });

  it('rejects mismatched or cross-session mandate scope structurally', async () => {
    const body = new Body(config(), undefined, newIdentity('phase2-scope-agent'));
    const invoke = (scope: Record<string, unknown>) =>
      Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'room', roomId: 'room', workspaceId: 'workspace' },
        'request_mandate',
        { action: 'schedule.list', scope },
      );
    await expect(invoke({ type: 'schedule.get' })).resolves.toMatchObject({
      status: 'failed',
      code: 'scope_action_mismatch',
    });
    await expect(
      invoke({ type: 'schedule.list', workspaceId: 'other-workspace' }),
    ).resolves.toMatchObject({ status: 'failed', code: 'invalid_arguments' });
  });

  it('creates a canonical model-turn schedule on the existing calendar wire format', async () => {
    const agent = newIdentity('phase2-schedule-agent');
    const body = new Body(config(), undefined, agent);
    vi.spyOn(body as never, 'currentAgentToolMandate' as never).mockResolvedValue(
      mandate() as never,
    );
    vi.spyOn(body as never, 'agentToolSchedules' as never).mockResolvedValue([] as never);
    vi.spyOn(body as never, 'agentToolScheduleIds' as never).mockResolvedValue([] as never);
    const publishIndex = vi
      .spyOn(body as never, 'publishAgentToolScheduleIndex' as never)
      .mockResolvedValue({ id: 'b'.repeat(64) } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );
    Reflect.get(body, 'activePermissionTurns').set('room', { requestId: 'turn' });

    const result = await Reflect.get(body, 'invokeAgentTool').call(
      body,
      { channelId: 'room', roomId: 'room', workspaceId: 'room' },
      'schedule',
      {
        operation: 'create',
        schedule_id: 'daily-triage',
        schedule: {
          operation: { type: 'agent_turn', prompt: 'Prepare the daily triage.' },
          cadence: { type: 'daily', local_time: '09:00', timezone: 'UTC' },
          expires_at: 2_000_000_000,
          max_runs: 20,
          per_run_reserved_tokens: 100,
          daily_reserved_tokens: 1_000,
          catch_up: 'latest_one',
          max_consecutive_failures: 3,
        },
      },
    );
    expect(result).toMatchObject({
      status: 'executed',
      event_id: expect.stringMatching(/^[0-9a-f]{64}$/),
      result: { schedule_id: 'daily-triage', revision: 1, status: 'active' },
    });
    expect(publishIndex).toHaveBeenCalledWith('room', ['daily-triage']);
    expect(
      BEELINE_MANDATE_DEFAULTS.find((entry) => entry.action === 'schedule.create')?.version,
    ).toBe(BEELINE_MANDATE_DEFAULTS_VERSION);
  });
});
