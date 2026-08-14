/**
 * Hermetic unit tests for body modules.
 * These tests do NOT require a relay or LLM endpoint.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasWriteTools, inventoryForMcpServers } from './mcp-inventory.js';
import { parseEnvFile, hasLlmCredentials } from './config.js';
import {
  AGENT_REQUEST_TAG,
  assertSubchannelArchiveTarget,
  Body,
  cornerNameForIntent,
  isChannelAddressedMessage,
  isChannelTaskRequest,
  isChannelWorkIntent,
  isReadOnlyInformationRequest,
  ReadOnlyToolsUnavailableError,
  readOnlyMcpServer,
} from './body.js';
import { AcpClient, isMutatingPermissionRequest } from './acp.js';
import { newIdentity } from '@beeline/gate';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  postAgentMessage,
  postAgentPresence,
  startAgentPresence,
  stripAgentReplyPreamble,
} from './activity.js';
import { isReadOnlyMcpPermissionRequest } from './read-only-policy.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mcp-inventory', () => {
  it('hasWriteTools returns false for empty list', () => {
    expect(hasWriteTools([])).toBe(false);
  });

  it('hasWriteTools detects write tools by name', () => {
    expect(hasWriteTools(['read_file', 'view_image'])).toBe(false);
    expect(hasWriteTools(['shell'])).toBe(true);
    expect(hasWriteTools(['str_replace'])).toBe(true);
    expect(hasWriteTools(['write'])).toBe(true);
  });

  it('inventoryForMcpServers returns empty for no servers', async () => {
    const tools = await inventoryForMcpServers([]);
    expect(tools).toEqual([]);
  });

  it('binds the read-only MCP to the exact paired checkout', () => {
    expect(
      readOnlyMcpServer(
        {
          agentBinary: '/agent',
          mcpBinary: '/buzz-dev-mcp',
          readonlyMcpCommand: '/buzz-readonly-mcp',
          readonlyMcpArgs: ['--fixed-entrypoint'],
          agentEnv: {},
          workspaceRoot: '/workspace',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        '/paired/repository',
      ),
    ).toEqual({
      name: 'buzz-readonly-mcp',
      command: '/buzz-readonly-mcp',
      args: ['--fixed-entrypoint'],
      env: [{ name: 'BUZZ_READONLY_ROOT', value: '/paired/repository' }],
    });
  });

  it('refuses to construct a Room server when read-only tools are unavailable', () => {
    expect(() =>
      readOnlyMcpServer(
        {
          agentBinary: '/agent',
          mcpBinary: '/buzz-dev-mcp',
          agentEnv: {},
          workspaceRoot: '/workspace',
          relayBaseUrl: 'http://relay.test',
          relayHost: 'relay.test',
          relayScheme: 'http',
          relayWsUrl: 'ws://relay.test',
          autoApprovePermissions: true,
        },
        '/paired/repository',
      ),
    ).toThrow('read-only tools unavailable');
  });
});

describe('config', () => {
  it('parseEnvFile handles basic key=value', () => {
    const result = parseEnvFile('/nonexistent');
    expect(result).toEqual({});
  });

  it('hasLlmCredentials detects openai setup', () => {
    expect(hasLlmCredentials({})).toBe(false);
    expect(
      hasLlmCredentials({
        OPENAI_COMPAT_API_KEY: 'sk-test',
        OPENAI_COMPAT_MODEL: 'gpt-4',
      }),
    ).toBe(true);
  });
});

describe('acp', () => {
  it('AcpClient must be started before use', async () => {
    const { AcpClient } = await import('./acp.js');
    const client = new AcpClient({
      agentBinary: '/nonexistent',
      agentEnv: {},
    });
    await expect(client.sessionNew({ cwd: '/tmp' })).rejects.toThrow('AcpClient not started');
  });

  it('classifies edit, write, and shell permissions without treating reads as writes', () => {
    expect(isMutatingPermissionRequest({ toolCall: { kind: 'edit', title: 'str_replace' } })).toBe(
      true,
    );
    expect(isMutatingPermissionRequest({ toolCall: { kind: 'execute', title: 'Run shell' } })).toBe(
      true,
    );
    expect(
      isMutatingPermissionRequest({ toolCall: { kind: 'read', title: 'Read package.json' } }),
    ).toBe(false);
  });

  it('recognizes only exact host-marked read-only MCP approvals', () => {
    expect(
      isReadOnlyMcpPermissionRequest({
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          kind: 'execute',
          title: 'mcp.buzz-readonly-mcp.read_file',
          rawInput: { server: 'buzz-readonly-mcp', tool: 'read_file', arguments: {} },
        },
      }),
    ).toBe(true);
    expect(
      isReadOnlyMcpPermissionRequest({
        toolCall: {
          kind: 'execute',
          title: 'mcp.buzz-readonly-mcp.read_file',
          rawInput: { server: 'buzz-readonly-mcp', tool: 'read_file', arguments: {} },
        },
      }),
    ).toBe(false);
    expect(
      isReadOnlyMcpPermissionRequest({
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          kind: 'execute',
          title: 'mcp.buzz-readonly-mcp.shell',
          rawInput: { server: 'buzz-readonly-mcp', tool: 'shell', arguments: {} },
        },
      }),
    ).toBe(false);
  });
});

describe('agent identity boundary', () => {
  const config = {
    agentBinary: '/nonexistent',
    mcpBinary: '/nonexistent',
    agentEnv: {},
    workspaceRoot: '/tmp/buzzy-body-unit',
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
  };

  it('always assigns the agent a key distinct from the operator', () => {
    const body = new Body(config, newIdentity('operator'));
    expect(body.agent.publicKey).not.toBe(body.identity.publicKey);
  });

  it('refuses to collapse the agent onto the operator identity', () => {
    const operator = newIdentity('operator');
    const body = new Body(config, operator);
    expect(() => body.setAgentIdentity(operator)).toThrow('must be distinct');
  });

  it('mounts only buzz-readonly-mcp when provisioning a Room', async () => {
    const body = new Body({
      ...config,
      readonlyMcpCommand: '/buzz-readonly-mcp',
      readonlyMcpArgs: ['--fixed-entrypoint'],
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const session = {
      channelId: 'room-id',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly' as const,
    };
    vi.spyOn(body as never, 'ensureAgentInChannel' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'ensureAgentEntity' as never).mockResolvedValue(undefined as never);
    vi.spyOn(body as never, 'channelCommunityId' as never).mockResolvedValue(null as never);
    const create = vi
      .spyOn(body as never, 'createManagedSession' as never)
      .mockResolvedValue(session as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    await expect(
      body.provision('room-id', { repo: 'repo', localPath: '/paired/repo' }),
    ).resolves.toBe(session);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'room-id',
        mode: 'readonly',
        autoApprovePermissions: false,
        mcpServers: [
          {
            name: 'buzz-readonly-mcp',
            command: '/buzz-readonly-mcp',
            args: ['--fixed-entrypoint'],
            env: [{ name: 'BUZZ_READONLY_ROOT', value: '/paired/repo' }],
          },
        ],
      }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain('buzz-dev-mcp');
  });

  it('fails a research Room closed when buzz-readonly-mcp is unresolved', async () => {
    const body = new Body({ ...config, workspaceRoot: '/tmp/buzzy-readonly-unavailable-unit' });
    const open = vi.spyOn(body, 'openSubchannel');
    const create = vi.spyOn(body as never, 'createManagedSession' as never);
    const durableState = Reflect.get(body, 'durableState') as {
      appendConversation: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(durableState, 'appendConversation').mockResolvedValue();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'research-room',
        { repo: 'repo' },
        {
          eventId: 'research-request',
          authorPubkey: body.identity.publicKey,
          content: 'Research how session scheduling works.',
          createdAt: 1,
        },
      ),
    ).resolves.toBe(false);

    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(body.listSessions()).toEqual([]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      content: expect.stringContaining('Read-only tools unavailable'),
    });
    expect(published[0]!.tags).toContainEqual(['t', 'agent-message']);
  });

  it('never reuses an edit session as a read-only Room session', async () => {
    const body = new Body({ ...config, readonlyMcpCommand: '/buzz-readonly-mcp' });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    body.registerSession({
      channelId: 'room-id',
      sessionId: 'edit-session',
      client,
      mode: 'edit',
    });
    const open = vi.spyOn(body, 'openSubchannel');
    const prompt = vi.spyOn(client, 'sessionPrompt');
    const durableState = Reflect.get(body, 'durableState') as {
      appendConversation: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(durableState, 'appendConversation').mockResolvedValue();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(body.provision('room-id')).rejects.toBeInstanceOf(ReadOnlyToolsUnavailableError);
    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'room-id',
        { repo: 'repo' },
        {
          eventId: 'research-request',
          authorPubkey: body.identity.publicKey,
          content: 'Explain how the scheduler works.',
          createdAt: 1,
        },
      ),
    ).resolves.toBe(false);

    expect(prompt).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toContain('Read-only tools unavailable');
  });

  it('NIP-98-authenticates repository safety reads as the agent', async () => {
    const operator = newIdentity('operator');
    const agent = newIdentity('agent');
    const roomId = '11111111-1111-4111-8111-111111111111';
    const authEvents: NostrEvent[] = [];
    const projection = (kind: number, members: string[]): NostrEvent =>
      signEvent(
        {
          pubkey: operator.publicKey,
          created_at: 1_700_000_000,
          kind,
          tags: [['d', roomId], ...members.map((pubkey) => ['p', pubkey])],
          content: '',
        },
        operator.secretKey,
      );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization');
        if (!authorization?.startsWith('Nostr ')) {
          return new Response(JSON.stringify({ error: 'missing Nostr auth' }), { status: 401 });
        }
        const authEvent = JSON.parse(
          Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8'),
        ) as NostrEvent;
        authEvents.push(authEvent);
        expect(verifyEvent(authEvent)).toBe(true);
        expect(authEvent.pubkey).toBe(agent.publicKey);
        expect(authEvent.tags).toContainEqual(['u', String(input)]);
        expect(authEvent.tags).toContainEqual(['method', 'POST']);

        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        const events = kind === 39002 ? [projection(39002, [agent.publicKey])] : [];
        return new Response(JSON.stringify(events), { status: 200 });
      }),
    );

    const body = new Body(config, operator, agent);
    await expect(
      body.assertRepositorySafety(roomId, { repo: 'local-repo', localOnly: true }),
    ).resolves.toBeUndefined();
    expect(authEvents.length).toBeGreaterThanOrEqual(2);
  });
});

describe('agent presence', () => {
  it('publishes signed online and offline markers as replaceable Room records', async () => {
    const agent = newIdentity('presence-agent');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await postAgentPresence('presence-room', agent, 'online');
    await postAgentPresence('presence-room', agent, 'offline');

    expect(published).toHaveLength(2);
    expect(published.map((event) => event.kind)).toEqual([30078, 30078]);
    expect(published.map((event) => verifyEvent(event))).toEqual([true, true]);
    expect(published[0]!.tags).toEqual(
      expect.arrayContaining([
        ['h', 'presence-room'],
        ['d', 'agent-presence:presence-room'],
        ['t', 'agent-presence'],
        ['agent', agent.publicKey],
        ['status', 'online'],
      ]),
    );
    expect(published[1]!.tags).toContainEqual(['status', 'offline']);
  });

  it('heartbeats periodically and marks a clean stop offline', async () => {
    vi.useFakeTimers();
    const agent = newIdentity('heartbeat-agent');
    const statuses: string[] = [];
    const generations: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        statuses.push(event.tags.find((tag) => tag[0] === 'status')?.[1] ?? '');
        generations.push(event.tags.find((tag) => tag[0] === 'generation')?.[1] ?? '');
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    const stop = startAgentPresence('presence-room', agent, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await stop();

    expect(statuses).toEqual(['online', 'online', 'offline']);
    expect(new Set(generations)).toEqual(new Set([stop.generationId]));
    vi.useRealTimers();
  });
});

describe('corner archive boundary', () => {
  const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
  const role = newIdentity('corner-owner');

  function info(options: { channelId?: string; parentChannelId?: string } = {}) {
    return {
      subchannelId: 'corner',
      worktreePath: '/tmp/corner',
      featureBranch: 'feature/corner',
      role,
      session: {
        channelId: options.channelId ?? 'corner',
        sessionId: 'session',
        client,
        mode: 'edit' as const,
        ...(options.parentChannelId ? { parentChannelId: options.parentChannelId } : {}),
      },
      lastPolledAt: 0,
      archived: false,
    };
  }

  it('accepts only the exact relay-linked corner identity', () => {
    expect(() =>
      assertSubchannelArchiveTarget(info({ parentChannelId: 'room' }), 'room'),
    ).not.toThrow();
  });

  it('refuses top-level Rooms and mismatched session identities', () => {
    expect(() => assertSubchannelArchiveTarget(info(), null)).toThrow('non-corner');
    expect(() =>
      assertSubchannelArchiveTarget(info({ channelId: 'room', parentChannelId: 'room' }), 'room'),
    ).toThrow('non-corner');
    expect(() =>
      assertSubchannelArchiveTarget(info({ parentChannelId: 'room' }), 'other-room'),
    ).toThrow('non-corner');
  });
});

describe('Room conversation and permission-gated work intent', () => {
  const human = newIdentity('human');
  const agent = newIdentity('agent');

  function requestEvent(
    tags: string[][],
    author = human,
    content = 'Implement the channel request',
  ) {
    return signEvent(
      {
        pubkey: author.publicKey,
        created_at: 1,
        kind: 9,
        tags: [['h', 'parent-channel'], ...tags],
        content,
      },
      author.secretKey,
    );
  }

  it('replies to an @-addressed ordinary message without authorizing work', () => {
    const event = requestEvent([['p', agent.publicKey]]);
    expect(isChannelAddressedMessage(event, agent.publicKey)).toBe(true);
    expect(isChannelWorkIntent(event, agent.publicKey)).toBe(false);
    expect(isChannelTaskRequest(event, agent.publicKey)).toBe(false);
  });

  it('replies conversationally in a two-party Room without opening work', () => {
    const event = requestEvent([]);
    const participants = [human.publicKey, agent.publicKey];
    expect(isChannelAddressedMessage(event, agent.publicKey, participants)).toBe(true);
    expect(isChannelWorkIntent(event, agent.publicKey, participants)).toBe(false);
  });

  it.each([
    'open a new corner to do work: add a FEATURE.md',
    'open a corner and implement the retry',
    'start work on the retry in a corner',
    'Could you create a new corner for this change?',
  ])('recognizes an explicit corner command: %s', (content) => {
    const participants = [human.publicKey, agent.publicKey];
    expect(
      isChannelWorkIntent(requestEvent([], human, content), agent.publicKey, participants),
    ).toBe(true);
  });

  it.each([
    'Create FEATURE.md and commit it.',
    'Can you implement the retry?',
    'What happens when an agent opens a corner?',
    'Should we open a corner for this?',
    "Don't open a corner; just explain the change.",
    'Tell me about the active corner.',
  ])('keeps vague or conversational intent in the Room: %s', (content) => {
    const participants = [human.publicKey, agent.publicKey];
    expect(
      isChannelWorkIntent(requestEvent([], human, content), agent.publicKey, participants),
    ).toBe(false);
  });

  it.each([
    'analyze this repository and tell me its principal user stories',
    'Explain what the session scheduler does.',
    'summarize the authentication flow',
    'What does isChannelWorkIntent do?',
    'Find where merge approval is verified.',
    'In one sentence, what is the purpose of a repository Room?',
    "I'd like you to explain how corners work.",
  ])('locks a pure information request to read-only Room analysis: %s', (content) => {
    expect(isReadOnlyInformationRequest(content)).toBe(true);
  });

  it.each([
    'Analyze the scheduler, then fix it.',
    'Explain this and implement the change.',
    'Find and replace the old API.',
    'Review this code and commit any fixes.',
    'Fix the scheduler and explain why it was broken.',
    'Analyze the scheduler. Fix the race.',
  ])('does not misclassify a mixed write request as information-only: %s', (content) => {
    expect(isReadOnlyInformationRequest(content)).toBe(false);
  });

  it('requires @-addressing when multiple people or agents share the Room', () => {
    const colleague = newIdentity('colleague');
    const otherAgent = newIdentity('other-agent');
    const participants = [
      human.publicKey,
      colleague.publicKey,
      agent.publicKey,
      otherAgent.publicKey,
    ];
    expect(isChannelAddressedMessage(requestEvent([]), agent.publicKey, participants)).toBe(false);
    expect(
      isChannelAddressedMessage(
        requestEvent([['p', agent.publicKey]]),
        agent.publicKey,
        participants,
      ),
    ).toBe(true);
    expect(
      isChannelAddressedMessage(
        requestEvent([['p', agent.publicKey]]),
        otherAgent.publicKey,
        participants,
      ),
    ).toBe(false);
  });

  it('retires the signed Start work marker as an edit authorization', () => {
    const participants = [human.publicKey, agent.publicKey];
    const work = requestEvent([['t', AGENT_REQUEST_TAG]]);
    expect(isChannelAddressedMessage(work, agent.publicKey, participants)).toBe(true);
    expect(isChannelWorkIntent(work, agent.publicKey, participants)).toBe(false);
  });

  it('never accepts the agent tasking itself', () => {
    expect(
      isChannelAddressedMessage(requestEvent([['p', agent.publicKey]], agent), agent.publicKey, [
        human.publicKey,
        agent.publicKey,
      ]),
    ).toBe(false);
  });

  it('uses the read-only Room session and publishes one durable assistant message', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-room-reply-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const prompt = vi.spyOn(client, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText:
        'Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill by reading its SKILL.md.\n\nDoing well. What are you thinking about?',
      toolCalls: [],
    });
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    const durableState = Reflect.get(body, 'durableState') as {
      appendConversation: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(durableState, 'appendConversation').mockResolvedValue();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const event = requestEvent([['p', body.agent.publicKey]]);

    await Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: event.id,
        authorPubkey: event.pubkey,
        content: "Hey, what's up?",
        createdAt: event.created_at,
      },
    );

    expect(prompt).toHaveBeenCalledWith(
      'readonly-session',
      expect.stringContaining("Hey, what's up?"),
      600_000,
    );
    expect(body.listSessions()).toHaveLength(1);
    expect(published).toHaveLength(3);
    expect(published[0]).toMatchObject({
      kind: 9,
      content: expect.stringContaining('thinking'),
    });
    expect(published[0]!.tags).toContainEqual(['t', 'agent-turn']);
    expect(published[0]!.tags).toContainEqual(['status', 'working']);
    expect(published[1]).toMatchObject({
      kind: 9,
      content: 'Doing well. What are you thinking about?',
    });
    expect(published[1]!.tags).toContainEqual(['h', 'parent-channel']);
    expect(published[1]!.tags).toContainEqual(['t', 'agent-message']);
    expect(published[2]!.tags).toContainEqual(['t', 'agent-turn']);
    expect(published[2]!.tags).toContainEqual(['status', 'complete']);

    prompt.mockResolvedValueOnce({
      stopReason: 'end_turn',
      updates: [],
      agentText: '',
      toolCalls: [],
    });
    await Reflect.get(body, 'replyInRoom').call(
      body,
      'parent-channel',
      { repo: 'repo' },
      {
        eventId: 'empty-research-result',
        authorPubkey: event.pubkey,
        content: 'Research the repository and report any findings.',
        createdAt: event.created_at + 1,
      },
    );

    expect(
      published.slice(-3).map((item) => item.tags.find((tag) => tag[0] === 'status')?.[1]),
    ).toEqual(['working', undefined, 'complete']);
    expect(published.at(-2)?.content).toBe('No repository findings to report.');

    prompt.mockRejectedValueOnce(new Error('prompt cancelled'));
    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        {
          eventId: 'cancelled-research-result',
          authorPubkey: event.pubkey,
          content: 'Research this, but cancel the turn.',
          createdAt: event.created_at + 2,
        },
      ),
    ).rejects.toThrow('prompt cancelled');
    expect(
      published.slice(-2).map((item) => item.tags.find((tag) => tag[0] === 'status')?.[1]),
    ).toEqual(['working', 'failed']);
  });

  it('opens explicitly authorized corner work without prompting the read-only session', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-explicit-corner-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const prompt = vi.spyOn(client, 'sessionPrompt');
    body.registerSession({
      channelId: 'parent-channel',
      sessionId: 'readonly-session',
      client,
      mode: 'readonly',
    });
    const durableState = Reflect.get(body, 'durableState') as {
      appendConversation: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(durableState, 'appendConversation').mockResolvedValue();
    const request = {
      eventId: 'explicit-corner-request',
      authorPubkey: human.publicKey,
      content: 'open a new corner to do work: add a FEATURE.md',
      createdAt: 1,
    };
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'corner-id',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      session: {
        channelId: 'corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);

    await expect(
      Reflect.get(body, 'replyInRoom').call(
        body,
        'parent-channel',
        { repo: 'repo' },
        request,
        true,
      ),
    ).resolves.toBe(true);

    expect(open).toHaveBeenCalledWith('parent-channel', { repo: 'repo' }, request.content, request);
    expect(start).toHaveBeenCalledWith(info, request.content);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('opens an edit corner only after a human allows the first mutating request', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-room-permission-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const request = {
      eventId: 'human-request',
      authorPubkey: human.publicKey,
      content: 'Create a file and commit it.',
      createdAt: 1,
    };
    const turn = {
      request,
      boundRepo: { repo: 'repo' },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'allow' as never,
    );
    const editClient = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const info = {
      subchannelId: 'corner-id',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/corner',
      role: body.agent,
      session: {
        channelId: 'corner-id',
        sessionId: 'edit-session',
        client: editClient,
        mode: 'edit' as const,
      },
      lastPolledAt: 1,
      archived: false,
    };
    const open = vi.spyOn(body, 'openSubchannel').mockResolvedValue(info);
    const start = vi
      .spyOn(body as never, 'startAgentTask' as never)
      .mockImplementation(() => undefined as never);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        sessionId: 'readonly-session',
        toolCall: { kind: 'edit', title: 'str_replace README.md' },
      }),
    ).resolves.toBe('reject');

    expect(open).toHaveBeenCalledWith('parent-channel', { repo: 'repo' }, request.content, request);
    expect(start).toHaveBeenCalledWith(info, request.content);
    expect(turn.transitionedToCorner).toBe(true);
    expect(
      published.some(
        (event) =>
          event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'allowed') &&
          event.tags.some((tag) => tag[0] === 'subchannel' && tag[1] === 'corner-id'),
      ),
    ).toBe(true);
  });

  it('keeps the Room read-only when the human denies editing', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-room-deny-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const turn = {
      request: {
        eventId: 'human-request',
        authorPubkey: human.publicKey,
        content: 'Edit README.',
        createdAt: 1,
      },
      boundRepo: { repo: 'repo' },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: false,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    vi.spyOn(body as never, 'waitForWritePermissionDecision' as never).mockResolvedValue(
      'deny' as never,
    );
    const open = vi.spyOn(body, 'openSubchannel');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })),
    );

    await Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
      toolCall: { kind: 'execute', title: 'shell' },
    });

    expect(open).not.toHaveBeenCalled();
    expect(turn.transitionedToCorner).toBe(false);
  });

  it('refuses agent mutation escalation for research without posting ALLOW or opening a corner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buzzy-research-boundary-'));
    const source = join(root, 'README.md');
    await writeFile(source, '# Evidence\n');
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const turn = {
      request: {
        eventId: 'research-request',
        authorPubkey: human.publicKey,
        content: 'Analyze this repository and summarize its user stories.',
        createdAt: 1,
      },
      boundRepo: { repo: 'repo', localPath: root },
      permissionHandled: false,
      transitionedToCorner: false,
      readOnlyInformationRequest: true,
    };
    (Reflect.get(body, 'pendingRoomTurns') as Map<string, unknown>).set('parent-channel', turn);
    const open = vi.spyOn(body, 'openSubchannel');
    const publish = vi.fn();
    vi.stubGlobal('fetch', publish);

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        sessionId: 'readonly-session',
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          kind: 'execute',
          title: 'mcp.buzz-readonly-mcp.read_file',
          rawInput: {
            server: 'buzz-readonly-mcp',
            tool: 'read_file',
            arguments: { path: 'README.md' },
          },
        },
      }),
    ).resolves.toBe('allow');

    await expect(
      Reflect.get(body, 'handleRoomPermissionRequest').call(body, 'parent-channel', {
        sessionId: 'readonly-session',
        toolCall: { kind: 'execute', title: 'shell: echo mutation > README.md' },
      }),
    ).resolves.toBe('reject');

    expect(open).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(turn.permissionHandled).toBe(false);
    expect(turn.transitionedToCorner).toBe(false);
    expect(await readFile(source, 'utf8')).toBe('# Evidence\n');
    await rm(root, { recursive: true, force: true });
  });
});

describe('first-class assistant messages', () => {
  it('strips only a leading Codex skill-budget warning', () => {
    const warning =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill by reading its SKILL.md.';
    expect(stripAgentReplyPreamble(`\n${warning}\n\nThe real answer.`)).toBe('The real answer.');
    expect(stripAgentReplyPreamble(`The real answer.\n\n${warning}`)).toBe(
      `The real answer.\n\n${warning}`,
    );
    expect(stripAgentReplyPreamble('Warning: This API is deprecated.\nUse v2.')).toBe(
      'Warning: This API is deprecated.\nUse v2.',
    );
  });

  it('omits cross-channel reply linkage for corner outcomes', async () => {
    const agent = newIdentity('corner-agent-message');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await postAgentMessage('child-corner', agent, 'Completed the requested work.');

    expect(published[0]!.tags).toContainEqual(['h', 'child-corner']);
    expect(published[0]!.tags.some((tag) => tag[0] === 'e')).toBe(false);
  });

  it('publishes agent outputs as the shared link-only attachment format', async () => {
    const agent = newIdentity('agent-file-message');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await postAgentMessage('room-id', agent, 'Here it is.', undefined, [
      {
        url: 'https://relay.example/media/mushroom.png',
        thumbnailUrl: 'https://relay.example/media/mushroom-thumb.jpg',
        name: 'mushroom.png',
        mimeType: 'image/png',
        size: 12_000_000,
      },
    ]);

    const serialized = JSON.stringify(published[0]);
    expect(published[0]!.content).toBe('Here it is.');
    expect(published[0]!.tags).toContainEqual(['t', 'buzz-attachment']);
    expect(serialized).toContain('https://relay.example/media/mushroom.png');
    expect(serialized).not.toContain('base64');
    expect(serialized.length).toBeLessThan(2_000);
  });

  it('uploads an agent worktree file before publishing only its link metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'buzzy-agent-output-'));
    const fileBytes = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8" /></svg>';
    await writeFile(join(workspace, 'mushroom.svg'), fileBytes);
    const agent = newIdentity('agent-output-upload');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/upload')) {
          const hash = new Headers(init?.headers).get('X-SHA-256');
          return new Response(
            JSON.stringify({
              url: 'https://relay.example/media/mushroom.svg',
              sha256: hash,
              size: new TextEncoder().encode(fileBytes).byteLength,
              type: 'image/svg+xml',
              thumb: 'https://relay.example/media/mushroom-thumb.jpg',
            }),
            { status: 200 },
          );
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = new Body(
      {
        agentBinary: '/nonexistent',
        mcpBinary: '/nonexistent',
        agentEnv: {},
        workspaceRoot: workspace,
        relayBaseUrl: 'https://relay.example',
        relayHost: 'relay.example',
        relayScheme: 'https',
        relayWsUrl: 'wss://relay.example',
        autoApprovePermissions: true,
      },
      undefined,
      agent,
    );

    try {
      await Reflect.get(body, 'publishAgentResult').call(
        body,
        'room-id',
        { cwd: workspace },
        {
          agentText: 'Here it is. [[buzz-attachment:mushroom.svg]]',
          updates: [],
        },
        'Done.',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    const serialized = JSON.stringify(published[0]);
    expect(published[0]!.content).toBe('Here it is.');
    expect(serialized).toContain('https://relay.example/media/mushroom.svg');
    expect(serialized).toContain('https://relay.example/media/mushroom-thumb.jpg');
    expect(serialized).not.toContain(fileBytes);
    expect(serialized).not.toContain('base64');
  });
});

describe('corner display names', () => {
  it('turns the human request into a compact Slack-style corner name', () => {
    expect(cornerNameForIntent('Fix OAuth callback + retry state', 'room-id')).toBe(
      'fix-oauth-callback-retry-state',
    );
  });

  it('uses a corner fallback without exposing the subchannel noun', () => {
    expect(cornerNameForIntent('  ', '12345678-abcd')).toBe('corner-12345678');
  });
});

describe('live steering loop', () => {
  it('polls member messages while the original agent task is still running', async () => {
    const body = new Body({
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/tmp/buzzy-body-unit',
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const client = new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} });
    const session = {
      channelId: 'subchannel',
      sessionId: 'session',
      client,
      mode: 'edit' as const,
      parentChannelId: 'room',
      archived: false,
    };
    body.registerSubchannel({
      subchannelId: 'subchannel',
      worktreePath: '/tmp/worktree',
      featureBranch: 'feature/steer',
      role: body.agent,
      session,
      lastPolledAt: 0,
      archived: false,
    });

    const runningTasks = Reflect.get(body, 'runningAgentTasks') as Map<string, Promise<void>>;
    runningTasks.set('subchannel', new Promise(() => undefined));

    const abort = new AbortController();
    let memberPolls = 0;
    body.assertRepositorySafety = async () => undefined;
    body.provision = async () => session;
    body.pollChannelRequests = async () => 0;
    body.pollMergeCompletions = async () => 0;
    body.pollMembers = async () => {
      memberPolls++;
      abort.abort();
      return 1;
    };

    await body.runChannelLoop(
      'room',
      { repo: 'repo', localPath: '/tmp/repo' },
      { pollMs: 1, signal: abort.signal },
    );

    expect(memberPolls).toBe(1);
  });
});
