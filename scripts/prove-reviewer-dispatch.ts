#!/usr/bin/env node
/**
 * End-to-end acceptance proof for reviewer dispatch on a green corner head.
 *
 * Everything here runs against the real HTTP server: the person's tap is a
 * phone operation, GitHub's news is a signed webhook delivery, and the
 * reviewer agent learns it has work the only way a daemon ever does — by
 * polling `getAgentCommands`. Nothing in the proof reaches past those routes.
 *
 * Six scenarios. The first two used to end in silence; the next two check
 * that the turn the reviewer is woken into can actually record a verdict,
 * because a reviewer whose PASS is only prose leaves the gate stuck at
 * `approvalPending=true` just as surely as no reviewer at all. The last two
 * bind the later zero-check and merge-authority regressions to the same real
 * HTTP boundary:
 *   1. The reviewer replaced its own event subscriptions, then a check passed.
 *   2. The head was already green when the Room's reviewer was configured.
 *   3. The reconciled turn carries `approve_merge`.
 *   4. It still does when the corner's owner was never recorded.
 *   5. A completed PR with no check contexts wakes the configured reviewer.
 *   6. The author gate stays closed until that reviewer approves the exact head.
 *
 * Local invocation:
 *   npm run prove:reviewer-dispatch
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { GitHubOperations } from '../apps/server/src/github-operations.js';
import { createAgentCommand } from '../apps/server/src/agent-command.js';
import { systemLine } from '../apps/server/src/system-line.js';
import { cornerReviewerInstruction } from '../apps/body/src/monolith-corner-turn.js';
import { agentToolsFor, prChecksStatus } from '../apps/body/src/read-only-mcp.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64);
const REVIEWER = 'b'.repeat(64);
const IMPLEMENTER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OVERWRITTEN_CORNER = '33333333-3333-4333-8333-333333333333';
const ALREADY_GREEN_CORNER = '44444444-4444-4444-8444-444444444444';
const ZERO_CHECK_CORNER = '55555555-5555-4555-8555-555555555555';
const INSTALLATION = 77;
const REPOSITORY = 101;
const WEBHOOK_SECRET = 'webhook-secret';

function head(seed: string): string {
  return seed.repeat(40).slice(0, 40);
}

async function main(): Promise<void> {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,github_subject)
     VALUES($1,'human','Proof Owner','proofowner','proof-owner'),
           ($2,'agent','Reviewer','reviewer',NULL),
           ($3,'agent','Implementer','implementer',NULL)`,
    [HUMAN, REVIEWER, IMPLEMENTER],
  );
  // The phone token exchange must land on this fixture person, not mint a second one.
  await database.query(
    `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
     VALUES('github','proof-owner',$1,'https://github.com','beeline','proofowner')`,
    [HUMAN],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    REVIEWER,
    IMPLEMENTER,
    HUMAN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO github_installations(
       installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
     ) VALUES($1,$2,'42','owner','User','selected','active')`,
    [INSTALLATION, HUMAN],
  );
  await database.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES($1,$2,'owner/widgets','main')`,
    [REPOSITORY, INSTALLATION],
  );
  await database.query(
    `INSERT INTO rooms(
       id,workspace_id,created_by,name,repository_key,repository_remote,
       repository_resolution,github_installation_id
     ) VALUES($1,$2,$3,'General','owner/widgets','https://github.com/owner/widgets.git','repository',$4)`,
    [ROOM, WORKSPACE, HUMAN, INSTALLATION],
  );
  for (const [corner, name] of [
    [OVERWRITTEN_CORNER, 'Overwritten'],
    [ALREADY_GREEN_CORNER, 'Already green'],
    [ZERO_CHECK_CORNER, 'Zero checks'],
  ] as const)
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5)`,
      [corner, WORKSPACE, ROOM, HUMAN, name],
    );
  for (const [corner, branch, number, seed] of [
    [OVERWRITTEN_CORNER, 'feature/overwritten', 1, '1'],
    [ALREADY_GREEN_CORNER, 'feature/already-green', 2, '2'],
    [ZERO_CHECK_CORNER, 'feature/zero-checks', 3, '3'],
  ] as const)
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,feature_branch,lifecycle)
       VALUES($1,$2,'Do the work',$3,$4::jsonb)`,
      [
        corner,
        IMPLEMENTER,
        branch,
        JSON.stringify({
          lifecycle: 'in-review',
          branch,
          checks: 'unknown',
          pr: {
            number,
            url: `https://github.com/owner/widgets/pull/${number}`,
            title: 'Do the work',
            targetBranch: 'main',
            headSha: head(seed),
            mergeability: 'clean',
          },
        }),
      ],
    );
  for (const who of [HUMAN, REVIEWER, IMPLEMENTER])
    for (const room of [null, ROOM, OVERWRITTEN_CORNER, ALREADY_GREEN_CORNER, ZERO_CHECK_CORNER])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
        [WORKSPACE, room, who, who === HUMAN ? 'owner' : 'member'],
      );

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const pullRequestHeads = new Map([
    [1, head('1')],
    [2, head('2')],
    [3, head('3')],
  ]);
  const githubApp = {
    installationToken: async () => ({
      token: 'installation-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    readPullRequest: async (_token: string, repository: string, number: number) => ({
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      headSha: pullRequestHeads.get(number) ?? head('f'),
    }),
    readCommitCheckRollup: async (_token: string, _repository: string, headSha: string) =>
      headSha === head('3')
        ? { state: 'pending' as const, total: 0, failing: [], checks: [] }
        : { state: 'passed' as const, total: 1, failing: [], checks: [] },
  } as unknown as GitHubAppClient;
  const github = new GitHubOperations(
    database,
    {} as GitHubOAuthClient,
    githubApp,
    'github-client-secret',
  );
  const phone = new PhoneService(database, 'http://placeholder', github);
  const live = new LiveHub();
  const daemon = new DaemonService(
    database,
    live,
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    (input) => github.prChecksStatus(input),
  );
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
    github: {
      webhookSecret: WEBHOOK_SECRET,
      onWebhook: (event, payload) => github.processWebhook(event, payload),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const daemonTokenFor = async (agentId: string) => {
    const exchange = await auth.createDaemonExchange(agentId);
    return (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  };
  const reviewerToken = await daemonTokenFor(REVIEWER);
  const implementerToken = await daemonTokenFor(IMPLEMENTER);
  Object.assign(process.env, {
    BEELINE_DAEMON_BASE_URL: origin,
    BEELINE_DAEMON_TOKEN: implementerToken,
    BEELINE_DAEMON_ROOM_ID: ROOM,
    BEELINE_DAEMON_CORNER_ID: ZERO_CHECK_CORNER,
    BEELINE_DAEMON_WORKSPACE_ID: WORKSPACE,
    BEELINE_DAEMON_AGENT_ID: IMPLEMENTER,
  });

  const call = async (path: string, token: string, payload: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const phoneOperation = (name: string, payload: unknown) =>
    call(`/v1/phone/operations/${name}`, accessToken, payload);
  const daemonOperation = (name: string, payload: unknown, token = reviewerToken) =>
    call(`/v1/daemon/operations/${name}`, token, payload);
  const checkPassed = async (branch: string, headSha: string, name: string) => {
    const body = JSON.stringify({
      action: 'completed',
      installation: { id: INSTALLATION },
      repository: { full_name: 'owner/widgets' },
      sender: { login: 'ci-bot' },
      check_run: {
        id: 5,
        name,
        status: 'completed',
        conclusion: 'success',
        head_sha: headSha,
        html_url: `https://github.com/owner/widgets/runs/${name}`,
        check_suite: { head_branch: branch, head_sha: headSha },
      },
    });
    const response = await fetch(`${origin}/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
      },
      body,
    });
    if (!response.ok) throw new Error(`webhook -> ${response.status} ${await response.text()}`);
  };
  const reviewerCommands = async (roomId: string) =>
    ((await daemonOperation('getAgentCommands', { roomId })).commands ?? []) as Array<{
      reason: string;
      source: { body: string };
    }>;
  const describe = (commands: Array<{ reason: string; source: { body: string } }>) =>
    commands.length
      ? commands.map((command) => `${command.reason}: ${command.source.body}`).join('; ')
      : 'NOTHING — the reviewer was never woken';
  /**
   * The tools the woken reviewer's turn would actually carry.
   *
   * Waking a reviewer that cannot record anything is not a review: its PASS
   * would exist only as chat prose while the gate stays at
   * `approvalPending=true`. So this asks the four daemon operations the body
   * asks at session activation, composes them exactly as `activate()` does,
   * and reports the surface the real tool filter produces from that env.
   */
  const reviewerToolSurface = async (cornerId: string) => {
    const [configuration, roster, corners, restore] = await Promise.all([
      daemonOperation('getAgentConfiguration', { agentId: REVIEWER, roomId: cornerId }),
      daemonOperation('getWorkspaceRoster', { agentId: REVIEWER, workspaceId: WORKSPACE }),
      daemonOperation('listRoomCorners', { roomId: ROOM }),
      daemonOperation('getCornerRestoreState', { cornerId }),
    ]);
    const members = (roster.members ?? []) as Array<{ identityId: string; handle?: string }>;
    const corner = (
      (corners.corners ?? []) as Array<{ cornerId: string; createdBy?: string }>
    ).find((entry) => entry.cornerId === cornerId);
    const openedBy = corner?.createdBy;
    const lifecycle = (restore as { lifecycle?: { pr?: { number: number; headSha: string } } })
      .lifecycle;
    const instruction = cornerReviewerInstruction({
      reviewerHandle: configuration.reviewerHandle as string | undefined,
      agentHandle: members.find((member) => member.identityId === REVIEWER)?.handle,
      authorHandle: members.find((member) => member.identityId === openedBy)?.handle,
      openedByAgent: !openedBy || openedBy === REVIEWER,
      ...(lifecycle?.pr
        ? { pullRequestNumber: lifecycle.pr.number, headSha: lifecycle.pr.headSha }
        : {}),
    });
    // What room-session.ts writes into the MCP server's env for this turn.
    const env = new Map<string, string>([
      ['BEELINE_MCP_SURFACE', 'agent'],
      ['BEELINE_DAEMON_CORNER_ID', cornerId],
      ...(instruction ? ([['BEELINE_CORNER_REVIEWER', '1']] as Array<[string, string]>) : []),
    ]);
    const tools = agentToolsFor(
      env.get('BEELINE_MCP_SURFACE') === 'agent',
      env.get('BEELINE_AGENT_DM') === '1',
      Boolean(env.get('BEELINE_DAEMON_CORNER_ID')),
      env.get('BEELINE_CORNER_REVIEWER') === '1',
    ).map((tool) => tool.name);
    return { env, tools, reviewerHandle: configuration.reviewerHandle as string | undefined };
  };

  const failures: string[] = [];

  console.log('# 1. reviewer replaced its own event subscriptions, then a check passed');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: REVIEWER });
  console.log('   person set the Room reviewer to @reviewer');
  const kept = await daemonOperation('setEventSubscriptions', {
    roomId: OVERWRITTEN_CORNER,
    kinds: ['joined'],
  });
  console.log(
    `   reviewer called subscribe_events(['joined']) -> kinds=${JSON.stringify(kept.kinds)}`,
  );
  await checkPassed('feature/overwritten', head('1'), 'build');
  const overwritten = await reviewerCommands(OVERWRITTEN_CORNER);
  console.log(
    `   GitHub reported a passing check; reviewer polled and got ${describe(overwritten)}`,
  );
  if (!overwritten.length)
    failures.push('no review command after the reviewer overwrote its subscriptions');

  console.log('# 2. head already green before the Room reviewer was configured');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: null });
  console.log('   person cleared the Room reviewer');
  await checkPassed('feature/already-green', head('2'), 'build');
  console.log('   GitHub reported a passing check on the second corner (no reviewer yet)');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: REVIEWER });
  console.log('   person set the Room reviewer to @reviewer');
  const alreadyGreen = await reviewerCommands(ALREADY_GREEN_CORNER);
  console.log(`   reviewer polled the already-green corner and got ${describe(alreadyGreen)}`);
  if (!alreadyGreen.length)
    failures.push('no review command for the already-green unreviewed head');

  console.log('# 3. the reconciled turn can actually record a verdict');
  const surface = await reviewerToolSurface(ALREADY_GREEN_CORNER);
  console.log(
    `   reconciled turn env: reviewerHandle=${surface.reviewerHandle ?? 'none'} ` +
      `BEELINE_DAEMON_CORNER_ID=${surface.env.get('BEELINE_DAEMON_CORNER_ID') ? 'set' : 'unset'} ` +
      `BEELINE_CORNER_REVIEWER=${surface.env.get('BEELINE_CORNER_REVIEWER') ?? 'unset'}`,
  );
  console.log(
    `   approve_merge on that turn's tool surface: ${
      surface.tools.includes('approve_merge') ? 'PRESENT' : 'ABSENT — the PASS could only be prose'
    }`,
  );
  if (!surface.tools.includes('approve_merge'))
    failures.push('the reconciled reviewer turn carries no approve_merge tool');

  // Reconciliation resurrects the oldest green heads, which are the ones whose
  // `owner_agent_id` predates the corner-owner backfill. That is the record the
  // corner listing used to substitute the polling agent for.
  console.log('# 4. same, for a green head whose corner owner was never recorded');
  await database.query(`UPDATE corner_facts SET owner_agent_id=NULL WHERE corner_id=$1`, [
    ALREADY_GREEN_CORNER,
  ]);
  const unowned = await reviewerToolSurface(ALREADY_GREEN_CORNER);
  console.log(
    `   reconciled turn env: reviewerHandle=${unowned.reviewerHandle ?? 'none'} ` +
      `BEELINE_CORNER_REVIEWER=${unowned.env.get('BEELINE_CORNER_REVIEWER') ?? 'unset'}`,
  );
  console.log(
    `   approve_merge on that turn's tool surface: ${
      unowned.tools.includes('approve_merge') ? 'PRESENT' : 'ABSENT — the PASS could only be prose'
    }`,
  );
  if (!unowned.tools.includes('approve_merge'))
    failures.push(
      'the reconciled reviewer turn carries no approve_merge tool when the corner owner is unrecorded',
    );

  console.log('# 5. Reproduction ZC-1: a completed PR has no check contexts or webhook');
  const objective = await systemLine(database, {
    roomId: ZERO_CHECK_CORNER,
    authorId: HUMAN,
    subject: { kind: 'person', id: HUMAN, name: 'Proof Owner' },
    verb: 'requested work',
  });
  await createAgentCommand(database, {
    roomId: ZERO_CHECK_CORNER,
    agentId: IMPLEMENTER,
    sourceMessageId: objective.id,
    reason: 'corner_objective',
  });
  const [worker] = ((
    await daemonOperation('getAgentCommands', { roomId: ZERO_CHECK_CORNER }, implementerToken)
  ).commands ?? []) as Array<{ id: string; turnRequestId: string }>;
  if (!worker) throw new Error('the zero-check worker command was not created');
  await daemonOperation(
    'claimAgentCommand',
    { roomId: ZERO_CHECK_CORNER, commandId: worker.id, generationId: 'zero-check-worker' },
    implementerToken,
  );
  await daemonOperation(
    'postAgentTurnReceipt',
    {
      roomId: ZERO_CHECK_CORNER,
      agentId: IMPLEMENTER,
      requestId: worker.turnRequestId,
      generationId: 'zero-check-worker',
      status: 'working',
    },
    implementerToken,
  );
  await daemonOperation(
    'postRoomMessage',
    {
      roomId: ZERO_CHECK_CORNER,
      requestId: worker.turnRequestId,
      generationId: 'zero-check-worker',
      text: 'https://github.com/owner/widgets/pull/3',
    },
    implementerToken,
  );
  const zeroCheckReviews = await reviewerCommands(ZERO_CHECK_CORNER);
  console.log(
    `   worker completed PR #3; GitHub reported zero contexts; reviewer polled and got ${describe(zeroCheckReviews)}`,
  );
  if (!zeroCheckReviews.length)
    failures.push('Reproduction ZC-1: no review command after a completed zero-check PR');

  console.log('# 6. Reproduction MG-1: green is not merge permission without reviewer PASS');
  const beforeApproval = JSON.parse(await prChecksStatus({ pullRequest: 3 })) as {
    checks: string;
    approvalPending: boolean;
    reviewerExists: boolean;
  };
  console.log(
    `   before approve_merge: checks=${String(beforeApproval.checks)} approvalPending=${String(beforeApproval.approvalPending)}`,
  );
  if (beforeApproval.checks !== 'passed' || beforeApproval.approvalPending !== true)
    failures.push('Reproduction MG-1: green head was not held pending reviewer approval');
  await daemonOperation(
    'approveCornerMerge',
    { cornerId: ZERO_CHECK_CORNER, headSha: head('3') },
    reviewerToken,
  );
  const afterApproval = JSON.parse(await prChecksStatus({ pullRequest: 3 })) as {
    approvalPending: boolean;
  };
  console.log(
    `   after exact-head approve_merge: approvalPending=${String(afterApproval.approvalPending)}`,
  );
  if (afterApproval.approvalPending !== false)
    failures.push('Reproduction MG-1: exact-head reviewer approval did not open the gate');
  pullRequestHeads.set(3, head('4'));
  const afterPush = JSON.parse(await prChecksStatus({ pullRequest: 3 })) as {
    approvalPending: boolean;
  };
  console.log(`   after the PR head changed: approvalPending=${String(afterPush.approvalPending)}`);
  if (afterPush.approvalPending !== true)
    failures.push('Reproduction MG-1: a new head inherited the old reviewer approval');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: null });
  const withoutReviewer = JSON.parse(await prChecksStatus({ pullRequest: 3 })) as {
    approvalPending: boolean;
    reviewerExists: boolean;
  };
  console.log(
    `   with no configured reviewer: reviewerExists=${String(withoutReviewer.reviewerExists)} approvalPending=${String(withoutReviewer.approvalPending)}`,
  );
  if (withoutReviewer.reviewerExists || withoutReviewer.approvalPending !== true)
    failures.push('Reproduction MG-1: missing reviewer was treated as merge consent');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    '\nPASSED: configured reviewers were woken, zero-check completion dispatched review, and only exact-head reviewer PASS opened the gate.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // PGlite keeps its worker alive; the proof has printed everything it knows.
  .finally(() => process.exit(process.exitCode ?? 0));
