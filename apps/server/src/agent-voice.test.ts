import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AgentVoiceService } from './agent-voice.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { VoiceService } from './voice-service.js';
import { LiveHub } from './live.js';

const w = '11111111-1111-4111-8111-111111111111',
  r = '22222222-2222-4222-8222-222222222222';
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  h = 'c'.repeat(64),
  stranger = 'd'.repeat(64);
const ids = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
const db = new PgliteDatabase();
const speech = {
  voices: ids,
  choices: ids.map((id, index) => ({
    id,
    name: `Library ${index}`,
    sampleUrl: `https://platform.r2.fish.audio/${id}.mp3`,
  })),
  synthesize: vi.fn(),
};
const profiles = new AgentVoiceService(db, async () => speech);
beforeAll(async () => {
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'agent','A'),($2,'agent','B'),($3,'human','Owner'),($4,'human','Admin')`,
    [a, b, h, stranger],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [w]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [r, w]);
  await db.query(
    `INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$3,$4::jsonb),($2,$3,'{}'::jsonb)`,
    [a, b, h, JSON.stringify({ instructions: `Fish: ${ids[0]}` })],
  );
  for (const id of [a, b, h, stranger])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'admin'),($1,$3,$2,'member')`,
      [w, id, r],
    );
}, 30000);
afterAll(async () => db.close());
it('saves an owner choice ahead of soul and auto-assignment, survives provider changes, and prevents Room collisions', async () => {
  expect((await profiles.catalog(w, a, h)).currentVoiceId).toBe(ids[0]);
  await expect(profiles.save(w, a, stranger, 'fish-s2.1-pro', ids[1]!)).rejects.toThrow('owner');
  await expect(profiles.save(w, a, h, 'fish-s2.1-pro', 'not-a-library-voice')).rejects.toThrow(
    'Unknown voice',
  );
  expect((await profiles.save(w, a, h, 'fish-s2.1-pro', ids[1]!)).currentVoiceId).toBe(ids[1]);
  const service = new VoiceService(db, new LiveHub(), {
    url: 'ws://localhost:7880',
    apiKey: 'key',
    apiSecret: 'secret',
    speech,
    brain: { answer: vi.fn() },
    stt: vi.fn(),
  });
  try {
    const assigned = await service.agents(r, h);
    expect((await profiles.catalog(w, b, h, r)).currentVoiceId).toBe(
      assigned.find((v) => v.id === b)?.voice,
    );
    await expect(profiles.catalog(w, a, h, '33333333-3333-4333-8333-333333333333')).rejects.toThrow(
      'Room agent access denied',
    );
    expect(assigned.find((v) => v.id === a)?.voice).toBe(ids[1]);
    expect(new Set(assigned.map((v) => v.voice)).size).toBe(2);
    await expect(profiles.save(w, b, h, 'fish-s2.1-pro', ids[1]!)).rejects.toThrow('Another agent');
    await profiles.save(w, b, h, 'fish-s2.1-pro', ids[2]!);
    expect((await service.agents(r, h)).find((v) => v.id === b)?.voice).toBe(ids[2]);
    await db.query(`UPDATE workspaces SET voice_provider='aura-2' WHERE id=$1`, [w]);
    await expect(profiles.save(w, a, h, 'fish-s2.1-pro', ids[0]!)).rejects.toThrow(
      'provider changed',
    );
    await profiles.save(w, a, h, 'aura-2', ids[0]!);
    await db.query(`UPDATE workspaces SET voice_provider='fish-s2.1-pro' WHERE id=$1`, [w]);
    expect((await profiles.catalog(w, a, h)).currentVoiceId).toBe(ids[1]);
    await service.recordAnswer(r, a, '(excited) Good news! [confident] We can fix it (today).');
    expect(
      (
        await db.query<{ text: string }>(
          `SELECT text FROM messages WHERE author_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [a],
        )
      ).rows[0]?.text,
    ).toBe('Good news! We can fix it (today).');
  } finally {
    await service.close();
  }
});
it('returns only provider sample URLs and refuses stale membership and unknown preview choices', async () => {
  expect(await profiles.preview(w, a, h, 'fish-s2.1-pro', ids[0]!)).toEqual({
    url: speech.choices[0]!.sampleUrl,
  });
  expect(speech.synthesize).not.toHaveBeenCalled();
  await expect(profiles.preview(w, a, h, 'fish-s2.1-pro', 'unknown')).rejects.toThrow(
    'Unknown voice',
  );
  await db.query(
    `UPDATE memberships SET removed_at=now() WHERE room_id IS NULL AND identity_id=$1`,
    [stranger],
  );
  await expect(profiles.catalog(w, a, stranger)).rejects.toThrow('access denied');
});
it('bounds synthesized provider previews and returns valid 24kHz WAV data', async () => {
  const fallback = new AgentVoiceService(db, async () => ({
    voices: ids,
    async *synthesize() {
      yield new Uint8Array([1, 2, 3, 4]);
    },
  }));
  const preview = await fallback.preview(w, a, h, 'fish-s2.1-pro', ids[0]!);
  expect('wavBase64' in preview).toBe(true);
  if ('wavBase64' in preview) {
    const wav = Buffer.from(preview.wavBase64, 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  }
});

it('denies an agent owner who is now a spectator', async () => {
  await db.query(
    `UPDATE memberships SET role='spectator' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
    [w, h],
  );
  try {
    expect((await profiles.catalog(w, a, h)).canChange).toBe(false);
    await expect(profiles.save(w, a, h, 'fish-s2.1-pro', ids[1]!)).rejects.toThrow('owner');
  } finally {
    await db.query(
      `UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [w, h],
    );
  }
});
