// Run after npm run build -w @beeline/server: node --import tsx .verification/corner-close/prove.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PgliteDatabase } from '../../apps/server/src/test-support.ts';
import { migrate } from '../../apps/server/dist/database.js';
import { DaemonService } from '../../apps/server/dist/daemon-service.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { GitHubOperations } from '../../apps/server/dist/github-operations.js';
import { LiveHub } from '../../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../../apps/server/dist/auth.js';
import { createBeelineServer } from '../../apps/server/dist/server.js';
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64), workspace = randomUUID(), parent = randomUUID();
const live = new LiveHub();
let fail = false;
const calls = [];
const github = new GitHubOperations(db, {}, {
  closePullRequest: async (...args) => {
    calls.push(args);
    if (fail) throw new Error('simulated GitHub outage');
  },
}, 'fixture');
const daemon = new DaemonService(db, live, undefined, undefined, false, undefined, false, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, id => github.closeCornerPullRequest(id));
daemon.warmConnectorIndex = async () => {};
const auth = new TokenAuth(db, async () => { throw new Error('fixture has no external sign-in'); });
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Agent')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'R1 proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,'R1 parent','owner/widgets','https://github.com/owner/widgets.git','repository',77)`, [parent, workspace]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
    VALUES(77,$1,'42','owner','User','selected','active')`, [owner]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`);
  for (const identity of [owner, agent]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [workspace, identity, parent]);
  }
  await db.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,'2035-01-01'::timestamptz)`, [tokenHash('R1-phone-fixture-123456789'), owner, workspace]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_R1_fixture_123456789'), agent]);
  assert.equal(await auth.authenticatePhone('R1-phone-fixture-123456789'), owner);
  server = createBeelineServer({ database: db, auth, daemon, phone: new PhoneService(db, 'http://test', github), live, mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const lane of ['phone', 'daemon']) for (const outage of [false, true]) {
    const corner = randomUUID();
    fail = outage;
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Disposable R1 corner')`, [corner, workspace, parent]);
    await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,lifecycle) VALUES($1,$2,$3::jsonb)`, [corner, agent,
      JSON.stringify({pr:{number:7,url:'https://github.com/owner/widgets/pull/7',headSha:'c'.repeat(40)}})]);
    await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing) VALUES($1,$2,'owner')`, [corner, owner]);
    const before = calls.length;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${lane}/operations/${lane === 'phone' ? 'requestCornerClose' : 'archiveCorner'}`, {
      method:'POST', headers:{authorization:`Bearer ${lane === 'phone' ? 'R1-phone-fixture-123456789' : 'bdt_R1_fixture_123456789'}`,'content-type':'application/json'},
      body:JSON.stringify(lane === 'phone' ? {roomId:corner} : {cornerId:corner}),
    });
    const result = await response.text();
    assert.ok(response.ok, `${response.status}: ${result}`);
    assert.equal(calls.length, before+1);
    assert.deepEqual(calls.at(-1), [77,101,'owner/widgets',7]);
    assert.equal((await db.query(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [corner])).rows[0].archived,true);
    assert.equal((await db.query(`SELECT released_at IS NULL held FROM corner_merge_holds WHERE corner_id=$1`, [corner])).rows[0].held,true);
    const pr = (await db.query(`SELECT lifecycle->'pr' pr FROM corner_facts WHERE corner_id=$1`, [corner])).rows[0].pr;
    assert.equal(pr === null,!outage);
    console.log(`R1 Demonstrated: built ${lane} HTTP close => ${response.status}; GitHub ${outage ? 'failure logged' : 'PR closed'}; corner archived; merge hold preserved.`);
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
}
