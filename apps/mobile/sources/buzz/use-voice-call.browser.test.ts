import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

it.skipIf(!existsSync(CHROME))('call-feedback-1: mic levels move the rendered composer waveform in Chrome', async () => {
  const mobile = process.cwd();
  const { result, status, stderr } = await runBrowserProof({ mobile, width: 480, height: 300,
    entry: path.join(mobile, 'scripts/call-feedback-proof.tsx'), budgetMs: 5000,
    shims: {
      ...webProofShims(mobile),
      '@/constants/Typography': 'export const Typography = { default: () => ({}) };',
      './client-error-report': 'export const errorDiagnostic = e => ({ message: String(e) }); export const reportClientError = async () => {};',
      '@/sync/transport/live-connection': 'export const sharedLiveConnection = () => ({ register: async () => () => {}, subscribeConnected: () => () => {} });',
      'livekit-client': `export const RoomEvent = { DataReceived: 'data', Disconnected: 'left', ActiveSpeakersChanged: 'levels', TrackSubscribed: 'track', TrackUnsubscribed: 'untrack' }; export const Track = { Kind: { Audio: 'audio' } };`,
      './voice-transport': `const listeners = new Map();
        const room = { on(event, listener) { listeners.set(event, listener); }, connect: async () => {}, disconnect: async () => {},
          remoteParticipants: new Map([['beeline-voice-proof-call', { audioLevel: 0 }]]),
          localParticipant: { audioLevel: 0, publishData: async () => {}, setMicrophoneEnabled: async () => {} } };
        globalThis.__callFeedback = { room, emit: (event, ...args) => listeners.get(event)?.(...args) };
        export const subscribeVoiceResume = () => () => {};
        export const voiceFetch = async () => new Response(JSON.stringify({ sessionId: 'proof-session',
          call: { id: 'proof-call', roomId: 'proof-room' }, url: 'wss://proof', token: 'proof', agents: [] }));
        export const createVoiceRoom = async () => ({ room, configureStop: async () => {}, closeAudio: async () => {},
          armSilence: async () => {}, cancelSilence: async () => {} });`,
      './runtime-config': 'export const getBuzzRuntimeConfig = () => ({ monolithUrl: "http://proof" });',
    },
  });
  console.log(result);
  expect(status, stderr).toBe(0);
  expect(result).toContain('RESULT PASS');
}, 90_000);
