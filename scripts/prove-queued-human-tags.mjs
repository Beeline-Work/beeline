// QUEUED-TAGS-REPEAT: production metadata replay through an isolated built HTTP server.
// Production bodies are never fetched. In particular, the sign-in code is absent.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const fixture = JSON.parse(await readFile(new URL('../apps/server/src/fixtures/queued-tags-repeat.json', import.meta.url), 'utf8'));
const db = new PgliteDatabase();
const room = fixture.roomId, agent = fixture.agentId, human = fixture.queued[0].author_id;
const scheduler = fixture.running.author_id, reporter = 'e'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const token = 'bdt_queued_human_tags_fixture';
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Ruby','ruby'),
    ($3,'human','Scheduler','scheduler'),($4,'agent','Reporter','reporter')`, [human, agent, scheduler, reporter]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [agent, reporter, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Queued tags replay')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Isolated Room')`, [room, workspace]);
  for (const who of [human, agent, reporter])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, who, room]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(token), agent]);
  const live = new LiveHub(), phone = new PhoneService(db, 'http://proof');
  const daemon = new DaemonService(db, live);
  server = createBeelineServer({ database: db, daemon, live, phone,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }), mediaMaximumBytes: 1024 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (name, input, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${name}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.status, status, `${name}: ${JSON.stringify(body)}`);
    return body;
  };
  const get = async () => (await call('getAgentCommands', { roomId: room })).commands;
  const claim = c => call('claimAgentCommand', { roomId: room, commandId: c.id, generationId: 'proof' });
  const reply = (requestId, text) => call('postRoomMessage', { roomId: room, requestId, generationId: 'proof', text });
  const insert = async (row, author, body) => {
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
      VALUES($1,$2,$3,$4,'message',$5)`, [row.source_message_id, room, author, body, row.created_at]);
    await createAgentCommand(db, { id: row.id, roomId: room, agentId: agent,
      sourceMessageId: row.source_message_id, turnRequestId: row.turn_request_id, reason: row.reason });
    await db.query(`UPDATE agent_commands SET created_at=$2,root_command_id=$3,root_source_message_id=$4,agent_depth=$5
      WHERE id=$1`, [row.id, row.created_at, row.root_command_id, row.root_source_message_id, row.agent_depth]);
  };
  await insert(fixture.running, scheduler, 'Scheduled browser task (synthetic body)');
  await claim({ id: fixture.running.id });
  for (const [index, row] of fixture.queued.entries()) await insert(row, human, `@ruby Queued human detail ${index + 1} (synthetic body)`);
  for (const row of fixture.reports) {
    await createAgentCommand(db, { id: row.id, roomId: room, agentId: agent, sourceMessageId: null,
      reason: row.reason, privatePayload: { kind: 'report', authorId: reporter, fromRoomId: room, text: 'Separate report (synthetic body)' } });
    await db.query(`UPDATE agent_commands SET created_at=$2 WHERE id=$1`, [row.id, row.created_at]);
  }
  // No GET while busy: this is the original missed coalescing window.
  await reply(fixture.running.turn_request_id, 'Scheduled task finished');
  let humanTurns = 0, reports = 0;
  const prompts = [];
  while (true) {
    const [next] = await get();
    if (!next) break;
    const claimed = await claim(next);
    if (next.reason === 'human_tag') {
      humanTurns++;
      const prompt = JSON.stringify(next.source) + (claimed.coalescedContext ?? '');
      prompts.push({ request: next.sourceMessageId, text: prompt });
      await reply(next.turnRequestId, 'One answer covers every queued human detail');
    } else {
      assert.equal(next.reason, 'report');
      reports++;
      await call('postAgentTurnReceipt', { roomId: room, requestId: next.turnRequestId,
        generationId: 'proof', status: 'complete', completionKind: 'no-reply' });
    }
  }
  console.log(`QUEUED-TAGS-REPEAT observed: ${humanTurns} human turns, ${reports} separate report turns`);
  assert.equal(humanTurns, 1, 'queued human inputs started separate turns');
  assert.equal(prompts[0].request, fixture.queued[0].source_message_id);
  for (const row of fixture.queued) assert(prompts[0].text.includes(row.source_message_id), 'combined prompt lacks a queued source');
  assert.equal(reports, fixture.reports.length);
  for (const row of fixture.queued.slice(1))
    await call('claimAgentCommand', { roomId: room, commandId: row.id, generationId: 'stale' }, 409);
  const view = await phone.readRoom(room, human);
  assert.equal(view.messages.filter(m => m.author.pubkey === agent && m.text === 'One answer covers every queued human detail').length, 1);
  assert.equal(view.pendingAgentCommands.length, 0);
  assert(!view.latestAgentTurns.some(t => t.agentPubkey === agent && t.status === 'working'));
  console.log('QUEUED-TAGS-REPEAT PASS: exact production command ids/timestamps replayed with synthetic bodies; one human turn, both source ids in one prompt, one visible answer, no further human claims, independent reports preserved.');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await db.close();
}
