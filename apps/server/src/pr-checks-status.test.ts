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
const H = 'a'.repeat(64),
  A = 'b'.repeat(64);
const URL = 'https://github.com/owner/widgets/pull/614';
const SHA = 'bcaa310a' + '1'.repeat(32);
let db: PgliteDatabase, operations: GitHubOperations, daemon: DaemonService;
let head: string, runs: Record<string, unknown>[], status: { state: string; total_count: number };
let requests: string[], server: Server | undefined;
let app: GitHubAppClient;

beforeEach(async () => {
  db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Reviewer')`,
    [H, A],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [W]);
  await db.query(
    `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`,
    [W, H, A],
  );
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status)
    VALUES(77,$1,'owner','User','active')`,
    [H],
  );
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
    VALUES(101,77,'owner/widgets','main')`);
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
      `INSERT INTO corner_facts(corner_id,objective,feature_branch,lifecycle)
      VALUES($1,'Review PR 614',$2,'{"checks":"unknown","lifecycle":"working"}')`,
      [corner, `corner/${corner}`],
    );
  }
  for (const room of [R, C, AUTHOR])
    await db.query(
      `INSERT INTO memberships(room_id,identity_id,role,workspace_id) VALUES($1,$2,'member',$4),($1,$3,'owner',$4)`,
      [room, A, H, W],
    );
  head = SHA;
  runs = [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }];
  status = { state: 'pending', total_count: 0 };
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
    if (url.includes('/check-runs?')) return Response.json({ check_runs: runs });
    if (url.endsWith('/status')) return Response.json(status);
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
const checkRequests = () => requests.filter((url) => url.includes('/check-runs?'));
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
  it('resolves the reproduced reviewer corner with unknown lifecycle and zero facts from GitHub', async () => {
    expect(
      (await db.query(`SELECT * FROM corner_check_facts WHERE corner_id=$1`, [C])).rowCount,
    ).toBe(0);
    expect(
      (await db.query(`SELECT lifecycle FROM corner_facts WHERE corner_id=$1`, [C])).rows[0]!
        .lifecycle,
    ).toEqual({ checks: 'unknown', lifecycle: 'working' });
    expect(await gate()).toEqual({
      checks: 'passed',
      pullRequest: URL,
      headSha: SHA,
      approvalPending: false,
    });
    expect(requests.some((url) => url.endsWith('/status'))).toBe(true);
    expect(
      (await db.query(`SELECT facts FROM github_head_checks WHERE head_sha=$1`, [SHA])).rows[0]!
        .facts,
    ).toEqual({ 'run:1': 'passed' });
  });

  it('defaults to the author PR and shares existing head facts with a reviewer', async () => {
    await ownPr();
    await db.query(
      `INSERT INTO corner_check_facts(corner_id,name,status,head_sha) VALUES($1,'test','passed',$2)`,
      [AUTHOR, SHA],
    );
    expect(await daemon.execute('getPrChecksStatus', { cornerId: AUTHOR }, A)).toMatchObject({
      checks: 'passed',
      pullRequest: URL,
    });
    expect(await gate(C, URL)).toMatchObject({ checks: 'passed' });
    expect(checkRequests()).toHaveLength(0);
  });

  it('shares GitHub fallback across corners but resolves a new head independently', async () => {
    await gate();
    await gate(AUTHOR);
    expect(checkRequests()).toHaveLength(1);
    head = '2'.repeat(40);
    runs = [{ id: 2, status: 'in_progress', conclusion: null }];
    expect(await gate()).toMatchObject({ checks: 'pending', headSha: head });
    expect(checkRequests()).toHaveLength(2);
  });

  it.each(['check_run', 'check_suite'])(
    'records %s for a non-corner PR head and invalidates the snapshot',
    async (event) => {
      await gate();
      runs = [{ id: 1, status: 'completed', conclusion: 'failure' }];
      await operations.processWebhook(event, {
        installation: { id: 77 },
        repository: { full_name: 'owner/widgets' },
        action: 'completed',
        [event]: {
          id: 1,
          name: 'test',
          head_sha: SHA,
          head_branch: 'human/opened',
          status: 'completed',
          conclusion: 'failure',
          pull_requests: [{ number: 614 }],
          check_suite: { head_branch: 'human/opened', head_sha: SHA },
        },
      });
      const row = (
        await db.query(`SELECT facts,verified_at FROM github_head_checks WHERE head_sha=$1`, [SHA])
      ).rows[0]!;
      expect(row.verified_at).toBeNull();
      expect(Object.values(row.facts)).toContain('failed');
      expect((await db.query(`SELECT * FROM corner_check_facts`)).rowCount).toBe(0);
      expect(await gate()).toMatchObject({ checks: 'failed' });
      expect(checkRequests()).toHaveLength(2);
    },
  );

  it('does not treat one green webhook check as the complete head verdict', async () => {
    await operations.processWebhook('check_run', {
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      action: 'completed',
      check_run: { id: 1, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success' },
    });
    status = { state: 'failure', total_count: 1 };
    expect(await gate()).toMatchObject({ checks: 'failed' });
    expect(checkRequests()).toHaveLength(1);
  });

  it('keeps pending approvals bound to the requested PR and exact head across author/reviewer corners', async () => {
    await db.query(
      `INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha) VALUES($1,$2,614,$3)`,
      [AUTHOR, H, SHA],
    );
    expect(await gate()).toMatchObject({ approvalPending: true });
    await db.query(`UPDATE corner_merge_approvals SET head_sha=$1`, ['9'.repeat(40)]);
    expect(await gate()).toMatchObject({ approvalPending: false });
  });

  it('reconciles an expired snapshot and never promotes a head with no checks', async () => {
    await gate();
    await db.query(`UPDATE github_head_checks SET verified_at=now()-interval '1 minute'`);
    runs = [];
    expect(await gate()).toMatchObject({ checks: 'pending' });
    expect(checkRequests()).toHaveLength(2);
  });

  it('keeps a webhook invalidation that overlaps an older GitHub snapshot fetch', async () => {
    let started!: () => void, release!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(app, 'readCommitChecks').mockImplementationOnce(async () => {
      started();
      await finish;
      return { 'run:1': 'passed' };
    });
    const initial = gate();
    await fetching;
    const webhook = operations.processWebhook('check_run', {
      installation: { id: 77 },
      repository: { full_name: 'owner/widgets' },
      action: 'completed',
      check_run: { id: 1, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'failure' },
    });
    release();
    await initial;
    await webhook;
    expect(
      (await db.query(`SELECT verified_at FROM github_head_checks WHERE head_sha=$1`, [SHA]))
        .rows[0]!.verified_at,
    ).toBeNull();
    runs = [{ id: 1, status: 'completed', conclusion: 'failure' }];
    expect(await gate()).toMatchObject({ checks: 'failed' });
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

  it('demonstrates the real helper tool returning passed over local HTTP for a PR it did not author', async () => {
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
    try {
      const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('helper timed out')), 10_000);
        createInterface({ input: child.stdout }).on('line', (line) => {
          const message = JSON.parse(line);
          if (message.id === 2) {
            clearTimeout(timer);
            resolve(message);
          }
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'pr_checks_status', arguments: { pullRequest: 614 } },
        }) + '\n',
      );
      const message = await answer;
      const result = message.result as { isError?: boolean; content: { text: string }[] };
      expect(message.error).toBeUndefined();
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const verdict = JSON.parse(result.content[0]!.text);
      expect(verdict).toMatchObject({
        checks: 'passed',
        pullRequest: URL,
        held: false,
        approvalPending: false,
      });
      console.log('Demonstrated pr_checks_status:', JSON.stringify(verdict));
    } finally {
      child.kill();
    }
  });
});
