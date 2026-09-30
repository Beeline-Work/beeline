// End-to-end demonstration of assignment by agent class, against the built
// server (`npm run build -w @beeline/server`) and a real PostgreSQL:
//
//   DATABASE_URL=postgres://... node scripts/agent-classes-room-demo.mjs
//
// It seeds one Workspace, a Room and a corner, loads the live models.dev
// registry, then drives the real HTTP routes: the person through
// /v1/phone/*, each agent's helper through /v1/daemon/operations/*. Bearer
// tokens map straight to identities (the only stub). It prints the Room and
// the corner as the person's phone reads them.
import { randomUUID } from 'node:crypto';
import { PostgresDatabase, migrate } from '../dist/database.js';
import { PhoneService } from '../dist/phone-service.js';
import { DaemonService } from '../dist/daemon-service.js';
import { LiveHub } from '../dist/live.js';
import { createBeelineServer } from '../dist/server.js';
import { systemLine } from '../dist/system-line.js';
import { refreshModelRegistryIfDue } from '../dist/agent-classes.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = new PostgresDatabase(url, 8);
await migrate(db);

const H = 'a'.repeat(64);
const agents = {
  niglet: { id: '1'.repeat(64), name: 'Niglet', harness: 'claude', model: 'opus', label: 'Opus 5.5' },
  sol: { id: '2'.repeat(64), name: 'Sol', harness: 'codex', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  charles: { id: '3'.repeat(64), name: 'Charles', harness: 'grok', model: 'grok-4.6', label: 'Grok 4.6' },
  hoots: { id: '4'.repeat(64), name: 'Hoots', harness: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' },
  baby: { id: '5'.repeat(64), name: 'Baby', harness: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1' },
  speedy: { id: '6'.repeat(64), name: 'Speedy', harness: 'pi', model: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
};
const byId = new Map(Object.values(agents).map((agent) => [agent.id, agent]));
const W = randomUUID();
const R = randomUUID();
const C = randomUUID();

// --- seed: one person, six agents, a Room and a corner (what onboarding writes)
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Lunchbox','lunchboxfortwo')
  ON CONFLICT(id) DO NOTHING`, [H]);
for (const agent of Object.values(agents)) {
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3) ON CONFLICT(id) DO NOTHING`,
    [agent.id, agent.name, agent.name.toLowerCase()]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT(agent_id) DO NOTHING`, [agent.id, H]);
}
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Demo')`, [W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$3,'workflows',$4),($2,$3,'corner',$4)`,
  [R, C, W, H]);
await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
for (const who of [H, ...byId.keys()])
  for (const room of [null, R, C])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [W, room, who, who === H ? 'owner' : 'member']);
await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle,commissioned_by)
  VALUES($1,$2,'Ship the release notes','{"checks":"unknown"}',$3)`, [C, agents.speedy.id, H]);

// --- the live registry: models.dev is the oracle
const refreshed = await refreshModelRegistryIfDue(db, { force: true });
const count = (await db.query(`SELECT model_count FROM model_registry_state`)).rows[0]?.model_count;
console.log(`models.dev: ${refreshed}, ${count} models cached`);

// --- the HTTP server built from this branch
const phone = new PhoneService(db, 'http://127.0.0.1');
const daemon = new DaemonService(db, new LiveHub());
const auth = {
  authenticatePhone: async (token) => (token === 'person-token-for-the-demo' ? H : null),
  authenticateDaemon: async (token) => (byId.has(token) ? token : null),
};
const server = createBeelineServer({ database: db, auth, phone, daemon, live: new LiveHub(), mediaMaximumBytes: 1 });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (path, token, body) => {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
};
const asPerson = (name, input) => call(`/v1/phone/operations/${name}`, 'person-token-for-the-demo', input);
const asHelper = (agent, name, input) => call(`/v1/daemon/operations/${name}`, agent.id, input);

// Each helper reports its harness and model catalog, and is online.
for (const agent of Object.values(agents)) {
  await asHelper(agent, 'postAgentModelCatalog', {
    agentId: agent.id,
    workspaceId: W,
    harness: agent.harness,
    options: [{ id: 'model', category: 'model', currentValue: agent.model,
      options: [{ id: agent.model, name: agent.label }] }],
    selection: { model: agent.model },
  });
  await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`,
    [R, agent.id]);
}
const classes = await asPerson('readWorkspaceAgentClasses', { workspaceId: W });
console.log('\n== Tags (Workspace settings → Agent classes) ==');
for (const agent of classes.agents)
  console.log(`${agent.name.padEnd(8)} ${agent.classes.tags.map((tag) => tag.tag).join(', ')}` +
    (agent.classes.outputCost !== undefined ? `  ($${agent.classes.outputCost}/1M out)` : ''));

// Real turns take seconds; system lines order themselves after their cause's second.
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_100));
async function pendingFor(roomId) {
  await pause();
  const found = [];
  for (const agent of Object.values(agents)) {
    const { commands } = await asHelper(agent, 'getAgentCommands', { roomId });
    for (const command of commands) found.push({ agent, command });
  }
  return found;
}
async function take(agent, command) {
  await asHelper(agent, 'claimAgentCommand', { roomId: command.roomId, commandId: command.id, generationId: 'g1' });
  await asHelper(agent, 'postAgentTurnReceipt', { roomId: command.roomId, agentId: agent.id,
    requestId: command.turnRequestId, generationId: 'g1', status: 'working' });
}
async function fail(agent, command, reasonKind, reason) {
  await take(agent, command);
  await asHelper(agent, 'postAgentTurnReceipt', { roomId: command.roomId, agentId: agent.id,
    requestId: command.turnRequestId, generationId: 'g1', status: 'failed', reason, reasonKind });
  console.log(`   ${agent.name} fails instantly: ${reason}`);
}
async function answer(agent, command, text) {
  await take(agent, command);
  await pause();
  await asHelper(agent, 'postRoomMessage', { roomId: command.roomId, requestId: command.turnRequestId,
    generationId: 'g1', text });
  await asHelper(agent, 'postAgentTurnReceipt', { roomId: command.roomId, agentId: agent.id,
    requestId: command.turnRequestId, generationId: 'g1', status: 'complete' });
  console.log(`   ${agent.name} answers`);
}
async function transcript(roomId, title) {
  const view = await call(`/v1/phone/rooms/${roomId}`, 'person-token-for-the-demo');
  console.log(`\n== ${title} (as the person's phone reads it) ==`);
  for (const message of view.messages) {
    const who = message.presentation === 'message' ? `${message.author?.name ?? '?'}: ` : '· ';
    console.log(`${who}${message.text}`);
    if (message.card?.constraint) console.log(`    ${message.card.constraint}`);
    if (message.card?.options) console.log(`    options: ${message.card.options.map((o) => o.label).join(' | ')}`);
  }
}

// --- AC-4: the corner reviewer is class "heavy"; its first pick is unavailable
console.log('\n== AC-4: corner reviewer = class heavy ==');
await asPerson('updateRoom', { roomId: R, reviewerClass: 'heavy' });
const firstReviewer = byId.get((await db.query(`SELECT reviewer_agent_id FROM rooms WHERE id=$1`, [R])).rows[0].reviewer_agent_id);
console.log(`   reviewer class heavy → current pick ${firstReviewer.name}`);
await db.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, JSON.stringify({
  checks: 'passing', lifecycle: 'in-review',
  pr: { number: 42, url: 'https://github.com/acme/app/pull/42', headSha: 'c0ffee42', title: 'Release notes' },
})]);
await systemLine(db, { roomId: C, authorId: H, subject: { kind: 'github', name: 'GitHub' },
  verb: 'passed checks', kind: 'check-passed', object: { text: 'aggregate checks', headSha: 'c0ffee42' } });
let [review] = await pendingFor(C);
console.log(`   review dispatched to ${review.agent.name}`);
await fail(review.agent, review.command, 'model-selection-unavailable', 'model selection unavailable');
[review] = await pendingFor(C);
console.log(`   review now with ${review.agent.name} (same source message: ${review.command.sourceMessageId.slice(0, 12)}…)`);
await answer(review.agent, review.command, 'Reviewed #42: the notes match the diff. Approve.');
await transcript(C, 'Corner');

// --- AC-2: a workflow whose reviewer role is bound to class "heavy"
const RELEASE = {
  version: 1,
  name: 'release',
  description: 'Review a release, then summarize it',
  roles: ['reviewer'],
  start: 'review',
  handoffs: {
    review: { role: 'reviewer', requires: ['notes'], on: { done: 'summarize' } },
    summarize: { role: 'reviewer', requires: ['summary'], on: { done: 'finished' } },
    finished: { kind: 'terminal', status: 'done' },
  },
};
console.log('\n== AC-2: workflow "release", role reviewer = class:heavy ==');
await asPerson('sendRoomMessage', { roomId: R, text: '@speedy start the release workflow with reviewer class:heavy' });
const [ask] = await pendingFor(R);
await take(ask.agent, ask.command);
const turn = { roomId: R, requestId: ask.command.turnRequestId, generationId: 'g1' };
await asHelper(ask.agent, 'saveWorkflow', { ...turn, agentId: ask.agent.id, contract: RELEASE });
const run = await asHelper(ask.agent, 'startWorkflow', {
  ...turn, agentId: ask.agent.id, name: 'release', roleBindings: { reviewer: 'class:heavy' },
});
await asHelper(ask.agent, 'postAgentTurnReceipt', { ...turn, agentId: ask.agent.id, status: 'complete' });
console.log(`   ${ask.agent.name} started run ${run.runId.slice(0, 12)}… at state ${run.state}`);
let [work] = await pendingFor(R);
console.log(`   class heavy picked ${work.agent.name} for reviewer`);
await fail(work.agent, work.command, 'model-selection-unavailable', 'model selection unavailable');
[work] = await pendingFor(R);
console.log(`   next heavy agent ${work.agent.name} took over reviewer`);
await take(work.agent, work.command);
const handed = await asHelper(work.agent, 'handoff', { roomId: R, agentId: work.agent.id,
  requestId: work.command.turnRequestId, generationId: 'g1', runId: run.runId, outcome: 'done',
  contents: { notes: 'Two dates were wrong; fixed in the draft.' } });
await asHelper(work.agent, 'postAgentTurnReceipt', { roomId: R, agentId: work.agent.id,
  requestId: work.command.turnRequestId, generationId: 'g1', status: 'complete' });
console.log(`   ${work.agent.name} handed off → ${handed.state}`);

console.log('\n== AC-2: state "summarize": the sticky reviewer and then every heavy agent fail ==');
for (let guard = 0; guard < 6; guard += 1) {
  const [next] = await pendingFor(R);
  if (!next) break;
  const card = (await db.query(`SELECT card FROM messages WHERE id=$1`, [next.command.sourceMessageId])).rows[0]?.card;
  console.log(`   reviewer is ${next.agent.name}; its prompt card carries ${JSON.stringify(card?.contents)}`);
  await fail(next.agent, next.command, guard % 2 ? 'allowance-spent' : 'not-signed-in',
    guard % 2 ? 'You need more credits' : 'authentication required');
}
const choice = (await db.query(`SELECT prompt,status FROM room_choices WHERE room_id=$1`, [R])).rows[0];
console.log(`   a person is asked: ${choice ? `"${choice.prompt}" (${choice.status})` : 'NO'}`);
await transcript(R, 'Room #workflows');

server.close();
await db.close();
