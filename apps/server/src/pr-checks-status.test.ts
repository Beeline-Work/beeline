import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubAppClient, type GitHubOAuthClient } from '@beeline/auth/github';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { GitHubOperations } from './github-operations.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '4c21aefc-a9e9-457b-918e-b26306253ac8';
const AUTHOR = '33333333-3333-4333-8333-333333333333';
const H = 'a'.repeat(64);
const A = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const URL = 'https://github.com/owner/widgets/pull/614';
const SHA = 'bcaa310a' + '1'.repeat(32);

let db: PgliteDatabase;
let operations: GitHubOperations;
let daemon: DaemonService;
let app: GitHubAppClient;
let head: string;
let rollupState: string | null;
let requests: string[];
let server: Server | undefined;

beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
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
    await db.query(
      `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,feature_branch,lifecycle)
       VALUES($1,$3,'Review PR 614',$2,'{"checks":"unknown","lifecycle":"working"}')`,
      [corner, `corner/${corner}`, A],
    );
  }
  for (const room of [R, C, AUTHOR]) {
    await db.query(
      `INSERT INTO memberships(room_id,identity_id,role,workspace_id)
       VALUES($1,$2,'member',$5),($1,$3,'member',$5),($1,$4,'owner',$5)`,
      [room, A, REVIEWER, H, W],
    );
  }
  head = SHA;
  rollupState = 'SUCCESS';
  requests = [];
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
    if (url.endsWith('/pulls/614')) return Response.json({ head: { sha: head } });
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
                      contexts: {
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
    (input) => operations.prChecksStatus(input),
  );
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

const gate = (cornerId = C, pullRequest: number | string | undefined = 614) =>
  daemon.execute(
    'getPrChecksStatus',
    { cornerId, ...(pullRequest === undefined ? {} : { pullRequest }) },
    A,
  );
const graphqlRequests = () => requests.filter((url) => url.endsWith('/graphql'));

async function ownPr() {
  await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    AUTHOR,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'passing',
      pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main' },
    }),
  ]);
}

