vi.mock('@/auth/monolith-session', () => ({ monolithSession: { fetch: vi.fn(async (input: string, init: unknown, options: any) => options.fetchImpl(input, init)) } }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://proof' }) }));
vi.mock('expo/fetch', () => ({ fetch: async () => new Response('locked response') }));
import { expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ roomFailure: null as Error | null, registerGlobals: vi.fn(),
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
vi.mock('react-native', () => ({ Linking: {
  addEventListener: (_type: string, listener: (event: {url: string}) => void) => { native.link = listener; return { remove: vi.fn() }; },
  getInitialURL: async () => null, openURL: native.openURL,
}, Platform: { OS: 'android' }, PermissionsAndroid: {
  PERMISSIONS: { RECORD_AUDIO: 'microphone' }, RESULTS: { GRANTED: 'granted' }, request: vi.fn(async () => 'granted'),
} }));
vi.mock('expo-modules-core', () => ({ requireNativeModule: () => native.background }));
vi.mock('livekit-client', () => ({ Room: class { constructor(options: unknown) { native.roomOptions = options; if (native.roomFailure) throw native.roomFailure; } } }));
import { createVoiceRoom, subscribeVoiceResume, routeVoiceResumeNotification } from './voice-transport.native';

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
  expect(native.roomOptions.reconnectPolicy.nextRetryDelayInMs({ retryCount: 1000 })).toBe(5000);
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
  const stop = subscribeVoiceResume('room-a', resume);
  await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
  native.link!({ url });
  expect(resume).toHaveBeenCalledOnce();
  await routeVoiceResumeNotification(url);
  expect(native.openURL).toHaveBeenCalledOnce();
  expect(await routeVoiceResumeNotification('https://example.com/beeline/chat/room-a?voiceResume=bad')).toBe(false);
  expect(await routeVoiceResumeNotification('beeline://foreign/beeline/chat/room-a?voiceResume=bad')).toBe(false);
  stop();
});


it('parks audio without stopping the foreground service and resumes the same native generation', async () => {
  native.background.stop.mockClear();
  const transport = await createVoiceRoom(() => {}, 'same-room');
  await transport.parkAudio('Ruby');
  expect(native.background.setActivity).toHaveBeenLastCalledWith(false, 'Ruby', 1);
  expect(native.background.stop).not.toHaveBeenCalled();
  await transport.resumeAudio();
  expect(native.background.setActivity).toHaveBeenLastCalledWith(true, null, 1);
  await transport.idleEnd();
  expect(native.background.endForIdle).toHaveBeenCalledWith(undefined, 1);
  await transport.closeAudio();
  expect(native.background.stop).toHaveBeenCalledWith(1);
});

it('uses native one-shot deadlines and drops idle events from stale or closed sessions', async () => {
  vi.useFakeTimers();
  const idle = vi.fn();
  try {
    const transport = await createVoiceRoom(() => {}, 'room', idle);
    const callback = native.background.addListener.mock.calls.filter(([event]) => event === 'idleRequested').at(-1)![1];
    await transport.armSilence();
    expect(native.background.armSilence).toHaveBeenLastCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
    callback({ generation: 2 });
    expect(idle).not.toHaveBeenCalled();
    callback({ generation: 1 });
    expect(idle).toHaveBeenCalledOnce();
    await transport.cancelSilence();
    expect(native.background.cancelSilence).toHaveBeenLastCalledWith(1);
    await transport.closeAudio();
    callback({ generation: 1 });
    expect(idle).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('delivers native voice HTTP while JavaScript timers remain paused', async () => {
  vi.useFakeTimers();
  try {
    const { voiceFetch } = await import('./voice-transport.native');
    const response = await voiceFetch('https://proof/idle', { method: 'POST' });
    expect(await response.text()).toBe('locked response');
    expect(vi.getTimerCount()).toBe(0);
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
