#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import pg from 'pg';
import WebSocket from 'ws';

const fail = (message) => { throw new Error(message); };
const secureFile = async (path, label) => {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) fail(`${label} must be mode 0600 (or stricter)`);
};
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const key of ['origin', 'roomId', 'agentId', 'phoneSessionFile', 'ownerDeviceTokenFile']) {
  if (typeof config[key] !== 'string' || !config[key]) fail(`config.${key} is required`);
}
if (!process.env.DATABASE_URL) fail('DATABASE_URL is required');
if (process.env.CUTOVER_MONOLITH_ORIGIN && config.origin.replace(/\/$/, '') !== process.env.CUTOVER_MONOLITH_ORIGIN) fail('config.origin does not match CUTOVER_MONOLITH_ORIGIN');
if (!/^[0-9a-f]{64}$/.test(config.agentId)) fail('config.agentId must be 64 lowercase hex');
if (!/^[0-9a-f-]{36}$/.test(config.roomId)) fail('config.roomId must be a UUID');
await secureFile(config.phoneSessionFile, 'phoneSessionFile');
await secureFile(config.ownerDeviceTokenFile, 'ownerDeviceTokenFile');
const session = JSON.parse(await readFile(config.phoneSessionFile, 'utf8'));
if (typeof session.refreshToken !== 'string' || !session.refreshToken.startsWith('brt_')) fail('phone session has no brt_ refresh token');
const deviceToken = (await readFile(config.ownerDeviceTokenFile, 'utf8')).trim();
if (deviceToken.length < 20) fail('owner device token file is invalid');
const origin = config.origin.replace(/\/$/, '');
const refreshed = await fetch(`${origin}/v1/auth/refresh`, {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify({ refreshToken: session.refreshToken }),
});
if (!refreshed.ok) fail(`phone refresh failed: HTTP ${refreshed.status}`);
const refreshedSession = await refreshed.json();
const accessToken = refreshedSession.accessToken;
if (typeof accessToken !== 'string' || !accessToken.startsWith('bat_')) fail('phone refresh returned no bat_ access token');
if (typeof refreshedSession.refreshToken !== 'string' || !refreshedSession.refreshToken.startsWith('brt_')) fail('phone refresh returned no brt_ refresh token');
const sessionTemporary = `${config.phoneSessionFile}.tmp-${process.pid}`;
await writeFile(sessionTemporary, `${JSON.stringify(refreshedSession)}\n`, { mode:0o600 });
await rename(sessionTemporary, config.phoneSessionFile);
await chmod(config.phoneSessionFile, 0o600);
const request = async (path, method = 'GET', payload) => fetch(`${origin}${path}`, {
  method,
  headers: { authorization: `Bearer ${accessToken}`, ...(payload ? {'content-type':'application/json'} : {}) },
  ...(payload ? { body: JSON.stringify(payload) } : {}),
});
const messageId = randomBytes(32).toString('hex');
const marker = `cutover-e2e-${messageId.slice(0, 12)}`;
const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/phone/live`, [`bearer.${accessToken}`]);
const waitSocket = (predicate, timeout = 20_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('WebSocket proof timed out')), timeout);
  const listener = (raw) => { let item; try { item=JSON.parse(raw.toString()); } catch { return; } if (!predicate(item)) return; clearTimeout(timer); socket.off('message', listener); resolve(item); };
  socket.on('message', listener);
});
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
socket.send(JSON.stringify({ type:'subscribe', roomId:config.roomId }));
await waitSocket((item) => item.type === 'subscribed' && item.roomId === config.roomId);
const phoneInvalidation = waitSocket((item) => item.type === 'invalidate' && item.roomId === config.roomId && item.reason === 'phone-write', 60_000);
const replyInvalidation = waitSocket((item) => item.type === 'invalidate' && item.roomId === config.roomId && item.reason === 'message', Number(config.timeoutMs ?? 300_000));
const sent = await request('/v1/phone/operations/sendRoomMessage', 'POST', { roomId:config.roomId, messageId, text:marker, mentions:[config.agentId] });
if (!sent.ok) fail(`phone send failed: HTTP ${sent.status}`);
await phoneInvalidation;

const deadline = Date.now() + Number(config.timeoutMs ?? 300_000);
let sawReceipt = false, sawReply = false, sawRead = false;
while (Date.now() < deadline) {
  const response = await request(`/v1/phone/rooms/${config.roomId}`);
  if (!response.ok) fail(`authenticated RoomView read failed: HTTP ${response.status}`);
  const room = await response.json();
  sawRead ||= room.messages?.some((message) => message.id === messageId && message.text === marker);
  sawReceipt ||= room.latestAgentTurns?.some((turn) => turn.requestId === messageId && turn.agentPubkey === config.agentId);
  sawReply ||= room.messages?.some((message) => message.requestId === messageId && message.author?.pubkey === config.agentId && message.presentation === 'message');
  if (sawRead && sawReceipt && sawReply) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
socket.close();
if (!sawRead || !sawReceipt || !sawReply) fail(`flow incomplete: read=${sawRead} receipt=${sawReceipt} reply=${sawReply}`);
await replyInvalidation;
const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
await database.connect();
try {
  let delivered = false;
  const claimDeadline = Date.now() + Number(config.pushClaimTimeoutMs ?? 60_000);
  while (Date.now() < claimDeadline) {
    const claim = await database.query('SELECT status FROM push_delivery_claims WHERE message_id=$1 AND device_token=$2', [messageId, deviceToken]);
    if (claim.rows[0]?.status === 'delivered') { delivered = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!delivered) fail('push_delivery_claims has no delivered row for the owner device');
} finally { await database.end(); }
process.stdout.write(`production E2E passed for message ${messageId}\n`);
