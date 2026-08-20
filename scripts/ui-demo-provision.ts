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
} from '@beeline/gate';
import {
  createIdentity,
  createAgent,
  createChannel as buzzCreateChannel,
  createCommunity,
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_MANIFEST_TAG,
  CHANGE_REVIEW_VERSION,
  identityNpub,
  identityNsec,
  loadIdentityFromNsec,
  createSubchannel as buzzCreateSubchannel,
  sendMessage,
  setAgentSoul,
  waitUntilMember,
} from '@beeline/buzz-client';
import {
  chunkChangeReviewPatch,
  listChangeReviewFiles,
  postChangeReviewMetadata,
  readChangeReviewPatch,
  resolveReviewBaseTip,
} from '@beeline/body';
import { signEvent } from '@beeline/nostr';

const RUN_MARKER = `uidemo-${randomUUID().slice(0, 8)}`;

function log(...args: unknown[]) {
  console.log(`[ui-demo]`, ...args);
}
function commit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  const add = git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const c = git(dir, ['commit', '-m', msg]);
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr}`);
}

async function postFixtureEvent(
  channelId: string,
  identity: ReturnType<typeof newIdentity>,
  content: string,
  tags: string[][],
  createdAt: number,
) {
  await publishEvent(
    signEvent(
      {
        pubkey: identity.publicKey,
        created_at: createdAt,
        kind: 9,
        tags: [['h', channelId], ...tags],
        content,
      },
      identity.secretKey,
    ),
    identity,
  );
}

async function postActivityFixture(
  channelId: string,
  agent: ReturnType<typeof newIdentity>,
  sessionId: string,
  update: Record<string, unknown>,
  createdAt: number,
) {
  await postFixtureEvent(
    channelId,
    agent,
    JSON.stringify({ sessionId, update, projected: true }),
    [
      ['t', 'agent-activity'],
      ['session', sessionId],
    ],
    createdAt,
  );
}

async function main() {
  const res = await fetch(`${BASE_URL}/health`, {
    headers: { host: HOST },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    log('Relay unreachable');
    process.exit(1);
  }

  // ── Identities ────────────────────────────────────────────────────
  const owner = createIdentity('ui-demo-owner'); // push identity
  const reviewer = process.env.BUZZY_UI_REVIEWER_NSEC
    ? loadIdentityFromNsec(process.env.BUZZY_UI_REVIEWER_NSEC, 'ui-demo-reviewer')
    : createIdentity('ui-demo-reviewer'); // review identity for UI
  const agent = newIdentity('ui-demo-agent');
  const channelContext = {
    http: { baseUrl: BASE_URL, host: HOST, identity: owner },
    identity: owner,
  };
  const agentContext = {
    http: { baseUrl: BASE_URL, host: HOST, identity: agent },
    identity: agent,
  };
  log('Owner npub:', identityNpub(owner));
  log('Reviewer npub:', identityNpub(reviewer));
  log('Reviewer nsec:', identityNsec(reviewer));

  // ── 1. Create a Workspace-linked parent Room ──────────────────────
  const repo = `ui-demo-${RUN_MARKER}`;
  const communityId = await createCommunity(channelContext, 'Corners UX Review');
  await setMemberRole(owner, communityId, reviewer.publicKey, 'member');
  await setMemberRole(owner, communityId, agent.publicKey, 'member');
  await waitUntilMember(agentContext, communityId, agent.publicKey);
  await createAgent(agentContext, communityId, { displayName: 'Ada' });
  await setAgentSoul(channelContext, communityId, agent.publicKey, {
    name: 'Ada',
    soul: 'Keeps the suite green and cuts dead code without ceremony. Keep the test suite green and refactor mercilessly.',
    avatarSeed: 'ada-soul',
  });
  const parentChannelId = await buzzCreateChannel(channelContext, repo, {
    communityId,
    repository: { key: repo, name: repo, localOnly: false },
  });
  log('Workspace:', communityId);
  log('Parent channel:', parentChannelId);

  await setMemberRole(owner, parentChannelId, owner.publicKey, 'owner');
  await setMemberRole(owner, parentChannelId, reviewer.publicKey, 'admin');
  await setMemberRole(owner, parentChannelId, agent.publicKey, 'member');
  await announceRepo(owner, repo, parentChannelId);

  // ── 2. Create subchannel with parent tag (like body does) ─────────
  // The key fix: createSubchannel sets parent tag on the 9007 create event
  const subchannelId = await buzzCreateSubchannel(
    agentContext,
    parentChannelId,
    'review-corner-navigation',
  );
  log('Subchannel:', subchannelId);

  // Mirror members
  await setMemberRole(owner, subchannelId, owner.publicKey, 'owner');
  await setMemberRole(owner, subchannelId, reviewer.publicKey, 'admin');
  await setMemberRole(owner, subchannelId, agent.publicKey, 'member');
  log('Subchannel members mirrored');
  await sendMessage(
    agentContext,
    parentChannelId,
    'I mapped the brittle paths and started a focused corner for the fix.',
    { agentActivity: true },
  );
  await sendMessage(
    agentContext,
    subchannelId,
    'The implementation is ready for review. Tests cover the fallback and overlay paths.',
    { agentActivity: true },
  );

  // Dense, realistic ACP telemetry fixture for the corner activity UI. The
  // sequence intentionally spans two final-message boundaries so screenshots
  // can prove compact defaults, markdown, expansion, and turn separation.
  const sessionId = `ses_${RUN_MARKER}`;
  const activityStart = Math.floor(Date.now() / 1000) - 40;
  let activityOffset = 0;
  await postFixtureEvent(
    subchannelId,
    agent,
    'Agent is thinking…',
    [
      ['t', 'body-control'],
      ['t', 'agent-turn'],
      ['request', `${RUN_MARKER}-turn-1`],
      ['session', sessionId],
      ['agent', agent.publicKey],
      ['status', 'working'],
    ],
    activityStart + activityOffset++,
  );
  for (const text of [
    '**Planning platform detection**',
    'I am checking the Android runtime and the existing activity projection.',
    '**Tracing turn boundaries**',
    'Each final message must remain separate from the telemetry that precedes it.',
    '**Implementing compact actions**',
    'The default stream should reveal milestones, not every internal delta.',
  ]) {
    await postActivityFixture(
      subchannelId,
      agent,
      sessionId,
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
      activityStart + activityOffset++,
    );
  }
  for (const update of [
    {
      sessionUpdate: 'tool_call_update',
      title: 'read apps/body/src/activity.ts',
      status: 'completed',
      content: { type: 'text', text: 'Read 184 lines.' },
    },
    {
      sessionUpdate: 'tool_call_update',
      title: 'grep "agent_message_chunk"',
      status: 'completed',
      content: { type: 'text', text: '12 matches' },
    },
    {
      sessionUpdate: 'tool_call_update',
      title: 'bash',
      status: 'completed',
      content: { type: 'text', text: 'Tests passed. Exited with code 0.' },
    },
  ]) {
    await postActivityFixture(
      subchannelId,
      agent,
      sessionId,
      update,
      activityStart + activityOffset++,
    );
  }
  await postFixtureEvent(
    subchannelId,
    agent,
    '**First pass complete.**\n\n- Markdown is rendered.\n- Tool detail stays available on tap.',
    [['t', 'agent-message']],
    activityStart + activityOffset++,
  );
  await postFixtureEvent(
    subchannelId,
    reviewer,
    'Verify that a second turn stays separate.',
    [],
    activityStart + activityOffset++,
  );
  await postActivityFixture(
    subchannelId,
    agent,
    sessionId,
    {
      sessionUpdate: 'activity_batch',
      updates: [
        { sessionUpdate: 'tool_call_update', title: 'Tool', status: 'in_progress' },
        {
          sessionUpdate: 'tool_call_update',
          title: 'Read /home/agent/work/apps/mobile/sources/buzz/rename.ts',
          status: 'completed',
        },
        {
          sessionUpdate: 'tool_call_update',
          title: 'Read /home/agent/work/apps/mobile/sources/buzz/rename.test.ts',
          status: 'completed',
        },
        {
          sessionUpdate: 'tool_call_update',
          title: 'grep "rename handler"',
          status: 'completed',
          content: { type: 'text', text: '12 matches under /home/agent/work/apps/mobile' },
        },
        {
          sessionUpdate: 'tool_call_update',
          title: 'bash: git status',
          status: 'completed',
          content: { type: 'text', text: 'On branch feature/demo' },
        },
        {
          sessionUpdate: 'tool_call_update',
          title: 'Code search',
          status: 'failed',
          content: {
            type: 'text',
            text: 'Code search unavailable at /home/agent/.codegraph/index.db',
          },
        },
      ],
    },
    activityStart + activityOffset++,
  );
  await postActivityFixture(
    subchannelId,
    agent,
    sessionId,
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '**Verifying whitespace preservation**' },
    },
    activityStart + activityOffset++,
  );
  await postActivityFixture(
    subchannelId,
    agent,
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      title: 'typecheck mobile',
      status: 'completed',
      content: { type: 'text', text: 'Exited with code 0.' },
    },
    activityStart + activityOffset++,
  );
  await postFixtureEvent(
    subchannelId,
    agent,
    '**Second turn complete.**\n\nParagraph spacing stays intact. The previous answer remains its own unit.',
    [['t', 'agent-message']],
    activityStart + activityOffset++,
  );

  // ── 3. Seed repo + push feature branch ────────────────────────────
  const repoUrl = gitRepoUrl(owner.publicKey, repo);
  const seedDir = mkdtempSync(join(tmpdir(), 'buzzy-ui-seed-'));
  git(seedDir, ['init', '-q', '-b', 'main']);
  commit(seedDir, 'README.md', `# ${repo}\n\nReview status: draft\n`, 'init');
  const seedPush = gitAuthed(seedDir, owner, owner.publicKey, repo, ['push', repoUrl, 'main']);
  if (!seedPush.ok) throw new Error('seed push failed: ' + seedPush.stderr);
  await new Promise((r) => setTimeout(r, 1000));

  const featureBranch = `feature/${RUN_MARKER}`;
  const agentDir = mkdtempSync(join(tmpdir(), 'buzzy-ui-agent-'));
  const agentClone = gitAuthed(agentDir, agent, owner.publicKey, repo, ['clone', repoUrl, 'work']);
  if (!agentClone.ok) throw new Error('clone failed');
  const work = join(agentDir, 'work');
  git(work, ['checkout', '-q', '-b', featureBranch]);
  writeFileSync(join(work, 'README.md'), `# ${repo}\n\nReview status: ready\n`);
  commit(work, 'FEATURE.md', `# Feature ${RUN_MARKER}\n`, `feat: ${RUN_MARKER}`);
  const featureTip = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const pushFeature = gitAuthed(work, agent, owner.publicKey, repo, [
    'push',
    'origin',
    featureBranch,
  ]);
  if (!pushFeature.ok) throw new Error('push failed: ' + pushFeature.stderr);
  log('Feature tip:', featureTip);

  // ── 4. Post exact-tip review metadata + merge target ──────────────
  const repoId = `${owner.publicKey}/${repo}`;
  const targetBranch = 'refs/heads/main';
  const baseTip = resolveReviewBaseTip(work, targetBranch);
  const files = listChangeReviewFiles(work, baseTip, featureTip);

  for (const [fileIndex, file] of files.entries()) {
    const chunks = chunkChangeReviewPatch(readChangeReviewPatch(work, baseTip, featureTip, file));
    for (const [index, content] of chunks.entries()) {
      await postChangeReviewMetadata(
        subchannelId,
        owner,
        `${subchannelId}:${featureTip}:file:${fileIndex}:${index}`,
        content,
        [
          ['t', CHANGE_REVIEW_FILE_TAG],
          ['f', file.path],
          ['r', featureTip],
          ['base', baseTip],
          ['tip', featureTip],
          ['chunk', String(index)],
          ['chunks', String(chunks.length)],
          ...(file.isBinary ? [['binary', 'true']] : []),
        ],
      );
    }
  }

  await postChangeReviewMetadata(
    subchannelId,
    owner,
    `${subchannelId}:${featureTip}:manifest:0`,
    JSON.stringify({
      version: CHANGE_REVIEW_VERSION,
      base: baseTip,
      tip: featureTip,
      files,
    }),
    [
      ['t', CHANGE_REVIEW_MANIFEST_TAG],
      ['r', featureTip],
      ['base', baseTip],
      ['tip', featureTip],
      ['chunk', '0'],
    ],
  );

  // Merge-ready is published last so the review payload is complete first.
  const subIntro = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [
        ['h', subchannelId],
        ['t', 'body-control'],
        ['session', `ses_${RUN_MARKER}`],
        ['parent', parentChannelId],
        ['mode', 'edit'],
        ['status', 'ready'],
        ['t', 'merge-ready'],
        ['repo', repoId],
        ['branch', targetBranch],
        ['feature', featureBranch],
        ['tip', featureTip],
      ],
      content: `Work is ready for human merge approval — ${featureTip.slice(0, 12)}…`,
    },
    owner.secretKey,
  );
  await publishEvent(subIntro, owner);
  log(`Review metadata posted for ${files.length} file diffs`);

  // To parent (subchannel link - for UI to render as navigable)
  const parentLink = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [
        ['h', parentChannelId],
        ['t', 'body-control'],
        ['subchannel', subchannelId],
        ['session', `ses_${RUN_MARKER}`],
        ['branch', featureBranch],
        ['mode', 'edit'],
        ['status', 'open'],
        ['repo', repoId],
        ['tip', featureTip],
      ],
      content: 'Agent opened #review-corner-navigation',
    },
    owner.secretKey,
  );
  await publishEvent(parentLink, owner);
  await postFixtureEvent(
    parentChannelId,
    agent,
    'Editing allowed. The agent is working in an isolated corner.',
    [
      ['t', 'body-control'],
      ['t', 'buzz-write-permission-request'],
      ['permission', `${RUN_MARKER}-permission`],
      ['request', `${RUN_MARKER}-human-request`],
      ['agent', agent.publicKey],
      ['tool', 'str_replace apps/mobile/sources/buzz/rename.ts'],
      ['repo', repoId],
      ['status', 'allowed'],
      ['subchannel', subchannelId],
    ],
    Math.floor(Date.now() / 1000) + 1,
  );
  log('Parent link message posted');

  // Extra lifecycle fixtures keep the nested navigation compact while making
  // every monochrome corner status visible in the browse-all review surface.
  const extraCorners: Array<{ name: string; status: 'live' | 'merged' | 'archived' }> = [
    { name: 'live-agent-iteration', status: 'live' },
    { name: 'merged-gate-proof', status: 'merged' },
    { name: 'archived-copy-spike', status: 'archived' },
  ];
  for (const fixture of extraCorners) {
    const id = await buzzCreateSubchannel(agentContext, parentChannelId, fixture.name);
    await setMemberRole(owner, id, owner.publicKey, 'owner');
    await setMemberRole(owner, id, reviewer.publicKey, 'admin');
    await setMemberRole(owner, id, agent.publicKey, 'member');

    const childStatus = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        tags: [
          ['h', id],
          ['t', 'body-control'],
          ['parent', parentChannelId],
          ['status', fixture.status === 'merged' ? 'archived' : fixture.status],
        ],
        content: `Corner #${fixture.name} is ${fixture.status}`,
      },
      owner.secretKey,
    );
    await publishEvent(childStatus, owner);

    if (fixture.status === 'merged') {
      const mergeSummary = signEvent(
        {
          pubkey: owner.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [
            ['h', parentChannelId],
            ['t', 'body-control'],
            ['t', 'merge-summary'],
            ['subchannel', id],
          ],
          content: `Corner #${fixture.name} merged after human approval`,
        },
        owner.secretKey,
      );
      await publishEvent(mergeSummary, owner);
    }
    log(`Corner fixture: #${fixture.name} ${fixture.status}`);
  }

  // Wait for propagation
  await new Promise((r) => setTimeout(r, 2000));

  // ── 5. Output for the UI demo ─────────────────────────────────────
  console.log(`\n=== UI DEMO SETUP COMPLETE ===`);
  console.log(`REVIEWER_NSEC=${identityNsec(reviewer)}`);
  console.log(`COMMUNITY_ID=${communityId}`);
  console.log(`PARENT_ID=${parentChannelId}`);
  console.log(`SUBCHANNEL_ID=${subchannelId}`);
  console.log(`REPO=${repoId}`);
  console.log(`FEATURE_BRANCH=${featureBranch}`);
  console.log(`FEATURE_TIP=${featureTip}`);
  console.log(`RUN_MARKER=${RUN_MARKER}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
