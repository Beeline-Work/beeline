import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { LiveHub } from './live.js';
import { VoiceService } from './voice-service.js';
import { VoiceRoomRuntime } from './voice-room-runtime.js';
import { createBeelineServer } from './server.js';
import { DaemonService } from './daemon-service.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { readChatListView, readRoomViewMessage } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

vi.mock('./voice-room-runtime.js', () => ({ VoiceRoomRuntime: { connect: vi.fn(async () => ({ close: vi.fn(), park: vi.fn(), resume: vi.fn(), refresh: vi.fn() })) } }));
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

it('defaults to Aura and refuses dormant providers, even when legacy Workspace settings remain', async () => {
  const phone = new PhoneService(db, 'http://proof');
  expect((await phone.readWorkspace(W, H))?.workspace.voiceProvider).toBe('aura-2');
  await phone.execute('updateWorkspace', { workspaceId: W, voiceProvider: 'aura-2' }, H);
  for (const voiceProvider of ['kokoro-deepinfra', 'fish-s2.1-pro'] as const)
    await expect(phone.execute('updateWorkspace', { workspaceId: W, voiceProvider }, H)).rejects.toThrow('Unknown voice provider');
  await expect(phone.execute('updateWorkspace', { workspaceId: W, voiceProvider: 'aura-2' }, SECOND)).rejects.toThrow();
  const aura = { voices: ['luna', 'apollo'], synthesize: vi.fn() };
  const dormant = { voices: ['af_heart', 'bm_george'], prepare: vi.fn(), synthesize: vi.fn() };
  const selectable = new VoiceService(db, live, { ...service.config, providers: { 'aura-2': aura, 'kokoro-deepinfra': dormant, 'fish-s2.1-pro': dormant } });
  try {
    await db.query(`UPDATE workspaces SET voice_provider='fish-s2.1-pro' WHERE id=$1`, [W]);
    expect(await selectable.speech(R)).toBe(aura);
    expect(new Set((await selectable.agents(R, H)).map(a => a.voice)).size).toBe(2);
    expect((await selectable.profiles.catalog(W, A, H)).provider).toBe('aura-2');
    expect(dormant.prepare).not.toHaveBeenCalled();
    expect(dormant.synthesize).not.toHaveBeenCalled();
  } finally { await selectable.close(); }
});

it('parks only this session’s pending command and prevents recovery from starting parked RTC', async () => {
  const joined = await service.join(R, H);
  const agent = (await service.agents(R, H)).find(a => a.id === A)!;
  const source = await service.recordHuman(joined.call.id, R, H, agent, 'Work until the report is ready');
  await service.dispatch(joined.call.id, source, A);
  try {
    expect(await service.idle(joined.call.id, H)).toEqual({ state: 'parked', agentName: 'Ruby' });
    expect((await db.query(`SELECT 1 FROM voice_participants WHERE call_id=$1 AND parked_at IS NOT NULL AND left_at IS NULL`, [joined.call.id])).rowCount).toBe(1);
    const runtime = await vi.mocked(VoiceRoomRuntime.connect).mock.results.at(-1)!.value;
    expect(runtime.park).toHaveBeenCalledWith(H, undefined);
    expect(runtime.close).not.toHaveBeenCalled();
    await service.resume(joined.call.id, H, joined.sessionId);
    expect(runtime.resume).toHaveBeenCalledWith(H);
    expect((await db.query(`SELECT session_id,parked_at FROM voice_participants WHERE call_id=$1 AND identity_id=$2`, [joined.call.id, H])).rows[0]).toMatchObject({ session_id: joined.sessionId, parked_at: null });
    await db.query(`UPDATE voice_participants SET parked_at=now() WHERE call_id=$1 AND identity_id=$2`, [joined.call.id,H]);
    await db.query(`UPDATE voice_calls SET runtime_until=NULL WHERE id=$1`, [joined.call.id]);
    const contender = new VoiceService(db, live, service.config);
    try { expect(await contender.ensureRuntime((await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`, [joined.call.id])).rows[0]!)).toBeUndefined(); }
    finally { await contender.close(); }
    await db.query(`UPDATE agent_commands SET state='cancelled',completed_at=now() WHERE source_message_id=$1`, [source]);
    expect(await service.idleState(joined.call.id, H)).toEqual({ state: 'ended' });
  } finally { await service.leave(joined.call.id, H); }
});

it('idle with no session command ends participation while unrelated Room work cannot park it', async () => {
  const joined = await service.join(R, H);
  expect(await service.idle(joined.call.id, H)).toEqual({ state: 'ended' });
  expect(await service.current(R, H)).toBeNull();
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
