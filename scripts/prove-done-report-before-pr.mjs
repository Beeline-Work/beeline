// Isolated built-service HTTP proof. GitHub is a fixture; its opened webhook is withheld.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { GitHubOperations } from '../apps/server/dist/github-operations.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const token = 'bdt_done_report_fixture';
let server, exists = true, lookups = 0, branch;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`, [human]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by,repository_key,repository_resolution,github_installation_id) VALUES($1,$2,'Parent',$3,'owner/widgets','repository',77)`, [room, workspace, human]);
  for (const member of [human, commander, worker]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, member, room]);
  }
  const github = new GitHubOperations(db, {}, {
    installationToken: async () => ({ token: 'fixture' }),
    openPullRequestsForBranch: async (_token, _repo, ref) => { branch = ref; lookups++; return exists ? [42] : []; },
    readPullRequest: async () => ({ number: 42, state: 'open', merged: false, headRef: branch, baseRef: 'main', headSha: '9'.repeat(40), title: 'Widget', url: 'https://github.com/owner/widgets/pull/42' }),
  }, 'fixture');
  const live = new LiveHub(), phone = new PhoneService(db, 'http://test');
  const daemon = new DaemonService(db, live);
  Object.assign(daemon, { github });
  daemon.warmConnectorIndex = async () => {};
  await phone.execute('sendRoomMessage', { roomId: room, messageId: randomBytes(32).toString('hex'), text: '@commander Build the widget' }, human);
  const order = (await daemon.execute('getAgentCommands', { roomId: room }, commander)).commands[0];
  const claim = c => daemon.execute('claimAgentCommand', { roomId: c.roomId, commandId: c.id, generationId: 'proof' }, c.agentId);
  const authority = c => ({ roomId: c.roomId, requestId: c.turnRequestId, generationId: 'proof' });
  await claim(order);
  const open = () => daemon.execute('createCorner', { ...authority(order), targetRoomId: room, name: 'Widget', objective: 'Build widget', implementer: 'worker', brief: { spec: 'Build widget', repositoryWork: true, approval: { sourceMessageId: order.sourceMessageId } } }, commander);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), worker]);
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }), phone, mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const opened = await open();
  await db.query(`UPDATE corner_facts SET feature_branch=$2 WHERE corner_id=$1`, [opened.cornerId, `feature/corner-${opened.cornerId.replaceAll('-', '').slice(0, 12)}`]);
  const turn = (await daemon.execute('getAgentCommands', { roomId: opened.cornerId }, worker)).commands[0];
  await claim(turn);
  for (const present of [true, false]) {
    exists = present;
    if (!present) await db.query(`UPDATE corner_facts SET lifecycle=lifecycle-'pr' WHERE corner_id=$1`, [opened.cornerId]);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/report`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...authority(turn), status: 'done', text: 'done: widget delivered' }) });
    const body = await response.json();
    assert.equal(response.status, present ? 200 : 409, JSON.stringify(body));
    if (present) {
      const view = await phone.readRoom(opened.cornerId, human);
      assert.equal(view.cornerLifecycle.pr.url, 'https://github.com/owner/widgets/pull/42');
      const reports = (await daemon.execute('getAgentCommands', { roomId: room }, commander)).commands;
      assert(reports.some(c => c.reason === 'report' && c.source.body === 'done: widget delivered'));
    } else assert.match(body.error, /done requires an opened or merged PR/);
    console.log(`DONE-PR-1: GitHub PR ${present ? 'open, webhook withheld → HTTP 200, commander receives report, phone shows PR' : 'absent → HTTP 409, done refused'}`);
  }
  assert.equal(lookups, 2);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
