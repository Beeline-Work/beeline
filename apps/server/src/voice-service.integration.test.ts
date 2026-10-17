import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { createBeelineServer } from './server.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { VoiceService } from './voice-service.js';
import { VoiceRoomRuntime } from './voice-room-runtime.js';
import { PhoneService } from './phone-service.js';
import { readChatListView, readRoomViewMessage } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

vi.mock('./voice-room-runtime.js', () => ({ VoiceRoomRuntime: { connect: vi.fn(async (_service: unknown, _call: string, roomId: string) => ({ roomId, stopCall: vi.fn(), close: vi.fn(), park: vi.fn(), resume: vi.fn(), refresh: vi.fn(), countHumans: vi.fn(async () => {}) })) } }));
vi.mock('livekit-server-sdk', async original => {
  const actual = await original<typeof import('livekit-server-sdk')>();
  return { ...actual, RoomServiceClient: class { async removeParticipant() {} async deleteRoom() {} } };
});
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
const db = new PgliteDatabase(); const live = new LiveHub();
const service = new VoiceService(db, live, { url: 'ws://localhost:7880', apiKey: 'devkey', apiSecret: 'secret',
  brain: { answer: vi.fn() }, speech: { synthesize: vi.fn() }, stt: vi.fn() });
beforeAll(async () => {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','System','system') ON CONFLICT DO NOTHING`, [SYSTEM_IDENTITY_ID]);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby'),
    ($3,'agent','Sol','sol'),($4,'human','Second','second')`, [H, A, B, SECOND]);
  await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$3,'{"instructions":"Warm."}'),($2,$3,'{"instructions":"Concise."}')`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Voice proof')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [R, W]);
  for (const id of [H, A, B, SECOND]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [W, id, R]);
}, 30_000);
afterAll(async () => { await service.close(); await db.close(); });

it('finds the last eligible agent message within the exact Room or corner', async () => {
  const corner = '44444444-4444-4444-8444-444444444444';
  await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Corner',$3)`, [corner, W, R]);
  const agents = await service.agents(R, H);
  const add = async (id: string, room: string, author: string, at: number, presentation = 'message', deleted = false) => {
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at,presentation,deleted_at)
      VALUES($1,$2,$3,'Activity proof',to_timestamp($4),$5,CASE WHEN $6 THEN now() END)`,
      [id, room, author, at, presentation, deleted]);
  };
  try {
    expect(await service.lastActiveAgent(R, agents)).toBeUndefined();
    await add('recent-1', R, A, 100);
    await add('recent-2', R, B, 200);
    await add('recent-human', R, H, 300);
    await add('recent-deleted', R, A, 400, 'message', true);
    await add('recent-activity', R, A, 500, 'activity');
    await add('recent-system', R, A, 600, 'system');
    expect(await service.lastActiveAgent(corner, agents)).toBeUndefined();
    await add('recent-corner', corner, A, 700);
    expect(await service.lastActiveAgent(R, agents)).toBe(B);
    expect(await service.lastActiveAgent(corner, agents)).toBe(A);
    expect(await service.lastActiveAgent(R, agents.filter(agent => agent.id === A))).toBe(A);
    expect(await service.lastActiveAgent(R, [])).toBeUndefined();
    await add('recent-3', R, A, 200);
    expect(await service.lastActiveAgent(R, agents)).toBe(A);
  } finally {
    await db.query(`DELETE FROM messages WHERE id LIKE 'recent-%'`);
    await db.query(`DELETE FROM rooms WHERE id=$1`, [corner]);
  }
});

it('stores one rendition when the voice model repeats a formatted answer as plain text', async () => {
  const answer = 'I’m listening. What were you going to say?';
  await service.recordAnswer(R, A, '**I’m listening.**\nWhat were you going to say?\n\n' + answer);
  const rows = await db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1 AND agent_model='openai/gpt-6-luna'`, [R]);
  expect(rows.rows.map(row => row.text)).toEqual(['**I’m listening.**\nWhat were you going to say?']);
});

