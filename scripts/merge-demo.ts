/**
 * P2 merge demo — REAL merge against the live relay via the gate worker.
 *
 * This script exercises the complete merge flow end to end:
 *   1. Provision channel + repo (branch protection: push:admin on main).
 *   2. Seed main branch with initial commit.
 *   3. Push a feature branch with a commit (simulating agent work).
 *   4. Post subchannel-open control messages with merge target tags
 *      (repo/branch/tip) — as the body would.
 *   5. POSITIVE: owner builds + publishes approval (as the Approve button
 *      in the UI does), then runs the gate attemptMerge → worker lands
 *      the merge and main moves to featureTip. Assert via ls-remote.
 *   6. Post merge-summary to parent and archive subchannel.
 *   7. NEGATIVE: non-owner builds + publishes approval → attemptMerge
 *      REFUSES and main unchanged. Assert via ls-remote.
 *
 * Pre-requisites: running relay stack (`npm run stack:up` at repo root).
 *   Optionally: BUZZ_AGENT_BIN, BUZZ_DEV_MCP_BIN for body (not needed for
 *   merge-demo — the commit is scripted).
 *
 * Usage:
 *   npx tsx scripts/merge-demo.ts
 *
 * Run markers enable grepping the transcript.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newIdentity,
  createChannel,
  setMemberRole,
  announceRepo,
  publishEvent,
  queryEvents,
  attemptMerge,
  buildApproval,
  verifyApproval,
  git,
  gitAuthed,
  lsRemoteRef,
  gitRepoUrl,
  BASE_URL,
  HOST,
  KIND_STREAM_MESSAGE,
  type Identity,
} from '@buzzy/gate';
import { signEvent, type NostrEvent } from '@buzzy/nostr';
import { encodeNpub } from '@buzzy/buzz-client';

const RUN_MARKER = `demo-${randomUUID().slice(0, 8)}`;
let ASSERT_FAILURES = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    ASSERT_FAILURES++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function log(...args: unknown[]): void {
  console.log(`[demo][${RUN_MARKER}]`, ...args);
}

async function relayReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitRepoCloneable(
  identity: Identity,
  ownerHex: string,
  repo: string,
): Promise<void> {
  const url = gitRepoUrl(ownerHex, repo);
  for (let i = 0; i < 30; i++) {
    const r = gitAuthed(tmpdir(), identity, ownerHex, repo, ['ls-remote', url]);
    if (r.ok) return;
    await sleep(500);
  }
  throw new Error(`repo ${ownerHex}/${repo} never became cloneable`);
}

function uniqueRepoName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function commit(dir: string, file: string, content: string, msg: string): void {
  writeFileSync(join(dir, file), content);
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const c = git(dir, ['commit', '-m', msg]);
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr}`);
}

async function main(): Promise<void> {
  log('=== P2 REAL MERGE DEMO ===');
  log('Run marker:', RUN_MARKER);
  log('Host:', HOST);
  log('Relay URL:', BASE_URL);

  // ── Pre-check ────────────────────────────────────────────────────
  if (!(await relayReachable())) {
    log('SKIP: relay not reachable at', BASE_URL);
    log('Start the stack with: npm run stack:up');
    console.log('\n[RESULT] SKIPPED — relay unreachable');
    process.exit(0);
  }
  log('Relay reachable');

  // ── Identities ───────────────────────────────────────────────────
  const owner = newIdentity('demo-owner');     // = worker (can push main via ACL)
  const reviewer = newIdentity('demo-reviewer'); // = human with admin role
  const nonOwner = newIdentity('demo-non-owner');
  const agent = newIdentity('demo-agent');      // = member, can push feature branches

  log('Owner (worker)  :', encodeNpub(owner.publicKey));
  log('Reviewer (human):', encodeNpub(reviewer.publicKey));
  log('Agent           :', encodeNpub(agent.publicKey));
  log('Non-owner       :', encodeNpub(nonOwner.publicKey));

  // ── 1. Provision channel + repo + branch protection ──────────────
  log('\n--- 1. Provision ---');
  const repo = uniqueRepoName('merge-demo');
  const channelId = await createChannel(owner, repo);
  log(`Channel: ${channelId}`);
  log(`Repo:    ${owner.publicKey}/${repo}`);

  await setMemberRole(owner, channelId, reviewer.publicKey, 'admin');
  await setMemberRole(owner, channelId, agent.publicKey, 'member');
  await setMemberRole(owner, channelId, nonOwner.publicKey, 'member');
  log('Members set: reviewer=admin, agent=member, nonOwner=member');

  await announceRepo(owner, repo, channelId);
  log('Repo announced (main push:admin, no-force-push)');

  await waitRepoCloneable(owner, owner.publicKey, repo);
  const url = gitRepoUrl(owner.publicKey, repo);
  log('Repo cloneable');

  // Seed main
  const seedDir = mkdtempSync(join(tmpdir(), 'buzzy-demo-seed-'));
  git(seedDir, ['init', '-q', '-b', 'main']);
  commit(seedDir, 'README.md', `# ${repo}\n`, 'initial commit');
  const seedPush = gitAuthed(seedDir, owner, owner.publicKey, repo, ['push', url, 'main']);
  assert('seed push to main succeeds', seedPush.ok, seedPush.stderr);
  if (seedPush.ok) log('Main seeded with initial commit');
  else { console.log('\n[RESULT] FAIL — seed push failed'); process.exit(1); }

  const mainTipBefore = lsRemoteRef(seedDir, owner, owner.publicKey, repo, 'refs/heads/main');
  assert('main tip resolved', !!mainTipBefore && /^[0-9a-f]{40}$/.test(mainTipBefore!));
  log('Main tip before:', mainTipBefore);

  // ── 2. Push feature branch (simulating agent work) ───────────────
  log('\n--- 2. Push feature branch ---');
  const featureBranch = `feature/${RUN_MARKER}`;
  const agentWorkDir = mkdtempSync(join(tmpdir(), 'buzzy-demo-agent-'));
  const agentClone = gitAuthed(agentWorkDir, agent, owner.publicKey, repo, ['clone', url, 'work']);
  assert('agent can clone repo', agentClone.ok, agentClone.stderr);
  if (!agentClone.ok) { console.log('\n[RESULT] FAIL'); process.exit(1); }

  const agentWork = join(agentWorkDir, 'work');
  git(agentWork, ['checkout', '-q', '-b', featureBranch]);
  commit(agentWork, 'CHANGE.txt', `agent change for ${RUN_MARKER}\n`, `[demo] ${RUN_MARKER}`);
  const featureTip = git(agentWork, ['rev-parse', 'HEAD']).stdout.trim();
  log('Feature tip:', featureTip);

  const pushFeature = gitAuthed(agentWork, agent, owner.publicKey, repo, ['push', 'origin', featureBranch]);
  assert('agent can push feature branch', pushFeature.ok, pushFeature.stderr);
  if (!pushFeature.ok) { console.log('\n[RESULT] FAIL'); process.exit(1); }

  // Verify feature is NOT on main
  const mainMid = lsRemoteRef(seedDir, owner, owner.publicKey, repo, 'refs/heads/main');
  assert('main unchanged after feature push', mainMid === mainTipBefore);

  // ── 3. Post subchannel-open control messages (as the body does) ──
  log('\n--- 3. Post subchannel control messages ---');
  const repoId = `${owner.publicKey}/${repo}`;
  const mergeTarget = { repo: repoId, branch: 'refs/heads/main', tip: featureTip };

  // Post to subchannel's own message list (what getSubchannelMergeTarget reads)
  const subControl = signEvent({
    pubkey: owner.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [
      ['h', channelId],     // same channel for simplicity; real body uses child
      ['t', 'body-control'],
      ['repo', repoId],
      ['branch', featureBranch],
      ['tip', featureTip],
      ['mode', 'edit'],
    ],
    content: `🤖 Edit session started — branch=${featureBranch} tip=${featureTip.slice(0, 12)}…`,
  }, owner.secretKey);
  await publishEvent(subControl);
  log('Control message posted with merge target tags');

  // ── 4. POSITIVE: owner approval → worker merges → main moves ─────
  log('\n--- 4. POSITIVE: owner/reviewer approval → merge lands ---');

  // 4a. Build + publish approval (what the UI Approve button does)
  const ownerApproval = buildApproval(reviewer, channelId, mergeTarget);
  const ownerVerify = verifyApproval(ownerApproval, reviewer.publicKey, mergeTarget);
  assert('owner approval verification passes', ownerVerify);

  // Publish it (as submitMergeApproval does)
  await publishEvent(ownerApproval);
  log('Owner approval published to relay');
  await sleep(1000);

  // 4b. Run the gate worker (attemptMerge)
  const mergeOutcome = await attemptMerge({
    worker: owner,
    trustedReviewer: reviewer.publicKey,
    repo,
    channelId,
    targetBranch: 'main',
    featureBranch,
  });

  assert('worker merged successfully', mergeOutcome.merged, mergeOutcome.reason);
  if (mergeOutcome.merged) {
    log(`  featureTip = ${featureTip}`);
    log(`  targetTipAfter = ${mergeOutcome.targetTipAfter}`);
  } else {
    log(`  worker refused: ${mergeOutcome.reason}`);
  }

  // 4c. Verify main MOVED via ls-remote
  const mainAfterOwner = lsRemoteRef(seedDir, owner, owner.publicKey, repo, 'refs/heads/main');
  assert('main moved to feature tip', mainAfterOwner === featureTip,
    `expected ${featureTip}, got ${mainAfterOwner}`);
  log('Main after merge:', mainAfterOwner);

  // ── 5. Post merge summary + archive to subchannel ────────────────
  log('\n--- 5. Post merge-summary + archive ---');

  // Merge summary to parent (same channel in this demo)
  const summaryEvent = signEvent({
    pubkey: owner.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [
      ['h', channelId],
      ['t', 'merge-summary'],
      ['subchannel', channelId],
    ],
    content: `✅ Merged ${featureBranch} → main (${featureTip.slice(0, 12)}…)`,
  }, owner.secretKey);
  await publishEvent(summaryEvent);
  log('Merge-summary posted');

  // Archive status to subchannel
  const archiveEvent = signEvent({
    pubkey: owner.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [
      ['h', channelId],
      ['t', 'body-control'],
      ['status', 'archived'],
    ],
    content: '📦 Subchannel archived — read-only',
  }, owner.secretKey);
  await publishEvent(archiveEvent);
  log('Archive status posted');

  // ── 6. Verify UI states in relay data ────────────────────────────
  log('\n--- 6. Verify UI states ---');

  // Check merge-summary exists
  const parentMsgs = await queryEvents(
    [{ kinds: [9], '#h': [channelId], limit: 30 }],
    owner.publicKey,
  );
  const summaryFound = parentMsgs.find((evt: NostrEvent) =>
    evt.tags.some((t: string[]) => t[0] === 't' && t[1] === 'merge-summary'),
  );
  assert('merge-summary found in channel', !!summaryFound);

  const archivedFound = parentMsgs.find((evt: NostrEvent) =>
    evt.tags.some((t: string[]) => t[0] === 'status' && t[1] === 'archived'),
  );
  assert('archived status found in channel', !!archivedFound);

  const controlWithMergeTarget = parentMsgs.find((evt: NostrEvent) =>
    evt.tags.some((t: string[]) => t[0] === 't' && t[1] === 'body-control')
    && evt.tags.some((t: string[]) => t[0] === 'tip'),
  );
  assert('control message with merge target tip exists', !!controlWithMergeTarget);

  // ── 7. NEGATIVE: non-owner approval → worker REFUSES → main unchanged ──
  log('\n--- 7. NEGATIVE: non-owner approval → worker REFUSES ---');

  // Push another feature branch for the negative test
  const negFeatureBranch = `feature/neg-${RUN_MARKER}`;
  const negWorkDir = mkdtempSync(join(tmpdir(), 'buzzy-demo-neg-'));
  const negClone = gitAuthed(negWorkDir, agent, owner.publicKey, repo, ['clone', url, 'work']);
  assert('agent can clone for negative test', negClone.ok, negClone.stderr);
  const negWork = join(negWorkDir, 'work');
  git(negWork, ['checkout', '-q', '-b', negFeatureBranch]);
  commit(negWork, 'NEG.txt', 'negative test\n', `[demo-neg] ${RUN_MARKER}`);
  const negTip = git(negWork, ['rev-parse', 'HEAD']).stdout.trim();
  const pushNeg = gitAuthed(negWork, agent, owner.publicKey, repo, ['push', 'origin', negFeatureBranch]);
  assert('agent can push neg feature branch', pushNeg.ok, pushNeg.stderr);

  const negTarget = {
    repo: repoId,
    branch: 'refs/heads/main',
    tip: negTip,
  };

  // Non-owner builds + publishes approval (what a non-owner Approve button press would do)
  const nonOwnerApproval = buildApproval(nonOwner, channelId, negTarget);
  const nonOwnerVerify = verifyApproval(nonOwnerApproval, reviewer.publicKey, negTarget);
  assert('non-owner approval fails verification against reviewer pubkey', !nonOwnerVerify,
    'non-owner signed but worker checks reviewer.publicKey');

  // Publish anyway
  await publishEvent(nonOwnerApproval);
  log('Non-owner approval published to relay');
  await sleep(1000);

  // Worker attempts merge — must REFUSE
  const negOutcome = await attemptMerge({
    worker: owner,
    trustedReviewer: reviewer.publicKey,
    repo,
    channelId,
    targetBranch: 'main',
    featureBranch: negFeatureBranch,
  });

  assert('worker REFUSED non-owner approval', !negOutcome.merged, negOutcome.reason);
  log(`  worker said: ${negOutcome.reason}`);

  // Verify main is still at featureTip (from the positive test), unchanged
  const mainAfterNeg = lsRemoteRef(seedDir, owner, owner.publicKey, repo, 'refs/heads/main');
  assert('main UNCHANGED after negative test', mainAfterNeg === featureTip,
    `expected ${featureTip}, got ${mainAfterNeg}`);
  log('Main after negative test:', mainAfterNeg);

  // ── Summary ──────────────────────────────────────────────────────
  log('\n=== DEMO COMPLETE ===');
  log('Run marker:', RUN_MARKER);
  log(`Channel: ${channelId}`);
  log(`Repo:    ${owner.publicKey}/${repo}`);
  log(`Main tip before:  ${mainTipBefore}`);
  log(`Feature tip:      ${featureTip}`);
  log(`Main tip after:   ${mainAfterOwner}`);
  log(`Neg feature tip:  ${negTip}`);

  if (ASSERT_FAILURES > 0) {
    console.log(`\n[RESULT] FAIL — ${ASSERT_FAILURES} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\n[RESULT] PASS — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[RESULT] FAIL — demo error:', err);
  process.exit(1);
});