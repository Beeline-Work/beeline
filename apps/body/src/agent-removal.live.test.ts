/** Relay-backed proof that app removal stops and erases the paired host daemon. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBuzzClient } from '@beeline/buzz-client';
import { newIdentity } from '@beeline/gate';
import { launchRuntimeDaemon, pairRepositoryAgent, runtimeDaemonPid } from './runtime.js';

const baseUrl = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
const host = process.env.BUZZY_RELAY_HOST ?? new URL(baseUrl).host;
const human = newIdentity('agent-removal-human');
const agent = newIdentity('agent-removal-agent');
const body = newIdentity('agent-removal-body');
let checkout = '';
/** Machine-local agent state root; the runtime no longer lives in the repo. */
let stateHome = '';
let daemonPid: number | undefined;

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { host },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

const live = await reachable();

describe.runIf(live)('live agent removal teardown', () => {
  beforeAll(async () => {
    checkout = await mkdtemp(resolve(tmpdir(), 'beeline-agent-removal-'));
    stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-agent-removal-state-'));
    git(checkout, ['init', '-q', '-b', 'main']);
  });

  afterAll(async () => {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM');
      } catch {
        // Expected after successful removal.
      }
    }
    if (checkout) await rm(checkout, { recursive: true, force: true });
    if (stateHome) await rm(stateHome, { recursive: true, force: true });
  });

  it('pairs, removes through the app SDK, stops the daemon, and deletes runtime state', async () => {
    const humanClient = createBuzzClient({ baseUrl, host, identity: human });
    const agentClient = createBuzzClient({ baseUrl, host, identity: agent });
    const communityId = await humanClient.createCommunity(`agent-removal-${Date.now()}`);
    const roomId = await humanClient.createChannel(`agent-removal-room-${Date.now()}`, {
      communityId,
    });
    const pairing = await humanClient.createAgentPairingCode(communityId);
    const result = await pairRepositoryAgent(
      {
        code: pairing.code,
        cwd: checkout,
        repo: null,
        relayBaseUrl: baseUrl,
        relayHost: host,
        agentBinary: '/bin/false',
        mcpBinary: '/bin/true',
        agentIdentity: agent,
        bodyIdentity: body,
        supervisorRoot: stateHome,
      },
      {
        redeem: (code) => agentClient.redeemAgentPairingCode(code),
        resolveRoom: (redeemed, repository) =>
          agentClient.resolveRepositoryRoom(
            redeemed.communityId,
            repository,
            redeemed.pairedBy,
          ),
        launch: (configPath) =>
          launchRuntimeDaemon(configPath, {
            entrypoint: resolve(process.cwd(), 'dist/cli.js'),
            execArgv: [],
          }),
      },
    );
    daemonPid = result.pid;

    await humanClient.attachAgentToChannel(roomId, agent.publicKey, communityId);

    await waitUntil(async () => (await runtimeDaemonPid(result.configPath)) === result.pid);
    console.log(
      `[live-agent-removal] before daemonPid=${result.pid} daemonAlive=true runtime=${existsSync(result.configPath)} room=${roomId}`,
    );

    // This is the same SDK call made by the Agents screen after confirmation.
    await humanClient.removeAgent(communityId, agent.publicKey);

    await waitUntil(async () => (await runtimeDaemonPid(result.configPath)) === null, 90_000);
    await waitUntil(async () => !existsSync(result.configPath));
    const [communityMember, roomMember, listedAgents] = await Promise.all([
      humanClient.isMember(communityId, agent.publicKey),
      humanClient.isMember(roomId, agent.publicKey),
      humanClient.listAgents(communityId),
    ]);
    console.log(
      `[live-agent-removal] after daemonPid=${result.pid} daemonAlive=false runtime=${existsSync(result.configPath)} communityMember=${communityMember} roomMember=${roomMember} agents=${listedAgents.length}`,
    );

    expect(communityMember).toBe(false);
    expect(roomMember).toBe(false);
    expect(listedAgents.some((candidate) => candidate.pubkey === agent.publicKey)).toBe(false);
    daemonPid = undefined;
    agentClient.disconnect();
    humanClient.disconnect();
  }, 120_000);
});

if (!live) {
  describe('live agent removal teardown (prerequisites)', () => {
    it('SKIPPED — requires a reachable relay stack; no LLM credentials are used', () => {
      console.warn('Start with `npm run stack:up` or set BUZZY_RELAY_URL.');
    });
  });
}