it('preserves distinct paragraphs and intentional repetition within an answer', async () => {
  const text = 'Say hey hey.\n\nThen say yeah yeah.';
  await service.recordAnswer(R, B, text);
  expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1 AND author_id=$2`, [R, B])).rows.map(row => row.text)).toEqual([text]);
});

it('joins a second human into one persisted call, targets only Ruby, and ends after the last leaves', async () => {
  const joined = await service.join(R, H);
  const second = await service.join(R, SECOND);
  expect(second.call.id).toBe(joined.call.id);
  expect(second.call.participants.map(p => p.pubkey)).toEqual([H, SECOND]);
  expect(await service.humanCount(joined.call.id)).toBe(2);
  const lease = (await db.query<{ runtime_owner: string }>(`SELECT runtime_owner FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]!.runtime_owner;
  const before = (await db.query(`SELECT 1 FROM messages WHERE room_id=$1`, [R])).rowCount;
  await expect(service.recordHuman(joined.call.id, R, H, (await service.agents(R, H))[0]!, 'stale runtime', 'old-lease')).rejects.toThrow('access denied');
  expect((await db.query(`SELECT 1 FROM messages WHERE room_id=$1`, [R])).rowCount).toBe(before);
  expect(lease).toContain(service.owner);
  const phone = new PhoneService(db, 'http://proof');
  const deck = await phone.readChats(W, SECOND);
  expect(readChatListView(deck)?.chats[0]?.voiceCall?.id).toBe(joined.call.id);
  const room = await phone.readRoom(R, SECOND);
  const card = room?.messages.find(m => m.voiceCall);
  expect(readRoomViewMessage(card)?.voiceCall?.participants).toHaveLength(2);
  const agent = (await service.agents(R, H)).find(a => a.id === A)!;
  const source = await service.recordHuman(joined.call.id, R, H, agent, 'Build a widget and ask @sol later');
  expect((await db.query(`SELECT * FROM agent_commands WHERE source_message_id=$1`, [source])).rowCount).toBe(0);
  await Promise.all([service.dispatch(joined.call.id, source, A), service.dispatch(joined.call.id, source, A)]);
  expect((await db.query<{ agent_id: string }>(`SELECT agent_id FROM agent_commands WHERE source_message_id=$1`, [source])).rows.map(r => r.agent_id)).toEqual([A]);
  await service.recordAnswer(R, A, 'I’ll work on that.');
  expect((await db.query<{ author_id: string }>(`SELECT author_id FROM messages WHERE text='I’ll work on that.'`)).rows[0]?.author_id).toBe(A);
  await service.leave(joined.call.id, H);
  expect((await service.current(R, SECOND))?.participants).toHaveLength(1);
  expect(await service.humanCount(joined.call.id)).toBe(1);
  await service.leave(joined.call.id, SECOND);
  expect(await service.current(R, SECOND)).toBeNull();
  const ended = await phone.readRoom(R, SECOND);
  expect(ended?.messages.find(m => m.voiceCall)?.text).toMatch(/^Voice call ended · \d+:\d{2}$/);
  expect(ended?.messages.find(m => m.voiceCall)?.presentation).toBe('system');
});

it('coalesces concurrent runtime claims before their database lease resolves', async () => {
  const contender = new VoiceService(db, live, service.config);
  const connect = vi.mocked(VoiceRoomRuntime.connect);
  const before = connect.mock.calls.length;
  const call = (await db.query<any>(`INSERT INTO voice_calls(id,room_id,message_id)
    SELECT '33333333-3333-4333-8333-333333333333',$1,m.id FROM messages m WHERE room_id=$1 AND NOT EXISTS (SELECT 1 FROM voice_calls c WHERE c.message_id=m.id) LIMIT 1 RETURNING *`, [R])).rows[0]!;
  await db.query(`INSERT INTO voice_participants(call_id,identity_id) VALUES($1,$2)`, [call.id, H]);
  try {
    await Promise.all(Array.from({ length: 4 }, () => contender.ensureRuntime(call)));
    expect(connect.mock.calls.length - before).toBe(1);
    await service.ensureRuntime(call);
    expect(connect.mock.calls.length - before).toBe(1);
  } finally {
    await contender.close();
    await db.query(`UPDATE voice_calls SET ended_at=now() WHERE id=$1`, [call.id]);
  }
});

