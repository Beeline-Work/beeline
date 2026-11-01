// Reproduction BRIEF-CITATION: built Body tool -> authenticated built HTTP server.
// Isolated database and fixture credentials; no production state is changed.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { callAgentTool } from '../apps/body/dist/read-only-mcp.js';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const dm = '33333333-3333-4333-8333-333333333333';
const scratch = mkdtempSync(join(tmpdir(), 'brief-citation-proof-'));
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES
    ($1,$3,'Parent',NULL),($2,$3,'Private source',jsonb_build_array($4::text,$5::text))`, [room, dm, workspace, human, commander]);
  for (const identity of [human, commander, worker]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace, identity, room]);
    if (identity !== worker) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member')`, [workspace, dm, identity]);
  }
  const source = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Build the widget')`, [source, dm, human]);
  const command = await createAgentCommand(db, { roomId: dm, agentId: commander, sourceMessageId: source, reason: 'human_tag' });
  await claimAgentCommand(db, dm, commander, command.id, 'proof');
  const live = new LiveHub(), daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  for (const agent of [commander, worker]) await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`,
    [tokenHash(`bdt_fixture_${agent}`), agent]);
  server = createBeelineServer({ database: db, daemon, live,
    auth: new TokenAuth(db, async () => { throw new Error('unused'); }),
    phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(agent, operation, input) {
    const response = await fetch(`${origin}/v1/daemon/operations/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer bdt_fixture_${agent}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }
  const authority = { roomId: dm, requestId: command.turn_request_id, generationId: 'proof' };
  const opened = await request(commander, 'createCorner', { ...authority, targetRoomId: room,
    name: 'Citation-proof', objective: 'Build the widget', implementer: 'worker',
    brief: { spec: 'Build the widget', repositoryWork: false, approval: { sourceMessageId: source } } });
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const corner = opened.body.cornerId;
  await db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [corner]);
  const forwarded = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Include validation')`, [forwarded, dm, human]);
  const parent = await createAgentCommand(db, { roomId: dm, agentId: commander, sourceMessageId: forwarded, reason: 'human_tag' });
  await claimAgentCommand(db, dm, commander, parent.id, 'proof');
  const ordered = await request(commander, 'order', { roomId: dm, requestId: parent.turn_request_id,
    generationId: 'proof', address: room, agent: 'worker', text: 'Revise the assigned brief to include validation' });
  assert.equal(ordered.status, 200, JSON.stringify(ordered));
  let turn = (await db.query(`SELECT * FROM agent_commands WHERE id=$1`, [ordered.body.id])).rows[0];
  await claimAgentCommand(db, room, worker, turn.id, 'proof');
  const context = join(scratch, 'context.json');
  Object.assign(process.env, { BEELINE_DAEMON_ROOM_ID: room, BEELINE_DAEMON_AGENT_ID: worker,
    BEELINE_DAEMON_BASE_URL: origin, BEELINE_DAEMON_TOKEN: `bdt_fixture_${worker}`, BEELINE_TURN_CONTEXT_FILE: context });
  let revision = 1;
  for (const citation of ['order', 'human', 'resume', 'ancestor']) {
    if (citation === 'resume') {
      await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [turn.id]);
      turn = await createAgentCommand(db, { roomId: room, agentId: worker, sourceMessageId: null,
        action: 'resume', reason: 'report', parent: turn, retainDepth: true });
      await claimAgentCommand(db, room, worker, turn.id, 'proof');
    }
    writeFileSync(context, JSON.stringify({ roomId: room, requestId: turn.turn_request_id, generationId: 'proof' }));
    const sourceMessageId = citation === 'human' ? forwarded : citation === 'ancestor' ? ordered.body.id : turn.id;
    const result = JSON.parse(await callAgentTool('revise_corner', { action: 'brief', address: corner,
      expectedRevision: revision, change: 'Record approved validation',
      brief: { spec: 'Build the widget and validate the result', repositoryWork: false, approval: { sourceMessageId } },
    }, `citation-${citation}`));
    assert.equal(result.revision, ++revision);
    assert.equal(result.approval.approvedBy, citation === 'human' ? human : commander);
    assert.equal(result.approval.sourceMessageId, citation === 'human' ? forwarded : ordered.body.id);
    const stored = (await db.query(`SELECT revision,approval_basis FROM corner_brief_revisions
      WHERE corner_id=$1 ORDER BY revision DESC LIMIT 1`, [corner])).rows[0];
    assert.equal(stored.revision, revision);
    assert.equal(stored.approval_basis.approvedBy, result.approval.approvedBy);
    console.log(`BRIEF-CITATION PASS: ${citation} citation -> built revise_corner -> persisted revision (${revision})`);
  }
  const refused = await request(worker, 'reviseCornerBrief', { roomId: room, requestId: turn.turn_request_id,
    generationId: 'proof', cornerId: corner, expectedRevision: revision,
    brief: { spec: 'Unapproved scope', change: 'Reject unrelated source', approval: { sourceMessageId: 'unrelated-message' } } });
  assert.equal(refused.status, 403, JSON.stringify(refused));
  assert.match(refused.body.error, /brief.approval.sourceMessageId.*use the delivered order ID/);
  console.log('BRIEF-CITATION PASS: unrelated citation refused with field and repair guidance');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
  rmSync(scratch, { recursive: true, force: true });
}
