import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { createBeelineServer } from './server.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { routeAgentResult, type CommandRow } from './agent-command.js';
import { readVoiceContext } from './voice-context.js';
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

it('stores queryable voice timing stages once per generation without transcript content', async () => {
  const timingRoom = '99999999-9999-4999-8999-999999999999';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Timing proof')`, [timingRoom, W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [W, timingRoom, H, A]);
  const joined = await service.join(timingRoom, H);
  const row = { traceId: '77777777-7777-4777-8777-777777777777', callId: joined.call.id,
    stage: 'first_voiced_audio_published', elapsedMs: 1234.5 };
  await service.recordTiming(row);
  await service.recordTiming({ ...row, elapsedMs: 9999 });
  const stages = (await db.query(`SELECT stage,elapsed_ms,server_release FROM voice_turn_timings WHERE trace_id=$1`, [row.traceId])).rows;
  expect(stages).toEqual([{ stage: row.stage, elapsed_ms: 1234.5,
    server_release: process.env.BEELINE_RELEASE_SHA ?? process.env.FLY_IMAGE_REF ?? 'local' }]);
  await service.leave(joined.call.id, H);
  await db.query(`DELETE FROM rooms WHERE id=$1`, [timingRoom]);
});

it('accepts Android NUL-only bodies on authenticated Room call joins', async () => {
  const roomId = '66666666-6666-4666-8666-666666666666';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Android join proof')`, [roomId, W]);
  for (const id of [H, A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [W, roomId, id]);
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','android-join-proof',$1,'https://github.com','beeline','android-join-proof')`, [H]);
  const { accessToken } = await auth.exchangeGitHubOidc('android-join-proof');
  const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/voice/${roomId}/join`;
  try {
    for (const payload of ['\u0000', ' \t\u0000\r\n', '', '{}']) {
      const response = await fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: payload,
      });
      const result = await response.json();
      expect({ status: response.status, error: result.error }).toEqual({ status: 200, error: undefined });
      expect(result.call.roomId).toBe(roomId);
      expect(result.sessionId).toEqual(expect.any(String));
      expect((await service.current(roomId, H))?.id).toBe(result.call.id);
      await service.leave(result.call.id, H, false, result.sessionId);
    }
    for (const payload of ['{', '\u0000{}', '[]', 'null']) {
      const response = await fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: payload,
      });
      expect(response.ok).toBe(false);
      expect(await service.current(roomId, H)).toBeNull();
    }
  } finally {
    const active = await service.current(roomId, H);
    if (active) await service.leave(active.id, H);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.query('DELETE FROM rooms WHERE id=$1', [roomId]);
  }
});

it('SOCKET-OPS-1: joins, reads, resumes and leaves a real voice session over the phone socket', async () => {
  const roomId = '55555555-5555-4555-8555-555555555555';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Socket voice proof')`, [roomId, W]);
  for (const id of [H, A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [W, roomId, id]);
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','socket-voice-proof',$1,'https://github.com','beeline','socket-voice-proof')`, [H]);
  const { accessToken } = await auth.exchangeGitHubOidc('socket-voice-proof');
  const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/v1/phone/live`, [`bearer.${accessToken}`]);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const request = (op: string, args: object) => new Promise<any>(resolve => {
    const id = `voice-${++sequence}`;
    const receive = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === 'res' && frame.id === id) { socket.off('message', receive); resolve(frame); }
    };
    socket.on('message', receive); socket.send(JSON.stringify({ t: 'req', id, op, args }));
  });
  try {
    expect(await request('voiceCurrent', { roomId })).toMatchObject({ ok: true, result: null });
    const joined = await request('voiceJoin', { roomId });
    expect(joined).toMatchObject({ ok: true, result: { call: { roomId } } });
    const callId = joined.result.call.id, sessionId = joined.result.sessionId;
    expect(await request('voiceCurrent', { roomId })).toMatchObject({ ok: true, result: { id: callId } });
    const state = await request('voiceState', { callId, sessionId });
    const webState = await fetch(`${origin}/v1/phone/voice/${callId}/state?sessionId=${sessionId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(state).toMatchObject({ ok: true, result: await webState.json() });
    expect(await request('voiceIdle', { callId, sessionId })).toMatchObject({ ok: true, result: { state: 'ready' } });
    expect(await request('voiceResume', { callId, sessionId })).toMatchObject({ ok: true, result: { resumed: true } });
    expect(await request('voiceLeave', { callId, sessionId })).toMatchObject({ ok: true, result: { left: true } });
    expect(await service.current(roomId, H)).toBeNull();
  } finally {
    socket.terminate();
    const active = await service.current(roomId, H);
    if (active) await service.leave(active.id, H);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.query('DELETE FROM rooms WHERE id=$1', [roomId]);
  }
});

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

it('quiet termination puts its reason on the ended card and explicit leave omits it', async () => {
  const first = await service.join(R, H);
  const second = await service.join(R, SECOND);
  await service.leave(first.call.id, SECOND, false, second.sessionId);
  await db.query(`UPDATE voice_calls SET started_at=now()-interval '2 minutes',runtime_owner=$2,runtime_until=now()+interval '1 minute' WHERE id=$1`, [first.call.id, service.owner]);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE state IN ('pending','claimed')`);
  // Model the actual quiet interval so millisecond Date conversion cannot tie
  // the end card with the final utterance in a fast in-memory database.
  await db.query(`UPDATE messages SET created_at=now()-interval '2 minutes'
    WHERE id=(SELECT message_id FROM voice_calls WHERE id=$1)`, [first.call.id]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
    VALUES($1,$2,$3,'That answers my question.',now()-interval '61 seconds')`, ['f'.repeat(64),R,H]);
  expect(await service.endInactive(first.call.id, service.owner, () => true)).toBe(true);
  const endedRoom=await new PhoneService(db,'http://proof').readRoom(R,H);
  expect(endedRoom?.messages.at(-1)?.voiceCall?.id).toBe(first.call.id);
  expect((await new PhoneService(db,'http://proof').readRoom(R,H))?.messages.find(m=>m.voiceCall?.id===first.call.id)?.voiceCall?.endReason).toBe('silence');
  expect((await new PhoneService(db,'http://proof').readRoom(R,H))?.messages.find(m=>m.voiceCall?.id===first.call.id)?.text)
    .toMatch(/^Voice call ended · \d+:\d{2} · No one spoke for 60s$/);
  expect(await service.idleState(first.call.id, SECOND, db, second.sessionId)).toEqual({state:'ended'});
  expect(await service.idleState(first.call.id, H, db, 'old-session')).toEqual({state:'ended'});
  const fresh = await service.join(R, H);
  expect(fresh.call.id).not.toBe(first.call.id);
  await service.leave(fresh.call.id, H, false, fresh.sessionId);
  expect(await service.idleState(fresh.call.id, H, db, fresh.sessionId)).toEqual({state:'ended'});
  expect((await new PhoneService(db,'http://proof').readRoom(R,H))?.messages.find(m=>m.voiceCall?.id===fresh.call.id)?.voiceCall?.endReason).toBeUndefined();
});



