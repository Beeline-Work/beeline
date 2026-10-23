// R1: exercise the built daemon HTTP route with an isolated database.
import assert from 'node:assert/strict';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const database = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64), trigger = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
let server;
try {
  await migrate(database);
  await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')", [owner, agent]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, owner]);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Proof')", [workspace]);
  await database.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')", [room, workspace]);
  await database.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')", [workspace, agent, room]);
  await database.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Report problems')", [trigger, room, owner]);
  const command = await createAgentCommand(database, { roomId: room, agentId: agent, sourceMessageId: trigger, reason: 'human_tag', turnRequestId: 'proof-r1' });
  await claimAgentCommand(database, room, agent, command.id, 'proof-generation');
  const live = new LiveHub();
  const daemon = new DaemonService(database, live);
  daemon.warmConnectorIndex = async () => {};
  await database.query('INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)', [tokenHash('bdt_feedback_fixture'), agent]);
  server = createBeelineServer({ database, daemon, live, auth: new TokenAuth(database, async () => { throw new Error('unused'); }), phone: new PhoneService(database, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function report(summary) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/reportFeedback`, {
      method: 'POST', headers: { authorization: 'Bearer bdt_feedback_fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: room, requestId: 'proof-r1', generationId: 'proof-generation', category: 'bug', summary }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  let first;
  for (let index = 1; index <= 200; index++) {
    const result = await report(`Distinct problem ${index}`);
    assert.equal(result.duplicate, false);
    if (index === 1) first = result;
    if (index === 51) console.log('R1: fifty-first distinct report HTTP 200, stored separately');
  }
  assert.deepEqual(await report('distinct PROBLEM 1.'), { ...first, duplicate: true });
  const overflow = await report('Overflow first');
  assert.equal((await report('Overflow latest')).itemId, overflow.itemId);
  const rows = await database.query("SELECT id,summary,occurrence_count FROM feedback_items WHERE status='new' AND (source_kind='human' OR COALESCE(last_occurrence_at,created_at)>now()-interval '24 hours')");
  assert.equal(rows.rows.length, 201);
  assert.deepEqual(rows.rows.find(row => row.id === overflow.itemId), { id: overflow.itemId, summary: 'Overflow latest', occurrence_count: 2 });
  console.log('R1: all 200 distinct reports HTTP 200; duplicates share the original; excess reports share one triage-visible row, count 2, latest summary retained');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await database.close();
}
