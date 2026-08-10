/**
 * Money-shot #2: a registered agent may create/push a feature branch, but its
 * own approval is refused even when it is deliberately configured as admin +
 * trusted reviewer. A human admin approval for the exact same tip then lands.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgentIdentity, createBuzzClient } from '@beeline/buzz-client';
import { buildApproval } from './approval.js';
import { announceRepo, createChannel, createCommunity, setMemberRole } from './buzz.js';
import { BASE_URL, HOST, gitRepoUrl } from './config.js';
import { git, gitAuthed, lsRemoteRef } from './git.js';
import { newIdentity, type Identity } from './identity.js';
import { publishEvent } from './relay.js';
import { attemptMerge } from './worker.js';

const RELAY_PROBE_MS = 2500;

async function relayReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(RELAY_PROBE_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const result = git(dir, ['commit', '-m', message]);
  if (!result.ok) throw new Error(`git commit failed: ${result.stderr}`);
}

async function waitRepoCloneable(
  identity: Identity,
  ownerHex: string,
  repo: string,
): Promise<void> {
  const url = gitRepoUrl(ownerHex, repo);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (gitAuthed(tmpdir(), identity, ownerHex, repo, ['ls-remote', url]).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`repo ${ownerHex}/${repo} never became cloneable`);
}

const reachable = await relayReachable();

describe.runIf(reachable)('live registered-agent merge refusal', () => {
  beforeAll(() => {
    console.log(`[agent-identity] relay reachable at ${BASE_URL} — running money-shot #2`);
  });

  it('agent approval is REFUSED and human approval for the same branch is ACCEPTED', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = newIdentity('repo-owner-worker');
    const human = newIdentity('human-admin');
    const agent = createAgentIdentity('coding-agent');
    const owner = worker.publicKey;
    const repo = `agent-identity-${runId}`;
    const url = gitRepoUrl(owner, repo);

    const communityId = await createCommunity(worker, `community-${runId}`);
    await setMemberRole(worker, communityId, agent.publicKey, 'member');
    const agentClient = createBuzzClient({
      baseUrl: BASE_URL,
      host: HOST,
      identity: agent,
    });
    await agentClient.waitUntilMember(communityId, agent.publicKey);
    const record = await agentClient.createAgent(communityId, {
      displayName: 'Coding Agent',
    });
    expect(record.pubkey).toBe(agent.publicKey);

    const channelId = await createChannel(worker, repo, { communityId });
    await setMemberRole(worker, channelId, human.publicKey, 'admin');
    // Deliberate hostile misconfiguration: role + trustedReviewer both point at
    // the agent. The identity marker must still win.
    await setMemberRole(worker, channelId, agent.publicKey, 'admin');
    await announceRepo(worker, repo, channelId);
    await waitRepoCloneable(worker, owner, repo);

    const seedDir = mkdtempSync(join(tmpdir(), 'buzzy-agent-id-seed-'));
    git(seedDir, ['init', '-q', '-b', 'main']);
    commit(seedDir, 'README.md', `# ${repo}\n`, 'initial commit');
    const seedPush = gitAuthed(seedDir, worker, owner, repo, ['push', url, 'main']);
    expect(seedPush.ok, seedPush.stderr).toBe(true);
    const mainBefore = lsRemoteRef(seedDir, worker, owner, repo, 'refs/heads/main');

    const agentRoot = mkdtempSync(join(tmpdir(), 'buzzy-agent-id-work-'));
    const clone = gitAuthed(agentRoot, agent, owner, repo, ['clone', url, 'work']);
    expect(clone.ok, clone.stderr).toBe(true);
    const work = join(agentRoot, 'work');
    const branch = `feature/agent-${runId}`;
    git(work, ['checkout', '-q', '-b', branch]);
    commit(work, 'AGENT.txt', 'work signed by the agent identity\n', 'agent: feature work');
    const featureTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
    const featurePush = gitAuthed(work, agent, owner, repo, ['push', 'origin', branch]);
    expect(featurePush.ok, featurePush.stderr).toBe(true);

    const target = {
      repo: `${owner}/${repo}`,
      branch: 'refs/heads/main',
      tip: featureTip,
    };
    await publishEvent(buildApproval(agent, channelId, target));

    const refused = await attemptMerge({
      worker,
      trustedReviewer: agent.publicKey,
      repo,
      channelId,
      targetBranch: 'main',
      featureBranch: branch,
    });
    expect(refused.merged).toBe(false);
    expect(refused.reason).toMatch(/registered agent identity; agents can never approve/i);
    expect(lsRemoteRef(seedDir, worker, owner, repo, 'refs/heads/main')).toBe(mainBefore);
    console.log(`[agent-identity] agent-approval REFUSED — ${refused.reason}`);

    await publishEvent(buildApproval(human, channelId, target));
    const accepted = await attemptMerge({
      worker,
      trustedReviewer: human.publicKey,
      repo,
      channelId,
      targetBranch: 'main',
      featureBranch: branch,
    });
    expect(accepted.merged, accepted.reason).toBe(true);
    expect(accepted.targetTipAfter).toBe(featureTip);
    console.log(`[agent-identity] human-approval ACCEPTED — branch=${branch} tip=${featureTip}`);
  }, 120_000);
});

describe.runIf(!reachable)('live registered-agent merge refusal (relay unreachable)', () => {
  it('SKIPPED — relay not reachable; start with `npm run stack:up` from repo root', () => {
    console.warn(
      `\n[agent-identity] SKIPPED: relay at ${BASE_URL} is unreachable.\n` +
        '                 Start it with: npm run stack:up   (repo root)\n' +
        '                 Then re-run:   npm run test:live  (apps/gate)\n',
    );
    expect(true).toBe(true);
  });
});
