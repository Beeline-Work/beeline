import { spawnSync } from 'node:child_process';
import { backfillLuna, LUNA_BACKFILL_SKIP, LUNA_BACKFILL_EXTRA_ROOM } from '../apps/server/dist/luna-backfill.js';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteDatabase, MemoryObjectStorage } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/dist/database.js';
import { FreeAgentService, freeAgentConfigFromEnv, createFreeAgentInWorkspace } from '../apps/server/dist/free-agents.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { ObjectService } from '../apps/server/dist/object-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { recordSigninFunnelEvent } from '../apps/server/dist/signin-funnel.js';
import { callAgentTool } from '../apps/body/dist/read-only-mcp.js';
import { CommandExecutionContext } from '../apps/body/dist/server-command-intake.js';

const db = new PgliteDatabase(), home = await mkdtemp(join(tmpdir(), 'welcome-proof-'));
let server;
try {
  await migrate(db);
  const owner = 'a'.repeat(64), live = new LiveHub();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Maya','maya')`, [owner]);
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'proof', FLY_FREE_AGENT_IMAGE: 'proof' }, 'http://127.0.0.1')
  const free = new FreeAgentService(db, config, { create: async () => { throw new Error('No Fly calls allowed'); } }, async () => { throw new Error('No exchange allowed'); });
  const storage = new MemoryObjectStorage(), objects = new ObjectService(db, storage.asStorage(), 'https://proof.invalid');
  const phone = new PhoneService(db, 'https://proof.invalid', undefined, undefined, live, false, db, objects);
  phone.setFreeAgents(free);
  const workspace = await phone.execute('createWorkspace', { name: 'Welcome proof' }, owner);
  const roomId = workspace.roomId;
  const agent = (await db.query(`SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND starter_role='beebee'`, [workspace.id])).rows[0].agent_id;
  const daemon = new DaemonService(db, live);
  server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const bytes of req) body += bytes;
      const result = await daemon.execute(req.url.split('/').pop(), JSON.parse(body), agent);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = new CommandExecutionContext(home);
  await phone.execute('sendRoomMessage', { roomId, text: '@beebee run onboarding' }, owner);
  const command = (await db.query(`SELECT * FROM agent_commands WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1`, [roomId])).rows[0];
  await context.enter({ roomId, turnRequestId: command.turn_request_id, rootCommandId: command.id });
  await claimAgentCommand(db, roomId, agent, command.id, context.generationId);
  Object.assign(process.env, { BEELINE_DAEMON_AGENT_ID: agent, BEELINE_DAEMON_ROOM_ID: roomId,
    BEELINE_DAEMON_BASE_URL: base, BEELINE_DAEMON_TOKEN: 'isolated-proof', BEELINE_TURN_CONTEXT_FILE: context.path });
  const discovery = JSON.parse(await callAgentTool('app_tool', { app: 'beeline:onboarding' }, 'discover'));
  assert(discovery.tools.some(tool => tool.name === 'welcome'));
  const posted = JSON.parse(await callAgentTool('app_tool', { app: 'beeline:onboarding', tool: 'welcome', args: {} }, 'welcome'));
  const read = () => phone.readRoom(roomId, owner);
  const card = (await read()).messages.find(message => message.id === posted.messageId).choice;
  assert.deepEqual(card.options.map(option => option.optionId), ['A', 'B', 'C', 'D']);
  assert.equal(card.onboardingManual, true);
  // An older client still sending signup welcome telemetry must not count this manual card.
  await recordSigninFunnelEvent(db, { event: 'welcome_shown', installId: '11111111-1111-4111-8111-111111111111', attemptId: '22222222-2222-4222-8222-222222222222', platform: 'android', version: 'old-client', environment: 'production', timestamp: new Date().toISOString() }, 'client', owner);
  await phone.execute('answerChoice', { choiceId: card.choiceId, optionId: 'D' }, owner);
  const follow = (await read()).messages.find(message => message.choice?.status === 'open').choice;
  assert.equal(follow.onboardingManual, true);
  await phone.execute('answerChoice', { choiceId: follow.choiceId, optionId: 'B' }, owner);
  const game = (await read()).messages.flatMap(message => message.attachments ?? []).find(file => file.mimeType === 'application/vnd.beeline.game+html');
  assert(game);
  await recordSigninFunnelEvent(db, { event: 'game_viewer_opened', installId: '11111111-1111-4111-8111-111111111111', attemptId: '22222222-2222-4222-8222-222222222222', platform: 'android', version: 'test', environment: 'production', timestamp: new Date().toISOString(), artifactId: game.url.split('/').pop() }, 'client', owner);
  assert.equal((await db.query(`SELECT 1 FROM signin_funnel_events WHERE event='game_viewer_opened' AND version='manual'`)).rowCount, 1);
  const next = (await read()).messages.find(message => message.choice?.status === 'open').choice;
  await phone.execute('answerChoice', { choiceId: next.choiceId, optionId: 'A' }, owner);
  assert((await read()).messages.some(message => message.text.startsWith("Here's your invite link.")));
  assert.equal((await db.query(`SELECT 1 FROM signin_funnel_events e JOIN signin_funnel_installs i USING(install_id) WHERE NOT i.internal`)).rowCount, 0);
  assert.equal((await db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1`, [roomId])).rowCount, 1);
  const backfillOwner = 'b'.repeat(64), backfillWorkspace = LUNA_BACKFILL_SKIP[0];
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','backfill-owner')`, [backfillOwner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tubing Crew fixture')`, [backfillWorkspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'general',$3)`, [LUNA_BACKFILL_EXTRA_ROOM, backfillWorkspace, backfillOwner]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [backfillWorkspace, backfillOwner, LUNA_BACKFILL_EXTRA_ROOM]);
  await db.transaction(tx => createFreeAgentInWorkspace(tx, config, { workspaceId: backfillWorkspace, roomId: LUNA_BACKFILL_EXTRA_ROOM, creatorId: backfillOwner }));
  const dry = await backfillLuna(db, undefined, {});
  assert(dry.some(row => row.room_id === LUNA_BACKFILL_EXTRA_ROOM && row.target_kind === 'explicit Room'));
  const applied = await backfillLuna(db, config, { apply: true });
  assert.equal(applied.find(row => row.room_id === LUNA_BACKFILL_EXTRA_ROOM).result, 'added Luna and intro');
  const repeated = await backfillLuna(db, config, { apply: true });
  assert.equal(repeated.find(row => row.room_id === LUNA_BACKFILL_EXTRA_ROOM).result, 'already present');
  const extraView = await phone.readRoom(LUNA_BACKFILL_EXTRA_ROOM, backfillOwner);
  assert.equal(extraView.messages.filter(message => message.text.startsWith("Hi @backfill-owner, I'm Luna.")).length, 1);
  assert(extraView.messages.some(message => message.text.startsWith("Hi @backfill-owner, I'm Luna.")));
  const cli = spawnSync(process.execPath, ['scripts/backfill-luna.mjs', '--apply'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
  assert.notEqual(cli.status, 0);
  assert(cli.stderr.includes('DATABASE_URL is required'));
  console.log('LUNA-1 demonstrated: built migration dry-run → fixture apply → phone-read Luna intro in the explicit excluded-workspace Room → repeat with no duplicate; approved production CLI still requires an explicit database environment. Fixture writes only.');
  console.log('WELCOME-1 demonstrated: human mention → built MCP discovery/welcome → active-command HTTP adapter → built DaemonService → phone-read welcome → explanation → game → invite; manual telemetry only, no additional model turns. Isolated PGlite/storage and a minimal HTTP adapter stand in for production; no model or native Android run claimed.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close(); await rm(home, { recursive: true, force: true });
}
