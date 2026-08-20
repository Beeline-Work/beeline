/** Production-relay proof that GitHub-origin landing waits for a signed human approval. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASE_URL, newIdentity, queryEvents } from '@beeline/gate';
import { createBuzzClient, repositoryRoomId } from '@beeline/buzz-client';
import { resolveAgentCommand } from './agent-command.js';
import { findRuntimeConfigPaths, inspectLocalRepository, readRuntimeRecord } from './runtime.js';
import { respondToWritePermission } from './write-permission.live-helper.js';

const checkout = process.env.BUZZY_GITHUB_LIVE_CHECKOUT ?? '';
const selectedAgent = process.env.BUZZY_LIVE_AGENT_KIND ?? 'codex';
const appConfigured = Boolean(
  process.env.BUZZY_GITHUB_APP_ID && process.env.BUZZY_GITHUB_APP_PRIVATE_KEY,
);
let daemonPid: number | undefined;
let humanClient: ReturnType<typeof createBuzzClient> | undefined;
/** Machine-local agent state root; the runtime no longer lives in the repo. */
let stateHome = '';

async function reachable(): Promise<boolean> {
  try {
    return (
      await fetch(`${BASE_URL}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

function runtimeAvailable(): boolean {
  try {
    resolveAgentCommand({ kind: selectedAgent as 'codex' });
    return selectedAgent === 'codex';
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10 * 60_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function localGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return (result.stdout ?? '').trim();
}

const live = Boolean(checkout) && appConfigured && runtimeAvailable() && (await reachable());

describe.runIf(live)('GitHub-origin pair → conversation → human-approved land', () => {
  beforeAll(async () => {
    stateHome = await mkdtemp(resolve(tmpdir(), 'beeline-github-state-'));
  });

  afterAll(async () => {
    humanClient?.disconnect();
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM');
      } catch {
        // The daemon may already have exited after a failed assertion.
      }
    }
    if (stateHome) await rm(stateHome, { recursive: true, force: true });
  });

  it(
    'uses GitHub App installation credentials only after a signed human-admin approval',
    async () => {
      const marker = `github-origin-${Date.now()}`;
      const human = newIdentity(`${marker}-human`);
      humanClient = createBuzzClient({ baseUrl: BASE_URL, identity: human });
      const communityId = await humanClient.createCommunity(`${marker}-workspace`);
      const pairing = await humanClient.createAgentPairingCode(communityId);
      const binding = inspectLocalRepository(checkout).repository;
      const roomId = repositoryRoomId(communityId, binding);

      const pair = spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), 'pair', pairing.code, '--agent', selectedAgent],
        {
          cwd: checkout,
          // The runtime now lives under the machine-local agent state home,
          // not the checkout's .git — keep it inside this test's scratch dir.
          env: { ...process.env, XDG_STATE_HOME: stateHome },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(pair.status, `${pair.stdout}\n${pair.stderr}`).toBe(0);
      expect(pair.stdout).toContain(`[buzz] room: ${roomId}`);

      const configs = await findRuntimeConfigPaths(checkout);
      expect(configs).toHaveLength(1);
      const runtime = await readRuntimeRecord(configs[0]!);
      const runtimeRoom = runtime.rooms.find((room) => room.channelId === roomId);
      expect(runtimeRoom?.mergeWorker).toBeUndefined();
      daemonPid = Number(
        (await readFile(resolve(dirname(configs[0]!), 'daemon.pid'), 'utf8')).trim(),
      );
      const daemonLog = resolve(dirname(configs[0]!), 'daemon.log');

      await waitUntil(() => humanClient!.isMember(roomId, runtime.agent.publicKey), 60_000);
      const conversation = await humanClient.messageSubmit(
        roomId,
        'Reply in one short sentence confirming this is a conversation, not a work request.',
      );
      await waitUntil(async () => {
        const events = await humanClient!.sessionEventsBackfill(roomId, { limit: 200 });
        return events.some(
          (event) =>
            event.pubkey === runtime.agent.publicKey &&
            event.event.tags.some((tag) => tag[0] === 'e' && tag[1] === conversation.id),
        );
      });
      expect(await humanClient.listSubchannels(roomId)).toHaveLength(0);

      const request = await humanClient.messageSubmit(
        roomId,
        `Create AGENT-LANDED.txt containing ${marker}, then commit it.`,
        { mentionAgent: runtime.agent.publicKey },
      );
      await respondToWritePermission(
        humanClient,
        roomId,
        request.id,
        runtime.agent.publicKey,
        'allow',
      );
      let subchannelId = '';
      await waitUntil(async () => {
        const events = await queryEvents(
          [{ kinds: [9], '#h': [roomId], authors: [runtime.agent.publicKey], limit: 200 }],
          human,
        );
        const opened = events.find((event) =>
          event.tags.some((tag) => tag[0] === 'request' && tag[1] === request.id),
        );
        subchannelId = opened?.tags.find((tag) => tag[0] === 'subchannel')?.[1] ?? '';
        return Boolean(subchannelId);
      });

      let tip = '';
      let feature = '';
      let mergeTarget: { repo: string; branch: string; tip: string } | undefined;
      await waitUntil(async () => {
        const events = await queryEvents(
          [{ kinds: [9], '#h': [subchannelId], authors: [runtime.agent.publicKey], limit: 300 }],
          human,
        );
        const ready = events.find((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
        );
        tip = ready?.tags.find((tag) => tag[0] === 'tip')?.[1] ?? '';
        feature = ready?.tags.find((tag) => tag[0] === 'feature')?.[1] ?? '';
        const repo = ready?.tags.find((tag) => tag[0] === 'repo')?.[1];
        const branch = ready?.tags.find((tag) => tag[0] === 'branch')?.[1];
        if (repo && branch && tip) mergeTarget = { repo, branch, tip };
        return Boolean(mergeTarget && feature);
      });

      const beforeApprovalEvents = await queryEvents(
        [{ kinds: [9], '#h': [subchannelId], authors: [runtime.agent.publicKey], limit: 300 }],
        human,
      );
      expect(
        beforeApprovalEvents.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'landed'),
        ),
      ).toBe(false);
      expect(localGit(['ls-remote', 'origin', 'refs/heads/main'])).not.toContain(tip);
      expect(localGit(['ls-remote', 'origin', `refs/heads/${feature}`])).toContain(tip);
      expect((await humanClient.getChannelMetadata(subchannelId))?.archived).not.toBe(true);

      await humanClient.submitMergeApproval(subchannelId, mergeTarget!);
      await waitUntil(async () => {
        const events = await queryEvents(
          [{ kinds: [9], '#h': [subchannelId], authors: [runtime.agent.publicKey], limit: 300 }],
          human,
        );
        return events.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'landed'),
        );
      });
      await waitUntil(
        async () => (await humanClient!.getChannelMetadata(subchannelId))?.archived === true,
      );
      expect(localGit(['ls-remote', 'origin', 'refs/heads/main'])).toContain(tip);
      expect(localGit(['show', `${tip}:AGENT-LANDED.txt`])).toContain(marker);

      const roomEvents = await queryEvents(
        [{ kinds: [9], '#h': [roomId], authors: [runtime.agent.publicKey], limit: 300 }],
        human,
      );
      expect(
        roomEvents.some(
          (event) =>
            event.tags.some((tag) => tag[0] === 'request' && tag[1] === request.id) &&
            event.tags.some((tag) => tag[0] === 'display-status' && tag[1] === 'ready') &&
            event.tags.some((tag) => tag[0] === 'delivery' && tag[1] === 'landed') &&
            event.tags.some((tag) => tag[0] === 'tip' && tag[1] === tip),
        ),
      ).toBe(true);
      expect(await readFile(daemonLog, 'utf8')).not.toContain('[gate]');

      const origin = localGit(['remote', 'get-url', 'origin'])
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/');
      console.log(`[github-origin-live] conversation=REPLIED corners-before-work=0`);
      console.log(`[github-origin-live] gate=SIGNED-HUMAN-APPROVAL feature=${feature}`);
      console.log(
        `[github-origin-live] before-approval=NO-LAND/NO-ARCHIVE after-approval=LANDED/ARCHIVED commit=${origin}/commit/${tip}`,
      );
    },
    12 * 60_000,
  );
});

if (!live) {
  describe('GitHub-origin pair → conversation → human-approved land (prerequisite)', () => {
    it('SKIPPED — requires BUZZY_GITHUB_LIVE_CHECKOUT, GitHub App credentials, production relay, and Codex', () => {
      console.warn(
        'Set BUZZY_GITHUB_LIVE_CHECKOUT plus BUZZY_GITHUB_APP_ID and BUZZY_GITHUB_APP_PRIVATE_KEY.',
      );
    });
  });
}
