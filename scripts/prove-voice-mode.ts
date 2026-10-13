/** Isolated local Beeline + actual LiveKit RTC + provider speech + command grammar.
 * Flux may be replaced with the documented EndOfTurn seam while its credential is pending.
 * No helper service, production Workspace, or emulator is touched.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { AuraSpeech, DeepInfraKokoroSpeech, FishSpeech, OpenRouterVoiceBrain, fluxFactory, type FluxEvent, type VoiceSpeech } from '../apps/server/src/voice-providers.js';
import { type VoiceJoin, VOICE_DATA_TOPIC } from '@beeline/api-contract/phone';

const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64);
const W = randomUUID(), R = randomUUID();
const output = `.voice-proof/${process.env.VOICE_PROOF_LABEL?.replace(/[^a-z0-9-]/gi, '') ?? 'local'}`;

async function main() {
  const key = process.env.BEELINE_VOICE_OPENROUTER_API_KEY;
  assert.ok(key, 'BEELINE_VOICE_OPENROUTER_API_KEY required; never write or log it');
  await mkdir(output, { recursive: true });
  const db = new PgliteDatabase(); const live = new LiveHub();
  const brain = new OpenRouterVoiceBrain(key);
  const cloudflareToken = process.env.CLOUDFLARE_WORKERS_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const speech: VoiceSpeech = process.env.BEELINE_VOICE_TTS_PROVIDER === 'fish-s2.1-pro'
    ? new FishSpeech(process.env.FISH_AUDIO_API_KEY!) : process.env.BEELINE_VOICE_TTS_PROVIDER === 'kokoro-deepinfra'
      ? new DeepInfraKokoroSpeech(key) : new AuraSpeech(cloudflareToken!, process.env.CLOUDFLARE_ACCOUNT_ID!);
  await speech.prepare?.();
  const humanSpeech = new AuraSpeech(cloudflareToken!, process.env.CLOUDFLARE_ACCOUNT_ID!);
  const sttEvents: Array<(event: FluxEvent) => void> = [];
  const useFlux = process.env.VOICE_PROOF_LIVE_FLUX === '1';
  const service = new VoiceService(db, live, {
    url: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:17880',
    apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey', apiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret', brain, speech,
    stt: useFlux ? fluxFactory(cloudflareToken!, process.env.CLOUDFLARE_ACCOUNT_ID!) : async onEvent => {
      sttEvents.push(onEvent); return { send() {}, close() {} };
    },
  });
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  const phone = new PhoneService(db, 'http://proof'); const daemon = new DaemonService(db, live);
  const server = createBeelineServer({ database: db, auth, phone, daemon, live, voice: service,
    mediaMaximumBytes: 1024 * 1024, webAppOrigins: ['http://127.0.0.1:18090'] });
  const clients: Room[] = []; const sources: AudioSource[] = [];
  const received = new Map<string, number>();
  const firstReceived = new Map<string, number>();
  const latencies: number[] = [];
  const speakers = new Map<string, string | null>();
  let waitTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),
      ($3,'agent','Ruby','ruby'),($4,'agent','Sol','sol')`, [H, SECOND, A, B]);
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
      VALUES('github','alex',$1,'https://github.com','beeline','alex'),('github','sam',$2,'https://github.com','beeline','sam')`, [H, SECOND]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$3,'{"instructions":"I am Ruby, warm and concise. Voice: af_heart"}'),
      ($2,$3,'{"instructions":"I am Sol, direct and calm. Voice: bm_george"}')`, [A, B, H]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated voice proof')`, [W]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Voice proof')`, [R, W]);
    for (const who of [H, SECOND, A, B]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [W, who, R]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const firstCredentials = await auth.exchangeGitHubOidc('alex');
    const secondCredentials = await auth.exchangeGitHubOidc('sam');
    let firstToken = firstCredentials.accessToken;
    let secondToken = secondCredentials.accessToken;
    const agentToken = (await auth.exchangeDaemonToken((await auth.createDaemonExchange(A)).exchangeToken))!.daemonToken;
    async function request(path: string, token = firstToken, input?: unknown) {
      const response = await fetch(`${origin}${path}`, { method: input === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
    }
    async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 45_000) {
      const start = Date.now(); while (!(await check())) {
        assert.ok(Date.now() - start < timeout, `Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    async function connect(joined: VoiceJoin, label: string) {
      const room = new Room(); clients.push(room); received.set(label, 0);
      room.on(RoomEvent.TrackSubscribed, track => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        void (async () => {
          const reader = new AudioStream(track, 24_000, 1).getReader();
          try { while (true) { const frame = await reader.read(); if (frame.done) break;
            if (frame.value.data.some(v => Math.abs(v) > 150)) {
              received.set(label, (received.get(label) ?? 0) + 1);
              if (!firstReceived.has(label)) firstReceived.set(label, performance.now());
            }
          } } catch {}
        })();
      });
      room.on(RoomEvent.DataReceived, (bytes, _participant, _kind, topic) => {
        if (topic === VOICE_DATA_TOPIC) { const data = JSON.parse(new TextDecoder().decode(bytes));
          if (data.type === 'latency' && label === 'Alex') latencies.push(data.firstAudioMs);
          if (data.type === 'speaker') speakers.set(label, data.agentId);
          if (data.type === 'error') console.log('Voice runtime:', data.message);
        }
      });
      await room.connect(joined.url, joined.token, { autoSubscribe: true, dynacast: false });
      const source = new AudioSource(16_000, 1, 100); sources.push(source);
      const opts = new TrackPublishOptions(); opts.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('proof-human-mic', source), opts);
      // Silence is real RTC media; an injected Flux EndOfTurn bypasses STT only.
      await source.captureFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
      return room;
    }
    const first = await request(`/v1/phone/voice/${R}/join`, firstToken, {}) as VoiceJoin;
    await connect(first, 'Alex');
    const second = await request(`/v1/phone/voice/${R}/join`, secondToken, {}) as VoiceJoin;
    assert.equal(second.call.id, first.call.id); assert.equal(second.call.participants.length, 2);
    const secondRtc = await connect(second, 'Sam');
    await until(() => sttEvents.length >= 2 || useFlux, 'human microphone subscriptions');
    console.log('PASS two authenticated humans joined one Room call through the join endpoint');
    const agents = await service.agents(R, H);
    assert.notEqual(agents[0]!.voice, agents[1]!.voice);
    async function utter(text: string, who: number, turn: number) {
      if (!useFlux) {
        sttEvents[who]!({ event: 'EndOfTurn', transcript: text, turn_index: turn, sequence_id: turn + 1 }); return;
      }
      // Synthesize a human fixture, resample 24kHz to the microphone's 16kHz,
      // and publish it as actual RTC media. Flux alone decides EndOfTurn.
      const chunks: Buffer[] = [];
      for await (const bytes of humanSpeech.synthesize(text, 'luna', new AbortController().signal)) chunks.push(Buffer.from(bytes));
      const input = Buffer.concat(chunks); const count = Math.floor(input.length / 2 / 1.5);
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        const position = i * 1.5; const lower = Math.floor(position); const mix = position - lower;
        const a = input.readInt16LE(lower * 2), b = input.readInt16LE(Math.min(lower + 1, input.length / 2 - 1) * 2);
        pcm[i] = Math.round(a * (1 - mix) + b * mix);
      }
      for (let offset = 0; offset < pcm.length; offset += 320) {
        const frame = new Int16Array(320); frame.set(pcm.subarray(offset, offset + 320));
        await sources[who]!.captureFrame(new AudioFrame(frame, 16_000, 1, 320));
      }
      await sources[who]!.waitForPlayout();
      for (let i = 0; i < 100; i++) await sources[who]!.captureFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
    }
    if (process.env.VOICE_PROOF_COMPARE === '1') {
      for (let turn = 0; turn < 3; turn++) {
        const prior = latencies.length;
        await utter('Ruby, say hello in one short sentence.', 0, turn);
        await until(() => latencies.length > prior, `latency sample ${turn + 1}`, 60_000);
        await until(() => speakers.get('Alex') === null, 'speech finished', 30_000);
        console.log(`Sample ${turn + 1}: ${Math.round(latencies.at(-1)!)} ms from Flux EndOfTurn to first voiced RTC frame`);
      }
    } else {
      await utter('Ruby, hello. Please say a short greeting.', 0, 0);
      await until(() => (received.get('Alex') ?? 0) > 5 && (received.get('Sam') ?? 0) > 5, 'Ruby audible on both human RTC clients', 60_000);
      console.log(`PASS ${useFlux ? 'live Flux -> ' : ''}Luna answer streamed in Ruby’s distinct voice over actual LiveKit audio to both humans`);
      const before = received.get('Sam')!;
      await secondRtc.localParticipant!.publishData(new TextEncoder().encode(JSON.stringify({ type: 'target', agentId: B })),
        { reliable: true, topic: VOICE_DATA_TOPIC });
      await utter('Sol, hello. Please say a short greeting.', 1, 0);
      await until(() => (received.get('Sam') ?? 0) > before + 20, 'Sol audible', 60_000);
      const conversationOrders = await db.query<{ text: string }>(`SELECT m.text FROM agent_commands c JOIN messages m ON m.id=c.source_message_id`);
      assert.equal(conversationOrders.rowCount, 0, `Conversation must not dispatch workers: ${JSON.stringify(conversationOrders.rows)}`);
      console.log('PASS conversational speech wakes no real worker; naming Sol changes the speaker and voice');
      await utter('Ruby, create a file named greeting.txt containing a friendly two-word greeting. Use your real agent to do this task.', 0, 1);
      await until(async () => Boolean((await db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [A])).rowCount), 'real work order', 60_000);
      const command = (await db.query<{ id: string; turn_request_id: string }>(`SELECT id,turn_request_id FROM agent_commands WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 1`, [A])).rows[0]!;
      await request('/v1/daemon/operations/claimAgentCommand', agentToken, { roomId: R, commandId: command.id, generationId: 'isolated-voice-proof' });
      // Temporary proof worker performs actual file work, then reports through the existing authenticated command grammar.
      const work = await brain.answer(agents.find(a => a.id === A)!, [{ role: 'user', content: 'Give me a friendly two-word greeting. Just the greeting.' }], () => {}, new AbortController().signal);
      await writeFile(`${output}/greeting.txt`, work.text);
      const beforeReport = received.get('Alex')!;
      await request('/v1/daemon/operations/report', agentToken, { roomId: R, requestId: command.turn_request_id,
        generationId: 'isolated-voice-proof', text: `done: I created greeting.txt containing ${work.text}` });
      await until(async () => Boolean((await db.query(`SELECT 1 FROM voice_orders WHERE spoken_message_id IS NOT NULL`)).rowCount), 'report matched by command provenance');
      await until(() => (received.get('Alex') ?? 0) > beforeReport + 20, 'real work report spoken', 60_000);
      console.log('PASS temporary worker claimed the real command, created a real file, and its report was spoken in Ruby’s voice');
    }
    // A browser can mount the actual composer/hook and use these local-only proof tokens.
    await writeFile(`${output}/session.json`, JSON.stringify({ origin, roomId: R, firstToken, secondToken }));
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    await writeFile(`${output}/result.json`, JSON.stringify({ stt: useFlux ? 'live Flux' : 'Flux EndOfTurn seam',
      provider: process.env.BEELINE_VOICE_TTS_PROVIDER ?? 'kokoro-deepinfra',
      calls: 1, humans: 2, distinctVoices: agents.map(a => ({ name: a.name, voice: a.voice })),
      firstAudioServerMs: latencies, p50FirstAudioServerMs: sortedLatencies[Math.floor(sortedLatencies.length / 2)],
      receivedAudioFrames: Object.fromEntries(received) }, null, 2));
    console.log('Proof server', origin, 'Room', R);
    if (process.env.VOICE_PROOF_HOLD === '1') {
      console.log('Holding isolated server for UI/phone proof; interrupt this process to clean up');
      waitTimer = setInterval(() => { void (async () => {
        firstToken = (await auth.refresh(firstCredentials.refreshToken))!.accessToken;
        secondToken = (await auth.refresh(secondCredentials.refreshToken))!.accessToken;
        await writeFile(`${output}/session.json`, JSON.stringify({ origin, roomId: R, firstToken, secondToken }));
      })().catch(() => {}); }, 60_000);
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    }
    await request(`/v1/phone/voice/${first.call.id}/leave`, firstToken, {});
    await request(`/v1/phone/voice/${first.call.id}/leave`, secondToken, {});
    console.log('PASS last participant left; call ended and the normal composer can return');
  } finally {
    clearInterval(waitTimer);
    await Promise.allSettled(clients.map(room => room.disconnect()));
    await service.close(); await Promise.allSettled(sources.map(source => source.close()));
    await new Promise<void>(resolve => server.close(() => resolve())); await db.close();
    dispose();
    console.log('Isolated Workspace/agents cleaned up');
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Voice proof failed'); process.exitCode = 1; });
