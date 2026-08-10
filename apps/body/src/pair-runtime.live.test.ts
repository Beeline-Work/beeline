/** One-command live proof: pair a checkout, start its daemon, request real work, observe branch. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  announceRepo,
  BASE_URL,
  checkAgentNotPushAllowed,
  createChannel,
  createCommunity,
  git,
  gitAuthed,
  gitRepoUrl,
  HOST,
  lsRemoteRef,
  newIdentity,
  queryEvents,
  resolveChannelRole,
} from '@beeline/gate';
import { createBuzzClient, repositoryRoomId } from '@beeline/buzz-client';
import { buildAgentEnv, hasLlmCredentials, resolveBinaries } from './config.js';
import {
  findRuntimeConfigPaths,
  inspectLocalRepository,
  readRuntimeRecord,
  runtimeIdentity,
} from './runtime.js';
import { AGENT_REQUEST_TAG } from './body.js';

const human = newIdentity('pair-runtime-human');
let checkout = '';
let protectedPushCheckout = '';
let daemonPid: number | undefined;
let daemonLog = '';

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function runtimeAvailable(): boolean {
  try {
    resolveBinaries();
    return hasLlmCredentials(
      buildAgentEnv(process.env, process.env.BUZZY_BODY_LLM_FILE ?? undefined),
    );
  } catch {
    return false;
  }
}

const live = (await reachable()) && runtimeAvailable();

describe.runIf(live)('live one-command pair → Room → branch', () => {
  beforeAll(async () => {
    checkout = await mkdtemp(resolve(tmpdir(), 'beeline-paired-repo-'));
  });

  afterAll(async () => {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM');
      } catch {
        // It may already have stopped after a test failure.
      }
    }
    if (checkout) await rm(checkout, { recursive: true, force: true });
    if (protectedPushCheckout) {
      await rm(protectedPushCheckout, { recursive: true, force: true });
    }
  });

  it('pairs inside the repo and produces a reviewable feature branch there', async () => {
    const marker = `pair-runtime-${Date.now()}`;
    const repo = marker;
    const communityId = await createCommunity(human, `${marker}-workspace`);
    const humanClient = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    const pairing = await humanClient.createAgentPairingCode(communityId);

    git(checkout, ['init', '-q', '-b', 'main']);
    await writeFile(resolve(checkout, 'README.md'), `# ${marker}\n`);
    git(checkout, ['add', '-A']);
    git(checkout, ['commit', '-m', 'seed paired repo']);
    git(checkout, ['remote', 'add', 'origin', gitRepoUrl(human.publicKey, repo)]);
    const binding = inspectLocalRepository(checkout).repository;
    const roomId = repositoryRoomId(communityId, binding);
    const stagingRoom = await createChannel(human, `${marker}-staging`, { communityId });
    await announceRepo(human, repo, stagingRoom);
    await waitUntil(
      async () =>
        gitAuthed(tmpdir(), human, human.publicKey, repo, [
          'ls-remote',
          gitRepoUrl(human.publicKey, repo),
        ]).ok,
    );
    const seed = gitAuthed(checkout, human, human.publicKey, repo, ['push', 'origin', 'main']);
    if (!seed.ok) throw new Error(`seed push failed: ${seed.stderr}`);

    const binaries = resolveBinaries();
    const command = spawnSync(process.execPath, [resolve('dist/cli.js'), 'pair', pairing.code], {
      cwd: checkout,
      env: {
        ...process.env,
        BUZZ_AGENT_BIN: binaries.agentBinary,
        BUZZ_DEV_MCP_BIN: binaries.mcpBinary,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(command.status, command.stderr).toBe(0);
    expect(command.stdout).toContain(`[buzz] room: ${roomId}`);

    const configs = await findRuntimeConfigPaths(checkout);
    expect(configs).toHaveLength(1);
    const runtime = await readRuntimeRecord(configs[0]!);
    daemonLog = resolve(dirname(configs[0]!), 'daemon.log');
    daemonPid = Number((await readFile(resolve(configs[0]!, '..', 'daemon.pid'), 'utf8')).trim());
    expect(runtime.repo.root).toBe(checkout);
    expect(runtime.channelId).toBe(roomId);
    expect(runtime.mergeWorker?.publicKey).toMatch(/^[0-9a-f]{64}$/);
    await announceRepo(human, repo, roomId);
    await waitUntil(
      async () =>
        (await resolveChannelRole(roomId, human.publicKey, human.publicKey)) === 'admin' &&
        (await resolveChannelRole(roomId, runtime.mergeWorker!.publicKey, human.publicKey)) ===
          'admin',
      30_000,
    );

    const secondAgent = newIdentity('pair-runtime-second-agent');
    const secondClient = createBuzzClient({ baseUrl: BASE_URL, identity: secondAgent });
    const secondCode = await humanClient.createAgentPairingCode(communityId);
    const secondPairing = await secondClient.redeemAgentPairingCode(secondCode.code);
    const secondRoom = await secondClient.resolveRepositoryRoom(
      communityId,
      binding,
      secondPairing.pairedBy,
    );
    expect(secondRoom.channelId).toBe(roomId);
    expect(secondRoom.created).toBe(false);
    expect(secondRoom.joined).toBe(true);
    expect(await secondClient.isMember(roomId, secondAgent.publicKey)).toBe(true);
    secondClient.disconnect();
    console.log('[live-pair-runtime] same-remote-second-agent=JOINED');

    const agentIdentity = runtimeIdentity(runtime.agent);
    await waitUntil(async () => {
      const protection = await checkAgentNotPushAllowed({
        ownerHex: human.publicKey,
        repo,
        agentPubkey: agentIdentity.publicKey,
        protectedRef: 'refs/heads/main',
      });
      return protection.ok && protection.agentRole === 'member';
    }, 30_000);
    await waitUntil(
      async () =>
        gitAuthed(checkout, agentIdentity, human.publicKey, repo, ['ls-remote', 'origin']).ok,
      30_000,
    );
    protectedPushCheckout = await mkdtemp(resolve(tmpdir(), 'beeline-protected-push-'));
    await rm(protectedPushCheckout, { recursive: true, force: true });
    const clone = gitAuthed(tmpdir(), agentIdentity, human.publicKey, repo, [
      'clone',
      gitRepoUrl(human.publicKey, repo),
      protectedPushCheckout,
    ]);
    expect(clone.ok, clone.stderr).toBe(true);
    await writeFile(resolve(protectedPushCheckout, 'UNAPPROVED.txt'), 'must not reach main\n');
    git(protectedPushCheckout, ['add', '-A']);
    git(protectedPushCheckout, ['commit', '-m', 'attempt unapproved protected push']);
    const protectedPush = gitAuthed(protectedPushCheckout, agentIdentity, human.publicKey, repo, [
      'push',
      'origin',
      'HEAD:refs/heads/main',
    ]);
    expect(protectedPush.ok, protectedPush.stderr).toBe(false);
    console.log('[live-pair-runtime] protected-push=REFUSED');

    await humanClient.messageSubmit(
      roomId,
      `Create PAIR-RUNTIME-PROOF.txt containing ${marker}, then commit it.`,
      {
        mentionAgent: runtime.agent.publicKey,
        extraTags: [['t', AGENT_REQUEST_TAG]],
      },
    );

    const roomEvents = async () =>
      queryEvents(
        [{ kinds: [9], '#h': [roomId], authors: [runtime.agent.publicKey], limit: 100 }],
        human.publicKey,
      );
    let opened: Awaited<ReturnType<typeof roomEvents>>[number] | undefined;
    try {
      await waitUntil(async () => {
        opened = (await roomEvents()).find((event) =>
          event.tags.some((tag) => tag[0] === 'feature'),
        );
        return Boolean(opened);
      }, 60_000);
    } catch (error) {
      const log = existsSync(daemonLog)
        ? await readFile(daemonLog, 'utf8')
        : '(missing daemon log)';
      throw new Error(`${String(error)}\n--- daemon.log ---\n${log}`);
    }

    const feature = opened?.tags.find((tag) => tag[0] === 'feature')?.[1] ?? '';
    const subchannel = opened?.tags.find((tag) => tag[0] === 'subchannel')?.[1];
    expect(subchannel).toBeTruthy();
    let tip = '';
    try {
      await waitUntil(async () => {
        const ready = (
          await queryEvents(
            [{ kinds: [9], '#h': [subchannel!], authors: [runtime.agent.publicKey], limit: 100 }],
            human.publicKey,
          )
        ).find((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'));
        tip = ready?.tags.find((tag) => tag[0] === 'tip')?.[1] ?? '';
        return Boolean(tip);
      });
    } catch (error) {
      const log = existsSync(daemonLog)
        ? await readFile(daemonLog, 'utf8')
        : '(missing daemon log)';
      throw new Error(`${String(error)}\n--- daemon.log ---\n${log}`);
    }

    const remoteFeature = gitAuthed(checkout, human, human.publicKey, repo, [
      'ls-remote',
      'origin',
      `refs/heads/${feature}`,
    ]);
    expect(remoteFeature.ok).toBe(true);
    expect(remoteFeature.stdout).toContain(tip);

    const mergeTarget = {
      repo: `${human.publicKey}/${repo}`,
      branch: 'refs/heads/main',
      tip,
    };
    const mainBeforeApproval = lsRemoteRef(
      checkout,
      human,
      human.publicKey,
      repo,
      'refs/heads/main',
    );
    const agentClient = createBuzzClient({ baseUrl: BASE_URL, identity: agentIdentity });
    await agentClient.submitMergeApproval(subchannel!, mergeTarget);
    try {
      await waitUntil(async () => {
        const log = existsSync(daemonLog) ? await readFile(daemonLog, 'utf8') : '';
        return log.includes('agents can never approve merges');
      }, 30_000);
    } catch (error) {
      const log = existsSync(daemonLog)
        ? await readFile(daemonLog, 'utf8')
        : '(missing daemon log)';
      throw new Error(`${String(error)}\n--- daemon.log ---\n${log}`);
    }
    expect(lsRemoteRef(checkout, human, human.publicKey, repo, 'refs/heads/main')).toBe(
      mainBeforeApproval,
    );
    console.log('[live-pair-runtime] agent-approval=REFUSED');

    await humanClient.submitMergeApproval(subchannel!, mergeTarget);
    try {
      await waitUntil(
        async () => lsRemoteRef(checkout, human, human.publicKey, repo, 'refs/heads/main') === tip,
        60_000,
      );
    } catch (error) {
      const log = existsSync(daemonLog)
        ? await readFile(daemonLog, 'utf8')
        : '(missing daemon log)';
      throw new Error(`${String(error)}\n--- daemon.log ---\n${log}`);
    }
    await waitUntil(
      async () => (await humanClient.getChannelMetadata(subchannel!))?.archived === true,
    );
    expect(lsRemoteRef(checkout, human, human.publicKey, repo, 'refs/heads/main')).toBe(tip);
    console.log('[live-pair-runtime] human-admin-approval=AUTO-LANDED');
    agentClient.disconnect();
    expect(existsSync(resolve(runtime.repo.gitCommonDir, 'beeline', 'agents'))).toBe(true);
    console.log(
      `[live-pair-runtime] PASS workspace=${communityId} room=${roomId} repo=${checkout} feature=${feature} tip=${tip}`,
    );
    humanClient.disconnect();
  }, 240_000);
});

if (!live) {
  describe('live one-command pair → Room → branch (prerequisites)', () => {
    it('SKIPPED — requires relay, local buzz-agent binaries, and operator LLM env', () => {
      console.warn(
        'Start with `npm run stack:up` and provide the documented local LLM environment.',
      );
    });
  });
}
