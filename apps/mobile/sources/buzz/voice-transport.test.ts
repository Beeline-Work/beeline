const socketRequest = vi.hoisted(() => vi.fn(async () => ({ ended: true })));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ request: socketRequest }) }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
import { expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  volumeListener: undefined as ((event: { id: string; volume: number }) => void) | undefined,
  removeVolumeListener: vi.fn(),
  meter: { createVolumeProcessor: vi.fn(() => 'meter-1'), deleteVolumeProcessor: vi.fn() }, roomFailure: null as Error | null, registerGlobals: vi.fn(),
  roomOptions: undefined as any,
  link: undefined as ((event: {url: string}) => void) | undefined,
  response: undefined as ((event: any) => void) | undefined,
  openURL: vi.fn(async () => {}),
  background: { configureStop: vi.fn(async () => {}), armSilence: vi.fn(async () => {}), cancelSilence: vi.fn(async () => {}), setActivity: vi.fn(async () => {}), endForIdle: vi.fn(async () => {}), start: vi.fn(async () => 1), stop: vi.fn(async () => {}),
    addListener: vi.fn((_event: string, _listener: (event: { generation: number }) => void) => ({ remove: vi.fn() })) },
  AudioSession: { startAudioSession: vi.fn(async () => {}), stopAudioSession: vi.fn(async () => {}) } }));
