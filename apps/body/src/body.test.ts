/**
 * Hermetic unit tests for body modules.
 * These tests do NOT require a relay or LLM endpoint.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { hasWriteTools, inventoryForMcpServers } from './mcp-inventory.js';
import { parseEnvFile, hasLlmCredentials } from './config.js';
import {
  AGENT_REQUEST_TAG,
  Body,
  cornerNameForIntent,
  isChannelAddressedMessage,
  isChannelTaskRequest,
  isChannelWorkIntent,
} from './body.js';
import { AcpClient } from './acp.js';
import { newIdentity } from '@beeline/gate';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';

afterEach(() => vi.unstubAllGlobals());

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

describe('Room conversation and explicit work intent', () => {
  const human = newIdentity('human');
  const agent = newIdentity('agent');

  function requestEvent(tags: string[][], author = human) {
    return signEvent(
      {
        pubkey: author.publicKey,
        created_at: 1,
        kind: 9,
        tags: [['h', 'parent-channel'], ...tags],
        content: 'Implement the channel request',
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

  it('requires @-addressing when multiple people or agents share the Room', () => {
    const colleague = newIdentity('colleague');
    const participants = [human.publicKey, colleague.publicKey, agent.publicKey];
    expect(isChannelAddressedMessage(requestEvent([]), agent.publicKey, participants)).toBe(false);
    expect(
      isChannelAddressedMessage(
        requestEvent([['p', agent.publicKey]]),
        agent.publicKey,
        participants,
      ),
    ).toBe(true);
  });

  it('opens work only for the signed Start work marker', () => {
    const participants = [human.publicKey, agent.publicKey];
    const work = requestEvent([['t', AGENT_REQUEST_TAG]]);
    expect(isChannelAddressedMessage(work, agent.publicKey, participants)).toBe(true);
    expect(isChannelWorkIntent(work, agent.publicKey, participants)).toBe(true);
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
      agentText: 'Doing well. What are you thinking about?',
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

    await Reflect.get(body, 'replyInRoom').call(body, 'parent-channel', { repo: 'repo' }, {
      eventId: event.id,
      authorPubkey: event.pubkey,
      content: "Hey, what's up?",
      createdAt: event.created_at,
    });

    expect(prompt).toHaveBeenCalledWith(
      'readonly-session',
      expect.stringContaining("Hey, what's up?"),
      120_000,
    );
    expect(body.listSessions()).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 9,
      content: 'Doing well. What are you thinking about?',
    });
    expect(published[0]!.tags).toContainEqual(['h', 'parent-channel']);
    expect(published[0]!.tags).toContainEqual(['t', 'agent-message']);
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
