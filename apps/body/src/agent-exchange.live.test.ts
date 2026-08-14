/** Live proof for human-authorized, two-message-per-agent Room exchanges. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { newIdentity, type Identity } from '@beeline/gate';
import {
  createBuzzClient,
  KIND_AGENT_PRESENCE,
  TAG_AGENT,
  TAG_AGENT_PRESENCE,
  tagValue,
} from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { AGENT_EXCHANGE_TAG, Body } from './body.js';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';

const baseUrl = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
const host = process.env.BUZZY_RELAY_HOST ?? new URL(baseUrl).host;

async function relayReachable(): Promise<boolean> {
  try {
    return (
      await fetch(`${baseUrl}/health`, {
        headers: { host },
        signal: AbortSignal.timeout(3_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

const reachable = await relayReachable();

describe.runIf(reachable)('human-authorized agent exchange', () => {
  const human = newIdentity('Milo');
  // Paired runtimes use this internal identity name; the Room-scoped agent
  // records below must remain authoritative for human-facing @handles.
  const xian = newIdentity('buzzy-agent');
  const joy = newIdentity('buzzy-agent');
  const humanClient = createBuzzClient({ baseUrl, host, identity: human });
  const xianClient = createBuzzClient({ baseUrl, host, identity: xian });
  const joyClient = createBuzzClient({ baseUrl, host, identity: joy });
  let root = '';
  let roomId = '';
  let xianBody: Body;
  let joyBody: Body;

  const config = (workspaceRoot: string): BodyConfig => ({
    agentBinary: '/bin/false',
    mcpBinary: '/bin/false',
    agentEnv: {},
    workspaceRoot,
    relayBaseUrl: baseUrl,
    relayHost: host,
    relayScheme: new URL(baseUrl).protocol.replace(':', ''),
    relayWsUrl: baseUrl.replace(/^http/, 'ws'),
    autoApprovePermissions: true,
  });

  const publishPresence = async (identity: Identity, status: 'online' | 'offline') => {
    const client = identity.publicKey === xian.publicKey ? xianClient : joyClient;
    const event = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1_000),
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', `${TAG_AGENT_PRESENCE}:${roomId}`],
          ['h', roomId],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', identity.publicKey],
          ['status', status],
        ],
        content: status,
      },
      identity.secretKey,
    );
    await client.publish(event);
  };

  const exchangeMessages = async (authorizationId: string): Promise<NostrEvent[]> =>
    (
      await humanClient.query([
        {
          kinds: [9],
          '#h': [roomId],
          '#t': [AGENT_EXCHANGE_TAG],
          '#exchange': [authorizationId],
          limit: 20,
        },
      ])
    )
      .filter((event) => tagValue(event, 'exchange') === authorizationId)
      .sort((left, right) => Number(tagValue(left, 'turn')) - Number(tagValue(right, 'turn')));

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'beeline-agent-exchange-'));
    roomId = await humanClient.createChannel(`agent-exchange-${randomUUID()}`);
    await humanClient.addMember(roomId, xian.publicKey, 'member');
    await humanClient.addMember(roomId, joy.publicKey, 'member');
    await humanClient.waitUntilMember(roomId, xian.publicKey);
    await humanClient.waitUntilMember(roomId, joy.publicKey);

    for (const [client, identity, name] of [
      [xianClient, xian, 'Xian'],
      [joyClient, joy, 'Joy'],
    ] as const) {
      await client.messageSubmit(roomId, JSON.stringify({ displayName: name }), {
        extraTags: [
          ['t', TAG_AGENT],
          ['d', `${name.toLowerCase()}-${randomUUID()}`],
          ['p', identity.publicKey],
          ['name', name],
          ['community', roomId],
        ],
      });
    }
    await publishPresence(xian, 'online');
    await publishPresence(joy, 'online');

    xianBody = new Body(config(resolve(root, 'xian')), human, xian, undefined, {
      statePath: resolve(root, 'xian-state.json'),
    });
    joyBody = new Body(config(resolve(root, 'joy')), human, joy, undefined, {
      statePath: resolve(root, 'joy-state.json'),
    });
  });

  afterAll(async () => {
    await humanClient.archiveRoom(roomId).catch(() => undefined);
    humanClient.disconnect();
    xianClient.disconnect();
    joyClient.disconnect();
    await xianBody?.dispose();
    await joyBody?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('posts four grounded turns, stops at two per agent, reports offline honestly, and strips harness notices', async () => {
    const xianAcp = new AcpClient({ agentBinary: '/bin/false', agentEnv: {} });
    const joyAcp = new AcpClient({ agentBinary: '/bin/false', agentEnv: {} });
    const xianPrompts = vi
      .spyOn(xianAcp, 'sessionPrompt')
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Joy, what matters most when choosing the retry policy?',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'That makes sense. I would pair the short timeout with bounded jitter.',
        toolCalls: [],
      });
    const joyPrompts = vi
      .spyOn(joyAcp, 'sessionPrompt')
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'The timeout matters most; retries should fail fast before adding jitter.',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Agreed on bounded jitter. We should keep the total attempt budget explicit.',
        toolCalls: [],
      });
    xianBody.registerSession({
      channelId: roomId,
      sessionId: 'xian-readonly',
      client: xianAcp,
      mode: 'readonly',
    });
    joyBody.registerSession({
      channelId: roomId,
      sessionId: 'joy-readonly',
      client: joyAcp,
      mode: 'readonly',
    });

    const authorization = await humanClient.messageSubmit(
      roomId,
      '@xian have a conversation with @joy',
      { mentionAgent: xian.publicKey },
    );
    await xianBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    await xianBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    await xianBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });

    const messages = await exchangeMessages(authorization.id);
    expect(messages.map((message) => tagValue(message, 'turn'))).toEqual(['1', '2', '3', '4']);
    expect(messages.filter((message) => message.pubkey === xian.publicKey)).toHaveLength(2);
    expect(messages.filter((message) => message.pubkey === joy.publicKey)).toHaveLength(2);
    expect(xianPrompts).toHaveBeenCalledTimes(2);
    expect(joyPrompts).toHaveBeenCalledTimes(2);
    expect(joyPrompts.mock.calls[0]?.[1]).toContain(
      'Joy, what matters most when choosing the retry policy?',
    );
    expect(xianPrompts.mock.calls[1]?.[1]).toContain(
      'The timeout matters most; retries should fail fast before adding jitter.',
    );
    expect(joyPrompts.mock.calls[1]?.[1]).toContain(
      'That makes sense. I would pair the short timeout with bounded jitter.',
    );

    await xianBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    expect(await exchangeMessages(authorization.id)).toHaveLength(4);
    expect(xianPrompts).toHaveBeenCalledTimes(2);
    expect(joyPrompts).toHaveBeenCalledTimes(2);

    await publishPresence(joy, 'offline');
    const offlineRequest = await humanClient.messageSubmit(roomId, '@xian talk to @joy for a bit', {
      mentionAgent: xian.publicKey,
    });
    await xianBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    const offlineReplies = await humanClient.query([
      {
        kinds: [9],
        authors: [xian.publicKey],
        '#h': [roomId],
        '#e': [offlineRequest.id],
        limit: 10,
      },
    ]);
    expect(offlineReplies).toHaveLength(1);
    expect(offlineReplies[0]!.content).toContain("Joy isn't online");
    expect(offlineReplies[0]!.content).not.toMatch(/done|completed|five rounds/i);
    expect(await exchangeMessages(offlineRequest.id)).toHaveLength(0);
    expect(xianPrompts).toHaveBeenCalledTimes(2);

    xianPrompts.mockResolvedValueOnce({
      stopReason: 'end_turn',
      updates: [],
      agentText:
        'Warning: Skill descriptions were shortened to fit the skills context budget.\nCodex can still see every skill by reading its SKILL.md.\n\nClean visible answer.',
      toolCalls: [],
    });
    const warningRequest = await humanClient.messageSubmit(roomId, '@xian answer cleanly', {
      mentionAgent: xian.publicKey,
    });
    await xianBody.pollChannelRequests(roomId, { repo: 'exchange-live', localOnly: true });
    const cleanReplies = await humanClient.query([
      {
        kinds: [9],
        authors: [xian.publicKey],
        '#h': [roomId],
        '#e': [warningRequest.id],
        limit: 10,
      },
    ]);
    expect(cleanReplies).toHaveLength(1);
    expect(cleanReplies[0]!.content).toBe('Clean visible answer.');
  }, 60_000);
});
