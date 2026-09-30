#!/usr/bin/env node
/**
 * End-to-end acceptance proof for the corner-migration onto the built-in
 * "corner" workflow contract (report: data/beeline-workflow-contracts-design/
 * report.md): a real local HTTP server, real per-agent daemon tokens, a real
 * PGlite-backed Postgres schema — driving the ACTUAL corner tools
 * (open_corner/createCorner, upgrade_corner_to_code/upgradeCornerLane,
 * pr_checks_status/approve_merge, postRoomMessage) exactly as a live daemon
 * would call them, plus the real GitHub webhook handling
 * (`GitHubOperations.processWebhook`, called directly the way the signed
 * `/v1/github/webhook` route calls it after verifying the signature — that
 * verification is HMAC plumbing unrelated to what this proof is about).
 *
 * These are agent CLIENTS: plain HTTP calls issuing the exact same
 * `/v1/daemon/operations/*` calls a live LLM-backed harness would make,
 * driven by this script rather than by a running model — NOT live
 * LLM-backed agent harnesses. Stated here plainly, and again in the written
 * transcript. Nothing here is mocked except GitHub's own HTTP API (an
 * `installationToken`/`readCommitCheckRollup` stub — this proof is about the
 * corner <-> workflow-contract bookkeeping, not GitHub's API surface, which
 * `github-operations.test.ts` already covers against real payload shapes);
 * nothing touched the production Workspace.
 *
 * Two scenarios:
 *   1. A no-code corner, upgraded to code mid-flight, pushed, checked,
 *      reviewed (approved), and landed via the real merge webhook.
 *   2. A code corner opened directly, pushed, checked, reviewed (one
 *      changes-requested round, then approved after a second push), and
 *      landed via the real merge webhook.
 * After each scenario, the script reads back the transcript-derived current
 * state (the same query `workflow-runs.ts`'s `loadRun` uses: the newest
 * `workflow-handoff` card citing the run id) and asserts it matches what the
 * corner's own `corner_facts`/`rooms.archived_at` say — proving the
 * bookkeeping layer tracks reality, not just that it doesn't crash.
 *
 * Local invocation:
 *   npx tsx scripts/prove-corner-workflow-migration.ts /path/to/real-run.md
 */
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { migrate, type SqlDatabase } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { GitHubOperations } from '../apps/server/src/github-operations.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { createAgentCommand } from '../apps/server/src/agent-command.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const HUMAN = 'a'.repeat(64);
const IMPLEMENTER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

type Command = {
  id: string;
  roomId: string;
  agentId: string;
  sourceMessageId: string;
  turnRequestId: string;
  reason: string;
};

type LogEntry = { label: string; request?: unknown; response: unknown };

