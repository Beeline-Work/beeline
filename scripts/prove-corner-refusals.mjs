// Run after building @beeline/server. --base asserts the original 503/Sentry behavior.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createAgentCommand } from '../apps/server/dist/agent-command.js';
import { CommandRefusalError } from '../apps/server/dist/commander.js';
const envelopes = [];
const collector = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  envelopes.push(Buffer.concat(chunks).toString()); response.end('{}');
});
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
process.env.SENTRY_DSN = `http://public@127.0.0.1:${collector.address().port}/1`;
const { createBeelineServer } = await import('../apps/server/dist/server.js');
const { captureServerError, flushServerErrors } = await import('../apps/server/dist/sentry.js');
const db = new PgliteDatabase();
const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const corner = '33333333-3333-4333-8333-333333333333';
const head = 'c'.repeat(40);
const live = new LiveHub();
// The proof needs only corner commands; skip the unrelated online connector index warmup.
const daemon = new DaemonService(db, live);
daemon.warmConnectorIndex = async () => {};
let server;
let origin;

const expected = process.argv.includes('--base') ? 503 : 409;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Reviewer')`, [owner, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Refusal proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Corner')`, [corner, workspace, parent]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, parent, agent]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id) VALUES($1,$2)`, [corner, agent]);
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash('bdt_refusal_fixture_123456789'), agent]);
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }), phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const [id, operation, code, detail] of [
    ['SENTRY-B', 'archiveCorner', null, 'close the corner pull request with close_corner_pr before closing the corner'],
    ['SENTRY-C', 'approveCornerMerge', 'NOT_CONFIGURED_REVIEWER', "only this corner's configured reviewer or its zero-check commander can record PASS"],
    ['SENTRY-C', 'approveCornerMerge', 'NO_PULL_REQUEST', 'corner has no pull request'],
    ['SENTRY-C', 'approveCornerMerge', 'STALE_HEAD', `pull request head is ${head}; review the current head before approving`],
  ]) {
    await db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [parent, code === 'NOT_CONFIGURED_REVIEWER' ? null : agent]);
    await db.query('UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1', [corner, JSON.stringify(code === 'NO_PULL_REQUEST' ? {} : { pr: { number: 7, headSha: head } })]);
    const input = { cornerId: corner, headSha: 'd'.repeat(40) };
    const error = await daemon.execute(operation, input, agent).catch(error => error);
    assert.equal(error instanceof CommandRefusalError, expected === 409);
    const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
      method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), { error: code ? `${code}: ${detail}` : detail });
    console.log(`Reproduction ${id} ${code ?? 'OPEN_PR'}: HTTP ${response.status}; message unchanged; expectedRefusal=${error instanceof CommandRefusalError}`);
  }
  const source = '1'.repeat(64), invalidApproval = '2'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$3,$4,'Open work'),($2,$3,$5,'Agent suggestion')`, [source, invalidApproval, parent, owner, agent]);
  const command = await createAgentCommand(db, { roomId: parent, agentId: agent, sourceMessageId: source, reason: 'human_tag' });
  await daemon.execute('claimAgentCommand', { roomId: parent, commandId: command.id, generationId: 'proof' }, agent);
  const input = { roomId: parent, requestId: command.turn_request_id, generationId: 'proof',
    name: 'Invalid-approval', objective: 'Refuse unapproved work',
    brief: { spec: 'Do the assigned work', approval: { sourceMessageId: invalidApproval } } };
  const before = (await db.query('SELECT id FROM rooms WHERE parent_id=$1', [parent])).rows;
  const error = await daemon.execute('createCorner', input, agent).catch(error => error);
  const baseD = process.argv.includes('--base-d') || expected === 503;
  assert.equal(error instanceof CommandRefusalError, !baseD);
  assert.equal(error.message, 'corner brief approval must name a human message or commander order');
  const response = await fetch(`${origin}/v1/daemon/operations/createCorner`, {
    method: 'POST', headers: { authorization: 'Bearer bdt_refusal_fixture_123456789', 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(response.status, baseD ? 503 : 403);
  assert.deepEqual(await response.json(), { error: error.message });
  assert.deepEqual((await db.query('SELECT id FROM rooms WHERE parent_id=$1', [parent])).rows, before);
  console.log(`Reproduction SENTRY-D: HTTP ${response.status}; message unchanged; no corner created`);
  captureServerError(new Error('Corner refusal proof control fault'));
  await flushServerErrors();
  const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))).filter(item => item.exception);
  const control = events.filter(event => event.exception.values.some(value => value.value === 'Corner refusal proof control fault'));
  assert.equal(control.length, 1, 'unexpected faults still reach Sentry');
  assert.equal(events.length - control.length, (expected === 503 ? 4 : 0) + (baseD ? 1 : 0));
  console.log(`Sentry refusal events from built HTTP server: ${events.length - control.length}; control fault events: ${control.length}`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
  collector.closeAllConnections();
  await new Promise(resolve => collector.close(resolve));
}
