// Isolated HTTP proof against the built service. No production state is changed.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callAgentTool, agentToolsFor } from '../apps/body/dist/read-only-mcp.js';
import { randomBytes } from 'node:crypto';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { createAgentCommand, claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';

const db = new PgliteDatabase();
const storage = new MemoryObjectStorage();
const human = 'a'.repeat(64), commander = 'b'.repeat(64), worker = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const parent = '22222222-2222-4222-8222-222222222222';
const scratch = mkdtempSync(join(tmpdir(), 'tool-contract-proof-'));
let server;
try {
  await migrate(db);
  await storage.listen();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),($3,'agent','Worker','worker')`, [human, commander, worker]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [commander, worker, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [parent, workspace]);
  for (const identity of [human, commander, worker])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace, identity, parent]);
  const source = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Build the widget')`, [source, parent, human]);
  const command = await createAgentCommand(db, { roomId: parent, agentId: commander, sourceMessageId: source, reason: 'human_tag' });
  await claimAgentCommand(db, parent, commander, command.id, 'proof-generation');
  const live = new LiveHub(), daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  for (const agent of [commander, worker])
    await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(`bdt_fixture_${agent}`), agent]);
  const objects = new ObjectService(db, storage.asStorage(), 'http://proof');
  const file = await objects.uploadArtifact(commander, Buffer.from('Proof attachment'), 'text/plain', 'proof.txt');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Evidence',$4::jsonb)`,
    [randomBytes(32).toString('hex'), parent, commander, JSON.stringify([{ ...file, name: 'proof.txt' }])]);
  const objectId = file.url.split('/').at(-1);
  server = createBeelineServer({ database: db, daemon, live, objectService: objects, auth: new TokenAuth(db, async () => { throw new Error('unused'); }), phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function request(agent, operation, input) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`, {
      method: 'POST', headers: { authorization: `Bearer bdt_fixture_${agent}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  }
  const authority = { roomId: parent, requestId: command.turn_request_id, generationId: 'proof-generation' };
  const opened = await request(commander, 'createCorner', { ...authority, targetRoomId: parent, name: 'Widget', objective: 'Build widget', implementer: 'worker',
    brief: { spec: 'Build widget', repositoryWork: false, approval: { sourceMessageId: source }, attachments: [{ objectId, purpose: 'Evidence', required: true }] } });
  assert.equal(opened.status, 200, JSON.stringify(opened));
  const corner = opened.body.cornerId;
  const context = join(scratch, 'context.json');
  writeFileSync(context, JSON.stringify({ roomId: parent, requestId: command.turn_request_id, generationId: 'proof-generation' }));
  Object.assign(process.env, { BEELINE_DAEMON_ROOM_ID: parent, BEELINE_DAEMON_AGENT_ID: commander,
    BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    BEELINE_DAEMON_TOKEN: `bdt_fixture_${commander}`, BEELINE_TURN_CONTEXT_FILE: context });
  const read = JSON.parse(await callAgentTool('read', { facet: 'brief', address: corner }, 'read'));
  const brief = read.revisions[0];
  assert.ok(brief.approval.approvedBy);
  assert.equal(brief.attachments[0].title, 'proof.txt');
  assert.equal(brief.attachments[0].size, 16);
  const revised = JSON.parse(await callAgentTool('revise_corner', { action: 'brief', address: corner,
    expectedRevision: brief.revision, change: 'Edit copied brief', brief: { ...brief, spec: 'Build the revised widget' } }, 'revise'));
  assert.equal(revised.revision, 2);
  assert.equal(revised.spec, 'Build the revised widget');
  assert.equal(revised.approval.approvedBy, human);
  assert.deepEqual(revised.attachments, brief.attachments);
  console.log('R1 PASS: built read → copied brief → revise → persisted revision with server-resolved approval');

  for (const approval of [{ ...brief.approval, sourceMessageId: '' }, { approvedBy: commander }]) {
    const forged = await request(commander, 'reviseCornerBrief', { ...authority, cornerId: corner,
      expectedRevision: 2, brief: { ...brief, spec: 'Forged direct scope', change: 'Forge', approval } });
    assert.equal(forged.status, 403, JSON.stringify(forged));
  }
  await callAgentTool('revise_corner', { action: 'brief', address: corner,
    expectedRevision: 2, change: 'Direct revision', brief: { spec: 'Commander direct scope', repositoryWork: false } }, 'direct');
  const directRead = JSON.parse(await callAgentTool('read', { facet: 'brief', address: corner }, 'direct-read')).revisions[0];
  assert.equal(directRead.approval.sourceMessageId, '');
  const copiedDirect = JSON.parse(await callAgentTool('revise_corner', { action: 'brief', address: corner,
    expectedRevision: directRead.revision, change: 'Copy direct revision', brief: { ...directRead, spec: 'Edited commander direct scope' } }, 'direct-copy'));
  assert.equal(copiedDirect.revision, 4);
  assert.equal(copiedDirect.approval.approvedBy, commander);
  const directAgain = JSON.parse(await callAgentTool('read', { facet: 'brief', address: corner }, 'direct-read-again')).revisions[0];
  const { sourceMessageId: omitted, ...approvalWithoutMessage } = directAgain.approval;
  const copiedAbsent = JSON.parse(await callAgentTool('revise_corner', { action: 'brief', address: corner,
    expectedRevision: 4, change: 'Copy absent citation', brief: { ...directAgain,
      spec: 'Edited again', approval: { ...approvalWithoutMessage, approvedBy: human, text: 'Forged metadata' } } }, 'direct-absent'));
  assert.equal(copiedAbsent.revision, 5);
  assert.equal(copiedAbsent.approval.approvedBy, commander);
  assert.notEqual(copiedAbsent.approval.text, 'Forged metadata');
  const workerCommand = await createAgentCommand(db, { roomId: parent, agentId: worker, sourceMessageId: source, reason: 'human_tag' });
  await claimAgentCommand(db, parent, worker, workerCommand.id, 'worker-generation');
  const stolen = await request(worker, 'reviseCornerBrief', { roomId: parent,
    requestId: workerCommand.turn_request_id, generationId: 'worker-generation', cornerId: corner,
    expectedRevision: 5, brief: { spec: 'Stolen direct scope', approval: copiedAbsent.approval, change: 'Steal' } });
  assert.equal(stolen.status, 403, JSON.stringify(stolen));
  console.log('R1-DIRECT-GUARDS PASS: message-backed projection cannot become direct; worker cannot reuse direct approval; metadata stays server-owned');
  console.log('R1-DIRECT PASS: commander revise without citation → read → edit copied projection → revise');

  const own = await request(commander, 'createAgentSchedule', { ...authority, title: 'Check work',
    cadence: { kind: 'interval', everyMinutes: 60 }, prompt: 'Check work' });
  assert.equal(own.status, 200, JSON.stringify(own));
  const reportText = 'blocked: ' + 'x'.repeat(15991);
  await callAgentTool('report', { status: 'blocked', text: reportText }, 'report-limit');
  await assert.rejects(callAgentTool('report', { status: 'blocked', text: reportText + 'x' }, 'report-over-limit'), /invalid arguments/);
  console.log('REPORT-LIMIT PASS: report accepts 16000 characters and refuses 16001 as advertised');
  const scheduledSource = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Scheduled check')`, [scheduledSource, parent, commander]);
  const scheduled = await createAgentCommand(db, { roomId: parent, agentId: commander, sourceMessageId: scheduledSource, reason: 'schedule' });
  await claimAgentCommand(db, parent, commander, scheduled.id, 'scheduled-generation');
  writeFileSync(context, JSON.stringify({ roomId: parent, requestId: scheduled.turn_request_id, generationId: 'scheduled-generation' }));
  await assert.rejects(callAgentTool('wake', { action: 'delete', scheduleId: own.body.scheduleId }, 'delete'), /workspace admins only/);
  const description = agentToolsFor(true, false).find(tool => tool.name === 'wake').description;
  assert.match(description, /human Workspace admin/);
  assert.match(description, /scheduled wake cannot/);
  console.log('R2 PASS: own delete from scheduled turn is refused, as the corrected description states');

} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await storage.close();
  await db.close();
  rmSync(scratch, { recursive: true, force: true });
}