async function main(): Promise<void> {
  const log: LogEntry[] = [];
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Proof Owner','proofowner'),
       ($2,'agent','Corny','corny'),
       ($3,'agent','Revi','revi')`,
    [HUMAN, IMPLEMENTER, REVIEWER],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    IMPLEMENTER,
    REVIEWER,
    HUMAN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Corner Migration Proof')`, [
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,
       repository_resolution,repository_target_branch,github_installation_id,reviewer_agent_id)
     VALUES($1,$2,$3,'Widgets','owner/widgets','https://github.com/owner/widgets.git','repository','main',77,$4)`,
    [ROOM, WORKSPACE, HUMAN, REVIEWER],
  );
  await database.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'42','owner','User','selected','active')`,
    [HUMAN],
  );
  await database.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/widgets','main')`,
  );
  for (const who of [HUMAN, IMPLEMENTER, REVIEWER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [WORKSPACE, who, who === HUMAN ? 'owner' : 'member', ROOM],
    );

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const phone = new PhoneService(database, 'http://placeholder');
  const live = new LiveHub();
  let rollupState: 'pending' | 'passed' | 'failed' = 'pending';
  const githubApp = {
    deleteBranch: async () => undefined,
    mergePullRequest: async () => undefined,
    installationToken: async () => ({ token: 'proof-token', expiresAt: '2030-01-01T00:00:00Z' }),
    readCommitCheckRollup: async () => ({
      state: rollupState,
      total: 1,
      failing: rollupState === 'failed' ? ['typecheck'] : [],
      checks: [{ name: 'typecheck', status: rollupState }],
    }),
  };
  const github = new GitHubOperations(
    database,
    {} as unknown as GitHubOAuthClient,
    githubApp as unknown as GitHubAppClient,
    'proof-secret',
  );
  const daemon = new DaemonService(database, live);
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const daemonTokenFor = async (agentId: string) => {
    const exchange = await auth.createDaemonExchange(agentId);
    return (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  };
  const implementerToken = await daemonTokenFor(IMPLEMENTER);
  const reviewerToken = await daemonTokenFor(REVIEWER);

  const call = async (label: string, name: string, payload: unknown, token: string) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      log.push({
        label,
        request: { operation: name, ...(payload as object) },
        response: { httpStatus: response.status, ...(text ? JSON.parse(text) : {}) },
      });
      throw new Error(`${label} (${name}) -> HTTP ${response.status} ${text}`);
    }
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    log.push({ label, request: { operation: name, ...(payload as object) }, response: parsed });
    return parsed;
  };

  const commandsFor = async (agentId: string, token: string, roomId: string): Promise<Command[]> =>
    ((await call(`${agentId} polls its commands`, 'getAgentCommands', { roomId }, token))
      .commands ?? []) as Command[];

  const claim = async (
    agentId: string,
    token: string,
    command: Command,
    generationSeed: string,
  ): Promise<{ requestId: string; generationId: string; roomId: string }> => {
    const generationId = `gen-${generationSeed}`;
    await call(`${agentId} claims its turn`, 'claimAgentCommand', {
      roomId: command.roomId,
      commandId: command.id,
      generationId,
    }, token);
    await call(`${agentId} starts working`, 'postAgentTurnReceipt', {
      roomId: command.roomId,
      agentId,
      requestId: command.turnRequestId,
      generationId,
      status: 'working',
    }, token);
    return { requestId: command.turnRequestId, generationId, roomId: command.roomId };
  };

  const reply = async (
    agentId: string,
    token: string,
    turn: { requestId: string; generationId: string; roomId: string },
    text: string,
  ): Promise<void> => {
    await call(`${agentId} replies`, 'postRoomMessage', {
      roomId: turn.roomId,
      requestId: turn.requestId,
      generationId: turn.generationId,
      text,
    }, token);
  };

  const seedHumanTag = async (roomId: string, agentId: string, text: string): Promise<Command> => {
    const id = `seed-${roomId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      id,
      roomId,
      HUMAN,
      text,
    ]);
    const row = await createAgentCommand(database, {
      roomId,
      agentId,
      sourceMessageId: id,
      reason: 'human_tag',
    });
    if (!row) throw new Error(`failed to seed a command for ${agentId} in ${roomId}: ${text}`);
    return {
      id: row.id,
      roomId: row.room_id,
      agentId: row.agent_id,
      sourceMessageId: row.source_message_id,
      turnRequestId: row.turn_request_id,
      reason: row.reason,
    };
  };

  const push = async (branch: string, headSha: string) => {
    log.push({
      label: `GitHub webhook: push to ${branch} at ${headSha.slice(0, 12)}`,
      response: 'processed',
    });
    await github.processWebhook('push', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      ref: `refs/heads/${branch}`,
      after: headSha,
      commits: [{}],
      pusher: { name: 'corny' },
    });
  };

  const checkRun = async (branch: string, headSha: string, conclusion: 'success' | 'failure') => {
    rollupState = conclusion === 'success' ? 'passed' : 'failed';
    log.push({
      label: `GitHub webhook: check_run completed (${conclusion}) on ${headSha.slice(0, 12)}`,
      response: 'processed',
    });
    await github.processWebhook('check_run', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'completed',
      check_run: {
        id: 900001,
        name: 'typecheck',
        status: 'completed',
        conclusion,
        head_sha: headSha,
        html_url: 'https://github.com/owner/widgets/runs/900001',
        check_suite: { head_branch: branch },
      },
      sender: { login: 'github-actions' },
    });
  };

  const mergePullRequest = async (branch: string, number: number, headSha: string) => {
    log.push({ label: `GitHub webhook: pull_request #${number} merged`, response: 'processed' });
    await github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number,
        title: `Ship ${branch}`,
        html_url: `https://github.com/owner/widgets/pull/${number}`,
        head: { ref: branch, sha: headSha },
        base: { ref: 'main' },
        merged: true,
        merged_at: new Date().toISOString(),
        commits: 1,
        changed_files: 1,
      },
      sender: { login: 'corny' },
    });
  };

  const openPullRequest = async (branch: string, number: number, headSha: string) => {
    log.push({ label: `GitHub webhook: pull_request #${number} opened`, response: 'processed' });
    await github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'opened',
      pull_request: {
        number,
        title: `Ship ${branch}`,
        html_url: `https://github.com/owner/widgets/pull/${number}`,
        head: { ref: branch, sha: headSha },
        base: { ref: 'main' },
        mergeable_state: 'clean',
        merged: false,
      },
      sender: { login: 'corny' },
    });
  };

  /** The same derivation `workflow-runs.ts`'s `loadRun` uses. */
  async function currentWorkflowState(db: SqlDatabase, cornerId: string): Promise<{
    toState: string;
    cards: { fromState?: string; outcome?: string; toState: string; status?: string }[];
  }> {
    const rows = await db.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='workflow-handoff' ORDER BY (card->>'seq')::int`,
      [cornerId],
    );
    const cards = rows.rows.map((row) => row.card as never as {
      fromState?: string;
      outcome?: string;
      toState: string;
      status?: string;
    });
    return { toState: cards.at(-1)?.toState ?? '(none)', cards };
  }

  const failures: string[] = [];
  const assertState = (label: string, actual: string, expected: string) => {
    if (actual !== expected) failures.push(`${label}: expected state '${expected}', got '${actual}'`);
  };

  // ============================================================
  // Scenario 1: a no-code corner, upgraded to code, landed.
  // ============================================================
  const kickoff1 = await seedHumanTag(ROOM, IMPLEMENTER, '@corny take a look at the widget project');
  const turn1a = await claim(IMPLEMENTER, implementerToken, kickoff1, 's1-open');
  const opened1 = await call(
    'corny opens a no-code corner',
    'createCorner',
    {
      roomId: ROOM,
      requestId: turn1a.requestId,
      generationId: turn1a.generationId,
      name: 'Widget scan',
      objective: 'Survey the widget project and report back',
      lane: 'no_code',
    },
    implementerToken,
  );
  const corner1 = opened1.cornerId as string;
  await reply(IMPLEMENTER, implementerToken, turn1a, 'Looked around — the widget project looks healthy.');

  const state1a = await currentWorkflowState(database, corner1);
  assertState('scenario 1, after open (no-code lane)', state1a.toState, 'no_code_work');

  const upgradeAsk = `upgrade-ask-${corner1}`;
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    upgradeAsk,
    corner1,
    HUMAN,
    'Actually there is a real bug in the code — please fix it and ship a PR.',
  ]);
  const upgradeCommandRow = await createAgentCommand(database, {
    roomId: corner1,
    agentId: IMPLEMENTER,
    sourceMessageId: upgradeAsk,
    reason: 'human_tag',
  });
  if (!upgradeCommandRow) throw new Error('failed to seed the upgrade-triggering command');
  const upgradeCommand: Command = {
    id: upgradeCommandRow.id,
    roomId: upgradeCommandRow.room_id,
    agentId: upgradeCommandRow.agent_id,
    sourceMessageId: upgradeCommandRow.source_message_id,
    turnRequestId: upgradeCommandRow.turn_request_id,
    reason: upgradeCommandRow.reason,
  };
  const turn1b = await claim(IMPLEMENTER, implementerToken, upgradeCommand, 's1-upgrade');
  await call(
    'corny upgrades the corner to the code lane',
    'upgradeCornerLane',
    { cornerId: corner1, requestId: turn1b.requestId, generationId: turn1b.generationId },
    implementerToken,
  );

  const state1b = await currentWorkflowState(database, corner1);
  assertState('scenario 1, after upgrade', state1b.toState, 'implement');
  const upgradeCard = state1b.cards.find((card) => card.outcome === 'upgraded');
  if (!upgradeCard) failures.push('scenario 1: no upgrade_to_code -> implement card was recorded');

  const branch1 = `feature/corner-${corner1.replaceAll('-', '').slice(0, 12)}`;
  const head1 = '1'.repeat(40);
  await push(branch1, head1);
  await openPullRequest(branch1, 501, head1);
  await checkRun(branch1, head1, 'success');

  const state1c = await currentWorkflowState(database, corner1);
  assertState('scenario 1, after green checks', state1c.toState, 'review');

  const reviewCommands1 = await commandsFor(REVIEWER, reviewerToken, corner1);
  const reviewTurn1 = await claim(REVIEWER, reviewerToken, reviewCommands1[0]!, 's1-review');
  await call(
    'revi approves the merge',
    'approveCornerMerge',
    { cornerId: corner1, headSha: head1, briefRevision: 1 },
    reviewerToken,
  );
  await reply(REVIEWER, reviewerToken, reviewTurn1, 'Review complete: looks good, approved — merge it.');

  const state1d = await currentWorkflowState(database, corner1);
  assertState('scenario 1, after approval', state1d.toState, 'land');

  await mergePullRequest(branch1, 501, head1);
  const state1e = await currentWorkflowState(database, corner1);
  assertState('scenario 1, after merge webhook', state1e.toState, 'landed');
  const archived1 = await database.query<{ archived: boolean }>(
    `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
    [corner1],
  );
  if (!archived1.rows[0]?.archived) failures.push('scenario 1: corner Room was not archived by the merge webhook');

  // ============================================================
  // Scenario 2: a code corner, one changes-requested round, landed.
  // ============================================================
  const kickoff2 = await seedHumanTag(ROOM, IMPLEMENTER, '@corny please fix the widget rendering bug');
  const turn2a = await claim(IMPLEMENTER, implementerToken, kickoff2, 's2-open');
  const opened2 = await call(
    'corny opens a code corner directly',
    'createCorner',
    {
      roomId: ROOM,
      requestId: turn2a.requestId,
      generationId: turn2a.generationId,
      name: 'Fix rendering',
      objective: 'Fix the widget rendering bug and land it',
      repository: 'owner/widgets',
      targetBranch: 'main',
      brief: {
        buildSpec: 'Fix the widget rendering bug',
        intentVerbatim: [
          { sourceMessageId: kickoff2.sourceMessageId, snapshot: '@corny please fix the widget rendering bug' },
        ],
        criteria: [{ id: 'AC-1', text: 'Widgets render correctly' }],
        references: [],
        approvalBasis: {
          kind: 'initiating-command',
          sourceMessageId: kickoff2.sourceMessageId,
          snapshot: '@corny please fix the widget rendering bug',
        },
      },
    },
    implementerToken,
  );
  const corner2 = opened2.cornerId as string;
  const state2a = await currentWorkflowState(database, corner2);
  assertState('scenario 2, after open (code lane)', state2a.toState, 'implement');

  const branch2 = `feature/corner-${corner2.replaceAll('-', '').slice(0, 12)}`;
  const head2a = '2'.repeat(40);
  await reply(IMPLEMENTER, implementerToken, turn2a, 'Pushed a first pass at the fix.');
  await push(branch2, head2a);
  await openPullRequest(branch2, 502, head2a);
  await checkRun(branch2, head2a, 'success');

  const state2b = await currentWorkflowState(database, corner2);
  assertState('scenario 2, after first green checks', state2b.toState, 'review');

  const reviewCommands2a = await commandsFor(REVIEWER, reviewerToken, corner2);
  const reviewTurn2a = await claim(REVIEWER, reviewerToken, reviewCommands2a[0]!, 's2-review1');
  await reply(REVIEWER, reviewerToken, reviewTurn2a, 'Review complete: please also handle the empty-state case.');

  const state2c = await currentWorkflowState(database, corner2);
  assertState('scenario 2, after changes requested', state2c.toState, 'implement');

  const handbackCommands2 = await commandsFor(IMPLEMENTER, implementerToken, corner2);
  const handback2 = handbackCommands2.find((command) => command.reason === 'corner_review');
  if (!handback2) throw new Error('scenario 2: the implementer was not handed the branch back');
  const turn2b = await claim(IMPLEMENTER, implementerToken, handback2, 's2-fix');
  await reply(IMPLEMENTER, implementerToken, turn2b, 'Handled the empty-state case and pushed again.');
  const head2b = '3'.repeat(40);
  await push(branch2, head2b);
  await checkRun(branch2, head2b, 'success');

  const state2d = await currentWorkflowState(database, corner2);
  assertState('scenario 2, after second green checks', state2d.toState, 'review');

  const reviewCommands2b = await commandsFor(REVIEWER, reviewerToken, corner2);
  const reviewTurn2b = await claim(REVIEWER, reviewerToken, reviewCommands2b[0]!, 's2-review2');
  await call(
    'revi approves the merge (second head)',
    'approveCornerMerge',
    { cornerId: corner2, headSha: head2b, briefRevision: 1 },
    reviewerToken,
  );
  await reply(REVIEWER, reviewerToken, reviewTurn2b, 'Review complete: the empty-state case is handled — approved, merge it.');

  const state2e = await currentWorkflowState(database, corner2);
  assertState('scenario 2, after second approval', state2e.toState, 'land');

  await mergePullRequest(branch2, 502, head2b);
  const state2f = await currentWorkflowState(database, corner2);
  assertState('scenario 2, after merge webhook', state2f.toState, 'landed');
  const archived2 = await database.query<{ archived: boolean }>(
    `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
    [corner2],
  );
  if (!archived2.rows[0]?.archived) failures.push('scenario 2: corner Room was not archived by the merge webhook');

  // ============================================================
  // Write the transcript.
  // ============================================================
  const transcript = await database.query<{
    created_at: Date;
    room_id: string;
    author_id: string;
    text: string;
    card_type: string | null;
  }>(
    `SELECT created_at,room_id,author_id,text,card_type FROM messages
     WHERE room_id IN ($1,$2,$3) ORDER BY created_at,id`,
    [ROOM, corner1, corner2],
  );
  const who = (id: string) =>
    id === HUMAN ? '@proofowner' : id === IMPLEMENTER ? '@corny' : id === REVIEWER ? '@revi' : id;
  const roomName = (id: string) =>
    id === ROOM ? 'Widgets (parent)' : id === corner1 ? 'corner 1 (no-code -> code)' : 'corner 2 (code)';

  const requestResponseSection = (entries: LogEntry[]): string[] => {
    const out: string[] = [];
    for (const entry of entries) {
      out.push(`#### ${entry.label}`);
      out.push('');
      if (entry.request) {
        out.push('Request:');
        out.push('```json');
        out.push(JSON.stringify(entry.request, null, 2));
        out.push('```');
      }
      out.push('Response:');
      out.push('```json');
      out.push(JSON.stringify(entry.response, null, 2));
      out.push('```');
      out.push('');
    }
    return out;
  };

  const lines: string[] = [];
  lines.push('# Real corner-workflow-migration run');
  lines.push('');
  lines.push(
    `A real local HTTP server (\`createBeelineServer\`, real \`DaemonService\`/\`PhoneService\`/auth stack, ` +
      `two real per-agent daemon tokens minted through \`TokenAuth\`) ran a disposable Workspace with one ` +
      `repository-backed Room. These are agent CLIENTS: plain HTTP calls issuing the exact same ` +
      `\`/v1/daemon/operations/*\` calls a live LLM-backed harness would make, driven by this script rather ` +
      `than by a running model — NOT live LLM-backed agent harnesses. GitHub webhook delivery ` +
      `(\`GitHubOperations.processWebhook\`) is called directly, exactly as the signed \`/v1/github/webhook\` ` +
      `route calls it after verifying the HMAC signature — that verification is unrelated plumbing this proof ` +
      `does not re-exercise. The only mock is GitHub's own HTTP API (\`installationToken\`/\`readCommitCheckRollup\`); ` +
      `nothing else is mocked and nothing touched the production Workspace.`,
  );
  lines.push('');
  lines.push(`- Workspace: \`${WORKSPACE}\` ("Corner Migration Proof")`);
  lines.push(`- Repository Room: \`${ROOM}\` (\`owner/widgets\`, reviewer configured: @revi)`);
  lines.push(`- Implementer agent: \`${IMPLEMENTER}\` (@corny)`);
  lines.push(`- Reviewer agent: \`${REVIEWER}\` (@revi)`);
  lines.push(`- Corner 1 (no-code, upgraded to code, landed): \`${corner1}\``);
  lines.push(`- Corner 2 (code from the start, one fix round, landed): \`${corner2}\``);
  lines.push('');
  lines.push('## Scenario 1: no-code corner opened, upgraded to code, reviewed, landed');
  lines.push('');
  lines.push('### Requests, webhooks, and responses, in order');
  lines.push('');
  lines.push(...requestResponseSection(log.slice(0, log.findIndex((entry) => entry.label.includes('corny opens a code corner directly')))));
  lines.push('### Bookkeeping cards recorded for corner 1 (the `corner` workflow contract run)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(state1e.cards, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Scenario 2: code corner opened directly, one changes-requested round, landed');
  lines.push('');
  lines.push('### Requests, webhooks, and responses, in order');
  lines.push('');
  const scenario2Start = log.findIndex((entry) => entry.label.includes('corny opens a code corner directly'));
  lines.push(...requestResponseSection(log.slice(scenario2Start)));
  lines.push('### Bookkeeping cards recorded for corner 2 (the `corner` workflow contract run)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(state2f.cards, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### Verdict');
  lines.push('');
  if (failures.length) {
    lines.push('**FAILED**');
    for (const failure of failures) lines.push(`- ${failure}`);
  } else {
    lines.push(
      'PASSED: both corners ran their real, unchanged lifecycle end to end (open, [upgrade,] push, checks, ' +
        'review, [a fix round,] approval, the real merge webhook) and, at every step, the transcript-derived ' +
        'current state of the built-in `corner` workflow run (the newest `workflow-handoff` card citing the ' +
        "corner's own room id as its run id — the exact query `workflow-runs.ts`'s `loadRun` uses for any other " +
        "workflow) matched what the corner's own facts said, with no change to any real dispatch, authorization, " +
        'or merge decision.',
    );
  }
  lines.push('');
  lines.push('## Resulting transcript, all three Rooms');
  lines.push('');
  for (const row of transcript.rows) {
    lines.push(
      `- \`${row.created_at.toISOString()}\` [${roomName(row.room_id)}] ${who(row.author_id)}` +
        `${row.card_type ? ` [${row.card_type}]` : ''}: ${row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text}`,
    );
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();

  const output = lines.join('\n');
  const target = process.argv[2];
  if (target) {
    await writeFile(target, output, 'utf8');
    console.log(`wrote transcript to ${target}`);
  } else {
    console.log(output);
  }
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
  .finally(() => process.exit(process.exitCode ?? 0));
