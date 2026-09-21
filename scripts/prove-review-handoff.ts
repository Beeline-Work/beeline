#!/usr/bin/env node
/**
 * End-to-end acceptance proof for the handoff back to a corner's worker when
 * its review ends.
 *
 * Everything here runs against the real HTTP server: GitHub's news is a signed
 * webhook delivery, the reviewer agent learns it has work and posts its verdict
 * the only way a daemon ever does, and the worker learns the review landed the
 * only way a daemon ever does — by polling `getAgentCommands`. Nothing in the
 * proof reaches past those routes.
 *
 * Two scenarios, one per verdict, and NEITHER verdict names the worker:
 *   1. The reviewer refuses with findings and types no tag.
 *   2. The reviewer records `approve_merge` and types no tag.
 *
 * Both used to end in silence: the worker's turn was created only by the tag
 * inside the reviewer's reply, so a verdict that named nobody stalled the
 * corner until a person noticed.
 *
 * Local invocation:
 *   npm run prove:review-handoff
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
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64);
const REVIEWER = 'b'.repeat(64);
const WORKER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const REFUSED_CORNER = '33333333-3333-4333-8333-333333333333';
const APPROVED_CORNER = '44444444-4444-4444-8444-444444444444';
const INSTALLATION = 77;
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
           ($3,'agent','Worker','worker',NULL)`,
    [HUMAN, REVIEWER, WORKER],
  );
  await database.query(
    `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
     VALUES('github','proof-owner',$1,'https://github.com','beeline','proofowner')`,
    [HUMAN],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    REVIEWER,
    WORKER,
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
     VALUES(101,$1,'owner/widgets','main')`,
    [INSTALLATION],
  );
  await database.query(
    `INSERT INTO rooms(
       id,workspace_id,created_by,name,repository_key,repository_remote,
       repository_resolution,github_installation_id
     ) VALUES($1,$2,$3,'General','owner/widgets','https://github.com/owner/widgets.git','repository',$4)`,
    [ROOM, WORKSPACE, HUMAN, INSTALLATION],
  );
  const corners = [
    { id: REFUSED_CORNER, name: 'Refused', branch: 'feature/refused', number: 1, seed: '1' },
    { id: APPROVED_CORNER, name: 'Approved', branch: 'feature/approved', number: 2, seed: '2' },
  ] as const;
  for (const corner of corners) {
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5)`,
      [corner.id, WORKSPACE, ROOM, HUMAN, corner.name],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,feature_branch,lifecycle)
       VALUES($1,$2,'Do the work',$3,$4::jsonb)`,
      [
        corner.id,
        WORKER,
        corner.branch,
        JSON.stringify({
          lifecycle: 'in-review',
          branch: corner.branch,
          checks: 'unknown',
          pr: {
            number: corner.number,
            url: `https://github.com/owner/widgets/pull/${corner.number}`,
            title: 'Do the work',
            targetBranch: 'main',
            headSha: head(corner.seed),
            mergeability: 'clean',
          },
        }),
      ],
    );
  }
  for (const who of [HUMAN, REVIEWER, WORKER])
    for (const room of [null, ROOM, REFUSED_CORNER, APPROVED_CORNER])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
        [WORKSPACE, room, who, who === HUMAN ? 'owner' : 'member'],
      );

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  // The only stand-in: GitHub itself. A check delivery makes the server ask
  // for the commit's aggregate rollup, and this proof has no GitHub to ask.
  const app = {
    installationToken: async () => ({ token: 'ghs-proof' }),
    readCommitCheckRollup: async () => ({
      state: 'passed' as const,
      total: 1,
      failing: [],
      checks: [{ name: 'build', status: 'passed' as const, conclusion: 'success' }],
    }),
  } as unknown as GitHubAppClient;
  const github = new GitHubOperations(
    database,
    {} as GitHubOAuthClient,
    app,
    'github-client-secret',
  );
  const phone = new PhoneService(database, 'http://placeholder', github);
  const live = new LiveHub();
  const daemon = new DaemonService(database, live);
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
  const workerToken = await daemonTokenFor(WORKER);

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
  const checkPassed = async (branch: string, headSha: string) => {
    const body = JSON.stringify({
      action: 'completed',
      installation: { id: INSTALLATION },
      repository: { full_name: 'owner/widgets' },
      sender: { login: 'ci-bot' },
      check_run: {
        id: 5,
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        head_sha: headSha,
        html_url: 'https://github.com/owner/widgets/runs/build',
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
  type Command = { id: string; agentId: string; roomId: string; turnRequestId: string; reason: string };
  const commandsFor = async (roomId: string, token: string) =>
    ((await daemonOperation('getAgentCommands', { roomId }, token)).commands ?? []) as Command[];
  const describe = (commands: Command[]) =>
    commands.length
      ? commands.map((command) => command.reason).join(', ')
      : 'NOTHING — the worker was never woken';
  /** The reviewer claims its dispatched review turn, exactly as its daemon does. */
  const startReview = async (review: Command) => {
    const generationId = `g-${review.id.slice(0, 6)}`;
    await daemonOperation(
      'claimAgentCommand',
      { roomId: review.roomId, commandId: review.id, generationId },
      reviewerToken,
    );
    await daemonOperation(
      'postAgentTurnReceipt',
      {
        roomId: review.roomId,
        agentId: REVIEWER,
        requestId: review.turnRequestId,
        generationId,
        status: 'working',
      },
      reviewerToken,
    );
    return generationId;
  };
  const postVerdict = (review: Command, generationId: string, text: string) =>
    daemonOperation(
      'postRoomMessage',
      { roomId: review.roomId, requestId: review.turnRequestId, generationId, text },
      reviewerToken,
    );

  const failures: string[] = [];

  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: REVIEWER });
  console.log('person set the Room reviewer to @reviewer; @worker owns both corners\n');

  console.log('# 1. the review REFUSES and names nobody');
  await checkPassed('feature/refused', head('1'));
  const [refusedReview] = await commandsFor(REFUSED_CORNER, reviewerToken);
  if (!refusedReview) throw new Error('the reviewer was never woken on the green head');
  console.log(`   GitHub reported a passing check; reviewer woken (${refusedReview.reason})`);
  const refused = await startReview(refusedReview);
  await postVerdict(
    refusedReview,
    refused,
    'Review complete: the reproduction is missing from the pull request body. Fix that and push.',
  );
  console.log('   reviewer posted its findings with NO tag in the text');
  const afterRefusal = await commandsFor(REFUSED_CORNER, workerToken);
  console.log(`   worker polled its corner and got ${describe(afterRefusal)}`);
  if (!afterRefusal.length) failures.push('no worker turn after the review refused');

  console.log('\n# 2. the review APPROVES and names nobody');
  await checkPassed('feature/approved', head('2'));
  const [approvedReview] = await commandsFor(APPROVED_CORNER, reviewerToken);
  if (!approvedReview) throw new Error('the reviewer was never woken on the green head');
  console.log(`   GitHub reported a passing check; reviewer woken (${approvedReview.reason})`);
  const approved = await startReview(approvedReview);
  const verdict = await daemonOperation(
    'approveCornerMerge',
    { cornerId: APPROVED_CORNER, headSha: head('2') },
    reviewerToken,
  );
  console.log(`   reviewer called approve_merge -> status=${String(verdict.status)}`);
  await postVerdict(
    approvedReview,
    approved,
    `Review complete: PASS at ${head('2')}. Approved, merge it.`,
  );
  console.log('   reviewer posted its PASS with NO tag in the text');
  const afterApproval = await commandsFor(APPROVED_CORNER, workerToken);
  console.log(`   worker polled its corner and got ${describe(afterApproval)}`);
  if (!afterApproval.length) failures.push('no worker turn after the review approved');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASSED: both verdicts handed the corner back to its worker with no tag typed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // PGlite keeps its worker alive; the proof has printed everything it knows.
  .finally(() => process.exit(process.exitCode ?? 0));
