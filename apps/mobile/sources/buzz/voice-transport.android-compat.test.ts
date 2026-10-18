import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  background: null as null | Record<string, unknown>,
  rejectLiveKit: true,
  loadLiveKit: vi.fn(),
  captureException: vi.fn(),
  emitterListener: undefined as undefined | ((event: string, listener: unknown) => { remove(): void }),
}));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '0.2.22', nativeBuildVersion: '92' }));
vi.mock('expo-updates', () => ({ runtimeVersion: '35' }));
vi.mock('./client-error-report', async original => ({ ...await original<object>(), reportClientError: vi.fn(async (scope, cause) => { const { captureMobileError } = await import('./sentry'); captureMobileError(scope, cause); }) }));
vi.mock('@sentry/react-native', () => ({ captureException: state.captureException }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' }, PermissionsAndroid: { request: async () => 'granted', PERMISSIONS: { RECORD_AUDIO: 'audio' }, RESULTS: { GRANTED: 'granted' } }, Linking: {},
}));
vi.mock('expo-modules-core', () => ({
  EventEmitter: { prototype: { get addListener() { return state.emitterListener; } } },
  requireOptionalNativeModule: () => state.background,
  requireNativeModule: () => { if (!state.background) throw new Error("Cannot find native module 'VoiceBackgroundAudio'"); return state.background; },
}));
vi.mock('livekit-client', () => ({ Room: class {} }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({}) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {} }));
let createVoiceRoom: typeof import('./voice-transport.native').createVoiceRoom;
import { captureMobileError } from './sentry';

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('@livekit/react-native', () => {
    state.loadLiveKit();
    if (state.rejectLiveKit) throw new Error('An unsupported native package was evaluated');
    return { registerGlobals() {}, AudioSession: { async startAudioSession() {}, async stopAudioSession() {} } };
  });
  ({ createVoiceRoom } = await import('./voice-transport.native'));
  state.emitterListener = undefined;
  state.background = null;
  state.rejectLiveKit = true;
  state.loadLiveKit.mockClear();
  state.captureException.mockClear();
});

afterEach(async () => {
  // Drain the best-effort diagnostic before resetting the next launch.
  await vi.dynamicImportSettled();
});

it('Reproduction MOBILE-6: refuses old Android before LiveKit and reports one diagnostic across retries', async () => {
  state.rejectLiveKit = false;
  const failure = await createVoiceRoom().catch(error => error);
  expect(failure.message).toBe('Update Beeline from the Play Store to join calls.');
  captureMobileError('voice-join', failure);
  await createVoiceRoom().catch(() => {});
  await vi.dynamicImportSettled();
  expect(state.captureException).toHaveBeenCalledOnce();
  const diagnostic = state.captureException.mock.calls[0][0];
  expect(diagnostic.message).toContain('Android voice capability check failed:');
  expect(JSON.parse(diagnostic.message.split('failed: ')[1])).toMatchObject({
    background_module: true, missing_methods: ['configureStop', 'start', 'stop', 'addListener'],
    appVersion: '0.2.22', build: '92', runtime: '35',
  });
  expect(state.loadLiveKit).not.toHaveBeenCalled();
});

it.each(['configureStop', 'start', 'stop', 'addListener'])('requires %s before loading LiveKit', async missing => {
  state.background = { configureStop() {}, start() {}, stop() {}, addListener() {} };
  delete state.background[missing];
  await expect(createVoiceRoom()).rejects.toThrow('Update Beeline from the Play Store to join calls.');
  expect(state.loadLiveKit).not.toHaveBeenCalled();
});

it.each([false, true])('starts, configures and closes Android audio with Expo emitter fallback=%s', async fallback => {
  const remove = vi.fn();
  const listener = vi.fn(() => ({ remove }));
  const configureStop = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  state.background = { configureStop, async start() { return 7; }, stop,
    ...(fallback ? {} : { addListener: listener }) };
  if (fallback) state.emitterListener = listener;
  state.rejectLiveKit = false;
  const transport = await createVoiceRoom();
  expect(state.loadLiveKit).toHaveBeenCalledOnce();
  await transport.configureStop('call', 'fixture');
  expect(configureStop).toHaveBeenCalledOnce();
  await transport.closeAudio();
  expect(remove).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledWith(7);
  expect(state.captureException).not.toHaveBeenCalled();
});
