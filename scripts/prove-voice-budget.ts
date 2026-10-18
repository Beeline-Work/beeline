/** Disposable Android call-limit proof. RTC/HTTP/runtime/ledger are real;
 * STT and synthesis are deterministic local doubles, with spoken PCM from flite.
 * Run with the normal Android index.ts entry; no production identity or provider. */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, dispose } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { ReviewAccess } from '../apps/server/src/review-access.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { PostgresLiveListener, POSTGRES_LIVE_CHANNEL } from '../apps/server/src/postgres-live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

async function main() {
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64);
const W = randomUUID(), R = randomUUID();
const db = new PgliteDatabase(), live = new LiveHub();
const pcm = await readFile('.voice-proof/budget/warning.pcm');
const peerSignals: unknown[] = [];
let peerVoicedFrames = 0, inputMs = 0, peerDisconnected = false;
let onFirstInput = () => {};
const service = new VoiceService(db, live, { url: 'ws://127.0.0.1:18884', apiKey: 'devkey', apiSecret: 'secret',
  budgetLimitMs: 180_000,
  brain: { async answer() { return { text: 'Ready.', order: false }; } },
  speech: { async *synthesize() { yield pcm; } },
  stt: async onEvent => {
    let samples = 0, turn = 0;
    return { send(data) {
      onFirstInput();
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
// Exercise the production committed-row projection with Pglite's LISTEN adapter.
// No phone polling or direct client state injection is used.
class FixtureLiveClient extends EventEmitter {
  private unlisten?: () => Promise<void>;
  async connect() {}
  async query() {
    this.unlisten = await db.client.listen(POSTGRES_LIVE_CHANNEL, payload => {
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload });
    });
  }
  async end() {
    const stop = this.unlisten; this.unlisten = undefined;
    await stop?.(); this.emit('end');
  }
}
const listener = new PostgresLiveListener(db, live, () => new FixtureLiveClient());
const listening = listener.run();
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
peer.on(RoomEvent.Disconnected, () => { peerDisconnected = true; });
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
// A second live microphone exercises call-level union through real RTC readers.
// Start its frames only after Android has begun, so it cannot spend the setup time.
const peerMic = new AudioSource(16_000, 1);
const publication = new TrackPublishOptions(); publication.source = TrackSource.SOURCE_MICROPHONE;
onFirstInput = () => {
  onFirstInput = () => {};
  void peer.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('proof-peer-mic', peerMic), publication);
};
const peerFrames = setInterval(() => {
  if (inputMs > 0 && !peerDisconnected) void peerMic.captureFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320)).catch(() => {});
}, 20);
// Only the emulator-facing response changes host address; runtime stays loopback.
const join = service.join.bind(service);
service.join = async (...args) => ({ ...await join(...args), url: 'ws://10.0.2.2:18884' });
const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
  daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024,
  review: new ReviewAccess({ secret: 'isolated-voice-budget-proof-only', mint: async () => session }) });
const ordinary = server.listeners('request')[0]!;
server.removeAllListeners('request');
server.on('request', (request, response) => {
  const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  if (request.url === '/__result') {
    void (async () => {
      const budget = await service.budget.read(W), peerBudget = await service.budget.read(W);
      const call = await service.current(R, SECOND);
      const result = { inputMs, budget, peerBudget, peerSignals, peerVoicedFrames, peerDisconnected,
        survivors: call?.participants.map(p => p.pubkey) ?? [], callStillActive: !!call,
        ended: (await db.query('SELECT text FROM messages WHERE card_type=$1 ORDER BY created_at DESC LIMIT 1', ['voice-call'])).rows[0] };
      await writeFile('.voice-proof/budget/result.json', JSON.stringify(result, null, 2)); json(result);
    })(); return;
  }
  ordinary.call(server, request, response);
});
await new Promise<void>(resolve => server.listen(38597, '127.0.0.1', resolve));
console.log('READY Android budget proof on loopback:38597; limit 180 seconds, warning at 60 seconds of input');
await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
clearInterval(peerFrames); await listener.stop(); await listening; await peer.disconnect(); await peerMic.close(); await service.close();
await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); dispose();

}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
