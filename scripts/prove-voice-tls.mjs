/** Run inside the built server image. No Beeline Workspace or provider is used.
 * Without credentials, prove verified production WSS reaches a 401 response.
 * With a scoped test-room JWT file, publish a tone and receive Android mic frames.
 * Raw SDK logs can contain JWTs: keep stdout/stderr in an ignored private directory.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Room, RoomEvent, AudioSource, AudioStream, AudioFrame, LocalAudioTrack,
  TrackPublishOptions, TrackSource, TrackKind, dispose } from '@livekit/rtc-node';

const url = 'wss://beeline-voice-livekit.fly.dev';
const room = new Room();
let source;
let pumping;
let stopped = false;
try {
  if (!process.env.VOICE_TLS_CREDENTIALS) {
    await assert.rejects(room.connect(url, 'invalid-tls-proof-token'),
      /client error: 401 Unauthorized/, 'WSS must reach LiveKit authentication through verified TLS');
    console.log('PASS native Rust signaling verified production WSS and reached LiveKit authentication');
  } else {
    const credentials = JSON.parse(await readFile(process.env.VOICE_TLS_CREDENTIALS, 'utf8'));
    assert.equal(credentials.url, url);
    assert.match(credentials.room, /^beeline-tls-proof-/);
    let microphoneFrames = 0;
    let subscribed = false;
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity !== 'android-tls-proof' || track.kind !== TrackKind.KIND_AUDIO) return;
      subscribed = true;
      void (async () => {
        const reader = new AudioStream(track, 16_000, 1).getReader();
        try {
          while (!stopped) {
            const frame = await reader.read();
            if (frame.done) break;
            assert.equal(frame.value.sampleRate, 16_000);
            if (frame.value.samplesPerChannel > 0) microphoneFrames++;
          }
        } finally { await reader.cancel().catch(() => {}); }
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
    await room.connect(url, credentials['rust-tls-proof'], { autoSubscribe: true, dynacast: false });
    source = new AudioSource(24_000, 1, 100);
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    const publication = await room.localParticipant.publishTrack(
      LocalAudioTrack.createAudioTrack('verified-tls-tone', source), options);
    pumping = (async () => {
      let offset = 0;
      while (!stopped) {
        const samples = Int16Array.from({ length: 480 }, (_, i) =>
          Math.round(3000 * Math.sin(2 * Math.PI * 440 * (offset + i) / 24_000)));
        offset += 480;
        await source.captureFrame(new AudioFrame(samples, 24_000, 1, samples.length));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })();
    console.log('Native peer connected and published; waiting for Android microphone');
    const deadline = Date.now() + 300_000;
    while (microphoneFrames < 100 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(subscribed && microphoneFrames >= 100, 'Android must publish actual microphone media to production LiveKit');
    const result = { url, nativeConnected: true, nativeAudioPublished: Boolean(publication.sid),
      androidAudioSubscribed: subscribed, androidMicrophoneFramesReceived: microphoneFrames };
    if (process.env.VOICE_TLS_RESULT) await writeFile(process.env.VOICE_TLS_RESULT, JSON.stringify(result, null, 2) + '\n');
    console.log('PASS', JSON.stringify(result));
    // Allow the connecting/connected UI captures before the test peer leaves.
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
} finally {
  stopped = true;
  await pumping?.catch(error => { console.error(error.message); process.exitCode = 1; });
  await room.disconnect();
  await source?.close();
  await dispose();
}
