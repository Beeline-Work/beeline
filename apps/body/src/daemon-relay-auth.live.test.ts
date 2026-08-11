/** Live proof that the daemon detects a two-party Room request through an auth-required bridge. */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newIdentity } from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import { Body } from './body.js';
import type { BodyConfig } from './config.js';

const authEnforced = process.env.BUZZ_REQUIRE_AUTH_TOKEN === 'true';
const baseUrl = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
const host = process.env.BUZZY_RELAY_HOST ?? new URL(baseUrl).host;
const workspaceRoot = resolve(process.cwd(), `.tmp-daemon-relay-auth-${randomUUID()}`);

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

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe.runIf(authEnforced && reachable)('daemon relay authentication', () => {
  it('serves a two-party Room and fires the request path without a quarantine 401', async () => {
    await mkdir(workspaceRoot, { recursive: true });
    const human = newIdentity('auth-live-human');
    const agent = newIdentity('auth-live-agent');
    const humanClient = createBuzzClient({ baseUrl, host, identity: human });
    const roomId = await humanClient.createChannel(`auth-live-${randomUUID()}`);
    await humanClient.addMember(roomId, agent.publicKey, 'member');
    await humanClient.waitUntilMember(roomId, agent.publicKey);

    const config: BodyConfig = {
      agentBinary: '/bin/false',
      mcpBinary: '/bin/false',
      agentEnv: {},
      workspaceRoot,
      relayBaseUrl: baseUrl,
      relayHost: host,
      relayScheme: new URL(baseUrl).protocol.replace(':', ''),
      relayWsUrl: baseUrl.replace(/^http/, 'ws'),
      autoApprovePermissions: true,
    };
    const body = new Body(config, newIdentity('auth-live-operator'), agent);
    await expect(
      body.assertRepositorySafety(roomId, { repo: 'auth-live', localOnly: true }),
    ).resolves.toBeUndefined();

    const participants = (await humanClient.listMembers(roomId)).map((member) => member.pubkey);
    expect(new Set(participants)).toEqual(new Set([human.publicKey, agent.publicKey]));

    const detected: Array<{ prompt: string; author: string }> = [];
    Reflect.set(body, 'openSubchannel', async (_room: string, _repo: unknown, prompt: string, request: { authorPubkey: string }) => ({
      request,
      prompt,
    }));
    Reflect.set(body, 'startAgentTask', (info: { request: { authorPubkey: string } }, prompt: string) => {
      detected.push({ prompt, author: info.request.authorPubkey });
    });

    const message = `two-party request ${randomUUID()}`;
    await humanClient.messageSubmit(roomId, message);
    expect(
      await body.pollChannelRequests(roomId, {
        repo: 'auth-live',
        repositoryKey: 'auth-live',
        localOnly: true,
      }),
    ).toBe(1);
    expect(detected).toEqual([{ prompt: message, author: human.publicKey }]);

    humanClient.disconnect();
    await body.dispose();
    console.log(`[daemon-auth] Room ${roomId} request detected and response path fired`);
  }, 60_000);
});
