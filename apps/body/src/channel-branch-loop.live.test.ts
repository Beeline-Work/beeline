/** Real relay + real LLM proof of the human channel → agent branch → human merge → archive loop. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Body } from './body.js';
import { hasLiveAgent, loadLiveBodyConfig } from './live-test-agent.js';
import {
  announceRepo,
  attemptMerge,
  BASE_URL,
  createChannel,
  createCommunity,
  git,
  gitAuthed,
  gitRepoUrl,
  HOST,
  lsRemoteRef,
  newIdentity,
  queryEvents,
  setMemberRole,
} from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';

const marker = `branch-loop-${randomUUID().slice(0, 8)}`;
const human = newIdentity(`${marker}-human`);
const operator = newIdentity(`${marker}-operator`);
const agent = newIdentity(`${marker}-agent`);
let body: Body | null = null;
let testDir = '';
let skipped = true;
let channelId = '';
let subchannelId = '';
let repo = '';

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

async function waitRepo(owner: string, name: string): Promise<void> {
  const url = gitRepoUrl(owner, name);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (gitAuthed(tmpdir(), human, owner, name, ['ls-remote', url]).ok) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('repo never became cloneable');
}

const relayUp = await reachable();

describe.runIf(relayUp)('live channel → subchannel branch loop', () => {
  beforeAll(async () => {
    testDir = await mkdtemp(resolve(tmpdir(), 'buzzy-branch-loop-'));
    const config = loadLiveBodyConfig({
      workspaceRoot: testDir,
      llmEnvFile: process.env.BUZZY_BODY_LLM_FILE ?? undefined,
    });
    if (!hasLiveAgent(config)) return;

    const communityId = await createCommunity(human, `${marker}-community`);
    channelId = await createChannel(human, `${marker}-channel`, { communityId });
    await setMemberRole(human, communityId, operator.publicKey, 'admin');
    await setMemberRole(human, channelId, operator.publicKey, 'admin');
    await setMemberRole(human, communityId, agent.publicKey, 'member');
    await setMemberRole(human, channelId, agent.publicKey, 'member');

    repo = marker;
    await announceRepo(human, repo, channelId);
    await waitRepo(human.publicKey, repo);
    const seed = await mkdtemp(resolve(tmpdir(), 'buzzy-branch-loop-seed-'));
    git(seed, ['init', '-q', '-b', 'main']);
    await writeFile(resolve(seed, 'README.md'), `# ${marker}\n`);
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-m', 'seed main']);
    const push = gitAuthed(seed, human, human.publicKey, repo, [
      'push',
      gitRepoUrl(human.publicKey, repo),
      'main',
    ]);
    if (!push.ok) throw new Error(`seed push failed: ${push.stderr}`);

    body = new Body(config, operator, agent);
    await body.provision(channelId);
    skipped = false;
  }, 60_000);

  afterAll(async () => {
    if (body) await body.dispose();
    if (testDir) await rm(testDir, { recursive: true, force: true });
  }, 20_000);

  it('runs the full loop and leaves the parent discussion writable', async () => {
    if (skipped || !body) return;
    const client = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    await client.startAgentWork(
      channelId,
      `Create LOOP-PROOF.txt containing ${marker}, then commit it.`,
      agent.publicKey,
    );

    expect(await body.pollChannelRequests(channelId, {
      ownerHex: human.publicKey,
      repo,
      targetBranch: 'refs/heads/main',
    })).toBe(1);
    const active = [...body.getSubchannels().values()];
    expect(active).toHaveLength(1);
    subchannelId = active[0]!.subchannelId;

    const creates = await queryEvents(
      [{ kinds: [9007], '#h': [subchannelId], limit: 5 }],
      human,
    );
    expect(creates.some((event) => event.pubkey === agent.publicKey)).toBe(true);

    await body.waitForAgentTasks();
    const info = body.getSubchannels().get(subchannelId)!;
    expect(info.mergeTarget?.branch).toBe('refs/heads/main');
    expect(info.mergeTarget?.tip).toMatch(/^[0-9a-f]{40}$/);
    expect(lsRemoteRef(
      info.worktreePath,
      agent,
      human.publicKey,
      repo,
      `refs/heads/${info.featureBranch}`,
    )).toBe(info.mergeTarget!.tip);

    await client.submitMergeApproval(subchannelId, info.mergeTarget!);
    const outcome = await attemptMerge({
      worker: human,
      trustedReviewer: human.publicKey,
      trustedReviewerCustody: 'device',
      repo,
      channelId: subchannelId,
      targetBranch: 'main',
      featureBranch: info.featureBranch,
    });
    expect(outcome.merged, outcome.reason).toBe(true);
    expect(await body.pollMergeCompletions()).toBe(1);
    expect(body.getSubchannels().has(subchannelId)).toBe(false);

    const metadata = await client.getChannelMetadata(subchannelId);
    expect(metadata?.archived).toBe(true);
    const continuation = `${marker}-parent-discussion-continues`;
    await client.messageSubmit(channelId, continuation);
    const history = await client.sessionEventsBackfill(channelId, { limit: 100 });
    expect(history.some((event) => event.content === continuation)).toBe(true);
    client.disconnect();
  }, 180_000);
});