it('demonstrates workspace exhaustion ending the whole call and refusing HTTP joins until reset', async () => {
  const otherRoom = '55555555-5555-4555-8555-555555555555';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Concurrent call')`, [otherRoom, W]);
  for (const who of [H, SECOND, A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [W, otherRoom, who]);
  await db.query(`UPDATE memberships SET role='owner',removed_at=NULL WHERE identity_id=ANY($1::text[])`, [[H, SECOND]]);
  const first = await service.join(R, H);
  await service.join(R, SECOND);
  const concurrent = await service.join(otherRoom, SECOND);
  const now = Date.now();
  // Seed today's exhausted budget without depending on the test's hour of day.
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  await db.query(`INSERT INTO voice_workspace_usage(workspace_id,call_id,day_start,audio)
    VALUES($1,$2,$3,$4::int8multirange),($1,$5,$3,$4::int8multirange)`,
    [W, first.call.id, day, `{[${day},${day + 1_800_000})}`, concurrent.call.id]);
  expect((await service.budget.read(W)).remainingMs).toBe(0);
  const firstRuntime = await (service as any).runtimes.get(first.call.id);
  let releaseClose!: () => void;
  firstRuntime.close.mockImplementationOnce(() => new Promise<void>(resolve => { releaseClose = resolve; }));
  const deleteRoom = vi.spyOn((service as any).rooms, 'deleteRoom');
  const ending = service.endWorkspaceCalls(W);
  try {
    // A stuck final checkpoint in one call cannot delay another Room's eviction.
    await vi.waitFor(() => expect(deleteRoom).toHaveBeenCalledWith(`beeline-voice-${concurrent.call.id}`));
  } finally {
    releaseClose?.(); await ending; deleteRoom.mockRestore();
  }
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','budget-proof-human',$1,'https://github.com','beeline','budget-proof-human')`, [H]);
  const { accessToken } = await auth.exchangeGitHubOidc('budget-proof-human');
  const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/voice/${R}/join`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('Calls resume at 12:00 AM');
    expect(body.budget.remainingMs).toBe(0);
    expect(body.budget.resetAt).toBeGreaterThan(Date.now());
    expect(await service.current(R, SECOND)).toBeNull();
    expect(await service.current(otherRoom, SECOND)).toBeNull();
    const ended = (await db.query<{ text: string }>('SELECT text FROM messages WHERE card_type=$1 ORDER BY created_at DESC LIMIT 1', ['voice-call'])).rows[0];
    expect(ended?.text).toMatch(/^Call ended · .* · Today's 60 minutes are used$/);
    // Deleting a Room must not refund its time to the Workspace.
    await db.query('DELETE FROM rooms WHERE id=$1', [otherRoom]);
    expect((await service.budget.read(W)).remainingMs).toBe(0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.leave(first.call.id, SECOND);
    await db.query('DELETE FROM voice_workspace_usage');
    await db.query('DELETE FROM rooms WHERE id=$1', [otherRoom]);
  }
});

it('DELIVERY-2: stable request IDs deduplicate uncertain recording and delivery, and committed orders cannot be revised', async () => {
  const room = '78787878-7878-4787-8787-787878787878';
  const id = 'stable-voice-request-delivery-2';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Delivery proof')`, [room,W]);
  for (const who of [H,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W,room,who]);
  const joined = await service.join(room,H);
  try {
    const agent = (await service.agents(room,H))[0]!;
    const owner = (await db.query<{runtime_owner:string}>(`SELECT runtime_owner FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]!.runtime_owner;
    const record = () => service.recordHuman(joined.call.id,room,H,agent,'check my latest report',owner,id);
    expect(await record()).toBe(id);
    expect(await record()).toBe(id);
    expect((await db.query(`SELECT * FROM messages WHERE id=$1`, [id])).rowCount).toBe(1);
    await service.dispatch(joined.call.id,id,agent.id);
    await service.dispatch(joined.call.id,id,agent.id);
    expect((await db.query(`SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [id,agent.id])).rowCount).toBe(1);
    expect((await db.query(`SELECT * FROM voice_orders WHERE source_message_id=$1`, [id])).rowCount).toBe(1);
    await expect(service.reviseHuman(joined.call.id,room,H,agent,id,'replace the order',owner)).rejects.toThrow('access denied');
    expect((await db.query<{text:string}>(`SELECT text FROM messages WHERE id=$1`, [id])).rows[0]!.text).toBe('@ruby check my latest report');
  } finally { await service.leave(joined.call.id,H); await db.query(`DELETE FROM rooms WHERE id=$1`, [room]); }
});

