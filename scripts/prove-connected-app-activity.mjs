// R1: built server, isolated database and real report/claim/phone-read paths.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { RoomsMcpAgentTools } from '../apps/server/dist/rooms-mcp-agent.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const H = 'a'.repeat(64), APP = 'b'.repeat(64), WORKER = 'c'.repeat(64), MACHINE = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const db = new PgliteDatabase();
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','App','app'),
    ($3,'agent','Worker','worker'),($4,'agent','Machine','machine')`, [H, APP, WORKER, MACHINE]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [APP, WORKER, MACHINE, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'R1 isolated proof')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Origin')`, [R, C, W]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  for (const member of [H, APP, WORKER, MACHINE]) for (const room of [null, R])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner')`, [W, room, member]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('r1-app','App','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label)
    VALUES('r1-app',$1,$2,'ChatGPT')`, [H, APP]);
  const tokens = new Map([[APP, 'bdt_r1_app_fixture'], [WORKER, 'bdt_r1_worker_fixture'], [MACHINE, 'bdt_r1_machine_fixture']]);
  for (const [agent, token] of tokens)
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
  const live = new LiveHub(), daemon = new DaemonService(db, live), phone = new PhoneService(db, 'http://proof');
  const auth = new TokenAuth(db, async () => ({ subject: 'r1-owner', login: 'owner', name: 'Owner' }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','r1-owner',$1,'https://github.com','beeline','owner')`, [H]);
  const phoneToken = (await auth.exchangeGitHubOidc('fixture')).accessToken;
  server = createBeelineServer({ database: db, daemon, phone, live, auth, mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function call(name, input, agent = WORKER, surface = 'daemon') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${surface}/operations/${name}`, {
      method: 'POST', headers: { authorization: `Bearer ${surface === 'phone' ? phoneToken : tokens.get(agent)}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(body)}`);
    return body;
  }
  const order = await createAgentCommand(db, { roomId: C, agentId: WORKER, sourceMessageId: null, reason: 'order',
    privatePayload: { kind: 'order', authorId: APP, fromRoomId: R, text: 'Prepare numbered-list instructions' } });
  await call('claimAgentCommand', { roomId: C, commandId: order.id, generationId: 'r1-worker' });
  const authority = { roomId: C, requestId: order.turn_request_id, generationId: 'r1-worker' };
  for (const text of ['approve the list', 'all checks pass; approve the list', 'latest approval context'])
    await call('report', { ...authority, status: 'needs_decision', text: `needs-decision: ${text}` });
  const reports = (await db.query(`SELECT id,state,cancellation_reason,private_payload->>'text' text
    FROM agent_commands WHERE agent_id=$1 AND reason='report' ORDER BY inbox_sequence`, [APP])).rows;
  assert.deepEqual(reports.map(r => r.state), ['cancelled', 'cancelled', 'pending']);
  assert.deepEqual(reports.slice(0, 2).map(r => r.cancellation_reason), ['superseded_report', 'superseded_report']);
  assert.equal(reports[2].text, 'needs-decision: latest approval context');
  const active = view => view.latestAgentTurns.filter(t => t.agentPubkey === APP && t.status === 'working');
  const view = () => call('readRoom', { roomId: R }, H, 'phone');
  assert.deepEqual(active(await view()), []);
  console.log('R1 PASS: three HTTP reports → one pending report with newest text; phone Room has no app Thinking turn');
  const machine = await createAgentCommand(db, { roomId: R, agentId: MACHINE, sourceMessageId: null, reason: 'system' });
  assert.ok((await view()).latestAgentTurns.some(t => t.agentPubkey === MACHINE && t.generationId === `pending:${machine.id}`));
  // Connected apps do not authenticate as helpers. Exercise the service claim
  // directly, then verify its public projection through the phone HTTP route.
  await daemon.execute('claimAgentCommand', { roomId: R, commandId: reports[2].id, generationId: 'r1-app-claimed' }, APP);
  assert.equal(active(await view())[0].generationId, 'r1-app-claimed');
  await daemon.execute('postAgentTurnReceipt', { roomId: R, requestId: reports[2].id, generationId: 'r1-app-claimed', status: 'complete' }, APP);
  assert.deepEqual(active(await view()), []);
  await new RoomsMcpAgentTools(db, daemon).call(APP, 'post', { address: R, text: 'R1 tool executed' });
  assert.equal((await db.query(`SELECT count(*)::int n FROM agent_turns WHERE agent_id=$1
    AND generation_id LIKE 'mcp:%' AND status='complete'`, [APP])).rows[0].n, 1);
  assert.ok((await view()).messages.some(message => message.text === 'R1 tool executed' && message.author.pubkey === APP));
  console.log('R1 PASS: machine placeholder preserved; real app claim appears in phone Room and clears on completion; real MCP post creates its tool turn and visible output');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