describe('PR-scoped check gate', () => {
  it('uses GitHub statusCheckRollup as the verdict', async () => {
    await expect(gate()).resolves.toMatchObject({
      checks: 'passed',
      pullRequest: URL,
      headSha: SHA,
      approvalPending: true,
      reviewer: null,
    });
    expect(graphqlRequests()).toHaveLength(1);
    expect(
      (
        await db.query<{ name: string }>(
          `SELECT table_name name FROM information_schema.tables
           WHERE table_name IN ('corner_check_facts','github_head_checks')`,
        )
      ).rows,
    ).toEqual([]);
  });

  it('reads the current head and current GitHub verdict every time', async () => {
    expect(await gate()).toMatchObject({ checks: 'passed', headSha: SHA });
    head = '2'.repeat(40);
    rollupState = 'PENDING';
    expect(await gate()).toMatchObject({ checks: 'pending', headSha: head });
    expect(graphqlRequests()).toHaveLength(2);
  });

  it('cannot be made stale by a synthetic check-suite webhook', async () => {
    await operations.processWebhook('check_suite', {
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      action: 'in_progress',
      check_suite: {
        id: 1,
        head_sha: SHA,
        head_branch: 'not-a-corner',
        status: 'in_progress',
        app: { name: 'GitHub Actions' },
      },
    });
    expect(await gate()).toMatchObject({ checks: 'passed' });
  });

  it('does not promote a head with no rollup', async () => {
    rollupState = null;
    expect(await gate()).toMatchObject({ checks: 'pending' });
  });

  it('does not turn self-review into merge authority', async () => {
    await ownPr();
    await db.query(`UPDATE corner_facts SET owner_agent_id=$2 WHERE corner_id=$1`, [AUTHOR, A]);
    await db.query(`UPDATE identities SET handle='reviewer' WHERE id=$1`, [A]);
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
    expect(await gate(AUTHOR)).toMatchObject({
      checks: 'passed',
      approvalPending: true,
      reviewer: '@reviewer',
      reviewerIsAuthor: true,
    });
  });

  it('distinguishes human approval from an agent review and missing request state', async () => {
    await ownPr();
    expect(await gate(AUTHOR)).toMatchObject({ approvalPending: true, reviewer: null });
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    expect(await gate(AUTHOR)).toMatchObject({ approvalPending: true, reviewer: '@reviewer' });
    await expect(
      daemon.execute('approveCornerMerge', { cornerId: AUTHOR, headSha: SHA }, REVIEWER),
    ).rejects.toThrow('merge approval requires a human');
    await db.query(
      `INSERT INTO corner_merge_approvals(corner_id,approved_by,force,pull_request_number,head_sha)
       VALUES($1,$2,false,614,$3)`,
      [AUTHOR, REVIEWER, SHA],
    );
    expect(await gate(AUTHOR)).toMatchObject({ approvalPending: true });
    await db.query(`DELETE FROM corner_merge_approvals WHERE corner_id=$1`, [AUTHOR]);
    await db.query(
      `INSERT INTO corner_merge_approvals(corner_id,approved_by,force,pull_request_number,head_sha)
       VALUES($1,$2,false,614,$3)`,
      [AUTHOR, H, SHA],
    );
    expect(await gate(AUTHOR)).toMatchObject({ approvalPending: false });
    head = '9'.repeat(40);
    expect(await gate(AUTHOR)).toMatchObject({ approvalPending: true, headSha: head });
  });

  it('preserves owner-authorized automatic merge mode without per-PR approval', async () => {
    await db.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [A]);
    expect(await gate()).toMatchObject({ approvalPending: false });
  });

  it('names a configured reviewer who is not a parent member and does not drop the gate', async () => {
    await ownPr();
    await db.query(`UPDATE identities SET handle='reviewer' WHERE id=$1`, [A]);
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
      R,
      A,
    ]);
    expect(await gate(AUTHOR)).toMatchObject({
      checks: 'passed',
      approvalPending: true,
      reviewer: '@reviewer',
      reviewerIsAuthor: false,
      reviewerWake: {
        status: 'unreachable',
        detail:
          '@reviewer is configured as reviewer but is not a current member of the parent Room, so the checks-passed transition cannot wake them.',
      },
    });
    expect((await gate(AUTHOR)).rule).toContain('cannot wake them');
  });

  it('reports waiting while checks are still pending so the author does not invent a missed wake', async () => {
    await ownPr();
    await db.query(`UPDATE identities SET handle='reviewer' WHERE id=$1`, [A]);
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
    await db.query(
      `UPDATE corner_facts SET lifecycle=$2::jsonb,command_check_state=NULL WHERE corner_id=$1`,
      [
        AUTHOR,
        JSON.stringify({
          lifecycle: 'in-review',
          checks: 'pending',
          pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main' },
        }),
      ],
    );
    rollupState = 'PENDING';
    expect(await gate(AUTHOR)).toMatchObject({
      checks: 'pending',
      reviewer: '@reviewer',
      reviewerWake: {
        status: 'waiting',
        detail: 'Checks are still pending, so @reviewer has not been woken yet.',
      },
    });
  });

  it('reports dispatched after the green transition consumed the reviewer wake', async () => {
    await ownPr();
    await db.query(`UPDATE identities SET handle='reviewer' WHERE id=$1`, [A]);
    await db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, A]);
    await db.query(`UPDATE corner_facts SET command_check_state='passing' WHERE corner_id=$1`, [
      AUTHOR,
    ]);
    expect(await gate(AUTHOR)).toMatchObject({
      reviewerWake: {
        status: 'dispatched',
        detail: 'The checks-passed transition woke @reviewer.',
      },
    });
  });

  it('refuses other repositories and nonmembers before accessing PR data', async () => {
    await expect(gate(C, 'https://github.com/other/private/pull/614')).rejects.toThrow(
      'Room repository',
    );
    await expect(
      daemon.execute('getPrChecksStatus', { cornerId: C, pullRequest: 614 }, 'c'.repeat(64)),
    ).rejects.toThrow('access denied');
    expect(requests).toHaveLength(0);
  });

  it('returns the authoritative verdict through the real helper over local HTTP', async () => {
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const operation = request.url!.split('/').pop() as keyof DaemonOperationMap;
        const output = await daemon.execute(
          operation,
          JSON.parse(Buffer.concat(chunks).toString()),
          A,
        );
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(output));
      } catch (error) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new globalThis.URL('../../body/src/read-only-mcp.ts', import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          BEELINE_MCP_SURFACE: 'agent',
          BEELINE_AGENT_DM: '0',
          BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${address.port}`,
          BEELINE_DAEMON_TOKEN: 'local-test',
          BEELINE_DAEMON_ROOM_ID: R,
          BEELINE_DAEMON_CORNER_ID: C,
          BEELINE_DAEMON_WORKSPACE_ID: W,
          BEELINE_DAEMON_AGENT_ID: A,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines = createInterface({ input: child.stdout });
    const replies: string[] = [];
    lines.on('line', (line) => replies.push(line));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pr_checks_status', arguments: { pullRequest: 614 } } })}\n`,
    );
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    child.kill();
    expect(JSON.parse(replies[0]!)).toMatchObject({
      result: { content: [{ type: 'text', text: expect.stringContaining('"checks":"passed"') }] },
    });
  });
});
