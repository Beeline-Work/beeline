/** Relay-backed proof that app removal stops and erases the paired host daemon. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBuzzClient } from '@beeline/buzz-client';
import { BASE_URL, HOST, createCommunity, newIdentity } from '@beeline/gate';
import { launchRuntimeDaemon, pairRepositoryAgent, runtimeDaemonPid } from './runtime.js';

const human = newIdentity('agent-removal-human');
const agent = newIdentity('agent-removal-agent');
const body = newIdentity('agent-removal-body');
const mergeWorker = newIdentity('agent-removal-merge-worker');
let checkout = '';
let daemonPid: number | undefined;
let sessionPid: number | undefined;

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fakeAgentBinary(root: string): Promise<{ binary: string; pidPath: string }> {
  const binary = resolve(root, 'fake-agent.mjs');
  const pidPath = resolve(root, 'fake-agent.pid');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'live-removal-session' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return { binary, pidPath };
}

const live = await reachable();

describe.runIf(live)('live agent removal teardown', () => {
  beforeAll(async () => {
    checkout = await mkdtemp(resolve(tmpdir(), 'beeline-agent-removal-'));
    git(checkout, ['init', '-q', '-b', 'main']);
  });

  afterAll(async () => {
    if (sessionPid) {
      try {
        process.kill(sessionPid, 'SIGTERM');
      } catch {
        // Expected after successful removal.
      }
    }
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM');
      } catch {
        // Expected after successful removal.
      }
    }
    if (checkout) await rm(checkout, { recursive: true, force: true });
  });

  it('pairs, removes through the app SDK, drains the daemon, and deletes runtime state', async () => {
    const communityId = await createCommunity(human, `agent-removal-${Date.now()}`);
    const humanClient = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    const agentClient = createBuzzClient({ baseUrl: BASE_URL, identity: agent });
    const pairing = await humanClient.createAgentPairingCode(communityId);
    const fakeAgent = await fakeAgentBinary(checkout);
    const result = await pairRepositoryAgent(
      {
        code: pairing.code,
        cwd: checkout,
        relayBaseUrl: BASE_URL,
        agentBinary: fakeAgent.binary,
        mcpBinary: '/bin/true',
        agentIdentity: agent,
        bodyIdentity: body,
        mergeWorkerIdentity: mergeWorker,
      },
      {
        redeem: (code) => agentClient.redeemAgentPairingCode(code),
        resolveRoom: (redeemed, repository, mergeWorkerPubkey) =>
          agentClient.resolveRepositoryRoom(
            redeemed.communityId,
            repository,
            redeemed.pairedBy,
            mergeWorkerPubkey,
          ),
        launch: (configPath) =>
          launchRuntimeDaemon(configPath, {
            entrypoint: resolve(process.cwd(), 'dist/cli.js'),
            execArgv: [],
          }),
      },
    );
    daemonPid = result.pid;

    await waitUntil(async () => (await runtimeDaemonPid(result.configPath)) === result.pid);
    await waitUntil(async () => existsSync(fakeAgent.pidPath));
    sessionPid = Number((await readFile(fakeAgent.pidPath, 'utf8')).trim());
    await waitUntil(async () => Boolean(sessionPid && processAlive(sessionPid)));
    console.log(
      `[live-agent-removal] before daemonPid=${result.pid} daemonAlive=true sessionPid=${sessionPid} sessionAlive=true runtime=${existsSync(result.configPath)} room=${result.room.channelId}`,
    );

    // This is the same SDK call made by the Agents screen after confirmation.
    await humanClient.removeAgent(communityId, agent.publicKey);

    await waitUntil(async () => (await runtimeDaemonPid(result.configPath)) === null);
    await waitUntil(async () => Boolean(sessionPid && !processAlive(sessionPid)));
    await waitUntil(async () => !existsSync(result.configPath));
    const [communityMember, roomMember, listedAgents] = await Promise.all([
      humanClient.isMember(communityId, agent.publicKey),
      humanClient.isMember(result.room.channelId, agent.publicKey),
      humanClient.listAgents(communityId),
    ]);
    console.log(
      `[live-agent-removal] after daemonPid=${result.pid} daemonAlive=false sessionPid=${sessionPid} sessionAlive=false runtime=${existsSync(result.configPath)} communityMember=${communityMember} roomMember=${roomMember} agents=${listedAgents.length}`,
    );

    expect(communityMember).toBe(false);
    expect(roomMember).toBe(false);
    expect(listedAgents.some((candidate) => candidate.pubkey === agent.publicKey)).toBe(false);
    daemonPid = undefined;
    sessionPid = undefined;
    agentClient.disconnect();
    humanClient.disconnect();
  });
});

if (!live) {
  describe('live agent removal teardown (prerequisites)', () => {
    it('SKIPPED — requires the local relay stack only; no LLM credentials are used', () => {
      console.warn('Start with `npm run stack:up` at the repository root.');
    });
  });
}
