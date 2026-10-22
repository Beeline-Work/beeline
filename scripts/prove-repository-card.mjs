/** R-REPO-CARD: built services; PGlite, verified Google claims and idle Fly stand in for production. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { TokenAuth } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { FreeAgentService } from '../apps/server/dist/free-agents.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { claimAgentCommand } from '../apps/server/dist/agent-command.js';
import { CommandExecutionContext } from '../apps/body/dist/server-command-intake.js';
import { callAgentTool } from '../apps/body/dist/read-only-mcp.js';

process.env.BEELINE_REPOSITORY_ONBOARDING = '1';
const db = new PgliteDatabase();
const scratch = await mkdtemp(join(tmpdir(), 'repo-card-proof-'));
const originalFetch = globalThis.fetch;
try {
  await migrate(db);
  const auth = new TokenAuth(db, async () => { throw new Error('GitHub not used'); }, () => new Date(),
    async () => ({ subject: 'repo-card-google-proof', name: 'Repo Card Proof', email: 'repo-proof@example.test', audience: 'proof' }));
  const { identityId } = await auth.exchangeGoogleOidc('verified-google-fixture');
  const live = new LiveHub();
  const phone = new PhoneService(db, 'https://proof.test', undefined, undefined, live);
  phone.setFreeAgents(new FreeAgentService(db, {
    model: 'deepseek/deepseek-v4-flash', idleSeconds: 60, maxPerOwner: 3, dailyTokenCap: 1000000,
    lifetimeTokenCap: 3000000, sealSecret: 'proof-only', publicOrigin: 'https://proof.test',
    image: 'proof', region: 'iad', cpus: 1, memoryMb: 1024, sleepMode: 'suspend',
    reapIdleMs: 300000, deleteAfterMs: 2592000000,
  }, {}, async () => { throw new Error('No machine should boot'); }, () => undefined));
  const workspace = await phone.execute('createWorkspace', { name: 'Google-only proof' }, identityId);
  const room = await phone.readRoom(workspace.roomId, identityId);
  const welcome = room.messages.find(message => message.onboarding)?.onboarding;
  assert.equal(welcome.state, 'install_missing');
  assert.equal(welcome.githubLinked, false);
  const agentId = welcome.agentId;
  await phone.execute('sendRoomMessage', { roomId: workspace.roomId, text: '@beebee connect my repo' }, identityId);
  const command = (await db.query(`SELECT * FROM agent_commands WHERE agent_id=$1 AND root_source_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [agentId])).rows[0];
  assert.ok(command, 'human request creates command');
  const context = new CommandExecutionContext(scratch);
  await context.enter({ roomId: workspace.roomId, turnRequestId: command.turn_request_id, rootCommandId: command.id });
  await claimAgentCommand(db, workspace.roomId, agentId, command.id, context.generationId);
  Object.assign(process.env, { BEELINE_DAEMON_AGENT_ID: agentId, BEELINE_DAEMON_ROOM_ID: workspace.roomId,
    BEELINE_DAEMON_BASE_URL: 'http://proof.test', BEELINE_DAEMON_TOKEN: 'proof-only', BEELINE_TURN_CONTEXT_FILE: context.path });
  const daemon = new DaemonService(db, live);
  const authority = {roomId:workspace.roomId,requestId:command.turn_request_id,generationId:context.generationId};
  const configuration = await daemon.execute('getAgentConfiguration', authority, agentId);
  assert.ok(configuration.soul.instructions.includes('tool:"repository"'));
  const operations = [];
  globalThis.fetch = async (url, init) => {
    const operation = new URL(url).pathname.split('/').pop();
    operations.push(operation);
    return Response.json(await daemon.execute(operation, JSON.parse(String(init.body)), agentId));
  };
  const discovered = JSON.parse(await callAgentTool('connect', { mode: 'discover' }, 'discover'));
  assert.ok(discovered.capabilities.includes('beeline:onboarding'));
  for (const service of ['GitHub', 'link my repository', 'connect my repo']) {
    const serverRoute = await daemon.execute('connect', {...authority,service,reason:'Connect repository',continuation:'Show the repository card.'}, agentId);
    assert.equal(serverRoute.app, 'beeline:onboarding');
    const connected = JSON.parse(await callAgentTool('connect', { mode: 'ensure', service,
      reason: 'Connect the Room repository', continuation: 'Show the repository card.' }, 'connect'));
    assert.equal(connected.app, 'beeline:onboarding');
    await callAgentTool('app_tool', { app: connected.app, tool: 'repository', args: {} }, 'card');
    const updated = await phone.readRoom(workspace.roomId, identityId);
    assert.ok(updated.messages.some(message => message.id !== welcome.id && message.onboarding?.state === 'install_missing'));
  }
  assert.ok(!operations.includes('connect') && !operations.includes('find_connectors'));
  console.log('R-REPO-CARD PASS: Google-only welcome, capability discovery, and repeated repository requests produce visible install_missing cards without external connector search.');
} finally {
  globalThis.fetch = originalFetch;
  await db.close();
  await rm(scratch, { recursive: true, force: true });
}
