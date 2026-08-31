/** Local-relay proof for visible, human-rooted, host-bounded Room delegation. */
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
import { Body } from './body.js';
import { AcpClient } from './acp.js';
import { AGENT_DELEGATION_TAG } from './agent-mention.js';
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

describe.runIf(reachable)('agent-to-agent Room delegation', () => {
  const human = newIdentity('Milo');
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
    accessPolicy: 'creator',
    accessOwnerPubkey: human.publicKey,
    agentDelegationMaxHops: 4,
  });

  const publishPresence = async (identity: Identity) => {
    const client = identity.publicKey === xian.publicKey ? xianClient : joyClient;
    await client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: KIND_AGENT_PRESENCE,
          tags: [
            ['d', `${TAG_AGENT_PRESENCE}:${roomId}`],
            ['h', roomId],
            ['t', TAG_AGENT_PRESENCE],
            ['agent', identity.publicKey],
            ['status', 'online'],
          ],
          content: 'online',
        },
        identity.secretKey,
      ),
    );
  };

  const delegationEvents = async (rootRequestId: string): Promise<NostrEvent[]> =>
    (
      await humanClient.query([
        {
          kinds: [9],
          '#h': [roomId],
          '#t': [AGENT_DELEGATION_TAG],
          limit: 100,
        },
      ])
    )
      .filter((event) => tagValue(event, 'root-request') === rootRequestId)
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'beeline-agent-delegation-'));
    roomId = await humanClient.createChannel(`agent-delegation-${randomUUID()}`);
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
    await publishPresence(xian);
    await publishPresence(joy);

    xianBody = new Body(config(resolve(root, 'xian')), human, xian, {
      statePath: resolve(root, 'xian-state.json'),
    });
    joyBody = new Body(config(resolve(root, 'joy')), human, joy, {
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

  it('delivers real peer work, preserves the human root, and stops deliberate ping-pong', async () => {
    const xianAcp = new AcpClient({ agentBinary: '/bin/false', agentEnv: {} });
    const joyAcp = new AcpClient({ agentBinary: '/bin/false', agentEnv: {} });
    const xianPrompts = vi
      .spyOn(xianAcp, 'sessionPrompt')
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: '@joy produce the ten launch quotes and post them here.',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: '@joy challenge quote number ten once more.',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: '@joy one more ping that the host must stop.',
        toolCalls: [],
      });
    const joyPrompts = vi
      .spyOn(joyAcp, 'sessionPrompt')
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText:
          'Ten quotes: 1. Launch small. 2. Listen. 3. Iterate. 4. Focus. 5. Ship. 6. Measure. 7. Learn. 8. Refine. 9. Repeat. 10. Endure. @xian verify number ten.',
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        updates: [],
        agentText: 'Number ten holds. @xian close the loop.',
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

    const humanRequest = await humanClient.messageSubmit(
      roomId,
      '@xian get ten launch quotes from @joy and post them here.',
      { mentionAgent: xian.publicKey },
    );

    await xianBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await xianBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await xianBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await xianBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'delegation-live', localOnly: true });

    const events = await delegationEvents(humanRequest.id);
    const dispatches = events
      .filter((event) => tagValue(event, 'to-agent'))
      .sort((left, right) => Number(tagValue(left, 'hop')) - Number(tagValue(right, 'hop')));
    const limitLines = events.filter((event) => tagValue(event, 'delegation-status') === 'limit');

    expect(dispatches.map((event) => tagValue(event, 'hop'))).toEqual(['1', '2', '3', '4']);
    expect(dispatches.every((event) => tagValue(event, 'root-human') === human.publicKey)).toBe(
      true,
    );
    expect(events.some((event) => event.content.startsWith('Ten quotes:'))).toBe(true);
    expect(limitLines).toHaveLength(1);
    expect(xianPrompts).toHaveBeenCalledTimes(3);
    expect(joyPrompts).toHaveBeenCalledTimes(2);

    for (const event of events) {
      console.log(
        JSON.stringify({
          id: event.id,
          timestamp: new Date(event.created_at * 1_000).toISOString(),
          author: event.pubkey,
          rootRequestId: tagValue(event, 'root-request'),
          rootHuman: tagValue(event, 'root-human'),
          hop: tagValue(event, 'hop'),
          toAgent: tagValue(event, 'to-agent'),
          status: tagValue(event, 'delegation-status'),
          content: event.content,
        }),
      );
    }
  }, 90_000);
});
