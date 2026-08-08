/**
 * UI demo provisioner: creates parent+subchannel+merge target on the live relay,
 * generates a reviewer identity for the mobile UI to import.
 *
 * Outputs: NSEC (import into mobile app), parent/subchannel IDs for UI navigation.
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
  git,
  gitAuthed,
  lsRemoteRef,
  gitRepoUrl,
  BASE_URL,
  HOST,
  publishEvent,
  buildApproval,
  attemptMerge,
} from '@buzzy/gate';
import {
  createIdentity,
  identityNpub,
  identityNsec,
  createSubchannel as buzzCreateSubchannel,
} from '@buzzy/buzz-client';
import { signEvent } from '@buzzy/nostr';

const RUN_MARKER = `uidemo-${randomUUID().slice(0, 8)}`;

function log(...args: unknown[]) { console.log(`[ui-demo]`, ...args); }
function commit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const c = git(dir, ['commit', '-m', msg]);
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr}`);
}

async function main() {
  const res = await fetch(`${BASE_URL}/health`, { headers: { host: HOST }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) { log('Relay unreachable'); process.exit(1); }

  // ── Identities ────────────────────────────────────────────────────
  const owner = createIdentity('ui-demo-owner');   // push identity
  const reviewer = createIdentity('ui-demo-reviewer'); // review identity for UI
  const agent = newIdentity('ui-demo-agent');
  log('Owner npub:', identityNpub(owner));
  log('Reviewer npub:', identityNpub(reviewer));
  log('Reviewer nsec:', identityNsec(reviewer));

  // ── 1. Create parent TLC channel ──────────────────────────────────
  const repo = `ui-demo-${RUN_MARKER}`;
  const parentChannelId = await createChannel(owner, repo);
  log('Parent channel:', parentChannelId);

  await setMemberRole(owner, parentChannelId, owner.publicKey, 'owner');
  await setMemberRole(owner, parentChannelId, reviewer.publicKey, 'admin');
  await setMemberRole(owner, parentChannelId, agent.publicKey, 'member');
  await announceRepo(owner, repo, parentChannelId);

  // ── 2. Create subchannel with parent tag (like body does) ─────────
  // The key fix: createSubchannel sets parent tag on the 9007 create event
  const subchannelId = await buzzCreateSubchannel(
    { http: { baseUrl: BASE_URL, host: HOST }, identity: owner },
    parentChannelId,
    `sub-${RUN_MARKER}`,
  );
  log('Subchannel:', subchannelId);

  // Mirror members
  await setMemberRole(owner, subchannelId, owner.publicKey, 'owner');
  await setMemberRole(owner, subchannelId, reviewer.publicKey, 'admin');
  await setMemberRole(owner, subchannelId, agent.publicKey, 'member');
  log('Subchannel members mirrored');

  // ── 3. Seed repo + push feature branch ────────────────────────────
  const repoUrl = gitRepoUrl(owner.publicKey, repo);
  const seedDir = mkdtempSync(join(tmpdir(), 'buzzy-ui-seed-'));
  git(seedDir, ['init', '-q', '-b', 'main']);
  commit(seedDir, 'README.md', `# ${repo}\n`, 'init');
  const seedPush = gitAuthed(seedDir, owner, owner.publicKey, repo, ['push', repoUrl, 'main']);
  if (!seedPush.ok) throw new Error('seed push failed: ' + seedPush.stderr);
  await new Promise(r => setTimeout(r, 1000));

  const featureBranch = `feature/${RUN_MARKER}`;
  const agentDir = mkdtempSync(join(tmpdir(), 'buzzy-ui-agent-'));
  const agentClone = gitAuthed(agentDir, agent, owner.publicKey, repo, ['clone', repoUrl, 'work']);
  if (!agentClone.ok) throw new Error('clone failed');
  const work = join(agentDir, 'work');
  git(work, ['checkout', '-q', '-b', featureBranch]);
  commit(work, 'FEATURE.md', `# Feature ${RUN_MARKER}\n`, `feat: ${RUN_MARKER}`);
  const featureTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const pushFeature = gitAuthed(work, agent, owner.publicKey, repo, ['push', 'origin', featureBranch]);
  if (!pushFeature.ok) throw new Error('push failed: ' + pushFeature.stderr);
  log('Feature tip:', featureTip);

  // ── 4. Post subchannel control messages with merge target ─────────
  const repoId = `${owner.publicKey}/${repo}`;

  // To subchannel (intro message with merge target - what getSubchannelMergeTarget reads)
  const subIntro = signEvent({
    pubkey: owner.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [
      ['h', subchannelId], ['t', 'body-control'],
      ['session', `ses_${RUN_MARKER}`],
      ['parent', parentChannelId], ['mode', 'edit'],
      ['repo', repoId], ['branch', featureBranch], ['tip', featureTip],
    ],
    content: `🤖 Edit session started — branch=${featureBranch} tip=${featureTip.slice(0, 12)}…`,
  }, owner.secretKey);
  await publishEvent(subIntro);
  log('Subchannel intro with merge target posted');

  // To parent (subchannel link - for UI to render as navigable)
  const parentLink = signEvent({
    pubkey: owner.publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [
      ['h', parentChannelId], ['t', 'body-control'],
      ['subchannel', subchannelId], ['session', `ses_${RUN_MARKER}`],
      ['branch', featureBranch], ['mode', 'edit'],
      ['repo', repoId], ['tip', featureTip],
    ],
    content: `🛠 Edit session opened — subchannel=${subchannelId} branch=${featureBranch}`,
  }, owner.secretKey);
  await publishEvent(parentLink);
  log('Parent link message posted');

  // Wait for propagation
  await new Promise(r => setTimeout(r, 2000));

  // ── 5. Output for the UI demo ─────────────────────────────────────
  console.log(`\n=== UI DEMO SETUP COMPLETE ===`);
  console.log(`REVIEWER_NSEC=${identityNsec(reviewer)}`);
  console.log(`PARENT_ID=${parentChannelId}`);
  console.log(`SUBCHANNEL_ID=${subchannelId}`);
  console.log(`REPO=${repoId}`);
  console.log(`FEATURE_BRANCH=${featureBranch}`);
  console.log(`FEATURE_TIP=${featureTip}`);
  console.log(`RUN_MARKER=${RUN_MARKER}`);
}

main().catch(e => { console.error(e); process.exit(1); });