it('refuses a removed member and a spectator, including stale call tokens', async () => {
  await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, SECOND]);
  await expect(service.join(R, SECOND)).rejects.toThrow('access denied');
  await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [R, SECOND]);
  await db.query(`UPDATE memberships SET role='spectator' WHERE room_id IS NULL AND identity_id=$1`, [SECOND]);
  await expect(service.join(R, SECOND)).rejects.toThrow('access denied');
});

it('ignores an old client provider field while keeping Aura and manager authorization', async () => {
  const phone = new PhoneService(db, 'http://proof');
  const legacyInput = { workspaceId: W, voiceProvider: 'retired-provider' };
  await phone.execute('updateWorkspace', legacyInput, H);
  expect((await phone.readWorkspace(W, H))?.workspace).not.toHaveProperty('voiceProvider');
  await expect(phone.execute('updateWorkspace', legacyInput, SECOND)).rejects.toThrow();
  expect(await service.speech(R)).toBe(service.config.speech);
});

it('demonstrates authenticated Aura saves and WAV previews while ignoring old provider fields', async () => {
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','aura-proof-owner',$1,'https://github.com','beeline','aura-proof-owner')`, [H]);
  const { accessToken } = await auth.exchangeGitHubOidc('aura-proof-owner');
  const aura = new VoiceService(db, live, { ...service.config, speech: {
    voices: ['luna', 'apollo'], async *synthesize() { yield new Uint8Array([1, 2, 3, 4]); },
  } });
  const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, voice: aura, mediaMaximumBytes: 1024 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function post(path: string, body: unknown) {
    const response = await fetch(origin + path, { method: 'POST', headers: {
      authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) });
    expect(response.status).toBe(path.includes('/operations/') ? 204 : 200);
    return response.status === 204 ? undefined : response.json();
  }
  try {
    await post('/v1/phone/operations/updateWorkspace', { workspaceId: W, voiceProvider: 'retired-provider' });
    const profilePath = `/v1/phone/workspaces/${W}/agents/${A}`;
    const saved = await post(profilePath + '/voices', { provider: 'retired-provider', voiceId: 'apollo' });
    expect(saved.currentVoiceId).toBe('apollo');
    expect(saved).not.toHaveProperty('provider');
    const preview = await post(profilePath + '/voice-preview', { provider: 'retired-provider', voiceId: 'apollo' });
    const wav = Buffer.from(preview.wavBase64, 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
    console.log('Demonstration AURA-ONLY-1: authenticated old-client workspace update and voice save pass; Apollo persists; preview returns a 24kHz WAV. Speech bytes are a fixture, not a live provider proof.');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await aura.close();
  }
});

it('call-wide-end-3: idle is a no-op in solo calls even while call work is pending', async () => {
  const joined = await service.join(R,H);
  try {
    expect(await service.idle(joined.call.id,H)).toEqual({state:'ready'});
    const agent = (await service.agents(R,H)).find(a => a.id===A)!;
    const source = await service.recordHuman(joined.call.id,R,H,agent,'Work');
    await service.dispatch(joined.call.id,source,A);
    expect(await service.hasCallWork(joined.call.id)).toBe(true);
    expect(await service.idle(joined.call.id,H)).toEqual({state:'ready'});
    expect((await db.query(`SELECT parked_at,left_at FROM voice_participants WHERE call_id=$1 AND identity_id=$2`,[joined.call.id,H])).rows[0]).toEqual({parked_at:null,left_at:null});
    await db.query(`UPDATE agent_commands SET state='cancelled',completed_at=now() WHERE source_message_id=$1`,[source]);
  } finally { await service.leave(joined.call.id,H); }
});

it('multi-human-silence-1: an old client idle deadline keeps both participants active', async () => {
  const joined = await service.join(R, H);
  // Earlier access tests deliberately leave SECOND a spectator.
  await db.query(`UPDATE memberships SET role='owner' WHERE room_id IS NULL AND identity_id=$1`, [SECOND]);
  await service.join(R, SECOND);
  try {
    expect(await service.idle(joined.call.id, H, joined.sessionId)).toEqual({ state: 'ready' });
    expect(await service.humanCount(joined.call.id)).toBe(2);
    expect(await service.idleState(joined.call.id, H, db, joined.sessionId)).toEqual({ state: 'ready' });
    expect((await db.query(`SELECT parked_at,left_at FROM voice_participants WHERE call_id=$1 AND identity_id=$2`, [joined.call.id,H])).rows[0]).toEqual({ parked_at: null, left_at: null });
  } finally { await service.leave(joined.call.id,H); await service.leave(joined.call.id,SECOND); }
});

it('multi-human-mode-2: join, leave and rejoin notify the RTC owner immediately after commit', async () => {
  const joined = await service.join(R,H);
  const runtime = await vi.mocked(VoiceRoomRuntime.connect).mock.results.at(-1)!.value;
  const counts: number[] = [];
  vi.spyOn(runtime,'countHumans').mockImplementation(async () => { counts.push(await service.humanCount(joined.call.id)); });
  const other = new VoiceService(db,live,service.config);
  try {
    await other.join(R,SECOND);
    await vi.waitFor(() => expect(counts.at(-1)).toBe(2));
    await other.leave(joined.call.id,SECOND);
    await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
    await other.join(R,SECOND);
    await vi.waitFor(() => expect(counts.at(-1)).toBe(2));
    await db.query(`UPDATE voice_participants SET parked_at=now() WHERE call_id=$1 AND identity_id=$2`,[joined.call.id,SECOND]);
    expect(await service.humanCount(joined.call.id)).toBe(2);
  } finally { await other.close(); await service.leave(joined.call.id,H); await service.leave(joined.call.id,SECOND); }
});

it('idle with no session command keeps participation active', async () => {
  const joined = await service.join(R, H);
  expect(await service.idle(joined.call.id, H)).toEqual({ state: 'ready' });
  expect(await service.current(R, H)).not.toBeNull();
  await service.leave(joined.call.id,H);
});

it('rejects delayed idle and leave from a superseded participation generation', async () => {
  const old = await service.join(R, H);
  const current = await service.join(R, H);
  expect(current.call.id).toBe(old.call.id);
  expect(current.sessionId).not.toBe(old.sessionId);
  await service.idle(old.call.id, H, old.sessionId);
  await service.leave(old.call.id, H, false, old.sessionId);
  expect((await service.current(R,H))?.participants.map(p => p.pubkey)).toContain(H);
  expect((await db.query(`SELECT parked_at FROM voice_participants WHERE call_id=$1 AND identity_id=$2`,[current.call.id,H])).rows[0]?.parked_at).toBeNull();
  await service.leave(current.call.id,H,false,current.sessionId);
});


it('native Stop ends a parked call and rejects tampering, expiry and successor sessions', async () => {
  const joined = await service.join(R, H);
  await db.query(`UPDATE voice_participants SET parked_at=now() WHERE call_id=$1 AND identity_id=$2`, [joined.call.id, H]);
  expect(await service.nativeStop(joined.call.id, joined.stopToken + 'x')).toBe(false);
  expect(await service.nativeStop(R, joined.stopToken)).toBe(false);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_001);
  try { expect(await service.nativeStop(joined.call.id, joined.stopToken)).toBe(false); }
  finally { clock.mockRestore(); }
  const successor = await service.join(R, H);
  expect(await service.nativeStop(joined.call.id, joined.stopToken)).toBe(true);
  expect((await service.current(R, H))?.participants.map(p => p.pubkey)).toContain(H);
  await db.query(`UPDATE voice_participants SET parked_at=now() WHERE call_id=$1 AND identity_id=$2`, [joined.call.id, H]);
  const app = createBeelineServer({ database: db, live, voice: service,
    auth: new TokenAuth(db, async () => ({ subject: 'proof', login: 'proof' })), daemon: new DaemonService(db, live), phone: new PhoneService(db, 'http://proof'),
    mediaMaximumBytes: 1000, webAppOrigins: [] });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const address = app.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/phone/voice/${successor.call.id}/native-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: successor.stopToken }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ left: true });
  } finally { await new Promise<void>(resolve => app.close(() => resolve())); }
  expect(await service.current(R, H)).toBeNull();
  expect((await db.query(`SELECT left_at FROM voice_participants WHERE call_id=$1 AND identity_id=$2`, [joined.call.id, H])).rows[0]?.left_at).not.toBeNull();
  console.log('parked native Stop => left_at set, call ended; stale capability cannot end successor');
});


