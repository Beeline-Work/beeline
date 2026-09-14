#!/usr/bin/env node
/**
 * End-to-end acceptance proof for reviewer dispatch on a green corner head.
 *
 * Everything here runs against the real HTTP server: the person's tap is a
 * phone operation, GitHub's news is a signed webhook delivery, and the
 * reviewer agent learns it has work the only way a daemon ever does — by
 * polling `getAgentCommands`. Nothing in the proof reaches past those routes.
 *
 * Two scenarios, both of which used to end in silence:
 *   1. The reviewer replaced its own event subscriptions, then a check passed.
 *   2. The head was already green when the Room's reviewer was configured.
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
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64);
const REVIEWER = 'b'.repeat(64);
const IMPLEMENTER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OVERWRITTEN_CORNER = '33333333-3333-4333-8333-333333333333';
const ALREADY_GREEN_CORNER = '44444444-4444-4444-8444-444444444444';
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
  ] as const)
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,$5)`,
      [corner, WORKSPACE, ROOM, HUMAN, name],
    );
  for (const [corner, branch, number, seed] of [
    [OVERWRITTEN_CORNER, 'feature/overwritten', 1, '1'],
    [ALREADY_GREEN_CORNER, 'feature/already-green', 2, '2'],
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
    for (const room of [null, ROOM, OVERWRITTEN_CORNER, ALREADY_GREEN_CORNER])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
        [WORKSPACE, room, who, who === HUMAN ? 'owner' : 'member'],
      );

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const github = new GitHubOperations(
    database,
    {} as GitHubOAuthClient,
    {} as GitHubAppClient,
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

  const failures: string[] = [];

  console.log('# 1. reviewer replaced its own event subscriptions, then a check passed');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: REVIEWER });
  console.log('   person set the Room reviewer to @reviewer');
  const kept = await daemonOperation('setEventSubscriptions', {
    roomId: OVERWRITTEN_CORNER,
    kinds: ['joined'],
  });
  console.log(`   reviewer called subscribe_events(['joined']) -> kinds=${JSON.stringify(kept.kinds)}`);
  await checkPassed('feature/overwritten', head('1'), 'build');
  const overwritten = await reviewerCommands(OVERWRITTEN_CORNER);
  console.log(`   GitHub reported a passing check; reviewer polled and got ${describe(overwritten)}`);
  if (!overwritten.length) failures.push('no review command after the reviewer overwrote its subscriptions');

  console.log('# 2. head already green before the Room reviewer was configured');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: null });
  console.log('   person cleared the Room reviewer');
  await checkPassed('feature/already-green', head('2'), 'build');
  console.log('   GitHub reported a passing check on the second corner (no reviewer yet)');
  await phoneOperation('updateRoom', { roomId: ROOM, reviewerAgentId: REVIEWER });
  console.log('   person set the Room reviewer to @reviewer');
  const alreadyGreen = await reviewerCommands(ALREADY_GREEN_CORNER);
  console.log(`   reviewer polled the already-green corner and got ${describe(alreadyGreen)}`);
  if (!alreadyGreen.length) failures.push('no review command for the already-green unreviewed head');

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASSED: the configured reviewer was woken for both green heads.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // PGlite keeps its worker alive; the proof has printed everything it knows.
  .finally(() => process.exit(process.exitCode ?? 0));
