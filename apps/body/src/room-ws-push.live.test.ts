/** Live proof that Body receives Room turns through authenticated WS push and replays a disconnect gap. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createBuzzClient } from '@beeline/buzz-client';
import { newIdentity } from '@beeline/gate';
import { Body } from './body.js';
import type { BodyConfig } from './config.js';

const baseUrl = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
const host = process.env.BUZZY_RELAY_HOST ?? new URL(baseUrl).host;
const workspaceRoot = resolve(process.cwd(), `.tmp-room-ws-push-${randomUUID()}`);

async function waitFor(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function relayReachable(): Promise<boolean> {
  try {
    return (
      await fetch(`${baseUrl}/health`, { headers: { host }, signal: AbortSignal.timeout(3_000) })
    ).ok;
  } catch {
    return false;
  }
}

const reachable = await relayReachable();

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe.runIf(reachable)('Body Room WebSocket push', () => {
  it('pushes a Room request without recurring query polling and replays a disconnect gap', async () => {
    await mkdir(workspaceRoot, { recursive: true });
    const human = newIdentity('ws-push-human');
    const agent = newIdentity('ws-push-agent');
    const humanClient = createBuzzClient({ baseUrl, host, identity: human });
    const roomId = await humanClient.createChannel(`ws-push-${randomUUID()}`);
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
    // onRoomPollSuccess now fires on every delivered WS event (and on a
    // periodic connected-socket tick), not only once per subscribe — that's
    // the watchdog-liveness fix under test elsewhere. Track WS (re)connect
    // count independently via the once-per-successful-subscribe presence
    // transition instead.
    let connections = 0;
    const presence: string[] = [];
    const body = new Body(config, newIdentity('ws-push-operator'), agent, {
      onRoomPollSuccess: () => {},
      onRoomPresence: (_channelId, status) => {
        presence.push(status);
        if (status === 'online') connections++;
      },
    });
    vi.spyOn(body, 'provision').mockResolvedValue({} as never);
    const received: string[] = [];
    Reflect.set(
      body,
      'replyInRoom',
      async (_room: string, _repo: unknown, request: { content: string }) => {
        received.push(request.content);
        return { openedCorner: false, producedReply: true };
      },
    );
    const backstop = vi.spyOn(body, 'pollChannelRequests');
    const abort = new AbortController();
    const loop = body.runConversationRoomLoop(roomId, 'direct-message', { signal: abort.signal });

    await waitFor(() => connections === 1, 'initial authenticated WS subscription');
    await waitFor(() => backstop.mock.calls.length === 1, 'initial safety-net query');
    expect(backstop).toHaveBeenCalledTimes(1);

    const first = `pushed-now-${randomUUID()}`;
    await humanClient.messageSubmit(roomId, first);
    await waitFor(() => received.includes(first), 'first pushed Room request');
    expect(backstop).toHaveBeenCalledTimes(1);

    await body.forceRecoverRoom(roomId);
    const duringGap = `pushed-during-gap-${randomUUID()}`;
    await humanClient.messageSubmit(roomId, duringGap);
    await waitFor(() => connections === 2, 'WS reconnect');
    await waitFor(() => backstop.mock.calls.length === 2, 'reconnect safety-net query');
    await waitFor(() => received.includes(duringGap), 'cursor replay after reconnect');
    expect(backstop).toHaveBeenCalledTimes(2);

    abort.abort();
    await loop;
    expect((Reflect.get(body, 'roomSockets') as Map<string, unknown>).size).toBe(0);
    expect(presence).toEqual(expect.arrayContaining(['online', 'offline']));
    humanClient.disconnect();
    await body.dispose();
  }, 60_000);
});

describe.runIf(!reachable)('Body Room WebSocket push', () => {
  it('soft-skips when the local relay is unreachable', () => {
    expect(true).toBe(true);
  });
});
