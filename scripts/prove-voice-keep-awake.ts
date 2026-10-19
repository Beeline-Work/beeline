/** Disposable Android keep-awake proof: real server, auth, Room and RTC; brain/STT/speech are silent doubles. */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dispose } from '@livekit/rtc-node';
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

async function main() {
const H = 'a'.repeat(64), A = 'b'.repeat(64);
const W = randomUUID(), R = randomUUID();
const db = new PgliteDatabase(), live = new LiveHub();
const service = new VoiceService(db, live, { url: 'ws://127.0.0.1:27940', apiKey: 'devkey', apiSecret: 'secret',
  budgetLimitMs: 3_600_000,
  brain: { async answer() { return { text: 'Ready.', order: false }; } },
  speech: { async *synthesize() {} },
  stt: async () => ({ send() {}, close() {} }),
});
const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
await migrate(db);
class FixtureLiveClient extends EventEmitter {
  private unlisten?: () => Promise<void>;
  async connect() {}
  async query() { this.unlisten = await db.client.listen(POSTGRES_LIVE_CHANNEL, payload => this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload })); }
  async end() { const stop = this.unlisten; this.unlisten = undefined; await stop?.(); this.emit('end'); }
}
const listener = new PostgresLiveListener(db, live, () => new FixtureLiveClient());
const listening = listener.run();
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'agent','Ruby','ruby')`, [H, A]);
await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Keep awake proof')`, [W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Keep awake proof')`, [R, W]);
for (const who of [H, A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
  VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [W, who, R]);
await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
  VALUES('github','ka-alex',$1,'https://github.com','beeline','ka-alex')`, [H]);
const session = await auth.exchangeGitHubOidc('ka-alex');
const join = service.join.bind(service);
service.join = async (...args) => ({ ...await join(...args), url: 'ws://10.0.2.2:27940' });
const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
  daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024,
  review: new ReviewAccess({ secret: 'isolated-keep-awake-proof-only', mint: async () => session }) });
const ordinary = server.listeners('request')[0]!;
server.removeAllListeners('request');
server.on('request', (request, response) => {
  if (request.url === '/__call') {
    void service.current(R, H).then(call => { response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ active: !!call, participants: call?.participants.map(p => p.kind) ?? [] })); });
    return;
  }
  ordinary.call(server, request, response);
});
await new Promise<void>(resolve => server.listen(38598, '127.0.0.1', resolve));
console.log('READY keep-awake proof on loopback:38598');
await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
await listener.stop(); await listening; await service.close();
await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); dispose();
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
