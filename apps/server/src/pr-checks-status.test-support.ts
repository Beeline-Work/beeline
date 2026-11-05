import { cornerFeatureBranch } from './corner-branch.js';

import { spawn } from 'node:child_process';

import { createServer, type Server } from 'node:http';

import { createInterface } from 'node:readline';

import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitHubAppClient, type GitHubOAuthClient } from '@beeline/auth/github';

import type { DaemonOperationMap } from '@beeline/api-contract/daemon';

import { PgliteDatabase, migratedDatabase, assignCornerWorker, recordCornerRun, insertCornerFacts, setCornerOwner, seedCornerOpening } from './test-support.js';

import { GitHubOperations } from './github-operations.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { LiveHub } from './live.js';

import { PhoneService } from './phone-service.js';

import { createAgentCommand } from './agent-command.js';

import { systemLine } from './system-line.js';


export const W = '11111111-1111-4111-8111-111111111111';

export const R = '22222222-2222-4222-8222-222222222222';

export const C = '4c21aefc-a9e9-457b-918e-b26306253ac8';

export const AUTHOR = '33333333-3333-4333-8333-333333333333';

export const H = 'a'.repeat(64);

export const A = 'b'.repeat(64);

export const REVIEWER = 'c'.repeat(64);

export const URL = 'https://github.com/owner/widgets/pull/614';

export const SHA = 'bcaa310a' + '1'.repeat(32);


export let db: PgliteDatabase;

export let operations: GitHubOperations;

export let daemon: DaemonService;

export let app: GitHubAppClient;

export let head: string;

export let rollupState: string | null;

export let rollupContexts: { totalCount: number; nodes: Record<string, unknown>[] } | undefined;

export let mergeableState: string | undefined;

export let pullBaseSha: string | undefined;

export let mainHead: string;

export let failMergeabilityRead: boolean;

export let workflowCount: number;

export let actionsEnabled: boolean;

export let registeredCount: number;

export let onWorkflowRead: (() => Promise<void>) | undefined;

export let workflowStatus: string;

export let suiteStatus: string;

export let suiteRuns: number | undefined;

export let associatedPulls: Record<string, unknown>[];

export let requiredContexts: string[] | null;

export let protectionForbidden: string | undefined;

export let requests: string[];

export let registrationForbidden: boolean;

export let server: Server | undefined;


beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle)
     VALUES($1,'human','Owner','owner'),($2,'agent','Author','author'),($3,'agent','Reviewer','reviewer')`,
    [H, A, REVIEWER],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,yolo_mode) VALUES($1,$3,false),($2,$3,false)`,
    [A, REVIEWER, H],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [W]);
  await db.query(
    `INSERT INTO memberships(workspace_id,identity_id,role)
     VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`,
    [W, H, A, REVIEWER],
  );
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status)
     VALUES(77,$1,'owner','User','active')`,
    [H],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/widgets','main')`,
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,repository_remote,github_installation_id)
     VALUES($1,$2,$3,'General','https://github.com/owner/widgets.git',77)`,
    [R, W, H],
  );
  for (const corner of [C, AUTHOR]) {
    await db.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Review PR 614')`,
      [corner, W, R, H],
    );
    await insertCornerFacts(db, { cornerId: corner, ownerAgentId: A, lifecycle: '{"checks":"unknown","lifecycle":"working"}' });
  }
  for (const room of [R]) {
    await db.query(
      `INSERT INTO memberships(room_id,identity_id,role,workspace_id)
       VALUES($1,$2,'member',$5),($1,$3,'member',$5),($1,$4,'owner',$5)`,
      [room, A, REVIEWER, H, W],
    );
  }
  head = SHA;
  rollupState = 'SUCCESS';
  rollupContexts = undefined;
  mergeableState = undefined;
  pullBaseSha = undefined;
  mainHead = 'd'.repeat(40);
  failMergeabilityRead = false;
  workflowCount = 0;
  actionsEnabled = true;
  registeredCount = 1;
  onWorkflowRead = undefined;
  workflowStatus = 'completed';
  suiteStatus = 'completed';
  suiteRuns = undefined;
  associatedPulls = [];
  requiredContexts = null;
  protectionForbidden = undefined;
  requests = [];
  registrationForbidden = false;
  app = new GitHubAppClient({
    appId: '1',
    privateKey: 'unused',
    slug: 'beeline',
    apiBaseUrl: 'https://api.github.test',
  });
  vi.spyOn(app, 'installationToken').mockResolvedValue({
    token: 'room-token',
    expiresAt: '2030-01-01T00:00:00Z',
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | globalThis.URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.test/')) return realFetch(input, init);
    requests.push(url);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer room-token');
    if (registrationForbidden && url.includes('/actions/runs?')) return Response.json(
      { message: 'Resource not accessible by integration' },
      { status: 403, headers: { 'x-github-request-id': 'sentry-1d', 'x-accepted-github-permissions': 'actions=read' } },
    );
    if (url.endsWith('/actions/permissions')) return Response.json({ enabled: actionsEnabled });
    if (url.endsWith('/actions/workflows?per_page=1')) {
      await onWorkflowRead?.();
      return Response.json({ total_count: workflowCount });
    }
    if (url.includes('/commits/') && url.includes('/pulls')) return Response.json(associatedPulls);
    if (url.includes('/protection/required_status_checks')) {
      if (protectionForbidden) return Response.json({ message: protectionForbidden }, { status: 403 });
      if (requiredContexts === null) return new Response('not protected', { status: 404 });
      return Response.json({
        contexts: requiredContexts,
        checks: requiredContexts.map((context) => ({ context, app_id: 15368 })),
      });
    }
    if (url.includes('per_page=100')) return Response.json(url.includes('/check-suites?')
      ? {
          total_count: 1,
          check_suites: [{
            status: suiteStatus,
            ...(suiteRuns === undefined ? {} : { latest_check_runs_count: suiteRuns }),
          }],
        }
      : { total_count: 1, workflow_runs: [{ status: workflowStatus }] });
    if (url.includes('/check-suites?') || url.includes('/actions/runs?')) {
      if (registeredCount) rollupState = 'PENDING';
      return Response.json({ total_count: registeredCount });
    }
    // The mergeability refresh reads the pull again after the check rollup.
    if (
      url.endsWith('/pulls/614') &&
      failMergeabilityRead &&
      requests.some((request) => request.endsWith('/graphql'))
    )
      return new Response('unavailable', { status: 502 });
    if (url.endsWith('/pulls/614'))
      return Response.json({
        head: { sha: head },
        ...(pullBaseSha ? { base: { ref: 'main', sha: pullBaseSha } } : {}),
        mergeable_state: mergeableState,
      });
    if (url.endsWith('/branches/main')) return Response.json({ commit: { sha: mainHead } });
    if (url.endsWith('/graphql')) {
      const variables = JSON.parse(String(init?.body)).variables as { expression: string };
      return Response.json({
        data: {
          repository: {
            object: {
              oid: variables.expression,
              statusCheckRollup:
                rollupState === null
                  ? null
                  : {
                      state: rollupState,
                      contexts: rollupContexts ?? {
                        totalCount: 1,
                        nodes: [
                          {
                            __typename: 'CheckRun',
                            name: 'test',
                            status: rollupState === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
                            conclusion: rollupState === 'SUCCESS' ? 'SUCCESS' : rollupState,
                          },
                        ],
                      },
                    },
            },
          },
        },
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  operations = new GitHubOperations(db, {} as GitHubOAuthClient, app, 'secret');
  daemon = new DaemonService(
    db,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    (input, confirmZeroChecks) => operations.prChecksStatus(input, confirmZeroChecks),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (cornerId) => operations.refreshStaleMergeability(cornerId),
  );
  Object.assign(daemon, { github: { assertCornerReviewerNotAuthor: async () => {} } });
});


afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.close();
});


export const gate = (cornerId = C, pullRequest: number | string | undefined = 614) =>
  daemon.execute(
    'getPrChecksStatus',
    { cornerId, ...(pullRequest === undefined ? {} : { pullRequest }) },
    A,
  );

export const graphqlRequests = () => requests.filter((url) => url.endsWith('/graphql'));


export async function ownPr() {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    AUTHOR,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'passing',
      pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main' },
    }),
  ]);
}
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get operations(){return operations;}, set operations(value: typeof operations){operations=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
get app(){return app;}, set app(value: typeof app){app=value;},
get head(){return head;}, set head(value: typeof head){head=value;},
get rollupState(){return rollupState;}, set rollupState(value: typeof rollupState){rollupState=value;},
get rollupContexts(){return rollupContexts;}, set rollupContexts(value: typeof rollupContexts){rollupContexts=value;},
get mergeableState(){return mergeableState;}, set mergeableState(value: typeof mergeableState){mergeableState=value;},
get pullBaseSha(){return pullBaseSha;}, set pullBaseSha(value: typeof pullBaseSha){pullBaseSha=value;},
get mainHead(){return mainHead;}, set mainHead(value: typeof mainHead){mainHead=value;},
get failMergeabilityRead(){return failMergeabilityRead;}, set failMergeabilityRead(value: typeof failMergeabilityRead){failMergeabilityRead=value;},
get workflowCount(){return workflowCount;}, set workflowCount(value: typeof workflowCount){workflowCount=value;},
get actionsEnabled(){return actionsEnabled;}, set actionsEnabled(value: typeof actionsEnabled){actionsEnabled=value;},
get registeredCount(){return registeredCount;}, set registeredCount(value: typeof registeredCount){registeredCount=value;},
get onWorkflowRead(){return onWorkflowRead;}, set onWorkflowRead(value: typeof onWorkflowRead){onWorkflowRead=value;},
get workflowStatus(){return workflowStatus;}, set workflowStatus(value: typeof workflowStatus){workflowStatus=value;},
get suiteStatus(){return suiteStatus;}, set suiteStatus(value: typeof suiteStatus){suiteStatus=value;},
get suiteRuns(){return suiteRuns;}, set suiteRuns(value: typeof suiteRuns){suiteRuns=value;},
get associatedPulls(){return associatedPulls;}, set associatedPulls(value: typeof associatedPulls){associatedPulls=value;},
get requiredContexts(){return requiredContexts;}, set requiredContexts(value: typeof requiredContexts){requiredContexts=value;},
get protectionForbidden(){return protectionForbidden;}, set protectionForbidden(value: typeof protectionForbidden){protectionForbidden=value;},
get requests(){return requests;}, set requests(value: typeof requests){requests=value;},
get registrationForbidden(){return registrationForbidden;}, set registrationForbidden(value: typeof registrationForbidden){registrationForbidden=value;},
get server(){return server;}, set server(value: typeof server){server=value;},
};
export function fixtureScope2() {

  /** The worker finishes its turn after GitHub has registered the corner PR. */
  async function finishPrTurn(baseSha: string, text = URL) {
    await new PhoneService(rootFixture.db, 'http://test').execute(
      'updateRoom',
      { roomId: R, reviewerAgentId: REVIEWER },
      H,
    );
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      C,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'unknown',
        pr: {
          number: 614,
          url: URL,
          headSha: SHA,
          title: 'Work',
          targetBranch: 'main',
          baseSha,
          mergeability: 'unknown',
        },
      }),
    ]);
    const source = await systemLine(rootFixture.db, {
      roomId: C,
      authorId: H,
      subject: { kind: 'person', id: H, name: 'Owner' },
      verb: 'requested work',
    });
    await createAgentCommand(rootFixture.db, {
      roomId: C,
      agentId: A,
      sourceMessageId: source.id,
      reason: 'corner_objective',
    });
    const [worker] = (await rootFixture.daemon.execute('getAgentCommands', { roomId: C }, A)).commands;
    await rootFixture.daemon.execute(
      'claimAgentCommand',
      { roomId: C, commandId: worker!.id, generationId: 'g1' },
      A,
    );
    await rootFixture.daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: C,
        agentId: A,
        requestId: worker!.turnRequestId,
        generationId: 'g1',
        status: 'working',
      },
      A,
    );
    await rootFixture.daemon.execute(
      'postRoomMessage',
      { roomId: C, requestId: worker!.turnRequestId, generationId: 'g1', text },
      A,
    );
    const lifecycle = (
      await rootFixture.db.query<{ lifecycle: Record<string, unknown> & { pr: Record<string, unknown> } }>(
        `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
        [C],
      )
    ).rows[0]!.lifecycle;
    const reasons = async (agentId: string) =>
      (
        await rootFixture.db.query<{ reason: string }>(
          `SELECT reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`,
          [C, agentId],
        )
      ).rows.map((row) => row.reason);
    return { lifecycle, reviewer: await reasons(REVIEWER), worker: await reasons(A) };
  }
return {
finishPrTurn,
};
}
export { cornerFeatureBranch } from './corner-branch.js';
export { spawn } from 'node:child_process';
export { createServer } from 'node:http';
export { createInterface } from 'node:readline';
export { fileURLToPath } from 'node:url';
export { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
export { GitHubAppClient } from '@beeline/auth/github';
export { PgliteDatabase, migratedDatabase, assignCornerWorker, recordCornerRun, insertCornerFacts, setCornerOwner, seedCornerOpening } from './test-support.js';
export { GitHubOperations } from './github-operations.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { LiveHub } from './live.js';
export { PhoneService } from './phone-service.js';
export { createAgentCommand } from './agent-command.js';
export { systemLine } from './system-line.js';
export type { Server } from 'node:http';
export type { GitHubOAuthClient } from '@beeline/auth/github';
export type { DaemonOperationMap } from '@beeline/api-contract/daemon';
