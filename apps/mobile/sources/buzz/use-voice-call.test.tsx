import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ room: undefined as any,
  request: vi.fn(), report: vi.fn(), meter: { createVolumeProcessor: vi.fn(() => 'microphone-meter'), deleteVolumeProcessor: vi.fn() },
  closeNative: vi.fn(async () => {}), stopAudio: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' }, AppState: { addEventListener: () => ({ remove() {} }) },
  PermissionsAndroid: { request: async () => 'granted', PERMISSIONS: { RECORD_AUDIO: 'mic' }, RESULTS: { GRANTED: 'granted' } },
  NativeModules: { LivekitReactNativeModule: fixture.meter },
  NativeEventEmitter: class { addListener() { return { remove() {} }; } },
  Linking: { addEventListener: () => ({ remove() {} }), getInitialURL: async () => null },
}));
vi.mock('expo-modules-core', () => {
  const background = { start: async () => 1, stop: fixture.closeNative, configureStop: async () => {}, addListener: () => ({ remove() {} }) };
  return { requireNativeModule: () => background, requireOptionalNativeModule: () => background, EventEmitter: class {} };
});
vi.mock('@livekit/react-native', () => ({ registerGlobals() {}, AudioSession: { startAudioSession: async () => {}, stopAudioSession: fixture.stopAudio } }));
vi.mock('livekit-client', () => ({
  RoomEvent: new Proxy({}, { get: (_target, name) => name }), Track: { Kind: { Audio: 'audio' } },
  Room: class {
    canPlaybackAudio = true;
    remoteParticipants = new Map();
    localParticipant = { audioTrackPublications: new Map(), publishData: vi.fn(async () => {}),
      setMicrophoneEnabled: vi.fn(async () => {
        this.localParticipant.audioTrackPublications.set('mic', { track: { isMuted: false, mediaStreamTrack: { id: 'mic', _peerConnectionId: 1 } } });
        this.listeners.get('LocalTrackPublished')?.forEach(listener => listener());
      }) };
    listeners = new Map<string, Function[]>();
    constructor() { fixture.room = this; }
    on(event: string, listener: Function) { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
    off(event: string, listener: Function) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== listener)); }
    async connect() {} async startAudio() {} async disconnect() {}
  },
}));
// Select the same platform adapter Metro selects on Android, without mocking its exports.
vi.mock('./voice-transport', async () => import('./voice-transport.native'));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
vi.mock('./client-error-report', () => ({ reportClientError: fixture.report }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ request: fixture.request,
  register: async () => () => {}, subscribeConnected: () => () => {} }) }));
import { useVoiceCall } from './use-voice-call';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('starts conversation mode with the real native adapter, publishes its mic, and leaves cleanly', async () => {
  const call = { id: 'call', roomId: 'room', startedAt: 1, participants: [{ pubkey: 'human', kind: 'human', name: 'Human' }] };
  fixture.request.mockImplementation(async (op: string) => op === 'voiceJoin'
    ? { call, sessionId: 'session', stopToken: 'stop', url: 'ws://rtc', token: 'rtc', agents: [] }
    : { left: true });
  let voice!: ReturnType<typeof useVoiceCall>;
  function Probe() { voice = useVoiceCall('room', true); return null; }
  let tree: any;
  await act(async () => { tree = create(<Probe />); });
  try {
    await act(async () => { await voice.join(); });
    expect(voice.error).toBeNull();
    expect(voice.call?.id).toBe(call.id);
    expect(voice.connecting).toBe(false);
    expect(fixture.room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.any(Object));
    expect(fixture.meter.createVolumeProcessor).toHaveBeenCalledWith(1, 'mic');
    expect(fixture.report).not.toHaveBeenCalled();
    await act(async () => { await voice.end(); });
    expect(fixture.request).toHaveBeenCalledWith('voiceLeave', { callId: 'call', sessionId: 'session' }, expect.any(Object));
    expect(fixture.meter.deleteVolumeProcessor).toHaveBeenCalledWith('microphone-meter', 1, 'mic');
    expect(fixture.closeNative).toHaveBeenCalledOnce();
  } finally { await act(async () => tree.unmount()); }
});