it('call history search excludes Rooms another caller cannot read and privately marks dispatched work', async () => {
  const room = '77777777-7777-4777-8777-777777777777';
  const privateRoom = '88888888-8888-4888-8888-888888888888';
  await db.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live') ON CONFLICT(workspace_id) DO UPDATE SET stage='live'`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Search call'),($2,$3,'Private source')`, [room, privateRoom, W]);
  for (const id of [H, A, SECOND]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W, room, id]);
  for (const id of [H, A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W, privateRoom, id]);
  const call = await service.join(room, H);
  await service.join(room, SECOND);
  await db.query(`UPDATE voice_calls SET runtime_owner=$2,runtime_until=now()+interval '60 seconds' WHERE id=$1`, [call.call.id, service.owner]);
  try {
    const agent = (await service.agents(room, H)).find(a => a.id === A)!;
    const source = await service.recordHuman(call.call.id, room, H, agent, 'Find saffronmarker', service.owner);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('voice-shared-search',$1,$3,'saffronmarker public answer'),('voice-private-search',$2,$3,'saffronmarker secret answer')`, [room, privateRoom, H]);
    const result = JSON.parse(await service.search(call.call.id, source, A, { name: 'search_history', query: 'saffronmarker' }, new AbortController().signal));
    expect(result.results.some((row: any) => row.messageId === 'voice-shared-search')).toBe(true);
    expect(result.results.some((row: any) => row.messageId === 'voice-private-search')).toBe(false);
    const posted = JSON.parse(await service.search(call.call.id, source, A,
      { name: 'read_posted_item', query: 'voice-shared-search' }, new AbortController().signal));
    expect(posted.text).toBe('saffronmarker public answer');
    const attachmentUrl = '/v1/media/12345678-1234-4234-8234-123456789012';
    await db.query(`UPDATE messages SET attachments=$1 WHERE id='voice-shared-search'`,
      [ JSON.stringify([{name:'notes.txt',url:attachmentUrl}])]);
    const read = vi.fn(async () => new TextEncoder().encode('The picnic starts at noon.'));
    const readRoomObject = vi.fn(async () => ({name:'notes.txt',mimeType:'text/plain',size:26,read}));
    service.config.objects = { readRoomObject } as any;
    try {
      const file = JSON.parse(await service.search(call.call.id, source, A,
        {name:'read_posted_item',query:attachmentUrl}, new AbortController().signal));
      expect(file).toEqual({title:'notes.txt',text:'The picnic starts at noon.'});
      expect(readRoomObject).toHaveBeenCalledWith(room,A,'12345678-1234-4234-8234-123456789012',service.db);
      await expect(service.search(call.call.id,source,A,{name:'read_posted_item',query:'https://example.com/private'},new AbortController().signal)).rejects.toThrow('not available');
      expect(read).toHaveBeenCalledOnce();
    } finally { delete service.config.objects; }

    await expect(service.search(call.call.id, source, A,
      { name: 'read_posted_item', query: 'voice-private-search' }, new AbortController().signal)).rejects.toThrow('not available');
    await service.dispatch(call.call.id, source, A);
    const { readAgentCommands } = await import('./agent-command.js');
    const commands = await readAgentCommands(db, room, A);
    expect(commands.commands[0]?.source.body).toContain('This is a separate request from a live voice call.');
    expect(commands.commands[0]?.source.body).toContain('Results dated today are current');
    expect(commands.commands[0]?.source.body).toContain('Never start your reply with your name');
    expect(commands.commands[0]?.source.body).toContain(String(new Date().getUTCFullYear()));
    expect(commands.commands[0]?.source.body).toContain('one line for a status, a few sentences for a real answer, at most about 150 words');
    const message = (await db.query<{text:string}>(`SELECT text FROM messages WHERE id=$1`, [source])).rows[0]!;
    expect(message.text).not.toContain('This request came');
  } finally { await service.leave(call.call.id, H); await service.leave(call.call.id, SECOND); }
});


