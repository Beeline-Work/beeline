// CHECK-HEADER-1: isolated built HTTP service, with GitHub responses supplied locally.
// Run: npm run build -w @beeline/server && node --import tsx scripts/prove-corner-check-header.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { GitHubOperations } from '../apps/server/dist/github-operations.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { readRoomView } from '@beeline/api-contract/phone';
import { cornerStatusLine } from '../apps/mobile/sources/buzz/corner-status-line.ts';

const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64), head = 'c'.repeat(40);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const branch = 'feature/header-proof';
const pending = Array.from({ length: 16 }, (_, i) => ({ name: `check ${i}`, status: i === 15 ? 'pending' : 'passed' }));
const complete = Array.from({ length: 34 }, (_, i) => ({ name: `check ${i}`, status: 'passed' }));
let rollup = { state: 'pending', total: 16, failing: [], checks: pending };
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`, [owner]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,github_installation_id) VALUES($1,$2,'Parent','owner/widgets','repository',77)`, [parent, workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`, [corner, workspace, parent, agent]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [workspace, owner]);
  for (const id of [owner, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, parent, id]);
  const pr = { number: 1, headSha: head, title: 'Header proof', targetBranch: 'main', mergeability: 'clean', url: 'https://github.com/owner/widgets/pull/1', merged: false, state: 'open' };
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,feature_branch,lifecycle) VALUES($1,$2,$3,$4::jsonb)`, [corner, agent, branch, JSON.stringify({ pr, checks: 'pending' })]);
  const operations = new GitHubOperations(db, {}, {
    installationToken: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }),
    readPullRequest: async () => pr,
    readCommitCheckRollup: async () => rollup,
  }, 'fixture');
  const live = new LiveHub();
  const daemon = new DaemonService(db, live, undefined, undefined, false, undefined, false, undefined, input => operations.prChecksStatus(input));
  daemon.warmConnectorIndex = async () => {};
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_header_proof_fixture_token'), agent]);
  await db.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, [tokenHash('bat_header_proof_fixture_token'), owner, workspace]);
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }),
    phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1,
    github: { webhookSecret: 'fixture', onWebhook: (event, body, delivery) => operations.processWebhook(event, body, delivery) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function webhook(event, body) {
    const payload = JSON.stringify({ ...body, installation: { id: 77 }, repository: { full_name: 'owner/widgets' } });
    const response = await fetch(`${base}/v1/github/webhook`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': crypto.randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture').update(payload).digest('hex')}`,
    }, body: payload });
    assert.equal(response.status, 202, await response.text());
  }
  async function header() {
    const response = await fetch(`${base}/v1/phone/rooms/${corner}`, { headers: { authorization: 'Bearer bat_header_proof_fixture_token' } });
    assert.equal(response.status, 200);
    return cornerStatusLine(readRoomView(await response.json()).cornerLifecycle, false);
  }
  async function checks() {
    const response = await fetch(`${base}/v1/daemon/operations/getPrChecksStatus`, { method: 'POST', headers: {
      authorization: 'Bearer bdt_header_proof_fixture_token', 'content-type': 'application/json',
    }, body: JSON.stringify({ cornerId: corner }) });
    assert.equal(response.status, 200);
    return response.json();
  }
  for (const trigger of ['workflow completion', 'live checks read']) {
    rollup = { state: 'pending', total: 16, failing: [], checks: pending };
    await webhook('check_run', { action: 'in_progress', check_run: { name: 'BODY SUITE', status: 'in_progress', head_sha: head, check_suite: { head_branch: branch } } });
    assert.equal(await header(), 'PR #1 · 15/16 tests passed · running');
    rollup = { state: 'passed', total: 34, failing: [], checks: complete };
    const started = performance.now();
    if (trigger === 'workflow completion') await webhook('workflow_run', { action: 'completed', workflow_run: { head_branch: branch, head_sha: head, conclusion: 'success' } });
    else assert.equal((await checks()).checkCount, 34);
    assert.equal(await header(), 'PR #1 · all 34 tests passed');
    assert.equal((await checks()).checkCount, 34);
    console.log(`CHECK-HEADER-1 ${trigger}: HTTP phone header=${await header()}; HTTP checks=34 passed; ${Math.round(performance.now() - started)}ms`);
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
