#!/usr/bin/env node
/**
 * End-to-end proof for a Room reviewer list, from the person's side.
 *
 * Everything runs against the real HTTP server: the person's choices and
 * reads are phone routes, GitHub's news is a signed webhook delivery, and the
 * reviewers learn they have work the only way a daemon ever does — by polling
 * `getAgentCommands`. A reviewer's failure is the same `postAgentTurnReceipt`
 * call a harness sends when its model is unavailable. Presence ("online") is
 * written directly to `live_outputs`, because this harness does not wire up
 * `ConnectionPresence`, exactly as `prove-agent-list-run.ts` does.
 *
 * The person:
 *   1. sets the Room's reviewers to @ridge, then @sable;
 *   2. sees that list on the Room, and no class, tag, or tier anywhere;
 *   3. watches a green head go to @ridge, @ridge's review turn fail, and the
 *      review pass to @sable, whose approval opens the merge gate.
 *
 * Local invocation:
 *   npm run prove:reviewer-list
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
const RIDGE = 'b'.repeat(64);
const SABLE = 'c'.repeat(64);
const IMPLEMENTER = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111117';
const ROOM = '22222222-2222-4222-8222-222222222227';
const CORNER = '33333333-3333-4333-8333-333333333337';
const INSTALLATION = 78;
const REPOSITORY = 102;
const WEBHOOK_SECRET = 'webhook-secret';
const HEAD = '7'.repeat(40);
const BRANCH = 'feature/reviewer-list';

type Command = { id: string; roomId: string; agentId: string; turnRequestId: string; reason: string };

async function main(): Promise<void> {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,github_subject)
     VALUES($1,'human','Proof Owner','proofowner','proof-owner'),
           ($2,'agent','Ridge','ridge',NULL),
           ($3,'agent','Sable','sable',NULL),
           ($4,'agent','Implementer','implementer',NULL)`,
    [HUMAN, RIDGE, SABLE, IMPLEMENTER],
  );
  await database.query(
    `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
     VALUES('github','proof-owner',$1,'https://github.com','beeline','proofowner')`,
    [HUMAN],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [
    RIDGE,
    SABLE,
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
     ) VALUES($1,$2,$3,'general','owner/widgets','https://github.com/owner/widgets.git','repository',$4)`,
    [ROOM, WORKSPACE, HUMAN, INSTALLATION],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Widget fix')`,
    [CORNER, WORKSPACE, ROOM, HUMAN],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,feature_branch,lifecycle)
     VALUES($1,$2,'Fix the widget',$3,$4::jsonb)`,
    [
      CORNER,
      IMPLEMENTER,
      BRANCH,
      JSON.stringify({
        lifecycle: 'in-review',
        branch: BRANCH,
        checks: 'unknown',
        pr: {
          number: 9,
          url: 'https://github.com/owner/widgets/pull/9',
          title: 'Fix the widget',
          targetBranch: 'main',
          headSha: HEAD,
          mergeability: 'clean',
        },
      }),
    ],
  );
  for (const who of [HUMAN, RIDGE, SABLE, IMPLEMENTER])
    for (const room of [null, ROOM, CORNER])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
        [WORKSPACE, room, who, who === HUMAN ? 'owner' : 'member'],
      );
  for (const agentId of [RIDGE, SABLE])
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       VALUES($1,$2,'presence','presence',$3::jsonb,now())`,
      [ROOM, agentId, JSON.stringify({ status: 'online', observedAt: Math.floor(Date.now() / 1000) })],
    );

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const githubApp = {
    installationToken: async () => ({
      token: 'installation-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    readPullRequest: async (_token: string, repository: string, number: number) => ({
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      headSha: HEAD,
    }),
    readCommitCheckRollup: async () => ({ state: 'passed' as const, total: 1, failing: [], checks: [] }),
  } as unknown as GitHubAppClient;
  const github = new GitHubOperations(database, {} as GitHubOAuthClient, githubApp, 'github-client-secret');
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
  const tokenFor: Record<string, string> = {
    [RIDGE]: await daemonTokenFor(RIDGE),
    [SABLE]: await daemonTokenFor(SABLE),
  };

  const request = async (method: 'GET' | 'POST', path: string, token: string, payload?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  const ok = async (method: 'GET' | 'POST', path: string, token: string, payload?: unknown) => {
    const result = await request(method, path, token, payload);
    if (result.status >= 300) throw new Error(`${path} -> ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const phoneOperation = (name: string, payload: unknown) =>
    ok('POST', `/v1/phone/operations/${name}`, accessToken, payload);
  const daemonOperation = (agentId: string, name: string, payload: unknown) =>
    ok('POST', `/v1/daemon/operations/${name}`, tokenFor[agentId]!, payload);
  const reviews = async (agentId: string) =>
    (((await daemonOperation(agentId, 'getAgentCommands', { roomId: CORNER })).commands ?? []) as Command[]).filter(
      (command) => command.reason === 'subscribed_event',
    );
  const checkPassed = async () => {
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
        head_sha: HEAD,
        html_url: 'https://github.com/owner/widgets/runs/build',
        check_suite: { head_branch: BRANCH, head_sha: HEAD },
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

  const failures: string[] = [];
  const expect = (condition: boolean, failure: string) => {
    if (!condition) failures.push(failure);
  };

  console.log('# 1. The person sets the Room reviewers to @ridge, then @sable');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: RIDGE, reviewerFallbackIds: [SABLE] });
  const roomView = await ok('GET', `/v1/phone/rooms/${ROOM}`, accessToken);
  console.log(
    `   Room view: reviewerAgentId=${roomView.room?.reviewerAgentId === RIDGE ? '@ridge' : roomView.room?.reviewerAgentId} ` +
      `reviewerFallbackIds=${JSON.stringify((roomView.room?.reviewerFallbackIds ?? []).map((id: string) => (id === SABLE ? '@sable' : id)))}`,
  );
  expect(roomView.room?.reviewerAgentId === RIDGE, 'Room view does not show @ridge as reviewer');
  expect(
    JSON.stringify(roomView.room?.reviewerFallbackIds) === JSON.stringify([SABLE]),
    'Room view does not list @sable after @ridge',
  );

  console.log('# 2. No class, tag, or weight tier is left for the person to see or set');
  const workspaceView = await ok('GET', `/v1/phone/workspaces/${WORKSPACE}`, accessToken);
  const agentView = await ok('GET', `/v1/phone/workspaces/${WORKSPACE}/agents/${RIDGE}`, accessToken);
  const members = await ok('GET', `/v1/phone/workspaces/${WORKSPACE}/members`, accessToken);
  const leftovers = [
    ...('weightTierRules' in (workspaceView.managerSettings ?? {}) ? ['workspace weightTierRules'] : []),
    ...('tags' in agentView ? ['agent profile tags'] : []),
    ...('tagsCanChange' in agentView ? ['agent profile tagsCanChange'] : []),
    ...((members.agents ?? []) as Array<Record<string, unknown>>).filter((agent) => 'tags' in agent).map(() => 'member row tags'),
    ...('reviewerClass' in (roomView.room ?? {}) ? ['room reviewerClass'] : []),
  ];
  console.log(`   workspace, agent profile, member rows and Room header carry: ${leftovers.length ? leftovers.join(', ') : 'no class/tag/tier fields'}`);
  expect(!leftovers.length, `leftover class fields: ${leftovers.join(', ')}`);
  for (const name of ['setAgentCustomTags', 'setWorkspaceWeightTierRules']) {
    const refused = await request('POST', `/v1/phone/operations/${name}`, accessToken, {
      workspaceId: WORKSPACE,
      agentId: RIDGE,
      tags: ['heavy'],
      rules: null,
    });
    console.log(`   ${name} -> HTTP ${refused.status} ${JSON.stringify(refused.body)}`);
    expect(refused.status >= 400, `${name} is still accepted`);
  }

  console.log('# 3. A green head goes to @ridge; @ridge fails; the review passes to @sable');
  await checkPassed();
  const ridgeReviews = await reviews(RIDGE);
  const sableBefore = await reviews(SABLE);
  console.log(`   GitHub reported the head green: @ridge has ${ridgeReviews.length} review turn(s), @sable has ${sableBefore.length}`);
  expect(ridgeReviews.length === 1 && sableBefore.length === 0, 'the green head did not go to @ridge alone');
  const ridgeTurn = ridgeReviews[0];
  if (ridgeTurn) {
    const generationId = 'ridge-gen';
    await daemonOperation(RIDGE, 'claimAgentCommand', { roomId: CORNER, commandId: ridgeTurn.id, generationId });
    await daemonOperation(RIDGE, 'postAgentTurnReceipt', {
      roomId: CORNER,
      agentId: RIDGE,
      requestId: ridgeTurn.turnRequestId,
      generationId,
      status: 'working',
    });
    await daemonOperation(RIDGE, 'postAgentTurnReceipt', {
      roomId: CORNER,
      agentId: RIDGE,
      requestId: ridgeTurn.turnRequestId,
      generationId,
      status: 'failed',
      reasonKind: 'wrong-model',
      reason: 'the selected model is no longer available',
    });
    console.log("   @ridge's review turn failed (model unavailable)");
  }
  const sableReviews = await reviews(SABLE);
  console.log(`   @sable now has ${sableReviews.length} review turn(s)`);
  expect(sableReviews.length === 1, 'the review did not pass to @sable');
  const configuration = await daemonOperation(SABLE, 'getAgentConfiguration', { agentId: SABLE, roomId: CORNER });
  console.log(`   @sable's corner configuration names the reviewer as @${configuration.reviewerHandle}`);
  expect(configuration.reviewerHandle === 'sable', '@sable is not told it holds the reviewer post');
  const sableTurn = sableReviews[0];
  if (sableTurn) {
    await daemonOperation(SABLE, 'claimAgentCommand', { roomId: CORNER, commandId: sableTurn.id, generationId: 'sable-gen' });
    const approved = await daemonOperation(SABLE, 'approveCornerMerge', {
      cornerId: CORNER,
      briefRevision: 0,
      headSha: HEAD,
    });
    console.log(`   @sable approved PR #${approved.pullRequestNumber} at ${HEAD.slice(0, 7)}`);
  }
  const status = await daemonOperation(SABLE, 'getPrChecksStatus', { cornerId: CORNER });
  console.log(
    `   pr_checks_status: reviewer="${status.reviewer}" approvalPending=${status.approvalPending} ` +
      `reviewerWake=${status.reviewerWake?.status}`,
  );
  expect(status.approvalPending === false, "@sable's approval did not satisfy the merge gate");
  // "tagging" an agent (an @mention) is not an agent tag.
  expect(
    !/\bclass(es)?\b|\btags?\b|\btiers?\b/i.test(JSON.stringify(status)),
    'pr_checks_status still mentions classes, tags, or tiers',
  );

  const transcript = await database.query<{ text: string }>(
    `SELECT text FROM messages WHERE room_id=$1 ORDER BY created_at,id`,
    [CORNER],
  );
  console.log('# Corner transcript');
  for (const row of transcript.rows) console.log(`   - ${row.text}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASSED');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .then(() => {
    if (process.exitCode) process.exit(process.exitCode);
  });
