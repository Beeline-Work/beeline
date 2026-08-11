/**
 * THE MONEY SHOT — prove the signed merge gate end to end, headless, against a
 * real Buzz relay with git hosting. Asserts on real relay/git state, not row
 * counts. Run: `npm run prove` (relay stack in relay-stack/ must be up).
 *
 * Composition under test:
 *   1. Branch protection (relay-enforced): `main` is `push:admin`; the agent is
 *      a channel Member, so the RELAY physically refuses its push to `main`.
 *   2. Merge worker (holds the only Admin/owner push identity): merges to `main`
 *      ONLY after verifying a schnorr-signed approval that binds to the exact
 *      (repo, branch, tip). No Buzz Rust was changed.
 *
 * Assertions:
 *   A. agent pushes a feature branch                    -> ALLOWED (legit member)
 *   B. agent pushes `main`                              -> REJECTED by the relay   [critical]
 *   C. worker with NO approval                          -> REFUSES
 *   D. worker with a WRONG-target approval              -> REFUSES, `main` unchanged
 *   E. worker with a VALID approval                     -> MERGES, `main` == feature tip
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newIdentity, type Identity } from '../apps/gate/src/identity.js';
import { createChannel, setMemberRole, announceRepo } from '../apps/gate/src/buzz.js';
import { buildApproval } from '../apps/gate/src/approval.js';
import { publishEvent } from '../apps/gate/src/relay.js';
import { git, gitAuthed, lsRemoteRef } from '../apps/gate/src/git.js';
import { gitRepoUrl } from '../apps/gate/src/config.js';
import { attemptMerge } from '../apps/gate/src/worker.js';

let failures = 0;
function assert(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function commit(dir: string, file: string, content: string, msg: string): void {
  writeFileSync(join(dir, file), content);
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const c = git(dir, ['commit', '-m', msg]);
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const worker = newIdentity('worker'); // repo owner; only key that can push main
  const reviewer = newIdentity('reviewer'); // the human approver
  const agent = newIdentity('agent'); // channel Member; must NOT be able to push main
  const owner = worker.publicKey;
  const repo = `gate-${Date.now().toString(36)}`;
  const url = gitRepoUrl(owner, repo);

  console.log('\n=== SETUP ===');
  console.log('repo   ', `${owner}/${repo}`);
  const channelId = await createChannel(worker, `gate-${repo}`);
  await setMemberRole(worker, channelId, reviewer.publicKey, 'admin');
  await setMemberRole(worker, channelId, agent.publicKey, 'member');
  await announceRepo(worker, repo, channelId);
  console.log('channel', channelId, '| protection: refs/heads/main push:admin no-force-push');

  // Wait until the announced repo is cloneable (empty manifest seeded).
  let ready = false;
  for (let i = 0; i < 20; i++) {
    const r = gitAuthed(tmpdir(), worker, owner, repo, ['ls-remote', url]);
    if (r.ok) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) throw new Error('repo never became cloneable after announcement');

  // Worker (owner) seeds the initial `main`.
  const seed = mkdtempSync(join(tmpdir(), 'buzzy-seed-'));
  git(seed, ['init', '-q', '-b', 'main']);
  commit(seed, 'README.md', '# gate proof\n', 'initial commit');
  const seedPush = gitAuthed(seed, worker, owner, repo, ['push', url, 'main']);
  assert(seedPush.ok, 'worker seeds main (owner push)', seedPush.ok ? '' : seedPush.stderr.trim());
  const baseMain = lsRemoteRef(seed, worker, owner, repo, 'refs/heads/main');
  console.log('base main =', baseMain);

  // === Agent makes a change in a worktree it controls (clone as the agent). ===
  console.log('\n=== AGENT WORKS (as a channel Member) ===');
  const agentRoot = mkdtempSync(join(tmpdir(), 'buzzy-agent-'));
  const cloneRes = gitAuthed(agentRoot, agent, owner, repo, ['clone', url, 'work']);
  assert(cloneRes.ok, 'agent clones the repo (member read)', cloneRes.ok ? '' : cloneRes.stderr.trim());
  const agentWork = join(agentRoot, 'work');
  const featureBranch = 'feature/agent-change';
  git(agentWork, ['checkout', '-q', '-b', featureBranch]);
  commit(agentWork, 'CHANGE.txt', 'the agent made this change\n', 'agent: make the change');
  const featureTip = git(agentWork, ['rev-parse', 'HEAD']).stdout.trim();
  console.log('feature tip =', featureTip);

  // A. Agent pushes the FEATURE branch -> allowed (legit member, branch create).
  const pushFeature = gitAuthed(agentWork, agent, owner, repo, ['push', 'origin', featureBranch]);
  assert(
    pushFeature.ok && !/rejected|denied|forbidden/i.test(pushFeature.stderr),
    'A. agent pushes feature branch -> ALLOWED',
    pushFeature.ok ? '' : pushFeature.stderr.trim(),
  );

  // B. Agent attempts to push MAIN -> the RELAY must reject it. THE critical test.
  console.log('\n=== MONEY SHOT B: unauthorized push to main ===');
  const pushMain = gitAuthed(agentWork, agent, owner, repo, ['push', 'origin', `HEAD:main`]);
  const rejected = !pushMain.ok || /rejected|denied|forbidden|push:admin|admin role/i.test(pushMain.stderr);
  assert(rejected, 'B. agent push to main -> REJECTED by relay [CRITICAL]', pushMain.stderr.trim().split('\n').slice(-2).join(' | '));
  const mainAfterAgent = lsRemoteRef(seed, worker, owner, repo, 'refs/heads/main');
  assert(mainAfterAgent === baseMain, 'B. main did NOT advance from the agent push', `main=${mainAfterAgent}`);

  // === The merge worker gates on a signed approval. ===
  const mergeReq = {
    worker,
    trustedReviewer: reviewer.publicKey,
    trustedReviewerCustody: 'device',
    repo,
    channelId,
    targetBranch: 'main',
    featureBranch,
  };

  // C. No approval yet -> worker refuses.
  console.log('\n=== MONEY SHOT C: worker with no approval ===');
  const noApproval = await attemptMerge(mergeReq);
  assert(!noApproval.merged, 'C. worker refuses with no approval', noApproval.reason);
  assert(
    lsRemoteRef(seed, worker, owner, repo, 'refs/heads/main') === baseMain,
    'C. main unchanged',
  );

  // D. WRONG-target approval (binds to the wrong tip) -> worker refuses.
  console.log('\n=== MONEY SHOT D: wrong-target approval ===');
  const wrongApproval = buildApproval(reviewer, channelId, {
    repo: `${owner}/${repo}`,
    branch: 'refs/heads/main',
    tip: baseMain!, // approves landing the OLD tip, not the feature tip
  });
  await publishEvent(wrongApproval);
  await sleep(500);
  const wrongOutcome = await attemptMerge(mergeReq);
  assert(!wrongOutcome.merged, 'D. worker refuses a wrong-target approval', wrongOutcome.reason);
  assert(
    lsRemoteRef(seed, worker, owner, repo, 'refs/heads/main') === baseMain,
    'D. main unchanged after wrong-target approval',
  );

  // E. VALID approval binding the exact feature tip -> worker merges and pushes main.
  console.log('\n=== MONEY SHOT E: valid approval lands the merge ===');
  const goodApproval = buildApproval(reviewer, channelId, {
    repo: `${owner}/${repo}`,
    branch: 'refs/heads/main',
    tip: featureTip,
  });
  await publishEvent(goodApproval);
  await sleep(500);
  const goodOutcome = await attemptMerge(mergeReq);
  assert(goodOutcome.merged, 'E. worker merges on a valid approval', goodOutcome.reason);
  const finalMain = lsRemoteRef(seed, worker, owner, repo, 'refs/heads/main');
  assert(finalMain === featureTip, 'E. main advanced to the approved feature tip', `main=${finalMain}`);

  console.log('\n=======================================');
  if (failures === 0) {
    console.log('GATE PROVEN: unapproved merge impossible; approved merge landed.');
  } else {
    console.log(`GATE NOT PROVEN: ${failures} assertion(s) failed.`);
  }
  console.log('=======================================\n');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('money-shot crashed:', e);
  process.exit(1);
});
