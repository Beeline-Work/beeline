import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const { Client } = require('pg');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const origin = 'http://127.0.0.1:8080';
const secret = required('BEELINE_REVIEW_SECRET');
const database = new Client({ connectionString: required('DATABASE_URL') });

const exchange = await fetch(`${origin}/v1/auth/review/exchange`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ secret }),
});
if (!exchange.ok) throw new Error(`review exchange failed: HTTP ${exchange.status}`);
const session = await exchange.json();
if (typeof session.accessToken !== 'string') throw new Error('review exchange returned no token');

await database.connect();
let target;
try {
  const result = await database.query(
    `SELECT room.id AS room_id, agent.agent_id
     FROM rooms room
     JOIN memberships reviewer
       ON reviewer.room_id=room.id AND reviewer.identity_id=$1 AND reviewer.removed_at IS NULL
     JOIN memberships agent_member
       ON agent_member.room_id=room.id AND agent_member.removed_at IS NULL
     JOIN agents agent ON agent.agent_id=agent_member.identity_id
     JOIN daemon_tokens token
       ON token.agent_id=agent.agent_id AND token.revoked_at IS NULL
       AND (token.expires_at IS NULL OR token.expires_at > now())
     LEFT JOIN live_outputs presence
       ON presence.room_id=room.id AND presence.agent_id=agent.agent_id AND presence.kind='presence'
     WHERE room.parent_id IS NULL AND room.archived_at IS NULL
       AND agent.access_policy->>'type'='everyone'
     ORDER BY presence.updated_at DESC NULLS LAST, token.created_at DESC
     LIMIT 1`,
    [session.identityId],
  );
  target = result.rows[0];
} finally {
  await database.end();
}
if (!target) throw new Error('no reachable agent shares a top-level Room with the reviewer');

const messageId = randomBytes(32).toString('hex');
const marker = `Cutover verification ${messageId.slice(0, 12)} — please confirm receipt.`;
const request = (path, method = 'GET', payload) =>
  fetch(`${origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

const sent = await request('/v1/phone/operations/sendRoomMessage', 'POST', {
  roomId: target.room_id,
  messageId,
  text: marker,
  mentions: [target.agent_id],
});
if (!sent.ok) throw new Error(`message send failed: HTTP ${sent.status}`);

const deadline = Date.now() + 300_000;
let stored = false;
let receipt = false;
let reply = false;
while (Date.now() < deadline) {
  const response = await request(`/v1/phone/rooms/${target.room_id}`);
  if (!response.ok) throw new Error(`Room read failed: HTTP ${response.status}`);
  const room = await response.json();
  stored ||= room.messages?.some((message) => message.id === messageId && message.text === marker);
  receipt ||= room.latestAgentTurns?.some(
    (turn) => turn.requestId === messageId && turn.agentPubkey === target.agent_id,
  );
  reply ||= room.messages?.some(
    (message) => message.requestId === messageId && message.author?.pubkey === target.agent_id,
  );
  if (stored && receipt && reply) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!stored || !receipt || !reply) {
  throw new Error(`round trip incomplete: stored=${stored} receipt=${receipt} reply=${reply}`);
}
console.log(`real message round trip passed: ${messageId}`);
