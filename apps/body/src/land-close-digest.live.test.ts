/**
 * Real local-stack proof of the terminal corner lifecycle:
 * open -> exact-tip human approval -> local land -> prompt drain/close ->
 * server-indexed parent-Room digest. No ACP model or external Git host is used.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, HOST, createCommunity, newIdentity, setMemberRole } from '@beeline/gate';
import { createBuzzClient, identityNsec, RoomViewClient } from '@beeline/buzz-client';
import { AcpClient } from './acp.js';
import { Body, createAgentSubchannel, type SubchannelInfo } from './body.js';

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const live = await reachable();
const cleanup: string[] = [];

afterAll(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.runIf(live)('live land -> close -> indexed parent digest', () => {
  it('projects the verified approver and reaps the worktree within seconds', async () => {
    const run = `land-close-${Date.now()}`;
    const human = newIdentity(`${run}-human`);
    const agent = newIdentity(`${run}-agent`);
    const humanClient = createBuzzClient({ baseUrl: BASE_URL, host: HOST, identity: human });
    const root = mkdtempSync(join(tmpdir(), `${run}-`));
    cleanup.push(root);

    const checkout = join(root, 'checkout');
    const worktree = join(root, 'corner');
    git(root, ['init', '-q', '-b', 'main', checkout]);
    git(checkout, ['config', 'user.name', 'Local Stack Owner']);
    git(checkout, ['config', 'user.email', 'owner@example.invalid']);
    writeFileSync(join(checkout, 'README.md'), '# Before\n');
    git(checkout, ['add', 'README.md']);
    git(checkout, ['commit', '-qm', 'seed']);
    git(checkout, ['worktree', 'add', '-q', '-b', 'feature/close-beat', worktree, 'main']);
    writeFileSync(join(worktree, 'LANDED.txt'), 'the close beat landed\n');
    git(worktree, ['add', 'LANDED.txt']);
    git(worktree, ['commit', '-qm', 'add close-beat proof']);
    const tip = git(worktree, ['rev-parse', 'HEAD']);

    const workspaceId = await createCommunity(human, `${run} Workspace`);
    await humanClient.setPersonProfile(workspaceId, { name: 'Ada Lovelace' });
    const roomId = await humanClient.createChannel('Land digest device proof', {
      communityId: workspaceId,
    });
    await setMemberRole(human, workspaceId, agent.publicKey, 'member');
    await setMemberRole(human, roomId, agent.publicKey, 'member');
    const cornerId = await createAgentSubchannel(
      agent,
      roomId,
      'Ship the close beat',
      human.publicKey,
      workspaceId,
      'Ship the close beat and prove its Room digest',
    );
    await setMemberRole(agent, cornerId, human.publicKey, 'admin');
    await humanClient.waitUntilMember(cornerId, human.publicKey);

    const body = new Body(
      {
        agentBinary: '/bin/false',
        mcpBinary: '/bin/false',
        agentEnv: {},
        workspaceRoot: root,
        relayBaseUrl: BASE_URL,
        relayHost: HOST,
        relayScheme: 'http',
        relayWsUrl: 'ws://127.0.0.1:3010',
        autoApprovePermissions: true,
      },
      human,
      agent,
      undefined,
      { statePath: join(root, 'state.json') },
    );
    const info: SubchannelInfo = {
      subchannelId: cornerId,
      worktreePath: worktree,
      featureBranch: 'feature/close-beat',
      role: agent,
      session: {
        channelId: cornerId,
        parentChannelId: roomId,
        sessionId: 'live-close-proof',
        mode: 'edit',
        client: new AcpClient({ agentBinary: '/bin/false', agentEnv: {} }),
        processState: 'suspended',
      } as never,
      lastPolledAt: 0,
      archived: false,
      request: {
        eventId: `${run}-request`,
        authorPubkey: human.publicKey,
        content: '@agent open a corner and ship the close beat and prove its Room digest',
        createdAt: Math.floor(Date.now() / 1000),
      },
      mergeSummary:
        'Added the terminal close beat and a typed Room digest. Did not change corner-open authority.',
      boundRepo: {
        repo: 'local-close-proof',
        repositoryKey: 'local-close-proof',
        localOnly: true,
        localPath: checkout,
        targetBranch: 'refs/heads/main',
      },
    };
    body.registerSubchannel(info);

    try {
      await Reflect.get(body, 'publishMergeReady').call(body, info);
      expect(info.mergeTarget?.tip).toBe(tip);
      await humanClient.submitMergeApproval(cornerId, info.mergeTarget!);

      const approvedAt = Date.now();
      await waitUntil(async () => {
        await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
        return info.landedTip === tip;
      });
      await body.pollMergeCompletions();
      await waitUntil(
        async () => (await humanClient.getChannelMetadata(cornerId))?.archived === true,
      );

      expect(Date.now() - approvedAt).toBeLessThan(8_000);
      expect(git(checkout, ['rev-parse', 'refs/heads/main'])).toBe(tip);
      expect(existsSync(worktree)).toBe(false);

      const indexedClient = new RoomViewClient({ baseUrl: BASE_URL, identity: human });
      let digest: Awaited<ReturnType<RoomViewClient['room']>>['messages'][number] | undefined;
      await waitUntil(async () => {
        const view = await indexedClient.room(roomId);
        digest = view.messages.find((message) => message.landSummary?.cornerId === cornerId);
        return Boolean(digest);
      });
      expect(digest).toMatchObject({
        presentation: 'card',
        landSummary: {
          objective: 'ship the close beat and prove its Room digest',
          delivered: '1 commit across 1 file (LANDED.txt)',
          omitted: 'Did not change corner-open authority.',
          branch: 'main',
          tip,
          approvedBy: {
            pubkey: human.publicKey,
            name: 'Ada Lovelace',
            handle: 'adalovelace',
          },
        },
      });
      console.log(`LAND_CLOSE_DIGEST_NSEC=${identityNsec(human)}`);
      console.log(`LAND_CLOSE_DIGEST_WORKSPACE_ID=${workspaceId}`);
      console.log(`LAND_CLOSE_DIGEST_ROOM_ID=${roomId}`);
      console.log(`LAND_CLOSE_DIGEST_CORNER_ID=${cornerId}`);
      console.log(`LAND_CLOSE_DIGEST_EVENT_ID=${digest.id}`);
      console.log(`LAND_CLOSE_DIGEST_TIP=${tip}`);
    } finally {
      humanClient.disconnect();
      await body.dispose();
    }
  }, 45_000);
});

if (!live) {
  describe('live land -> close -> indexed parent digest (prerequisite)', () => {
    it('SKIPPED — requires the local relay stack; no LLM credentials are used', () => {
      console.warn('Start with `npm run stack:up` at the repository root.');
    });
  });
}