it('call-feedback-1: delivers a recorded utterance before leave while PostgreSQL LISTEN is unavailable', async () => {
  const joined = await service.join(R, H);
  const phone = new PhoneService(db, 'http://proof');
  const app = createBeelineServer({ database: db, live, voice: service,
    auth: { authenticatePhone: async () => H } as unknown as TokenAuth,
    daemon: new DaemonService(db, live), phone, mediaMaximumBytes: 1000 });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${(app.address() as AddressInfo).port}/v1/phone/live`, ['bearer.proof']);
  const frames: any[] = [];
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'subscribe', roomIds: [R] }));
    await until(() => frames.some(frame => frame.type === 'subscribed'));
    const agent = (await service.agents(R, H))[0]!;
    const source = await service.recordHuman(joined.call.id, R, H, agent, 'Show this while I am still speaking');
    await until(() => frames.some(frame => frame.type === 'message-delta' && frame.message.id === source));
    const delta = frames.find(frame => frame.type === 'message-delta' && frame.message.id === source);
    expect(delta.message.text).toContain('Show this while I am still speaking');
    expect(readRoomViewMessage(delta.message)?.author.pubkey).toBe(H);
    expect((await service.current(R, H))?.id).toBe(joined.call.id);
  } finally {
    socket.close();
    await new Promise<void>(resolve => app.close(() => resolve()));
    await service.leave(joined.call.id, H);
  }
});

it('call-wide-end-3: reconnect cannot create or join a successor after its call ends', async () => {
  const joined = await service.join(R,H);
  await service.leave(joined.call.id,H);
  await expect(service.join(R,H,joined.call.id)).rejects.toThrow('voice session ended');
  expect(await service.current(R,H)).toBeNull();
  const successor=await service.join(R,H);
  try { await expect(service.join(R,SECOND,joined.call.id)).rejects.toThrow('voice session ended'); }
  finally { await service.leave(successor.call.id,H); }
});

it('call-wide-end-3: a stale owner or speech during the end transaction cannot close the call', async () => {
  const joined=await service.join(R,H);
  const owner=(await db.query<{runtime_owner:string}>(`SELECT runtime_owner FROM voice_calls WHERE id=$1`,[joined.call.id])).rows[0]!.runtime_owner;
  expect(await service.endInactive(joined.call.id,'stale-owner',()=>true)).toBe(false);
  const update=service.updateCard.bind(service); let quiet=true;
  const card=vi.spyOn(service,'updateCard').mockImplementationOnce(async (...args)=>{await update(...args);quiet=false;});
  try {
    expect(await service.endInactive(joined.call.id,owner,()=>quiet)).toBe(false);
    expect(await service.current(R,H)).not.toBeNull();
    expect(await service.humanCount(joined.call.id)).toBe(1);
  } finally { card.mockRestore();await service.leave(joined.call.id,H); }
});

it('quiet termination returns a private reason only to the participant session present at the end', async () => {
  const first = await service.join(R, H);
  const second = await service.join(R, SECOND);
  await service.leave(first.call.id, SECOND, false, second.sessionId);
  await db.query(`UPDATE voice_calls SET runtime_owner=$2,runtime_until=now()+interval '1 minute' WHERE id=$1`, [first.call.id, service.owner]);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE state IN ('pending','claimed')`);
  expect(await service.endInactive(first.call.id, service.owner, () => true)).toBe(true);
  expect(await service.idleState(first.call.id, H, db, first.sessionId)).toEqual({state:'ended',endReason:'silence'});
  expect(await service.idleState(first.call.id, SECOND, db, second.sessionId)).toEqual({state:'ended'});
  expect(await service.idleState(first.call.id, H, db, 'old-session')).toEqual({state:'ended'});
  const fresh = await service.join(R, H);
  expect(fresh.call.id).not.toBe(first.call.id);
  await service.leave(fresh.call.id, H, false, fresh.sessionId);
  expect(await service.idleState(fresh.call.id, H, db, fresh.sessionId)).toEqual({state:'ended'});
});
