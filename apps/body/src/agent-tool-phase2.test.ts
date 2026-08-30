import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { KIND_CHANNEL_MEMBERS } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { AcpClient } from './acp.js';
import { Body } from './body.js';
import { mediaUploadResponse, relayQueryResponse } from './relay-test-helper.js';
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
    schema_version: 3,
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
  it('opens, works, delivers, and closes a repo-less corner without Git semantics', async () => {
    const agent = newIdentity('repoless-corner-agent');
    const body = new Body(config(), undefined, agent);
    const workspace = await mkdtemp(resolve(tmpdir(), 'beeline-repoless-corner-'));
    const request = {
      eventId: 'c'.repeat(64),
      authorPubkey: newIdentity('repoless-corner-human').publicKey,
      content: 'Prepare the launch brief artifact.',
      createdAt: 1,
    };
    Reflect.get(body, 'pendingRoomTurns').set('room', {
      request,
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    });
    Reflect.get(body, 'activePermissionTurns').set('room', { requestId: request.eventId });
    vi.spyOn(body as never, 'requesterCanOpenCornerDirectly' as never).mockResolvedValue(
      true as never,
    );
    vi.spyOn(body as never, 'currentAgentToolMandate' as never).mockImplementation(
      async (_workspaceId: string, _roomId: string, requestedScope?: unknown) => {
        const current = mandate();
        return requestedScope && (requestedScope as { type?: string }).type === 'corner.close'
          ? {
              ...current,
              grants: [
                {
                  action: 'corner.close',
                  scope: requestedScope,
                  source: 'signed-grant',
                  event_id: 'b'.repeat(64),
                },
              ],
            }
          : current;
      },
    );
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const artifactPath = resolve(workspace, 'launch-brief.md');
    const open = vi.spyOn(body, 'openSubchannel').mockImplementation(async (...args) => {
      expect(args[1]).toBeUndefined();
      await writeFile(artifactPath, '# Launch brief\n');
      const info = {
        subchannelId: 'repoless-corner',
        worktreePath: workspace,
        role: body.agent,
        session: {
          channelId: 'repoless-corner',
          parentChannelId: 'room',
          sessionId: 'session',
          client: editClient,
          mode: 'edit',
          cwd: workspace,
        },
        lastPolledAt: 1,
        archived: false,
        request,
      };
      body.registerSession(info.session as never);
      body.registerSubchannel(info as never);
      return info as never;
    });
    vi.spyOn(body as never, 'startAgentTask' as never).mockImplementation(() => undefined as never);
    const archive = vi
      .spyOn(body, 'archiveSubchannel')
      .mockImplementation(async () => undefined as never);
    const membership = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 1,
        kind: KIND_CHANNEL_MEMBERS,
        tags: [
          ['d', 'repoless-corner'],
          ['p', agent.publicKey, '', 'member'],
        ],
        content: '',
      },
      agent.secretKey,
    );
    const published: NostrEvent[] = [membership];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const query = relayQueryResponse(published, input, init);
        if (query) return query;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        if (init?.body && typeof init.body === 'string') {
          published.push(JSON.parse(init.body) as NostrEvent);
        }
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const result = await Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'room', roomId: 'room', workspaceId: 'workspace' },
        'open_corner',
        { objective: request.content },
      );
    expect(result).toEqual({
      status: 'executed',
      event_id: expect.any(String),
      result: { corner_id: 'repoless-corner' },
    });
    expect(open).toHaveBeenCalledOnce();

    Reflect.get(body, 'activePermissionTurns').set('repoless-corner', {
      requestId: 'd'.repeat(64),
    });
    const delivered = await Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'repoless-corner', roomId: 'room', workspaceId: 'workspace' },
        'deliver',
        { path: 'launch-brief.md', audience: 'current_corner' },
      );
    expect(delivered).toEqual({
      status: 'executed',
      event_id: expect.any(String),
      result: expect.objectContaining({ name: 'launch-brief.md' }),
    });

    await expect(
      Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'repoless-corner', roomId: 'room', workspaceId: 'workspace' },
        'close_corner',
        { corner_id: 'repoless-corner', disposition: 'land' },
      ),
    ).resolves.toMatchObject({
      status: 'denied',
      code: 'landing_unavailable',
      message: expect.stringContaining('no repository or feature branch'),
    });
    await expect(
      Reflect.get(body, 'invokeAgentTool').call(
        body,
        { channelId: 'repoless-corner', roomId: 'room', workspaceId: 'workspace' },
        'close_corner',
        { corner_id: 'repoless-corner', disposition: 'abandon' },
      ),
    ).resolves.toMatchObject({
      status: 'executed',
      result: { corner_id: 'repoless-corner', disposition: 'abandon', state: 'closed' },
    });
    expect(archive).toHaveBeenCalledWith('repoless-corner');
    await rm(workspace, { recursive: true, force: true });
  });

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