vi.mock('@livekit/react-native', () => native);
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (listener: (event: any) => void) => { native.response = listener; return { remove: vi.fn() }; },
  getLastNotificationResponseAsync: async () => null,
}));
vi.mock('react-native', () => ({
  NativeModules: { LivekitReactNativeModule: native.meter },
  NativeEventEmitter: class { addListener(_name: string, listener: typeof native.volumeListener) { native.volumeListener = listener; return { remove: native.removeVolumeListener }; } },
  Linking: {
  addEventListener: (_type: string, listener: (event: {url: string}) => void) => { native.link = listener; return { remove: vi.fn() }; },
  getInitialURL: async () => null, openURL: native.openURL,
}, Platform: { OS: 'android' }, PermissionsAndroid: {
  PERMISSIONS: { RECORD_AUDIO: 'microphone' }, RESULTS: { GRANTED: 'granted' }, request: vi.fn(async () => 'granted'),
} }));
vi.mock('expo-modules-core', () => ({
  EventEmitter: { prototype: { addListener: native.background.addListener } },
  requireNativeModule: () => native.background,
  requireOptionalNativeModule: () => native.background,
}));
vi.mock('livekit-client', () => ({
  RoomEvent: { LocalTrackPublished: 'published', LocalTrackUnpublished: 'unpublished', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed', ParticipantDisconnected: 'disconnected', TrackMuted: 'muted', TrackUnmuted: 'unmuted' },
  Room: class { constructor(options: unknown) { native.roomOptions = options; if (native.roomFailure) throw native.roomFailure; } async startAudio() {} } }));
import * as nativeTransport from './voice-transport.native';
import { createVoiceRoom, subscribeVoiceResume, routeVoiceResumeNotification } from './voice-transport.native';

it('implements the complete shared voice transport contract on native', () => {
  const contract: typeof import('./voice-transport') = nativeTransport;
  expect(contract.subscribeVoiceMicrophone).toBeTypeOf('function');
});

it('starts native audio only when voice mode opens and exposes cleanup for leave/unmount', async () => {
  expect(native.AudioSession.startAudioSession).not.toHaveBeenCalled();
  const transport = await createVoiceRoom();
  expect(native.registerGlobals).toHaveBeenCalledOnce();
  expect(native.AudioSession.startAudioSession).toHaveBeenCalledOnce();
  await transport.closeAudio();
  await transport.closeAudio();
  expect(native.AudioSession.stopAudioSession).toHaveBeenCalledOnce();
  expect(native.background.stop).toHaveBeenCalledOnce();
  expect(native.background.start.mock.invocationCallOrder[0]).toBeLessThan(native.AudioSession.startAudioSession.mock.invocationCallOrder[0]);
  expect(native.roomOptions.reconnectPolicy.nextRetryDelayInMs({ retryCount: 0 })).toBeNull();
});

it('releases native audio if creating the Room fails before the join request', async () => {
  native.roomFailure = new Error('Room initialization failed');
  native.AudioSession.stopAudioSession.mockClear();
  try {
    await expect(createVoiceRoom()).rejects.toThrow('Room initialization failed');
    expect(native.AudioSession.stopAudioSession).toHaveBeenCalledOnce();
  } finally { native.roomFailure = null; }
});


it('retains a cold iOS restart across navigation and consumes it once in the matching Room', async () => {
  native.openURL.mockClear();
  const url = 'beeline:///beeline/chat/room-a?voiceResume=cold-notification-1';
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const routing = routeVoiceResumeNotification(url, () => ready);
  expect(native.openURL).not.toHaveBeenCalled();
  release();
  expect(await routing).toBe(true);
  expect(native.openURL).toHaveBeenCalledWith(url);
  const resume = vi.fn();
  let stop!: () => void;
  await new Promise<void>(resolve => {
    stop = subscribeVoiceResume('room-a', () => { resume(); resolve(); });
  });
  expect(resume).toHaveBeenCalledOnce();
  native.link!({ url });
  expect(resume).toHaveBeenCalledOnce();
  await routeVoiceResumeNotification(url);
  expect(native.openURL).toHaveBeenCalledOnce();
  expect(await routeVoiceResumeNotification('https://example.com/beeline/chat/room-a?voiceResume=bad')).toBe(false);
  expect(await routeVoiceResumeNotification('beeline://foreign/beeline/chat/room-a?voiceResume=bad')).toBe(false);
  stop();
});


it('keeps audio live without a per-person idle event or deadline', async () => {
  vi.useFakeTimers(); native.background.addListener.mockClear();
  try {
    const transport = await createVoiceRoom(() => {}, 'room');
    expect(native.background.addListener.mock.calls.map(([event]) => event)).toEqual(['stopRequested']);
    expect(vi.getTimerCount()).toBe(0);
    await transport.closeAudio();
  } finally { vi.useRealTimers(); }
});

it('configures native Stop for the current session and drops late configuration after close', async () => {
  native.background.configureStop.mockClear();
  const transport = await createVoiceRoom();
  await transport.configureStop('call', 'session-capability');
  expect(native.background.configureStop).toHaveBeenCalledWith('http://proof/v1/phone/voice/call/native-stop', 'session-capability', 1);
  await transport.closeAudio();
  await transport.configureStop('successor', 'stale-capability');
  expect(native.background.configureStop).toHaveBeenCalledOnce();
});


it('disables timed SDK reconnects in the browser adapter too', async () => {
  const { createVoiceRoom: createBrowserVoiceRoom } = await import('./voice-transport');
  await createBrowserVoiceRoom();
  for (const retryCount of [0, 1, 1000])
    expect(native.roomOptions.reconnectPolicy.nextRetryDelayInMs({ retryCount })).toBeNull();
});


it('starts the native microphone meter through the adapter used by conversation join', async () => {
  const track = { isMuted: false, mediaStreamTrack: { id: 'microphone', _peerConnectionId: 3 } };
  const room = { localParticipant: { audioTrackPublications: new Map([['mic', { track }]]) },
    remoteParticipants: new Map(), on: vi.fn(), off: vi.fn() };
  const level = vi.fn();
  const stop = nativeTransport.subscribeVoiceMicrophone(room as any, level);
  expect(native.meter.createVolumeProcessor).toHaveBeenCalledWith(3, 'microphone');
  native.volumeListener!({ id: 'meter-1', volume: 0.7 });
  expect(level).toHaveBeenLastCalledWith(0.7);
  stop();
  expect(native.meter.deleteVolumeProcessor).toHaveBeenCalledWith('meter-1', 3, 'microphone');
  expect(native.removeVolumeListener).toHaveBeenCalledOnce();
});
