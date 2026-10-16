#!/usr/bin/env node
// End-to-end proof and rewake latency measurement for free starter agents.
//
//   SERVER=https://server.example DATABASE_URL=postgres://... \
//     [PHONE_TOKEN=...] [SAMPLES=10] [WORKSPACE_ID=...] node scripts/prove-free-agent.mjs
//
// Creates a Workspace as a person (or reuses WORKSPACE_ID), waits for the free
// agent's hello in #general, asks for a real task, then measures SAMPLES
// rewakes: each waits for the agent's Machine to sleep, sends one message and
// times message -> wake requested -> Machine started -> helper registered ->
// first reply. Timestamps come from the server's own rows. With no
// PHONE_TOKEN a throwaway person and token are created in DATABASE_URL, which
// must then be a disposable local database.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const server = (process.env.SERVER ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const samples = Number(process.env.SAMPLES ?? 10);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A throwaway person and phone token in a disposable local database. */
async function throwawayPerson(name, handlePrefix) {
  const person = randomBytes(32).toString('hex');
  const bearer = `bpt_${randomBytes(32).toString('base64url')}`;
  const handle = `${handlePrefix}${person.slice(0, 6)}`;
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human',$2,$3)`, [person, name, handle]);
  await db.query(
    `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
     VALUES($1,$2,gen_random_uuid(),now()+interval '1 day')`,
    [createHash('sha256').update(bearer).digest('hex'), person],
  );
  return { person, bearer, handle, name };
}

let token = process.env.PHONE_TOKEN;
const local = !token;
if (!token) {
  const owner = await throwawayPerson('Proof Person', 'proof');
  token = owner.bearer;
  log(`created proof person ${owner.person.slice(0, 12)}`);
}

async function operation(name, input, bearer = token) {
  const response = await fetch(`${server}/v1/phone/operations/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

let workspaceId = process.env.WORKSPACE_ID;
let roomId;
if (!workspaceId) {
  const created = await operation('createWorkspace', { name: `Free agent proof ${new Date().toISOString().slice(11, 19)}` });
  workspaceId = created.id;
  roomId = created.roomId;
  log(`created Workspace ${workspaceId}; #general ${roomId}`);
}
const agent = await waitFor(
  'the free agent row',
  async () =>
    (
      await db.query(
        `SELECT f.agent_id,i.handle,f.created_at FROM free_agents f JOIN identities i ON i.id=f.agent_id
         WHERE f.workspace_id=$1`,
        [workspaceId],
      )
    ).rows[0],
  10_000,
);
roomId ??= (
  await db.query(
    `SELECT room_id FROM agent_commands WHERE agent_id=$1 AND reason='free_agent_hello'`,
    [agent.agent_id],
  )
).rows[0].room_id;
log(`free agent @${agent.handle} (${agent.agent_id.slice(0, 12)})`);

const reply = (after) =>
  db
    .query(
      `SELECT id,text,created_at FROM messages WHERE room_id=$1 AND author_id=$2
         AND presentation='message' AND created_at>$3 ORDER BY created_at LIMIT 1`,
      [roomId, agent.agent_id, after],
    )
    .then((result) => result.rows[0]);

const hello = await waitFor('the hello in #general', () => reply(new Date(0)), 300_000);
log(`hello after ${((hello.created_at - agent.created_at) / 1000).toFixed(1)} s: ${hello.text.replace(/\s+/g, ' ').slice(0, 300)}`);

async function send(text) {
  const messageId = randomBytes(32).toString('hex');
  await operation('sendRoomMessage', { roomId, messageId, text, mentions: [agent.agent_id] });
  return (await db.query(`SELECT created_at FROM messages WHERE id=$1`, [messageId])).rows[0].created_at;
}

const taskAt = await send(
  `@${agent.handle} please create a file named proof.txt in your home folder containing the line "made on my own VM", then run sha256sum on it and tell me the hash and the output of uname -a.`,
);
const task = await waitFor('the task reply', () => reply(taskAt), 600_000);
log(`task reply after ${((task.created_at - taskAt) / 1000).toFixed(1)} s: ${task.text.replace(/\s+/g, ' ').slice(0, 500)}`);

if (local) {
  // Membership: a person joins (exact greeting), then leaves (one exit note).
  const guest = await throwawayPerson('Guest Proof', 'guest');
  const joinedAt = new Date();
  await operation('addWorkspaceMember', { workspaceId, memberId: guest.person, role: 'member' });
  const greeting = await waitFor('the join greeting', () => reply(joinedAt), 300_000);
  const expected = `@${guest.handle} what up boss? I'm a pro bono agent for beeline. I can help you set up this workspace, invite other humans and agents, or whatever else you might need`;
  log(`join greeting after ${((greeting.created_at - joinedAt) / 1000).toFixed(1)} s; exact=${greeting.text === expected}: ${greeting.text}`);
  const leftAt = new Date();
  await operation('leaveWorkspace', { workspaceId }, guest.bearer);
  const exit = await waitFor('the exit note', () => reply(leftAt), 300_000);
  log(`exit note after ${((exit.created_at - leftAt) / 1000).toFixed(1)} s: ${exit.text}`);
}

const event = (kind, after) =>
  db
    .query(
      `SELECT at,detail FROM free_agent_events WHERE agent_id=$1 AND kind=$2 AND at>$3 ORDER BY at LIMIT 1`,
      [agent.agent_id, kind, after],
    )
    .then((result) => result.rows[0]);

const results = [];
let since = task.created_at;
for (let index = 1; index <= samples; index++) {
  const slept = await waitFor('the Machine to sleep', () => event('slept', since), 300_000);
  const sleepRequested = await event('sleep_requested', since);
  log(
    `sample ${index}: asleep (${slept.detail?.machineId ?? ''}); idle report ${(
      (sleepRequested.at - since) / 1000
    ).toFixed(1)} s after the last reply`,
  );
  await sleep(5_000);
  const sentAt = await send(`@${agent.handle} rewake ${index}: reply with just the word pong.`);
  const answered = await waitFor('the rewake reply', () => reply(sentAt), 300_000);
  const wake = await event('wake_requested', sentAt);
  const started = await event('machine_started', sentAt);
  const connected = await event('connected', sentAt);
  const ms = (value) => (value ? value.at - sentAt : null);
  const sample = {
    sample: index,
    wakeRequestedMs: ms(wake),
    machineStartedMs: ms(started),
    helperRegisteredMs: ms(connected),
    replyVisibleMs: answered.created_at - sentAt,
  };
  results.push(sample);
  log(`sample ${index}: ${JSON.stringify(sample)} reply="${answered.text.slice(0, 80)}"`);
  since = answered.created_at;
}

const stat = (key) => {
  const values = results.map((row) => row[key]).filter((value) => value !== null).sort((a, b) => a - b);
  if (!values.length) return { median: null, worst: null };
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return { median, worst: values.at(-1) };
};
const summary = Object.fromEntries(
  ['wakeRequestedMs', 'machineStartedMs', 'helperRegisteredMs', 'replyVisibleMs'].map((key) => [key, stat(key)]),
);
console.log(JSON.stringify({ workspaceId, roomId, agentId: agent.agent_id, results, summary }, null, 2));
await db.end();
