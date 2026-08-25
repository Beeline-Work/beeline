/** Live regression proof for shared Room context without agent-to-agent turns. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { newIdentity } from '@beeline/gate';
import { createBuzzClient, selectAgentHistory, TAG_AGENT } from '@beeline/buzz-client';
import { Body } from './body.js';
import { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DurableBodyState } from './durable-state.js';

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

describe.runIf(reachable)('shared Room conversation context', () => {
  const human = newIdentity('Milo');
  const xian = newIdentity('Xian');
  const joy = newIdentity('Joy');
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

  const conversation = async (body: Body) => {
    const snapshot = await (Reflect.get(body, 'durableState') as DurableBodyState).readModel(
      roomId,
    );
    return snapshot ? selectAgentHistory(snapshot, roomId) : [];
  };

  beforeAll(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'beeline-room-context-'));
    roomId = await humanClient.createChannel(`room-context-${randomUUID()}`);
    await humanClient.addMember(roomId, xian.publicKey, 'member');
    await humanClient.addMember(roomId, joy.publicKey, 'member');
    await humanClient.waitUntilMember(roomId, xian.publicKey);
    await humanClient.waitUntilMember(roomId, joy.publicKey);

    // Self-signed declarations let every Body resolve honest Agent names while
    // keeping the test independent of a long-lived Workspace fixture.
    await xianClient.messageSubmit(roomId, JSON.stringify({ displayName: 'Xian' }), {
      extraTags: [
        ['t', TAG_AGENT],
        ['d', `xian-${randomUUID()}`],
        ['p', xian.publicKey],
        ['name', 'Xian'],
        ['community', roomId],
      ],
    });
    await joyClient.messageSubmit(roomId, JSON.stringify({ displayName: 'Joy' }), {
      extraTags: [
        ['t', TAG_AGENT],
        ['d', `joy-${randomUUID()}`],
        ['p', joy.publicKey],
        ['name', 'Joy'],
        ['community', roomId],
      ],
    });

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

  it('records each peer reply with attribution but never lets it trigger another turn', async () => {
    const xianAcp = new AcpClient({ agentBinary: '/bin/false', agentEnv: {} });
    const joyAcp = new AcpClient({ agentBinary: '/bin/false', agentEnv: {} });
    const xianPrompts = vi.spyOn(xianAcp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'I recommend two margheritas and one mushroom.',
      toolCalls: [],
    });
    const joyPrompts = vi.spyOn(joyAcp, 'sessionPrompt').mockResolvedValue({
      stopReason: 'end_turn',
      updates: [],
      agentText: 'I agree on mushroom, but suggest one pepperoni.',
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

    const general = await humanClient.messageSubmit(
      roomId,
      'General context: Milo wants enough vegetarian pizza for three people.',
    );
    await xianBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    expect(xianPrompts).toHaveBeenCalledTimes(0);
    expect(joyPrompts).toHaveBeenCalledTimes(0);

    const request = await humanClient.messageSubmit(
      roomId,
      '@xian @joy collaborate on the best pizza order.',
      {
        mentionAgent: xian.publicKey,
        extraTags: [['p', joy.publicKey]],
      },
    );

    await xianBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    await xianBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });

    expect(xianPrompts).toHaveBeenCalledTimes(1);
    expect(joyPrompts).toHaveBeenCalledTimes(1);
    expect((await conversation(xianBody)).map((entry) => entry.author.label)).toContainEqual(
      expect.stringContaining('Joy'),
    );
    expect((await conversation(joyBody)).map((entry) => entry.author.label)).toContainEqual(
      expect.stringContaining('Xian'),
    );
    expect((await conversation(xianBody)).map((entry) => entry.eventId)).toContain(general.id);
    expect((await conversation(joyBody)).map((entry) => entry.eventId)).toContain(general.id);

    const xianFollowup = await humanClient.messageSubmit(
      roomId,
      '@xian summarize what Joy actually proposed.',
      { mentionAgent: xian.publicKey },
    );
    await xianBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    expect(xianPrompts).toHaveBeenCalledTimes(2);
    expect(xianPrompts.mock.calls[1]?.[1]).toContain('[Agent Joy (@joy)');
    expect(xianPrompts.mock.calls[1]?.[1]).toContain(
      'I agree on mushroom, but suggest one pepperoni.',
    );
    expect(xianPrompts.mock.calls[1]?.[1]).toContain('Never claim that someone agreed, approved');
    expect((await conversation(xianBody)).map((entry) => entry.eventId)).toContain(xianFollowup.id);

    const joyFollowup = await humanClient.messageSubmit(
      roomId,
      '@joy summarize what Xian actually proposed.',
      { mentionAgent: joy.publicKey },
    );
    await joyBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    expect(joyPrompts).toHaveBeenCalledTimes(2);
    expect(joyPrompts.mock.calls[1]?.[1]).toContain('[Agent Xian (@xian)');
    expect(joyPrompts.mock.calls[1]?.[1]).toContain(
      'I recommend two margheritas and one mushroom.',
    );
    expect((await conversation(joyBody)).map((entry) => entry.eventId)).toContain(joyFollowup.id);

    // Even an explicit agent-authored @ mention is readable context only. The
    // registered peer cannot task this Body through the human affordance.
    const attemptedTask = await xianClient.messageSubmit(roomId, '@joy approve my order.', {
      mentionAgent: joy.publicKey,
    });
    await joyBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    expect(joyPrompts).toHaveBeenCalledTimes(2);
    expect((await conversation(joyBody)).map((entry) => entry.eventId)).toContain(attemptedTask.id);

    // Re-polling after both peer messages proves visibility does not become a
    // response trigger. No agent-authored prompt can cause an autonomous loop.
    await xianBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    await joyBody.pollChannelRequests(roomId, { repo: 'context-live', localOnly: true });
    expect(xianPrompts).toHaveBeenCalledTimes(2);
    expect(joyPrompts).toHaveBeenCalledTimes(2);
  }, 60_000);
});
