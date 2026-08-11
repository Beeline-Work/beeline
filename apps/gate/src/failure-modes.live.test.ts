/**
 * Live failure-mode test suite — tests 1-3 from spec.md failure modes.
 *
 *   1. Agent's OWN key accepted as merge approval → MUST REFUSE.
 *      Positive control: same approval signed by the human reviewer → merges.
 *   2. Worker polls before any approval published → refuse; publish valid
 *      approval afterwards → merges. Assert `main` unchanged before, changed
 *      after.
 *   3. Approval replay / wrong-target: (a) different repo, (b) same repo
 *      different tip (second commit pushed after approval signed), (c) replay
 *      the same approval after main already moved → refuse each.
 *
 * Reuses provisionFresh from push-rights.live.test.ts (same pattern) and the
 * attemptMerge + buildApproval + verifyApproval infrastructure.
 *
 * Requires the real Buzz relay stack (`npm run stack:up` from repo root).
 * Run with: cd apps/gate && npm run test:live
 * If the relay is unreachable the suite exits 0 with a clear skip message.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { newIdentity, type Identity } from './identity.js';
import { buildApproval } from './approval.js';
import { publishEvent } from './relay.js';
import { createChannel, setMemberRole, announceRepo } from './buzz.js';
import { git, gitAuthed, lsRemoteRef } from './git.js';
import { gitRepoUrl, BASE_URL, HOST } from './config.js';
import { attemptMerge } from './worker.js';

const RELAY_PROBE_MS = 2500;

async function relayReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(RELAY_PROBE_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function commit(dir: string, file: string, content: string, msg: string): void {
  writeFileSync(join(dir, file), content);
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const c = git(dir, ['commit', '-m', msg]);
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr}`);
}

async function waitRepoCloneable(
  identity: Identity,
  ownerHex: string,
  repo: string,
): Promise<void> {
  const url = gitRepoUrl(ownerHex, repo);
  for (let i = 0; i < 20; i++) {
    const r = gitAuthed(tmpdir(), identity, ownerHex, repo, ['ls-remote', url]);
    if (r.ok) return;
    await sleep(500);
  }
  throw new Error(`repo ${ownerHex}/${repo} never became cloneable`);
}

/** Unique short id so parallel live runs never collide. */
function uniqueRepoName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Provisioned {
  worker: Identity;
  reviewer: Identity;
  agent: Identity;
  owner: string;
  repo: string;
  channelId: string;
  url: string;
  seedDir: string;
  baseMain: string;
}

/**
 * Provision a fresh channel+repo with the standard Buzzy ACL:
 * worker=owner, reviewer=admin, agent=member, main push:admin.
 * Seeds `main` with an initial commit.
 */
async function provisionFresh(prefix: string): Promise<Provisioned> {
  const worker = newIdentity('worker');
  const reviewer = newIdentity('reviewer');
  const agent = newIdentity('agent');
  const owner = worker.publicKey;
  const repo = uniqueRepoName(prefix);
  const url = gitRepoUrl(owner, repo);

  const channelId = await createChannel(worker, repo);
  await setMemberRole(worker, channelId, reviewer.publicKey, 'admin');
  await setMemberRole(worker, channelId, agent.publicKey, 'member');
  await announceRepo(worker, repo, channelId);
  await waitRepoCloneable(worker, owner, repo);

  const seedDir = mkdtempSync(join(tmpdir(), 'buzzy-live-seed-'));
  git(seedDir, ['init', '-q', '-b', 'main']);
  commit(seedDir, 'README.md', `# ${repo}\n`, 'initial commit');
  const seedPush = gitAuthed(seedDir, worker, owner, repo, ['push', url, 'main']);
  if (!seedPush.ok) {
    throw new Error(`owner seed push failed: ${seedPush.stderr}`);
  }
  const baseMain = lsRemoteRef(seedDir, worker, owner, repo, 'refs/heads/main');
  if (!baseMain || !/^[0-9a-f]{40}$/.test(baseMain)) {
    throw new Error(`could not resolve seeded main tip: ${baseMain}`);
  }

  return { worker, reviewer, agent, owner, repo, channelId, url, seedDir, baseMain };
}

/**
 * Push a feature branch and return the feature tip hash.
 */
