/** Actual Flux, Aura 2, Luna and RTC in a disposable Workspace.
 * The second human joins from the release emulator fixture through the call card.
 * Private session credentials stay in the ignored proof directory.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, dispose } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { AuraSpeech, OpenRouterVoiceBrain, fluxFactory, type VoiceBrain, type VoiceSpeech } from '../apps/server/src/voice-providers.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

const output = '.voice-proof/multiparty';
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64);
const W = randomUUID(), R = randomUUID();
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 60_000) {
  const start = Date.now();
  while (!(await check())) {
    assert.ok(Date.now() - start < timeout, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function main() {
  const key = process.env.BEELINE_VOICE_OPENROUTER_API_KEY ?? process.env.OPENROUTER_EMBEDDING_API_KEY;
  const cf = process.env.CLOUDFLARE_WORKERS_AI_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  assert.ok(key && cf && process.env.CLOUDFLARE_ACCOUNT_ID, 'Voice provider credentials required');
  await mkdir(output, { recursive: true });
  const db = new PgliteDatabase(), live = new LiveHub();
  const aura = new AuraSpeech(cf, process.env.CLOUDFLARE_ACCOUNT_ID);
  const luna = new OpenRouterVoiceBrain(key);
  const answers: { agent: string; text: string }[] = [], synthesis: string[] = [], finals: string[] = [];
  const observations: { connected?: boolean; speaker?: string; audibleFrames?: number; error?: string }[] = [];
  let activeAnswers = 0, maximumActiveAnswers = 0, pcmBytes = 0, receivedFrames = 0, speaker: string | null = null;
  const speech: VoiceSpeech = { voices: aura.voices, async *synthesize(text, voice, signal) {
    synthesis.push(text);
    for await (const bytes of aura.synthesize(text, voice, signal)) { pcmBytes += bytes.length; yield bytes; }
  } };
  const brain: VoiceBrain = { async answer(agent, history, onText, signal) {
    activeAnswers++; maximumActiveAnswers = Math.max(maximumActiveAnswers, activeAnswers);
    try {
      const reply = await luna.answer(agent, history, onText, signal);
      answers.push({ agent: agent.name, text: reply.text }); return reply;
    } finally { activeAnswers--; }
  } };
  const service = new VoiceService(db, live, {
    url: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:17880', apiKey: 'devkey', apiSecret: 'secret', brain, speech,
    providers: { 'aura-2': speech },
    stt: async (onEvent, onError, hints) => fluxFactory(cf, process.env.CLOUDFLARE_ACCOUNT_ID!)(event => {
      if (event.event === 'EndOfTurn') { finals.push(event.transcript); console.log('Flux final:', event.transcript); }
      onEvent(event);
    }, onError, hints),
  });
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  const server = createBeelineServer({ database: db, auth, phone: new PhoneService(db, 'http://proof'),
    daemon: new DaemonService(db, live), live, voice: service, mediaMaximumBytes: 1024 * 1024 });
  const ordinary = server.listeners('request')[0]!;
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    if (request.url === '/__voice-session') {
      void readFile(`${output}/session.json`).then(bytes => { response.setHeader('content-type', 'application/json'); response.end(bytes); }, () => { response.statusCode = 503; response.end('{}'); });
      return;
    }
    if (request.url !== '/__voice-proof') { ordinary.call(server, request, response); return; }
    let body = '';
    request.on('data', chunk => { if (body.length < 4096) body += String(chunk); });
    request.on('end', () => { try { observations.push(JSON.parse(body)); } catch {} response.end('{}'); });
  });
  const client = new Room(), source = new AudioSource(16_000, 1, 100);
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),
      ($3,'agent','Ruby','ruby'),($4,'agent','Goosey','goose')`, [H, SECOND, A, B]);
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
      VALUES('github','alex',$1,'https://github.com','beeline','alex'),('github','sam',$2,'https://github.com','beeline','sam')`, [H, SECOND]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$3,'{}'),($2,$3,'{}')`, [A, B, H]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Disposable multiparty voice proof')`, [W]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice proof')`, [R, W]);
    for (const who of [H, SECOND, A, B]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [W, who, R]);
    const firstCredentials = await auth.exchangeGitHubOidc('alex'), secondCredentials = await auth.exchangeGitHubOidc('sam');
    await new Promise<void>(resolve => server.listen(18096, '127.0.0.1', resolve));
    const first = await service.join(R, H);
    client.on(RoomEvent.DataReceived, (bytes, _participant, _kind, topic) => {
      if (topic !== VOICE_DATA_TOPIC) return;
      const signal = JSON.parse(new TextDecoder().decode(bytes));
      if (signal.type === 'speaker') speaker = signal.agentId;
      if (signal.type === 'error') console.log('Voice runtime:', signal.message);
    });
    client.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        const reader = new AudioStream(track, 24_000, 1).getReader();
        try { while (true) { const frame = await reader.read(); if (frame.done) break;
          if (frame.value.data.some(sample => Math.abs(sample) > 150)) receivedFrames++;
        } } catch {}
      })();
    });
    await client.connect(first.url, first.token);
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await client.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('proof-human-mic', source), options);
    // Local only credentials for the release fixture's second human, never committed.
    await writeFile(`${output}/session.json`, JSON.stringify({ origin: 'http://10.0.2.2:18096', roomId: R,
      token: secondCredentials.accessToken, firstToken: firstCredentials.accessToken, call: first.call,
      agents: (await service.agents(R, H)).map(a => ({ pubkey: a.id, name: a.name, kind: 'agent', face: a.face })) }), { mode: 0o600 });
    console.log('READY isolated first human joined; waiting for second-human release call-card Join');
    await until(() => service.humanCount(first.call.id).then(count => count === 2), 'release emulator Join', 1_800_000);
    await until(() => observations.some(o => o.connected), 'release VoiceBar connected', 60_000);
    await until(async () => { try { await access(`${output}/run`); return true; } catch { return false; } }, 'proof run marker', 600_000);
    async function utter(text: string) {
      const prior = finals.length, chunks: Buffer[] = [];
      for await (const bytes of aura.synthesize(text, 'apollo', AbortSignal.timeout(20_000))) chunks.push(Buffer.from(bytes));
      const input = Buffer.concat(chunks), count = Math.floor(input.length / 3), pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        const position = i * 1.5, lower = Math.floor(position), mix = position - lower;
        pcm[i] = Math.round(input.readInt16LE(lower * 2) * (1 - mix) + input.readInt16LE(Math.min(lower + 1, input.length / 2 - 1) * 2) * mix);
      }
      for (let offset = 0; offset < pcm.length; offset += 320) {
        const frame = new Int16Array(320); frame.set(pcm.subarray(offset, offset + 320));
        await source.captureFrame(new AudioFrame(frame, 16_000, 1, 320));
      }
      for (let i = 0; i < 100; i++) await source.captureFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
      await source.waitForPlayout(); await until(() => finals.length > prior, 'live Flux final');
    }
    // Repeated joins and reconciliation must keep the same runtime and brain stream.
    await Promise.all([service.join(R, H), service.join(R, SECOND), service.recover(), service.recover()]);
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    for (const [agent, prompt] of [
      ['Ruby', 'Ruby, please tell me about lunch in exactly two short sentences'],
      ['Goosey', 'Please tell me about lunch in exactly two short sentences, Goosey'],
    ]) {
      const before = answers.length, beforeSpeech = synthesis.length;
      await utter(prompt!);
      await until(() => answers.length === before + 1 && speaker === null, `${agent} full reply`);
      assert.equal(answers.at(-1)!.agent, agent);
      assert.equal(normalize(synthesis.slice(beforeSpeech).join(' ')), normalize(answers.at(-1)!.text));
      assert.ok(answers.at(-1)!.text.split(/[.!?]/).filter(s => s.trim()).length >= 2, `full multi-sentence answer: ${answers.at(-1)!.text}`);
      console.log(`PASS named ${agent}: one complete multi-sentence reply`);
    }
    const before = answers.length, spokenBefore = synthesis.length;
    await utter('How are you doing today?');
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(answers.length, before); assert.equal(synthesis.length, spokenBefore);
    assert.equal(maximumActiveAnswers, 1);
    assert.ok(receivedFrames > 20);
    assert.ok(observations.some(o => (o.audibleFrames ?? 0) > 0), 'release Android received speaking audio');
    const connectedAt = observations.findIndex(o => o.connected);
    assert.ok(!observations.slice(connectedAt).some(o => o.error), 'no error after successful release Join');
    const transcriptReplies = (await db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND author_id=ANY($2::text[]) AND presentation='message'`, [R, [A, B]])).rowCount;
    assert.equal(transcriptReplies, 2, 'one durable agent reply per named utterance');
    await writeFile(`${output}/result.json`, JSON.stringify({ stt: 'live Flux', provider: 'aura-2', humans: 2,
      agents: ['Ruby', 'Goosey'], answers, synthesis, unnamedSpeechSilent: true, maximumActiveAnswers,
      pcmBytes, receivedFrames, transcriptReplies, android: observations.filter(o => o.connected).at(-1), fullReplies: true }, null, 2));
    console.log('PASS unnamed speech silent with two humans; one stream per utterance; actual RTC audio on both humans');
    if (process.env.VOICE_PROOF_HOLD === '1') {
      console.log('Holding isolated proof for screenshots; send SIGINT for cleanup');
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    }
    await service.leave(first.call.id, SECOND); await service.leave(first.call.id, H);
  } finally {
    await client.disconnect(); await service.close(); await source.close();
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); dispose();
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Voice proof failed'); process.exitCode = 1; });
