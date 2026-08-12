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
  createRelayClient,
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
import { buildAgentEnv, hasLlmCredentials, resolveMcpBinary } from './config.js';
import {
  detectInstalledAgentCommands,
  resolveAgentCommand,
  type AgentCommand,
  type AgentKind,
} from './agent-command.js';
import {
  findRuntimeConfigPaths,
  inspectLocalRepository,
  readRuntimeRecord,
  runtimeIdentity,
} from './runtime.js';
import { respondToWritePermission } from './write-permission.live-helper.js';

const human = newIdentity('pair-runtime-human');
let checkout = '';
let secondCheckout = '';
let protectedPushCheckout = '';
let daemonPid: number | undefined;
let daemonLog = '';
const selectedAgentKind = process.env.BUZZY_LIVE_AGENT_KIND as AgentKind | undefined;

function availableLiveAgent(): AgentCommand | undefined {
  if (selectedAgentKind) return resolveAgentCommand({ kind: selectedAgentKind });
  const detected = detectInstalledAgentCommands();
  return detected.length === 1 ? detected[0] : undefined;
}

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
    const agent = availableLiveAgent();
    if (!agent) return false;
    resolveMcpBinary();
    if (agent.kind !== 'reference') return true;
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
    if (secondCheckout) await rm(secondCheckout, { recursive: true, force: true });
    if (protectedPushCheckout) {
      await rm(protectedPushCheckout, { recursive: true, force: true });
    }
  });

  it('pairs inside the repo and produces a reviewable feature branch there', async () => {
    const marker = `pair-runtime-${Date.now()}`;
    const repo = marker;
    const liveAgent = availableLiveAgent()!;
    const exerciseSecondRoom = liveAgent.kind === 'reference';
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

    const binaries = {
      agentBinary: liveAgent.command,
      mcpBinary: resolveMcpBinary(),
    };
    const command = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'pair',
        pairing.code,
        ...(selectedAgentKind ? ['--agent', selectedAgentKind] : []),
      ],
      {
        cwd: checkout,
        env: {
          ...process.env,
          BUZZ_AGENT_BIN: binaries.agentBinary,
          BUZZ_DEV_MCP_BIN: binaries.mcpBinary,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(command.status, command.stderr).toBe(0);
    expect(command.stdout).toContain(`[buzz] room: ${roomId}`);
    if (!selectedAgentKind) {
      expect(command.stdout).toContain(`[buzz] using ${liveAgent.kind} (auto-detected)`);
    }
    expect(command.stdout).toContain(`[body] agent binary: ${liveAgent.kind}:`);

    const configs = await findRuntimeConfigPaths(checkout);
    expect(configs).toHaveLength(1);
    const runtime = await readRuntimeRecord(configs[0]!);
    expect(runtime.agentKind).toBe(liveAgent.kind);
    const runtimeRoom = runtime.rooms.find((room) => room.channelId === roomId)!;
    daemonLog = resolve(dirname(configs[0]!), 'daemon.log');
    daemonPid = Number((await readFile(resolve(configs[0]!, '..', 'daemon.pid'), 'utf8')).trim());
    expect(runtimeRoom.repo.root).toBe(checkout);
    expect(runtimeRoom.channelId).toBe(roomId);
    expect(runtimeRoom.mergeWorker?.publicKey).toMatch(/^[0-9a-f]{64}$/);
    await announceRepo(human, repo, roomId);
    const humanRelay = createRelayClient(human);
    await waitUntil(
      async () =>
        (await resolveChannelRole(roomId, human.publicKey, humanRelay)) === 'admin' &&
        (await resolveChannelRole(roomId, runtimeRoom.mergeWorker!.publicKey, humanRelay)) ===
          'admin',
      30_000,
    );

    if (exerciseSecondRoom) {
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
    }

    const agentIdentity = runtimeIdentity(runtime.agent);
    await waitUntil(async () => {
      const protection = await checkAgentNotPushAllowed({
        ownerHex: human.publicKey,
        repo,
        agentPubkey: agentIdentity.publicKey,
        protectedRef: 'refs/heads/main',
        relay: createRelayClient(agentIdentity),
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

    // Create a second repository Room after the one and only pairing. Workspace
    // agent membership must not ambiently mirror into it; the in-app helper is
    // the sole attachment write the running supervisor discovers.
    let secondRepo = '';
    let secondRoomId = '';
    if (exerciseSecondRoom) {
      secondRepo = `${marker}-second`;
      secondCheckout = await mkdtemp(resolve(tmpdir(), 'beeline-second-room-'));
      git(secondCheckout, ['init', '-q', '-b', 'main']);
      await writeFile(resolve(secondCheckout, 'README.md'), `# ${secondRepo}\n`);
      git(secondCheckout, ['add', '-A']);
      git(secondCheckout, ['commit', '-m', 'seed second paired repo']);
      git(secondCheckout, ['remote', 'add', 'origin', gitRepoUrl(human.publicKey, secondRepo)]);
      const secondBinding = inspectLocalRepository(secondCheckout).repository;
      secondRoomId = repositoryRoomId(communityId, secondBinding);
      const secondStagingRoom = await createChannel(human, `${secondRepo}-staging`, {
        communityId,
      });
      await announceRepo(human, secondRepo, secondStagingRoom);
      await waitUntil(
        async () =>
          gitAuthed(tmpdir(), human, human.publicKey, secondRepo, [
            'ls-remote',
            gitRepoUrl(human.publicKey, secondRepo),
          ]).ok,
      );
      const secondSeed = gitAuthed(secondCheckout, human, human.publicKey, secondRepo, [
        'push',
        'origin',
        'main',
      ]);
      expect(secondSeed.ok, secondSeed.stderr).toBe(true);

      const humanRoom = await humanClient.resolveRepositoryRoomForHuman(
        communityId,
        secondBinding,
      );
      expect(humanRoom.channelId).toBe(secondRoomId);
      expect(await humanClient.isMember(secondRoomId, human.publicKey)).toBe(true);
      // Move smart-HTTP authority from the seed staging channel to the final
      // authoritative Room before the invited member attempts a feature push.
      await announceRepo(human, secondRepo, secondRoomId);
      expect(await humanClient.isMember(secondRoomId, runtime.agent.publicKey)).toBe(false);

      const invitation = await humanClient.attachAgentToChannel(
        secondRoomId,
        runtime.agent.publicKey,
        communityId,
      );
      expect(invitation.joined).toBe(true);
      await waitUntil(async () => {
        const stored = await readRuntimeRecord(configs[0]!);
        return stored.rooms.some((candidate) => candidate.channelId === secondRoomId);
      }, 60_000);
      console.log(
        `[live-pair-runtime] one-link-two-rooms=ATTACHED agent=${runtime.agent.publicKey} rooms=${roomId},${secondRoomId}`,
      );
    }

    const firstRequest = await humanClient.messageSubmit(
      roomId,
      exerciseSecondRoom
        ? `Create PAIR-RUNTIME-PROOF.txt containing ${marker}. Before committing, run sleep 12 so a human can steer this active turn.`
        : `Create PAIR-RUNTIME-PROOF.txt containing ${marker}, then commit it.`,
      { mentionAgent: runtime.agent.publicKey },
    );
    const permissionResponses = [
      respondToWritePermission(
        humanClient,
        roomId,
        firstRequest.id,
        runtime.agent.publicKey,
        'allow',
      ),
    ];
    if (exerciseSecondRoom) {
      const secondRequest = await humanClient.messageSubmit(
        secondRoomId,
        `Create SECOND-ROOM-PROOF.txt containing ${marker}, then commit it.`,
        { mentionAgent: runtime.agent.publicKey },
      );
      permissionResponses.push(
        respondToWritePermission(
          humanClient,
          secondRoomId,
          secondRequest.id,
          runtime.agent.publicKey,
          'allow',
        ),
      );
    }
    await Promise.all(permissionResponses);

    const roomEvents = async () =>
      queryEvents(
        [{ kinds: [9], '#h': [roomId], authors: [runtime.agent.publicKey], limit: 100 }],
        human,
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
    const firstSessionPin = opened?.tags.find((tag) => tag[0] === 'session')?.[1];
    expect(firstSessionPin).toBeTruthy();
    let secondFeature = '';
    let secondSubchannel: string | undefined;
    if (exerciseSecondRoom) {
      const secondRoomEvents = async () =>
        queryEvents(
          [
            {
              kinds: [9],
              '#h': [secondRoomId],
              authors: [runtime.agent.publicKey],
              limit: 100,
            },
          ],
          human,
        );
      let secondOpened: Awaited<ReturnType<typeof secondRoomEvents>>[number] | undefined;
      await waitUntil(async () => {
        secondOpened = (await secondRoomEvents()).find((event) =>
          event.tags.some((tag) => tag[0] === 'feature'),
        );
        return Boolean(secondOpened);
      }, 60_000);
      secondFeature = secondOpened?.tags.find((tag) => tag[0] === 'feature')?.[1] ?? '';
      secondSubchannel = secondOpened?.tags.find((tag) => tag[0] === 'subchannel')?.[1];
      const secondSessionPin = secondOpened?.tags.find((tag) => tag[0] === 'session')?.[1];
      expect(secondSubchannel).toBeTruthy();
      expect(secondSessionPin).toBeTruthy();
      expect(firstSessionPin).not.toBe(secondSessionPin);
      await humanClient.messageSubmit(
        subchannel!,
        `Concurrent steer: also create STEERED.txt containing ${marker}.`,
      );
      console.log(
        `[live-pair-runtime] isolated-session-pins=${firstSessionPin},${secondSessionPin} steer=DELIVERED`,
      );
    } else {
      console.log(
        `[live-pair-runtime] two-party-request=DETECTED session=${firstSessionPin} subchannel=${subchannel}`,
      );
    }
    let tip = '';
    try {
      await waitUntil(async () => {
        const ready = (
          await queryEvents(
            [{ kinds: [9], '#h': [subchannel!], authors: [runtime.agent.publicKey], limit: 100 }],
            human,
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
    const fetchFirst = gitAuthed(checkout, human, human.publicKey, repo, [
      'fetch',
      'origin',
      `refs/heads/${feature}`,
    ]);
    expect(fetchFirst.ok, fetchFirst.stderr).toBe(true);
    // The reference agent reliably processes the concurrent steering message before
    // committing. Other ACP agents may finish the original request first, so their
    // portable contract is the original requested artifact and committed feature tip.
    const firstProofFile =
      liveAgent.kind !== 'reference' ? 'PAIR-RUNTIME-PROOF.txt' : 'STEERED.txt';
    expect(git(checkout, ['show', `${tip}:${firstProofFile}`]).stdout).toContain(marker);
    console.log(
      `[live-pair-runtime] first-corner=COMMITTED branch=${feature} tip=${tip} file=${firstProofFile}`,
    );

    if (exerciseSecondRoom) {
      let secondTip = '';
      try {
        await waitUntil(async () => {
          const ready = (
            await queryEvents(
              [
                {
                  kinds: [9],
                  '#h': [secondSubchannel!],
                  authors: [runtime.agent.publicKey],
                  limit: 100,
                },
              ],
              human,
            )
          ).find((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'));
          secondTip = ready?.tags.find((tag) => tag[0] === 'tip')?.[1] ?? '';
          return Boolean(secondTip);
        }, 120_000);
      } catch (error) {
        const [log, events] = await Promise.all([
          existsSync(daemonLog)
            ? readFile(daemonLog, 'utf8')
            : Promise.resolve('(missing daemon log)'),
          queryEvents([{ kinds: [9], '#h': [secondSubchannel!], limit: 200 }], human),
        ]);
        throw new Error(
          `${String(error)}\n--- second Room events ---\n${events
            .map((event) => `${event.pubkey.slice(0, 12)} ${event.content}`)
            .join('\n')}\n--- daemon.log ---\n${log}`,
        );
      }
      const remoteSecondFeature = gitAuthed(
        secondCheckout,
        human,
        human.publicKey,
        secondRepo,
        ['ls-remote', 'origin', `refs/heads/${secondFeature}`],
      );
      expect(remoteSecondFeature.ok, remoteSecondFeature.stderr).toBe(true);
      expect(remoteSecondFeature.stdout).toContain(secondTip);
      const fetchSecond = gitAuthed(
        secondCheckout,
        human,
        human.publicKey,
        secondRepo,
        ['fetch', 'origin', `refs/heads/${secondFeature}`],
      );
      expect(fetchSecond.ok, fetchSecond.stderr).toBe(true);
      expect(
        git(secondCheckout, ['show', `${secondTip}:SECOND-ROOM-PROOF.txt`]).stdout,
      ).toContain(marker);
      console.log(
        `[live-pair-runtime] concurrent-rooms=SERVED firstTip=${tip} secondTip=${secondTip}`,
      );
    }

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

    // Reassert the fixture human through the dedicated merge worker immediately
    // before approval. Projection application is asynchronous under a loaded
    // live suite, so retry a refused human event only after a fresh admin grant.
    // This does not grant the autonomous agent any new authority.
    const mergeWorkerIdentity = runtimeIdentity(runtimeRoom.mergeWorker!);
    const mergeWorkerClient = createBuzzClient({
      baseUrl: BASE_URL,
      identity: mergeWorkerIdentity,
    });
    const mergeWorkerRelay = createRelayClient(mergeWorkerIdentity);
    let landed = false;
    for (let attempt = 0; attempt < 3 && !landed; attempt += 1) {
      let reviewerRole = await resolveChannelRole(
        subchannel!,
        human.publicKey,
        mergeWorkerRelay,
      );
      if (reviewerRole !== 'admin' && reviewerRole !== 'owner') {
        await mergeWorkerClient.addMember(subchannel!, human.publicKey, 'admin');
        await waitUntil(
          async () =>
            (await resolveChannelRole(subchannel!, human.publicKey, mergeWorkerRelay)) === 'admin',
          30_000,
        );
        // Role projections are asynchronous; require the grant to remain current
        // after the next second-resolution ordering boundary.
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
        reviewerRole = await resolveChannelRole(
          subchannel!,
          human.publicKey,
          mergeWorkerRelay,
        );
        if (reviewerRole !== 'admin' && reviewerRole !== 'owner') continue;
      }

      const approval = await humanClient.submitMergeApproval(subchannel!, mergeTarget);
      await waitUntil(async () => {
        if (lsRemoteRef(checkout, human, human.publicKey, repo, 'refs/heads/main') === tip) {
          return true;
        }
        const log = existsSync(daemonLog) ? await readFile(daemonLog, 'utf8') : '';
        return log.includes(`approval=${approval.id}`);
      }, 30_000);
      landed =
        lsRemoteRef(checkout, human, human.publicKey, repo, 'refs/heads/main') === tip;
    }
    mergeWorkerClient.disconnect();
    if (!landed) {
      const log = existsSync(daemonLog)
        ? await readFile(daemonLog, 'utf8')
        : '(missing daemon log)';
      throw new Error(`human admin approval did not land after three grants\n--- daemon.log ---\n${log}`);
    }
    await waitUntil(
      async () => (await humanClient.getChannelMetadata(subchannel!))?.archived === true,
    );
    expect(lsRemoteRef(checkout, human, human.publicKey, repo, 'refs/heads/main')).toBe(tip);
    console.log('[live-pair-runtime] human-admin-approval=AUTO-LANDED');
    agentClient.disconnect();
    expect(existsSync(resolve(runtime.supervisorRoot, 'beeline', 'agents'))).toBe(true);
    console.log(
      `[live-pair-runtime] PASS workspace=${communityId} room=${roomId} repo=${checkout} feature=${feature} tip=${tip}`,
    );
    humanClient.disconnect();
  }, 360_000);
});

if (!live) {
  describe('live one-command pair → Room → branch (prerequisites)', () => {
    it('SKIPPED — requires relay and exactly one available ACP agent (plus LLM env for reference)', () => {
      console.warn(
        'Start the relay and install/select a documented ACP agent; reference also needs LLM credentials.',
      );
    });
  });
}
