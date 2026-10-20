import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))('R1: active call survives DNS failure without rendering a raw error', async () => {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({ mobile, width: 480, height: 300,
    entry: path.join(mobile, 'scripts/voice-resume-proof.tsx'), budgetMs: 5000,
    shims: {
      ...webProofShims(mobile),
      '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
      './client-error-report': 'export const errorDiagnostic = e => ({ message: String(e) }); export const reportClientError = async () => {};',
      "@/sync/transport/live-connection": 'export const sharedLiveConnection = () => ({ register: async () => () => {}, subscribeConnected: cb => { globalThis.__voiceResume.reconnect = cb; return () => {}; } });',
      'livekit-client': `export const RoomEvent = { DataReceived: 'data', Disconnected: 'left', ActiveSpeakersChanged: 'levels', TrackSubscribed: 'track', TrackUnsubscribed: 'untrack' }; export const Track = { Kind: { Audio: 'audio' } };`,
      './voice-transport': `const listeners = new Map();
        const fixture = globalThis.__voiceResume = { offline: false, ready: false, resumed: false, mic: false,
          emit: (event, ...args) => listeners.get(event)?.(...args) };
        const room = { on(event, listener) { listeners.set(event, listener); }, connect: async () => {}, disconnect: async () => {},
          canPlaybackAudio: true, startAudio: async () => {},
          remoteParticipants: new Map(), localParticipant: { audioLevel: 0, publishData: async () => {},
            setMicrophoneEnabled: async enabled => { fixture.mic = enabled; } } };
        export const subscribeVoiceResume = () => () => {};
        export const subscribeVoiceMicrophone = () => () => {};
        export const voiceFetch = async url => {
          if (url.includes('/state') && fixture.offline) throw new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "server.usebeeline.app": No address associated with hostname');
          return new Response(JSON.stringify(url.includes('/state') || url.endsWith('/idle')
            ? { state: fixture.ended ? 'ended' : 'ready' }
            : { sessionId: 'proof-session', call: { id: 'proof-call', roomId: 'proof-room', participants: [{ kind: 'human', identity: 'proof-viewer' }] }, url: 'wss://proof', token: 'proof', agents: [] }));
        };
        export const createVoiceRoom = async (_stop, _roomId, idle) => {
          fixture.idle = idle;
          return { room, configureStop: async () => {}, closeAudio: async () => {}, parkAudio: async () => {},
            resumeAudio: async () => { fixture.resumed = true; }, armSilence: async () => {}, cancelSilence: async () => {} };
        };`,
      './runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "http://proof" });',
    },
  });
  console.log(result);
  expect(status, stderr).toBe(0);
  expect(result).toContain('RESULT PASS');
}, 90_000);