it('VOICE-ROUTER-1: hand-offs arriving mid-turn remain separate requests after overdue recovery', async () => {
  const room = '67676767-6767-4767-8767-676767676767';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Busy voice proof')`, [room,W]);
  for (const who of [H,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W,room,who]);
  const joined = await service.join(room,H);
  try {
    const agent = (await service.agents(room,H))[0]!;
    const owner = (await db.query<{runtime_owner:string}>(`SELECT runtime_owner FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]!.runtime_owner;
    const handoff = async (text: string) => {
      const source = await service.recordHuman(joined.call.id,room,H,agent,text,owner);
      await service.dispatch(joined.call.id,source,agent.id);
      return source;
    };
    const first = await handoff('check whether the release went out');
    const daemon = new DaemonService(db,live);
    const commands = () => daemon.execute('getAgentCommands',{roomId:room},A).then(page=>page.commands);
    const active = (await commands())[0]!;
    await daemon.execute('claimAgentCommand',{roomId:room,commandId:active.id,generationId:'voice-busy'},A);
    const second = await handoff('merge the PR');
    const third = await handoff('open a corner to fix X');
    await db.query(`UPDATE agent_commands SET created_at=created_at-interval '2 minutes' WHERE room_id=$1`,[room]);
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now()-interval '2 minutes' WHERE source_message_id=$1`,[first]);
    const queued = await commands();
    expect(queued.map(command=>command.source.id)).toEqual(expect.arrayContaining([second,third]));
    expect(queued.every(command=>!command.recoveryContext)).toBe(true);
    expect(queued.every(command=>command.source.body.includes('Answer this request in this turn'))).toBe(true);
    expect((await db.query(`SELECT state FROM agent_commands WHERE source_message_id=$1`,[first])).rows[0]).toEqual({state:'complete'});
  } finally { await service.leave(joined.call.id,H); await db.query('DELETE FROM rooms WHERE id=$1',[room]); }
});

it('Reproduction R1/R2: a handed-off voice request carries today and posts its heavy answer without its own name', async () => {
  const room = '13131313-1313-4313-8313-131313131313';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice reply proof')`,[room,W]);
  for (const id of [H,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[W,room,id]);
  const joined = await service.join(room,H);
  try {
    const agent = (await service.agents(room,H)).find(agent=>agent.id===A)!;
    const owner = (await db.query<{runtime_owner:string}>(`SELECT runtime_owner FROM voice_calls WHERE id=$1`,[joined.call.id])).rows[0]!.runtime_owner;
    const source = await service.recordHuman(joined.call.id,room,H,agent,"what triggered today's chip selloff",owner);
    await service.dispatch(joined.call.id,source,A);
    const {readAgentCommands}=await import('./agent-command.js');
    const command=(await readAgentCommands(db,room,A)).commands.find(command=>command.source.id===source)!;
    expect(command.source.body).toContain('Results dated today are current');
    expect(command.source.body).toContain('Never start your reply with your name');
    const day=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(Date.now());
    expect(command.source.body).toContain(day);
    const daemon=new DaemonService(db,live);
    await daemon.execute('claimAgentCommand',{roomId:room,commandId:command.id,generationId:'voice-name-proof'},A);
    await daemon.execute('postRoomMessage',{roomId:room,requestId:command.turnRequestId,generationId:'voice-name-proof',text:'**Ruby:** Today’s search shows the answer.'},A);
    const messages=(await new PhoneService(db,'http://proof').readRoom(room,H))!.messages;
    expect(messages.some(message=>message.author.pubkey===A && message.text==='Today’s search shows the answer.')).toBe(true);
  } finally {await service.leave(joined.call.id,H);await db.query('DELETE FROM rooms WHERE id=$1',[room]);}
});


it('Reproduction VOICE-TAG-1: final call reply wakes another agent once and sees its answer', async () => {
  const room = '31313131-3131-4131-8131-313131313131';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice tag proof')`, [room,W]);
  for (const id of [H,A,B]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W,room,id]);
  await db.query(`UPDATE identities SET name='Baby',handle='baby' WHERE id=$1`,[B]);
  try {
    await service.recordAnswer(room,A,'@baby let me look.', {routeMentions:false});
    await service.recordAnswer(room,A,'@ruby @missing hello.', {replyId:'self-and-missing'});
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`,[room])).rows).toHaveLength(0);
    await service.recordAnswer(room,A,'@baby what are you up to?',{replyId:'final-answer'});
    await service.recordAnswer(room,A,'@baby what are you up to?',{replyId:'final-answer'});
    const commands = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE room_id=$1`,[room])).rows;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({agent_id:B,reason:'agent_tag',agent_depth:0,private_payload:null});
    expect((await db.query(`SELECT text,author_id FROM messages WHERE id=$1`,[commands[0]!.source_message_id])).rows[0])
      .toEqual({text:'@baby what are you up to?',author_id:A});
    await db.transaction(tx=>routeAgentResult(tx,undefined,commands[0]!.source_message_id!,{roomId:room,agentId:A}));
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`,[room])).rows).toHaveLength(1);
    await service.recordAnswer(room,B,'I am checking the call history.');
    expect(JSON.stringify(await readVoiceContext(db,room,'next-turn',A))).toContain('I am checking the call history.');
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[room,B]);
    await service.recordAnswer(room,A,'@baby are you still here?',{replyId:'removed-member'});
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1`,[room])).rows).toHaveLength(1);
    console.log('VOICE-TAG-1: final post -> one agent_tag -> reply in next voice history; replay, acknowledgements, self and nonmembers bounded. Pglite service stand-in; RTC and model not live.');
  } finally {
    await db.query(`UPDATE identities SET name='Sol',handle='sol' WHERE id=$1`,[B]);
    await db.query(`DELETE FROM rooms WHERE id=$1`,[room]);
  }
});