async function pushFeatureBranch(
  agent: Identity,
  worker: Identity,
  owner: string,
  repo: string,
  url: string,
  branchName: string,
): Promise<{ featureTip: string; workDir: string }> {
  const agentRoot = mkdtempSync(join(tmpdir(), 'buzzy-agent-'));
  const cloneRes = gitAuthed(agentRoot, agent, owner, repo, ['clone', url, 'work']);
  if (!cloneRes.ok) throw new Error(`agent clone failed: ${cloneRes.stderr}`);
  const work = join(agentRoot, 'work');
  git(work, ['checkout', '-q', '-b', branchName]);
  commit(work, 'CHANGE.txt', `agent change for ${branchName}\n`, `agent: ${branchName}`);
  const featureTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const pushFeature = gitAuthed(work, agent, owner, repo, ['push', 'origin', branchName]);
  if (!pushFeature.ok || /rejected|denied|forbidden/i.test(pushFeature.stderr)) {
    throw new Error(`agent push failed: ${pushFeature.stderr}`);
  }
  return { featureTip, workDir: work };
}

const reachable = await relayReachable();

(reachable ? describe : describe.skip)('live failure-mode suite (tests 1-3)', () => {
  beforeAll(() => {
    console.log(`[live-failure] relay reachable at ${BASE_URL} — running suite`);
  });

  // ── Test 1: Agent's own key accepted as merge approval ──────────────
  it(
    '1a. approval signed by AGENT key (not the trusted reviewer) is REFUSED and main unchanged',
    async () => {
      const p = await provisionFresh('fm1');
      const branch = 'feature/fm1-agent-approval';

      const { featureTip } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch,
      );

      const target = {
        repo: `${p.owner}/${p.repo}`,
        branch: 'refs/heads/main',
        tip: featureTip,
      };

      // Build approval signed by the AGENT key, not the reviewer.
      const agentApproval = buildApproval(p.agent, p.channelId, target);
      await publishEvent(agentApproval);
      await sleep(500);

      const outcome = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(outcome.merged).toBe(false);
      expect(outcome.reason).toMatch(/no valid approval/i);

      const mainAfter = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter).toBe(p.baseMain);
    },
    120_000,
  );

  it(
    '1b. POSITIVE CONTROL: same approval signed by the HUMAN REVIEWER key DOES merge',
    async () => {
      const p = await provisionFresh('fm1b');
      const branch = 'feature/fm1b-reviewer-approval';

      const { featureTip } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch,
      );

      const target = {
        repo: `${p.owner}/${p.repo}`,
        branch: 'refs/heads/main',
        tip: featureTip,
      };

      // Valid approval signed by the TRUSTED reviewer.
      const validApproval = buildApproval(p.reviewer, p.channelId, target);
      await publishEvent(validApproval);
      await sleep(500);

      const outcome = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(outcome.merged).toBe(true);
      expect(outcome.featureTip).toBe(featureTip);
      expect(outcome.targetTipAfter).toBe(featureTip);

      const mainAfter = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter).toBe(featureTip);
    },
    120_000,
  );

  // ── Test 2: Merge before the grant lands (race) ─────────────────────
  it(
    '2a. no approval published → worker refuses and main unchanged',
    async () => {
      const p = await provisionFresh('fm2a');
      const branch = 'feature/fm2a-no-approval';

      const { featureTip } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch,
      );

      // No approval published — worker must refuse.
      const outcome = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(outcome.merged).toBe(false);
      expect(outcome.reason).toMatch(/no valid approval/i);
      const mainAfter = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter).toBe(p.baseMain);
    },
    120_000,
  );

  it(
    '2b. publish valid approval AFTER the initial refusal → merge succeeds',
    async () => {
      const p = await provisionFresh('fm2b');
      const branch = 'feature/fm2b-late-approval';

      const { featureTip } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch,
      );

      const target = {
        repo: `${p.owner}/${p.repo}`,
        branch: 'refs/heads/main',
        tip: featureTip,
      };

      // No approval yet.
      const initial = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(initial.merged).toBe(false);
      const mainMid = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainMid).toBe(p.baseMain);

      // Now publish the valid approval.
      const validApproval = buildApproval(p.reviewer, p.channelId, target);
      await publishEvent(validApproval);
      await sleep(500);

      const afterApproval = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(afterApproval.merged).toBe(true);
      expect(afterApproval.targetTipAfter).toBe(featureTip);

      const mainAfter = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter).toBe(featureTip);
    },
    120_000,
  );

  // ── Test 3: Approval replay / wrong-target ──────────────────────────
  it(
    '3a. approval for repo A does NOT authorize merge B (different repo)',
    async () => {
      const p = await provisionFresh('fm3a');
      const branch = 'feature/fm3a-wrong-repo';

      const { featureTip } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch,
      );

      // Target with a DIFFERENT repo (same owner, wrong repo name).
      const wrongTarget = {
        repo: `${p.owner}/different-repo-name`,
        branch: 'refs/heads/main',
        tip: featureTip,
      };

      const wrongApproval = buildApproval(p.reviewer, p.channelId, wrongTarget);
      await publishEvent(wrongApproval);
      await sleep(500);

      const outcome = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(outcome.merged).toBe(false);
      expect(outcome.reason).toMatch(/no valid approval/i);

      const mainAfter = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter).toBe(p.baseMain);
    },
    120_000,
  );

  it(
    '3b. stale-tip approval (second commit pushed after signing) is REFUSED',
    async () => {
      const p = await provisionFresh('fm3b');
      const branch = 'feature/fm3b-stale-tip';

      const { featureTip: firstTip } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch,
      );

      // Build approval for the first tip.
      const target = {
        repo: `${p.owner}/${p.repo}`,
        branch: 'refs/heads/main',
        tip: firstTip,
      };
      const approval = buildApproval(p.reviewer, p.channelId, target);
      await publishEvent(approval);

      // Now push a second commit to the feature branch (changes tip).
      const agentRoot = mkdtempSync(join(tmpdir(), 'buzzy-agent-3b-'));
      const cloneRes = gitAuthed(agentRoot, p.agent, p.owner, p.repo, ['clone', p.url, 'work']);
      expect(cloneRes.ok, cloneRes.stderr).toBe(true);
      const work = join(agentRoot, 'work');
      git(work, ['fetch', 'origin', branch]);
      git(work, ['checkout', branch]);
      commit(work, 'SECOND.txt', 'second commit\n', 'agent: second commit');
      const secondTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
      const pushSecond = gitAuthed(work, p.agent, p.owner, p.repo, ['push', 'origin', branch]);
      expect(pushSecond.ok, pushSecond.stderr).toBe(true);

      // The approval binds to firstTip, NOT secondTip. Worker must refuse.
      const outcome = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch,
      });

      expect(outcome.merged).toBe(false);
      expect(outcome.reason).toMatch(/no valid approval/i);
      // The worker's featureTip should now be the second tip.
      expect(outcome.featureTip).toBe(secondTip);

      const mainAfter = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter).toBe(p.baseMain);
    },
    120_000,
  );

  it(
    '3c. replaying same approval after main advanced is REFUSED (tip mismatch)',
    async () => {
      // Use a single channel+repo for two sequential merges to test replay.
      const p = await provisionFresh('fm3c');
      const branch1 = 'feature/fm3c-first';
      const branch2 = 'feature/fm3c-second';

      // First merge: push feature 1, approve, land it.
      const { featureTip: tip1 } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch1,
      );

      const target1 = {
        repo: `${p.owner}/${p.repo}`,
        branch: 'refs/heads/main',
        tip: tip1,
      };
      const approval1 = buildApproval(p.reviewer, p.channelId, target1);
      await publishEvent(approval1);
      await sleep(500);

      const merge1 = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch1,
      });
      expect(merge1.merged).toBe(true);

      const mainAfter1 = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfter1).toBe(tip1);

      // Now push feature 2 (new branch from updated main).
      const { featureTip: tip2 } = await pushFeatureBranch(
        p.agent, p.worker, p.owner, p.repo, p.url, branch2,
      );

      // Try to use the OLD approval (approval1) for the new feature branch.
      // approval1 binds to `tip1`, not `tip2` — must refuse.
      // We also try replaying with branch2's target but tip1 — wrong tip.
      // However, the replay attack is: the stored approval1 is found and
      // bound to tip1, but the worker is trying to land tip2. So the
      // approval doesn't match the feature tip.
      const replayOutcome = await attemptMerge({
        worker: p.worker,
        trustedReviewer: p.reviewer.publicKey,
        repo: p.repo,
        channelId: p.channelId,
        targetBranch: 'main',
        featureBranch: branch2,
      });

      expect(replayOutcome.merged).toBe(false);
      expect(replayOutcome.reason).toMatch(/no valid approval/i);
      expect(replayOutcome.featureTip).toBe(tip2);

      const mainAfterReplay = lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
      expect(mainAfterReplay).toBe(tip1);
    },
    120_000,
  );
});
