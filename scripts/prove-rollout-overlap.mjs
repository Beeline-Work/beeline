import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { historicalServerBuild } from './historical-server-build.mjs';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';

const oldRef = '3fe0d1b17ef0f73a6e6948b117ba7130e736a209';
const oldRoot = historicalServerBuild(oldRef);
const starRef = '75e48e93346e3304e29f3101db55e24bcc74227e';
const starRoot = historicalServerBuild(starRef);
const load = (root, name) => import(pathToFileURL(resolve(root, name + '.js')).href);
const currentRoot = resolve('apps/server/dist');
const oldServer = resolve(oldRoot, 'server/dist');
const currentDatabase = await load(currentRoot, 'database');
const H = 'a'.repeat(64), A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let missingColumns = 0;
const baseline = process.argv.includes('--baseline');
const results = [];
const database = new PgliteDatabase();
let starDatabase;
try {
  await currentDatabase.migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Replay owner','owner'),($2,'agent','Replay agent','agent')`, [H,A]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Rollout replay')`, [W]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [R,W,H]);
  await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Replay',$4)`, [C,W,R,A]);
  await database.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [C]);
  for (const who of [H,A]) await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [W,who,R]);
  const { createAgentCommand } = await load(currentRoot, 'agent-command');
  await createAgentCommand(database, { roomId: C, agentId: A, sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { kind: 'order', authorId: H, fromRoomId: R, text: 'Replay the production rollout' } });
  // The historical image still stores a corner roster. Keep that input to the
  // replay, independent of the retired-column defect under investigation.
  await database.query(`ALTER TABLE memberships DISABLE TRIGGER USER`);
  for (const who of [H,A]) await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'owner')`, [W,C,who]);
  await database.query(`ALTER TABLE memberships ENABLE TRIGGER USER`);
  const { TokenAuth } = await load(currentRoot, 'auth');
  const auth = new TokenAuth(database, async () => ({ subject: 'isolated-proof', login: 'owner', name: 'Replay owner' }));
  const daemonToken = (await auth.exchangeDaemonToken((await auth.createDaemonExchange(A)).exchangeToken)).daemonToken;
  if (baseline) {
    // Exact destructive schema state introduced by the incident rollout.
    await database.query(`ALTER TABLE corner_facts DROP COLUMN owner_agent_id`);
    await database.query(`ALTER TABLE github_star_prompts DROP COLUMN reached_milestone`);
  }
  for (const [label, root] of [['preceding build on repaired post-migration schema', oldServer]]) {
    const { LiveHub } = await load(root, 'live');
    const { DaemonService } = await load(root, 'daemon-service');
    const { PhoneService } = await load(root, 'phone-service');
    const { createBeelineServer } = await load(root, 'server');
    const live = new LiveHub();
    const server = createBeelineServer({ database, live,
      auth,
      daemon: new DaemonService(database, live), phone: new PhoneService(database, 'http://replay'), mediaMaximumBytes: 1024 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const operation of ['listRoomCorners','getAgentCommands']) {
        const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, { method: 'POST',
          headers: { authorization: `Bearer ${daemonToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: operation === 'listRoomCorners' ? R : C }) });
        const body = await response.text();
        if (/column .*does not exist/.test(body)) missingColumns++;
        results.push({ label, operation, status: response.status });
        assert.equal(response.status, baseline && root === oldServer ? 503 : 200, `${label} ${operation}: ${body}`);
        if (response.status === 200) assert.ok(body.includes(C), `${operation} must return the seeded corner or its command`);
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  // SERVER-27: run the actual preceding posting build, then read the reply
  // through its phone HTTP endpoint. This exercises the whole old INSERT.
  const starServerRoot = resolve(starRoot, 'server/dist');
  const { LiveHub: StarLive } = await load(starServerRoot, 'live');
  const { DaemonService: StarDaemon } = await load(starServerRoot, 'daemon-service');
  const { PhoneService: StarPhone } = await load(starServerRoot, 'phone-service');
  const { createBeelineServer: starServer } = await load(starServerRoot, 'server');
  // Replay November 2 against that rollout's schema, before November 3's
  // unrelated reviewer-column contracts. Only repair the incident column.
  starDatabase = new PgliteDatabase();
  await (await load(oldServer, 'database')).migrate(starDatabase);
  if (!baseline) await starDatabase.query(`ALTER TABLE github_star_prompts ADD COLUMN reached_milestone integer NOT NULL DEFAULT 0`);
  await starDatabase.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Replay owner','owner'),($2,'agent','Replay agent','agent')`, [H,A]);
  await starDatabase.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
  await starDatabase.query(`INSERT INTO workspaces(id,name) VALUES($1,'Star rollout replay')`, [W]);
  await starDatabase.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [R,W,H]);
  for (const who of [H,A]) await starDatabase.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [W,who,R]);
  await starDatabase.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','isolated-proof',$1,'https://github.com','beeline','owner')`, [H]);
  const { TokenAuth: StarAuth } = await load(starServerRoot, 'auth');
  const starAuth = new StarAuth(starDatabase, async () => ({ subject: 'isolated-proof', login: 'owner', name: 'Replay owner' }));
  const starToken = (await starAuth.exchangeDaemonToken((await starAuth.createDaemonExchange(A)).exchangeToken)).daemonToken;
  const starPhoneToken = (await starAuth.exchangeGitHubOidc('fixture')).accessToken;
  const phone = new StarPhone(starDatabase, 'http://replay');
  await phone.execute('sendRoomMessage', { roomId: R, text: '@agent Post the rollout proof' }, H);
  const live = new StarLive();
  const server = starServer({ database: starDatabase, auth: starAuth, live, daemon: new StarDaemon(starDatabase, live), phone, mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = (name, input) => fetch(`${origin}/v1/daemon/operations/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${starToken}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const commands = await (await call('getAgentCommands', { roomId: R })).json();
    const command = commands.commands.at(-1);
    assert.ok(command, 'a human message must dispatch a reply command');
    const claim = await call('claimAgentCommand', { roomId: R, commandId: command.id, generationId: 'star-rollout-proof' });
    assert.equal(claim.status, 200, await claim.text());
    const replyText = 'The reply landed during the schema overlap';
    const reply = await call('postRoomMessage', { roomId: R, requestId: command.turnRequestId, generationId: 'star-rollout-proof', text: replyText });
    const body = await reply.text();
    if (/column .*does not exist/.test(body)) missingColumns++;
    assert.equal(reply.status, baseline ? 503 : 200, body);
    if (!baseline) {
      const room = await fetch(`${origin}/v1/phone/rooms/${R}`, { headers: { authorization: `Bearer ${starPhoneToken}` } });
      assert.equal(room.status, 200);
      assert.ok((await room.text()).includes(replyText), 'the person must see the committed reply');
    }
    results.push({ label: 'SERVER-27 preceding posting build', operation: 'postRoomMessage', status: reply.status, visible: !baseline });
  } finally { await new Promise(resolve => server.close(resolve)); }
  // Reverse overlap: start with the real preceding schema and its existing
  // messages, apply the candidate's predeployment expansion, then serve it
  // with the candidate build while compatibility columns still exist.
  await currentDatabase.migrate(starDatabase);
  await starDatabase.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Reverse replay',$4)`, [C,W,R,A]);
  await starDatabase.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [C]);
  await createAgentCommand(starDatabase, { roomId: C, agentId: A, sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { kind: 'order', authorId: H, fromRoomId: R, text: 'Reverse overlap proof' } });
  const { LiveHub: ReverseLive } = await load(currentRoot, 'live');
  const { DaemonService: ReverseDaemon } = await load(currentRoot, 'daemon-service');
  const { PhoneService: ReversePhone } = await load(currentRoot, 'phone-service');
  const { createBeelineServer: reverseServer } = await load(currentRoot, 'server');
  const reverseLive = new ReverseLive();
  const reversed = reverseServer({ database: starDatabase, auth: new TokenAuth(starDatabase, async () => ({})), live: reverseLive,
    daemon: new ReverseDaemon(starDatabase, reverseLive), phone: new ReversePhone(starDatabase, 'http://replay'), mediaMaximumBytes: 1024 });
  await new Promise(resolve => reversed.listen(0, '127.0.0.1', resolve));
  try {
    for (const operation of ['listRoomCorners','getAgentCommands']) {
      const response = await fetch(`http://127.0.0.1:${reversed.address().port}/v1/daemon/operations/${operation}`, { method: 'POST',
        headers: { authorization: `Bearer ${starToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: operation === 'listRoomCorners' ? R : C }) });
      const body = await response.text();
      if (/column .*does not exist/.test(body)) missingColumns++;
      assert.equal(response.status, 200, body);
      assert.ok(body.includes(C));
      results.push({ label: 'candidate on expanded preceding schema', operation, status: response.status });
    }
  } finally { await new Promise(resolve => reversed.close(resolve)); }
  assert.equal(missingColumns, baseline ? 3 : 0);
  const proof = { reproduction: 'rollout-0707', oldRef, starRef, baseline, missingColumns, results };
  writeFileSync(`.beeline-proof/rollout-overlap${baseline ? '-baseline' : ''}.json`, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally { await starDatabase?.close(); await database.close(); }
