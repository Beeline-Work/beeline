// Isolated built-service proof; provider responses are fixtures, never a real merge.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { GitHubOperations } from '../apps/server/dist/github-operations.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64), head = 'c'.repeat(40);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const base = process.argv.includes('--base');
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Commander')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`, [owner]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,github_installation_id,reviewer_agent_id) VALUES($1,$2,'Parent','owner/widgets','repository',77,$3)`, [parent, workspace, agent]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`, [corner, workspace, parent, agent]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, parent, agent]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle) VALUES($1,$2,$3::jsonb)`, [corner, agent, JSON.stringify({pr:{number:1,headSha:head}})]);
  await db.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,head_sha,pull_request_number) VALUES($1,$2,$3,1)`, [corner, agent, head]);
  const operations = new GitHubOperations(db, {}, {
    installationToken: async () => ({token:'fixture',expiresAt:'2030-01-01T00:00:00Z'}),
    readPullRequest: async () => ({number:1,headSha:head,url:'https://github.com/owner/widgets/pull/1',merged:false}),
    readCommitCheckRollup: async () => ({state:'passed',total:1,checks:[],failing:[]}),
  }, 'fixture');
  const live = new LiveHub();
  const daemon = new DaemonService(db, live, undefined, undefined, false, undefined, false, undefined, input => operations.prChecksStatus(input));
  daemon.warmConnectorIndex = async () => {};
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_closed_corner_fixture'), agent]);
  server = createBeelineServer({database:db,daemon,live,auth:new TokenAuth(db, async () => {throw new Error('unused');}),phone:new PhoneService(db,'http://test'),mediaMaximumBytes:1});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  async function request(operation) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`, {method:'POST',headers:{authorization:'Bearer bdt_closed_corner_fixture','content-type':'application/json'},body:JSON.stringify({cornerId:corner})});
    return {status:response.status,body:await response.json()};
  }
  const open = await request('getPrChecksStatus');
  assert.equal(open.status,200);
  assert.equal(open.body.mergeAllowed,true);
  await db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [corner]);
  const checks = await request('getPrChecksStatus');
  assert.equal(checks.status,200);
  assert.equal(checks.body.stage,'closed');
  assert.equal(checks.body.mergeAllowed,base);
  const merge = await request('mergeCorner');
  assert.equal(merge.status,base ? 404 : 200);
  assert.deepEqual(merge.body,base ? {error:'corner not found'} : {status:'blocked',blocker:'the corner is closed'});
  console.log(`Reproduction CLOSED-1: open mergeAllowed=true; closed stage=${checks.body.stage}, mergeAllowed=${checks.body.mergeAllowed}; merge HTTP ${merge.status} ${JSON.stringify(merge.body)}`);
} finally {
  if(server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
