import type { AddressInfo } from 'node:net';
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

vi.mock('./voice-room-runtime.js', () => ({ VoiceRoomRuntime: { connect: vi.fn(async () => ({ close: vi.fn(), refresh: vi.fn() })) } }));
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
