/** Disposable Android call-limit proof. RTC/HTTP/runtime/ledger are real;
 * STT and synthesis are deterministic local doubles, with spoken PCM from flite.
 * Run alongside voice-budget-native-proof.tsx; no production identity or provider. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Room, RoomEvent, AudioStream, TrackKind, dispose } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

async function main() {
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64);
const W = randomUUID(), R = randomUUID();
const db = new PgliteDatabase(), live = new LiveHub();
const pcm = await readFile('.voice-proof/budget/warning.pcm');
const observations: unknown[] = [], peerSignals: unknown[] = [];
let peerVoicedFrames = 0, inputMs = 0;
const service = new VoiceService(db, live, { url: 'ws://127.0.0.1:17884', apiKey: 'devkey', apiSecret: 'secret',
  budgetLimitMs: 180_000,
  brain: { async answer() { return { text: 'Ready.', order: false }; } },
  speech: { async *synthesize() { yield pcm; } },
  stt: async onEvent => {
    let samples = 0, turn = 0;
    return { send(data) {
      inputMs += data.length / 16; samples += data.length;
      // Keep pre-2546 silence handling out of this budget proof without changing it.
      if (samples >= 16_000 * 8) {
        samples = 0;
        onEvent({ event: 'EndOfTurn', transcript: 'Hello everyone', turn_index: turn++, sequence_id: turn,
          words: [{ word: 'Hello', confidence: .99, start: 0, end: .3 }, { word: 'everyone', confidence: .99, start: .3, end: .7 }] });
      }
    }, close() {} };
  },
});
const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
await migrate(db);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),($3,'agent','Ruby','ruby')`, [H, SECOND, A]);
await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated voice budget proof')`, [W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Budget proof')`, [R, W]);
for (const who of [H, SECOND, A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
  VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [W, who, R]);
await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
  VALUES('github','budget-alex',$1,'https://github.com','beeline','budget-alex')`, [H]);
const session = await auth.exchangeGitHubOidc('budget-alex');
const second = await service.join(R, SECOND);
const peer = new Room();
peer.on(RoomEvent.DataReceived, (bytes, _participant, _kind, topic) => {
  if (topic === VOICE_DATA_TOPIC) {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.type === 'budget') peerSignals.push(data);
  }
});
peer.on(RoomEvent.TrackSubscribed, track => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  void (async () => { const reader = new AudioStream(track, 24_000, 1).getReader();
    try { while (true) { const frame = await reader.read(); if (frame.done) break;
      if (frame.value.data.some(sample => Math.abs(sample) > 150)) peerVoicedFrames++; } } catch {}
  })();
});
await peer.connect(second.url, second.token);
// Only the emulator-facing response changes host address; runtime stays loopback.
const join = service.join.bind(service);
service.join = async (...args) => ({ ...await join(...args), url: 'ws://10.0.2.2:17884' });
const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
  daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024 });
const ordinary = server.listeners('request')[0]!;
server.removeAllListeners('request');
server.on('request', (request, response) => {
  const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.url === '/__config') {
    json({ roomId: R, token: session.accessToken, call: second.call,
      agents: [{ pubkey: A, kind: 'agent', name: 'Ruby' }] }); return;
  }
  if (request.url === '/__observe') {
    let body = ''; request.on('data', chunk => { if (body.length < 4096) body += chunk; });
    request.on('end', () => { observations.push({ at: Date.now(), ...JSON.parse(body) }); json({ ok: true }); }); return;
  }
  if (request.url === '/__result') {
    void (async () => {
      const budget = await service.budget.read(H), peerBudget = await service.budget.read(SECOND);
      const call = await service.current(R, SECOND);
      const result = { observations, inputMs, budget, peerBudget, peerSignals, peerVoicedFrames,
        survivors: call?.participants.map(p => p.pubkey), callStillActive: !!call };
      await writeFile('.voice-proof/budget/result.json', JSON.stringify(result, null, 2)); json(result);
    })(); return;
  }
  ordinary.call(server, request, response);
});
await new Promise<void>(resolve => server.listen(38497, '127.0.0.1', resolve));
console.log('READY Android budget proof on loopback:38497; limit 180 seconds, warning at 60 seconds of input');
await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
await peer.disconnect(); await service.close();
await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); dispose();

}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
