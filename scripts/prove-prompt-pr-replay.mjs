/** Isolated built HTTP webhook -> private local agent turn -> subscription subprocess -> PR comment.
 * GitHub and the Codex provider are deterministic process doubles, not live services.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { GitHubOperations } from '../apps/server/dist/github-operations.js';
import { DaemonService } from '../apps/server/dist/daemon-service.js';
import { LiveHub } from '../apps/server/dist/live.js';
import { TokenAuth, tokenHash } from '../apps/server/dist/auth.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { createBeelineServer } from '../apps/server/dist/server.js';
import { replay } from './prompt-pr-replay.mjs';
import { loadCases } from './prompt-cases.ts';

const owner = 'a'.repeat(64), baby = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = resolve('.beeline-proof');
mkdirSync(root, { recursive: true });
const scratch = mkdtempSync(join(root, 'prompt-pr-'));
const bin = join(scratch, 'bin'), out = join(scratch, 'results');
mkdirSync(bin);
const captured = join(scratch, 'posted.md');
// This provider double still uses the real executeSample subprocess, fixture,
// native prompt assembly and native transcript grader. It has no model login.
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
if (['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','OPENAI_BASE_URL'].some(key => process.env[key])) process.exit(9);
const setting = process.argv.find(arg => arg.startsWith('mcp_servers.replay.args='));
const args = JSON.parse(setting.slice(setting.indexOf('=') + 1));
const fixture = JSON.parse(fs.readFileSync(args[3], 'utf8'));
fs.writeFileSync(args[4], JSON.stringify({ calls: [], attemptedCalls: [], invalidCalls: [], searches: [], results: [], terminal: null }));
if (fixture.testCase.id === 'checks-turn-quiet-on-green') console.log(JSON.stringify({ type:'item.completed', item:{type:'agent_message',text:'An unwanted scheduled reply'} }));
console.log(JSON.stringify({ type:'turn.completed', usage:{input_tokens:10,output_tokens:1} }));
`, { mode: 0o700 });
writeFileSync(join(bin, 'gh-axi'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') console.log('api_response:\\n  body: open ${head}\\n  truncated: false');
else if (args[0] === 'pr' && args[1] === 'comment') fs.copyFileSync(args[args.indexOf('--body-file') + 1], ${JSON.stringify(captured)});
else process.exit(8);
`, { mode: 0o700 });
const previous = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
const db = new PgliteDatabase();
let server;
try {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Baby','baby')`, [owner, baby]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [baby, owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated replay proof')`, [workspace]);
  await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,status) VALUES(77,$1,'Beeline-Work','Organization','active')`, [owner]);
  await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'Beeline-Work/beeline','main')`);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,github_installation_id) VALUES($1,$2,$3,'Replay agents','Beeline-Work/beeline',77)`, [room, workspace, owner]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [workspace, owner]);
  for (const who of [owner, baby]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace, room, who]);
  await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [room, baby]);
  const app = { installationToken: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }),
    readPullRequest: async () => ({ state: 'open', headSha: head }),
    readPullRequestFiles: async () => ({ complete: true, files: [{ filename: 'apps/body/src/prompt-assembly.ts' }] }) };
  const operations = new GitHubOperations(db, {}, app, 'fixture');
  const live = new LiveHub(), daemon = new DaemonService(db, live);
  daemon.warmConnectorIndex = async () => {};
  const bearer = 'bdt_replay_fixture_token';
  await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`, [tokenHash(bearer), baby]);
  server = createBeelineServer({ database: db, daemon, live, auth: new TokenAuth(db, async () => { throw new Error('unused'); }),
    phone: new PhoneService(db, 'http://test'), mediaMaximumBytes: 1,
    github: { webhookSecret: 'fixture', onWebhook: (event, body, delivery) => operations.processWebhook(event, body, delivery) } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = JSON.stringify({ action: 'synchronize', installation: { id: 77 }, repository: { full_name: 'Beeline-Work/beeline' }, pull_request: { number: 7, head: { sha: head } } });
  const delivery = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/v1/github/webhook`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture').update(payload).digest('hex')}`,
    }, body: payload });
    assert.equal(response.status, attempt ? 200 : 202, await response.text());
  }
  async function call(name, input) {
    const response = await fetch(`${base}/v1/daemon/operations/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
    return response.json();
  }
  const { commands } = await call('getAgentCommands', { roomId: room });
  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.equal(command.reason, 'order');
  assert.match(command.source.body, new RegExp(head));
  await call('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'local-replay' });
  await call('postAgentTurnReceipt', { roomId: room, requestId: command.turnRequestId, generationId: 'local-replay', status: 'working' });
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.CODEX_HOME = join(scratch, 'codex-home');
  const selected = loadCases().filter(c => ['reply-silent-on-empty-schedule', 'checks-turn-quiet-on-green'].includes(c.id));
  assert.equal(selected.length, 2);
  const result = await replay({ repository: 'Beeline-Work/beeline', number: 7, head, agent: 'baby', out }, { loadCases: () => selected });
  assert.equal(result.status, 'fail');
  const comment = readFileSync(captured, 'utf8');
  assert.match(comment, /Prompt replay: FAIL/);
  assert.match(comment, /reply-silent-on-empty-schedule \| PASS/);
  assert.match(comment, /checks-turn-quiet-on-green \| FAIL/);
  assert.match(comment, new RegExp(head));
  await call('postAgentTurnReceipt', { roomId: room, requestId: command.turnRequestId, generationId: 'local-replay', status: 'complete' });
  assert.equal((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0].state, 'complete');
  assert.equal((await db.query('SELECT 1 FROM messages')).rowCount, 0);
  console.log('PROMPT-PR-REPLAY: signed HTTP webhook -> exactly one private Baby order -> authenticated command claim and local turn -> two real subscription-runner subprocesses -> exact-head FAIL comment with one PASS and one FAIL case');
  console.log('Provider/GitHub are local process doubles. No live model spend, GitHub writes, production Room traffic or lifecycle operations. Live proof remains post-release.');
  console.log(`Evidence: ${out}`);
} finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (server) await new Promise(done => server.close(done));
  await db.close();
  rmSync(bin, { recursive: true, force: true });
}
