/** Two-human Conversation routing over actual LiveKit RTC and the real join endpoint.
 * Speech-to-text uses the EndOfTurn seam; the voice model and speech are local doubles,
 * so the proof needs no provider key. Run against any revision to compare behaviour.
 *   LIVEKIT_URL=ws://127.0.0.1:35880 LIVEKIT_API_SECRET=... npx tsx scripts/prove-voice-multi-routing.ts
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, dispose } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import type { FluxEvent, VoiceBrain, VoiceSpeech } from '../apps/server/src/voice-providers.js';
import { type VoiceJoin, VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

const ALEX = 'a'.repeat(64), SAM = 'd'.repeat(64), RUBY = 'b'.repeat(64), GOOSY = 'c'.repeat(64);
const W = randomUUID(), R = randomUUID();
const names: Record<string, string> = { [RUBY]: 'Ruby', [GOOSY]: 'Goosy' };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

async function main() {
  const db = new PgliteDatabase(); const live = new LiveHub();
  const answers: { agent: string; text: string; aborted: () => boolean }[] = [];
  const brain: VoiceBrain = {
    async answer(agent, history, onText, signal) {
      answers.push({ agent: names[agent.id] ?? agent.id, text: history.at(-1)!.content, aborted: () => signal.aborted });
      const text = history.at(-1)!.content.includes('story') ? 'Once upon a time there was a long story.' : 'Here.';
      await wait(50); onText(text); return { text, order: false };
    },
  };
  let playing = 0;
  const speech: VoiceSpeech = {
    async *synthesize(text, _voice, signal) {
      const chunks = text.includes('long story') ? 200 : 4;
      playing++;
      try {
        for (let i = 0; i < chunks && !signal.aborted; i++) { await wait(50); yield Buffer.alloc(1920, 40); }
      } finally { playing--; }
    },
  };
  const sttEvents: Array<(event: FluxEvent) => void> = [];
  const service = new VoiceService(db, live, {
    url: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:35880',
    apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey', apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secretsecretsecretsecretsecretsecret',
    brain, speech, stt: async onEvent => { sttEvents.push(onEvent); return { send() {}, close() {} }; },
  });
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  const phone = new PhoneService(db, 'http://proof'); const daemon = new DaemonService(db, live);
  const server = createBeelineServer({ database: db, auth, phone, daemon, live, voice: service,
    mediaMaximumBytes: 1024 * 1024, webAppOrigins: ['http://127.0.0.1:18090'] });
  const clients: Room[] = []; const sources: AudioSource[] = [];
  const signals = new Map<string, any[]>();
  const heard = new Map<string, number>();
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),
      ($3,'agent','Ruby','ruby'),($4,'agent','Goosy','goosy')`, [ALEX, SAM, RUBY, GOOSY]);
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
      VALUES('github','alex',$1,'https://github.com','beeline','alex'),('github','sam',$2,'https://github.com','beeline','sam')`, [ALEX, SAM]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$3,'{"instructions":"Ruby"}'),($2,$3,'{"instructions":"Goosy"}')`, [RUBY, GOOSY, ALEX]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated multi-human proof')`, [W]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice proof')`, [R, W]);
    for (const who of [ALEX, SAM, RUBY, GOOSY]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [W, who, R]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tokens = { Alex: (await auth.exchangeGitHubOidc('alex')).accessToken, Sam: (await auth.exchangeGitHubOidc('sam')).accessToken };
    async function request(path: string, token: string) {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      return await response.json();
    }
    async function until(test: () => boolean, timeout = 5000) {
      const start = Date.now(); while (!test()) { if (Date.now() - start > timeout) return false; await wait(20); } return true;
    }
    async function connect(label: 'Alex' | 'Sam') {
      const joined = await request(`/v1/phone/voice/${R}/join`, tokens[label]) as VoiceJoin;
      const room = new Room(); clients.push(room); signals.set(label, []); heard.set(label, 0);
      room.on(RoomEvent.TrackSubscribed, track => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        void (async () => {
          const reader = new AudioStream(track, 24_000, 1).getReader();
          try { while (true) { const frame = await reader.read(); if (frame.done) break;
            if (frame.value.data.some(v => Math.abs(v) > 150)) heard.set(label, heard.get(label)! + 1); } } catch {}
        })();
      });
      room.on(RoomEvent.DataReceived, (bytes, _p, _k, topic) => {
        if (topic === VOICE_DATA_TOPIC) signals.get(label)!.push(JSON.parse(new TextDecoder().decode(bytes)));
      });
      await room.connect(joined.url, joined.token, { autoSubscribe: true, dynacast: false });
      const source = new AudioSource(16_000, 1, 100); sources.push(source);
      const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack(`${label}-mic`, source), options);
      await source.captureFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
      return { room, call: joined.call.id };
    }
    const alex = await connect('Alex');
    await until(() => sttEvents.length >= 1, 10_000);
    const sam = await connect('Sam');
    await until(() => sttEvents.length >= 2, 10_000);
    const stt = { Alex: sttEvents[0]!, Sam: sttEvents[1]! };
    const turns = { Alex: 0, Sam: 0 };
    const words = (text: string, seconds: number) => text.split(' ').map((word, i, all) =>
      ({ word, start: i * seconds / all.length, end: (i + 1) * seconds / all.length, confidence: 0.95 }));
    const say = (who: 'Alex' | 'Sam', text: string, event: 'Update' | 'EndOfTurn' = 'EndOfTurn', seconds = 0.25 * text.split(' ').length) =>
      stt[who]({ event, transcript: text, turn_index: event === 'EndOfTurn' ? turns[who]++ : turns[who], sequence_id: Date.now(), words: words(text, seconds) } as FluxEvent);
    const answered = async (count: number) => { await until(() => answers.length >= count, 10_000); await wait(150); return answers.slice(count - 1).map(a => a.agent); };
    const unaddressed = (who: string) => signals.get(who)!.filter(s => s.type === 'unaddressed').length;
    console.log('Two humans joined one call through the join endpoint, over LiveKit RTC.');

    check('every panel learns that 2 humans are in the call', await until(() =>
      ['Alex', 'Sam'].every(who => signals.get(who)!.some(s => s.type === 'humans' && s.count === 2)), 10_000),
      JSON.stringify(Object.fromEntries([...signals].map(([who, list]) => [who, list.filter(s => s.type === 'humans')]))));

    say('Alex', 'What do you think?');
    await until(() => unaddressed('Alex') > 0, 10_000); await wait(500);
    check('Alex\'s unnamed speech gets no reply', answers.length === 0, `answers: ${answers.map(a => a.agent).join(',') || 'none'}`);
    check('only Alex\'s panel gets the tip highlight signal', unaddressed('Alex') === 1 && unaddressed('Sam') === 0, `Alex ${unaddressed('Alex')}, Sam ${unaddressed('Sam')}`);

    say('Sam', 'Gussie, are you there?');
    const gussie = await answered(1);
    check('Sam\'s "Gussie" reaches Goosy', gussie[0] === 'Goosy', `answered by ${gussie[0] ?? 'nobody'}`);
    say('Alex', 'hey Goosey what about you');
    const goosey = await answered(2);
    check('Alex\'s "hey Goosey" reaches Goosy', goosey[0] === 'Goosy', `answered by ${goosey[0] ?? 'nobody'}`);
    await until(() => playing === 0);

    await alex.room.localParticipant!.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: RUBY, tap: true })),
      { reliable: true, topic: VOICE_DATA_TOPIC });
    await wait(300);
    const before = answers.length;
    say('Sam', 'And then what happened?');
    await wait(1500);
    check('Alex\'s tap does not route Sam\'s unnamed speech', answers.length === before);
    say('Alex', 'And then what happened?');
    const tapped = await answered(before + 1);
    check('Alex\'s tap sends Alex\'s next unnamed turn to Ruby', tapped[0] === 'Ruby', `answered by ${tapped[0] ?? 'nobody'}`);
    await until(() => playing === 0);
    say('Alex', 'Anything else to add?');
    await wait(1500);
    check('the tap covers one turn only, then clears', answers.length === before + 1);

    const heardBefore = heard.get('Sam')!;
    const storyAt = answers.length;
    say('Alex', 'Ruby, tell me a long story');
    await answered(storyAt + 1);
    await until(() => heard.get('Sam')! > heardBefore + 5);
    const story = answers[storyAt]!;
    for (const [text, seconds] of [['mm hmm', 0.6], ['uh', 0.3], ['yeah okay', 0.5], ['wait', 0.25]] as const) {
      say('Sam', text, 'Update', seconds); await wait(120);
    }
    await wait(300);
    check('Sam\'s noise and backchannel words do not interrupt Ruby', !story.aborted() && playing > 0, `aborted=${story.aborted()} playing=${playing}`);
    await sam.room.localParticipant!.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: RUBY, tap: true })),
      { reliable: true, topic: VOICE_DATA_TOPIC });
    await wait(300);
    const tapAt = answers.length;
    say('Sam', 'uh', 'EndOfTurn', 0.2);
    await wait(1500);
    check('after Sam taps Ruby, Sam\'s completed "uh" turn does not interrupt or get a reply', !story.aborted() && answers.length === tapAt,
      `aborted=${story.aborted()} new answers=${answers.length - tapAt}`);
    const nameAt = answers.length;
    say('Sam', 'Ruby', 'EndOfTurn', 0.2);
    await wait(1500);
    check('Sam\'s short name-only "Ruby" turn does not interrupt Ruby', !story.aborted() && answers.length === nameAt,
      `aborted=${story.aborted()} new answers=${answers.length - nameAt}`);
    say('Sam', 'hold on everyone', 'Update');
    const stopped = await until(() => story.aborted(), 3000);
    check('Sam, who did not ask, interrupts Ruby with two real words', stopped);
    say('Sam', 'hold on everyone');
    await wait(300);

    await sam.room.disconnect();
    await request(`/v1/phone/voice/${sam.call}/leave`, tokens.Sam);
    check('Alex\'s panel learns Alex is the only human left', await until(() =>
      signals.get('Alex')!.some(s => s.type === 'humans' && s.count === 1), 12_000));
    const soloAt = answers.length;
    say('Alex', 'Keep going please');
    const solo = await answered(soloAt + 1);
    say('Alex', 'And one more thing');
    const solo2 = await answered(soloAt + 2);
    check('with one human, the locked agent answers every unnamed turn', solo[0] === 'Ruby' && solo2[0] === 'Ruby', `answered by ${[...solo, ...solo2].join(',') || 'nobody'}`);

    const latencies = signals.get('Alex')!.filter(s => s.type === 'latency').map(s => Math.round(s.firstAudioMs));
    console.log(`end of speech to first reply audio, Alex's answered turns (ms): ${latencies.join(', ')}`);
    if (process.env.PROOF_DEBUG) console.log(JSON.stringify(Object.fromEntries(signals)), sttEvents.length);
    await request(`/v1/phone/voice/${alex.call}/leave`, tokens.Alex);
  } finally {
    await Promise.allSettled(clients.map(room => room.disconnect()));
    await service.close(); await Promise.allSettled(sources.map(source => source.close()));
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
    dispose();
    console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
    process.exitCode = failures ? 1 : 0;
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