it('VOICE-TAG-1: voice orders preserve chain depth and stop ping-pong', async () => {
  const room = '32323232-3232-4232-8232-323232323232';
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice depth proof')`, [room,W]);
  for (const id of [H,A,B]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [W,room,id]);
  const joined = await service.join(room,H);
  try {
    const source = await service.recordHuman(joined.call.id,room,H,(await service.agents(room,H))[0]!, 'Ask Sol');
    await service.dispatch(joined.call.id,source,A);
    await db.query(`UPDATE agent_commands SET private_payload=$2::jsonb WHERE source_message_id=$1 AND agent_id=$3`,
      [source,JSON.stringify({kind:'order',text:'private assignment',authorId:H,fromRoomId:room}),A]);
    await service.recordAnswer(room,A,'@sol what are you doing?',{replyId:'ordered',sourceId:source});
    const child = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE room_id=$1 AND reason='agent_tag'`,[room])).rows[0]!;
    expect(child).toMatchObject({agent_id:B,agent_depth:1,private_payload:null,root_source_message_id:source});
    await db.query(`UPDATE agent_commands SET agent_depth=3 WHERE source_message_id=$1 AND agent_id=$2`,[source,A]);
    await service.recordAnswer(room,A,'@sol ping again?',{replyId:'at-limit',sourceId:source});
    expect((await db.query(`SELECT * FROM agent_commands WHERE room_id=$1 AND reason='agent_tag'`,[room])).rows).toHaveLength(1);
  } finally { await service.leave(joined.call.id,H); await db.query(`DELETE FROM rooms WHERE id=$1`,[room]); }
});
