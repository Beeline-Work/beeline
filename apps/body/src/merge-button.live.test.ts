/**
 * Local-relay acceptance proof for the owner's merge-button contract. Git and
 * relay publications are real; the one conflict resolver model boundary is
 * stubbed so this proof needs no external LLM credential.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, HOST, createCommunity, newIdentity, setMemberRole } from '@beeline/gate';
import { createBuzzClient, tagValue } from '@beeline/buzz-client';
import { AcpClient } from './acp.js';
import { Body, createAgentSubchannel, type SubchannelInfo } from './body.js';

async function reachable(): Promise<boolean> {
  try {
    return (
      await fetch(`${BASE_URL}/health`, {
        headers: { host: HOST },
        signal: AbortSignal.timeout(3_000),
      })
    ).ok;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const live = await reachable();
const cleanup: string[] = [];

afterAll(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.runIf(live)('live merge button always lands', () => {
  it('mounts a stale review without a model turn, queues two lands, then auto-resolves a conflict', async () => {
    const run = `merge-button-${Date.now()}`;
    const root = mkdtempSync(join(tmpdir(), `${run}-`));
    cleanup.push(root);
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    git(checkout, ['init', '-q', '-b', 'main']);
    git(checkout, ['config', 'user.name', 'Merge Button Proof']);
    git(checkout, ['config', 'user.email', 'merge-button@example.invalid']);
    writeFileSync(join(checkout, 'README.md'), '# Merge button proof\n');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-qm', 'seed']);

    const human = newIdentity(`${run}-human`);
    const agent = newIdentity(`${run}-agent`);
    const humanClient = createBuzzClient({ baseUrl: BASE_URL, host: HOST, identity: human });
    const workspaceId = await createCommunity(human, `${run} Workspace`);
    const roomId = await humanClient.createChannel('Merge button live proof', {
      communityId: workspaceId,
    });
    await setMemberRole(human, workspaceId, agent.publicKey, 'member');
    await setMemberRole(human, roomId, agent.publicKey, 'member');

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

    const makeCorner = async (
      name: string,
      branch: string,
      worktreePath: string,
    ): Promise<SubchannelInfo> => {
      const cornerId = await createAgentSubchannel(
        agent,
        roomId,
        name,
        human.publicKey,
        workspaceId,
        name,
      );
      await setMemberRole(agent, cornerId, human.publicKey, 'admin');
      await humanClient.waitUntilMember(cornerId, human.publicKey);
      const info: SubchannelInfo = {
        subchannelId: cornerId,
        worktreePath,
        featureBranch: branch,
        role: agent,
        session: {
          channelId: cornerId,
          parentChannelId: roomId,
          sessionId: `${name}-session`,
          mode: 'edit',
          client: new AcpClient({ agentBinary: '/bin/false', agentEnv: {} }),
          processState: 'suspended',
        } as never,
        lastPolledAt: 0,
        archived: false,
        taskDescription: name,
        boundRepo: {
          repo: 'merge-button-proof',
          repositoryKey: 'merge-button-proof',
          localOnly: true,
          localPath: checkout,
          targetBranch: 'refs/heads/main',
        },
      };
      body.registerSubchannel(info);
      return info;
    };

    let conflictPath: string | undefined;
    const resolver = vi
      .spyOn(body as never, 'promptAgent' as never)
      .mockImplementation(async (_session: never, prompt: string) => {
        expect(conflictPath).toBeDefined();
        expect(prompt).toContain('README.md');
        expect(prompt).toContain('Do not ask the human');
        git(conflictPath!, ['reset', '--hard', 'main']);
        writeFileSync(
          join(conflictPath!, 'README.md'),
          '# Main changed while approved\n\nCorner intent preserved by automatic resolution.\n',
        );
        git(conflictPath!, ['add', 'README.md']);
        git(conflictPath!, ['commit', '-qm', 'resolve approved landing conflict']);
        return {
          agentText: 'Resolved and validated the approved landing conflict.',
          updates: [],
          toolCalls: [],
          stopReason: 'end_turn',
        } as never;
      });

    try {
      const pathA = join(root, 'corner-a');
      git(checkout, ['worktree', 'add', '-q', '-b', 'feature/a', pathA, 'main']);
      writeFileSync(join(pathA, 'A.txt'), 'corner a\n');
      git(pathA, ['add', 'A.txt']);
      git(pathA, ['commit', '-qm', 'corner a']);
      const infoA = await makeCorner('Queue corner A', 'feature/a', pathA);

      // Move main after the agent committed. Publishing the review must do the
      // clean rebase itself and must not invoke the model boundary.
      writeFileSync(join(checkout, 'UNRELATED.txt'), 'new main work\n');
      git(checkout, ['add', 'UNRELATED.txt']);
      git(checkout, ['commit', '-qm', 'unrelated main movement']);
      await expect(Reflect.get(body, 'publishMergeReady').call(body, infoA)).resolves.toBe(true);
      expect(resolver).not.toHaveBeenCalled();

      const pathB = join(root, 'corner-b');
      git(checkout, ['worktree', 'add', '-q', '-b', 'feature/b', pathB, 'main']);
      writeFileSync(join(pathB, 'B.txt'), 'corner b\n');
      git(pathB, ['add', 'B.txt']);
      git(pathB, ['commit', '-qm', 'corner b']);
      const infoB = await makeCorner('Queue corner B', 'feature/b', pathB);
      await expect(Reflect.get(body, 'publishMergeReady').call(body, infoB)).resolves.toBe(true);

      const approvalA = await humanClient.submitMergeApproval(
        infoA.subchannelId,
        infoA.mergeTarget!,
      );
      const approvalB = await humanClient.submitMergeApproval(
        infoB.subchannelId,
        infoB.mergeTarget!,
      );
      await waitUntil(async () => {
        await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
        return Boolean(infoA.landedTip && infoB.landedTip);
      });
      expect(readFileSync(join(checkout, 'A.txt'), 'utf8')).toBe('corner a\n');
      expect(readFileSync(join(checkout, 'B.txt'), 'utf8')).toBe('corner b\n');
      expect(resolver).not.toHaveBeenCalled();

      const conflictCornerPath = join(root, 'corner-conflict');
      git(checkout, [
        'worktree',
        'add',
        '-q',
        '-b',
        'feature/conflict',
        conflictCornerPath,
        'main',
      ]);
      writeFileSync(join(conflictCornerPath, 'README.md'), '# Corner changed this line\n');
      git(conflictCornerPath, ['add', 'README.md']);
      git(conflictCornerPath, ['commit', '-qm', 'conflicting corner change']);
      const conflictInfo = await makeCorner(
        'Conflict corner',
        'feature/conflict',
        conflictCornerPath,
      );
      await expect(Reflect.get(body, 'publishMergeReady').call(body, conflictInfo)).resolves.toBe(
        true,
      );
      writeFileSync(join(checkout, 'README.md'), '# Main changed while approved\n');
      git(checkout, ['add', 'README.md']);
      git(checkout, ['commit', '-qm', 'conflicting main movement']);
      conflictPath = conflictCornerPath;
      const conflictApproval = await humanClient.submitMergeApproval(
        conflictInfo.subchannelId,
        conflictInfo.mergeTarget!,
      );
      await waitUntil(async () => {
        await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
        return Boolean(conflictInfo.landedTip);
      });
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toContain(
        'Corner intent preserved',
      );

      const proofEvents = (
        await Promise.all(
          [infoA.subchannelId, infoB.subchannelId, conflictInfo.subchannelId].map((cornerId) =>
            humanClient.query([{ kinds: [9], '#h': [cornerId], limit: 500 }]),
          ),
        )
      ).flat();
      const coordinates = proofEvents
        .filter((event) =>
          event.tags.some(
            (tag) => tag[0] === 't' && (tag[1] === 'merge-ready' || tag[1] === 'landed'),
          ),
        )
        .map((event) => ({
          id: event.id,
          at: new Date(event.created_at * 1_000).toISOString(),
          corner: tagValue(event, 'h'),
          type: event.tags.find(
            (tag) => tag[0] === 't' && (tag[1] === 'merge-ready' || tag[1] === 'landed'),
          )?.[1],
          tip: tagValue(event, 'tip'),
        }));
      expect(coordinates.filter((event) => event.type === 'landed')).toHaveLength(3);
      console.log(
        `MERGE_BUTTON_LIVE_PROOF=${JSON.stringify({
          workspaceId,
          roomId,
          approvals: [approvalA.id, approvalB.id, conflictApproval.id],
          events: coordinates,
          automaticConflictTurns: resolver.mock.calls.length,
        })}`,
      );
    } finally {
      humanClient.disconnect();
      await body.dispose();
    }
  }, 90_000);
});

if (!live) {
  describe('live merge button always lands (prerequisite)', () => {
    it('SKIPPED — requires the local relay stack; no external LLM is used', () => {
      console.warn('Start with `npm run stack:up` at the repository root.');
    });
  });
}
