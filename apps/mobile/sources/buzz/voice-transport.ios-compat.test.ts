import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  turbo: {} as Record<string, unknown>,
  modules: {} as Record<string, unknown>,
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
  Platform: { OS: 'ios' }, TurboModuleRegistry: { get: (name: string) => state.turbo[name] ?? null }, NativeModules: state.modules, PermissionsAndroid: {}, Linking: {},
}));
vi.mock('expo-modules-core', () => ({
  EventEmitter: { prototype: { get addListener() { return state.emitterListener; } } },
  requireOptionalNativeModule: () => state.background,
  requireNativeModule: () => state.background,
}));
vi.mock('@livekit/react-native', () => {
  state.loadLiveKit();
  if (state.rejectLiveKit) throw new Error('An unsupported native package was evaluated');
  return { registerGlobals() {}, AudioSession: { async startAudioSession() {}, async stopAudioSession() {} } };
});
vi.mock('livekit-client', () => ({ Room: class {} }));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({}) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {} }));
let createVoiceRoom: typeof import('./voice-transport.native').createVoiceRoom;
import { captureMobileError } from './sentry';

beforeEach(async () => {
  vi.resetModules();
  ({ createVoiceRoom } = await import('./voice-transport.native'));
  for (const key of Object.keys(state.turbo)) delete state.turbo[key];
  for (const key of Object.keys(state.modules)) delete state.modules[key];
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

it('does not evaluate WebRTC on an App Store iOS runtime without its native modules', async () => {
  await expect(createVoiceRoom()).rejects.toThrow('Update Beeline in the App Store to join calls.');
  expect(state.loadLiveKit).not.toHaveBeenCalled();
});

it('starts and closes audio when the iOS native capabilities are present', async () => {
  state.modules.WebRTCModule = {};
  state.modules.LivekitReactNativeModule = {};
  const stop = vi.fn(async () => {});
  state.background = {
    async configureStop() {}, async start() { return 1; }, stop,
    async setActivity() {}, async endForIdle() {}, async armSilence() {}, async cancelSilence() {},
    addListener() { return { remove() {} }; },
  };
  state.rejectLiveKit = false;
  const transport = await createVoiceRoom();
  expect(state.loadLiveKit).toHaveBeenCalledOnce();
  await transport.closeAudio();
  expect(stop).toHaveBeenCalledWith(1);
});

it('requires the background audio methods before loading voice on an intermediate iOS runtime', async () => {
  state.modules.WebRTCModule = {};
  state.modules.LivekitReactNativeModule = {};
  state.background = { start() {}, stop() {} };
  await expect(createVoiceRoom()).rejects.toThrow('Update Beeline in the App Store to join calls.');
  expect(state.loadLiveKit).not.toHaveBeenCalled();
});

it('Reproduction iphone-022-false-gate: reports exact failures once while keeping the refusal visible', async () => {
  const failure = await createVoiceRoom().catch(error => error);
  expect(failure.message).toBe('Update Beeline in the App Store to join calls.');
  captureMobileError('voice-join', failure);
  await createVoiceRoom().catch(() => {});
  await vi.waitFor(() => expect(state.captureException).toHaveBeenCalledOnce());
  const diagnostic = state.captureException.mock.calls[0][0];
  expect(diagnostic.message).toContain('iOS voice capability check failed:');
  expect(JSON.parse(diagnostic.message.split('failed: ')[1])).toMatchObject({
    webrtc: true, livekit: true, background_module: true,
    missing_methods: ['configureStop', 'start', 'stop', 'setActivity', 'endForIdle', 'armSilence', 'cancelSilence', 'addListener'],
    appVersion: '0.2.22', build: '92', runtime: '35', bridgeless: false,
  });
  expect(state.loadLiveKit).not.toHaveBeenCalled();
});

it('Reproduction iphone-022-false-gate: bridgeless modules and inherited Expo events open and close the call', async () => {
  state.turbo.WebRTCModule = {};
  state.turbo.LivekitReactNativeModule = {};
  const remove = vi.fn();
  const listener = vi.fn((_event: string, _callback: unknown) => ({ remove }));
  const stop = vi.fn(async () => {});
  state.background = Object.assign(Object.create({ addListener: listener }), {
    async configureStop() {}, async start() { return 7; }, stop,
    async setActivity() {}, async endForIdle() {}, async armSilence() {}, async cancelSilence() {},
  });
  expect(state.modules.WebRTCModule).toBeUndefined();
  expect(state.modules.LivekitReactNativeModule).toBeUndefined();
  expect(Object.hasOwn(state.background!, 'addListener')).toBe(false);
  state.rejectLiveKit = false;
  const transport = await createVoiceRoom();
  expect(listener.mock.calls.map(call => call[0])).toEqual(['stopRequested', 'idleRequested']);
  await transport.closeAudio();
  expect(remove).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledWith(7);
  expect(state.captureException).not.toHaveBeenCalled();
});

it('uses the Expo EventEmitter for a background module without its own listener method', async () => {
  state.modules.WebRTCModule = {};
  state.modules.LivekitReactNativeModule = {};
  const remove = vi.fn();
  state.emitterListener = vi.fn(function (this: unknown) {
    expect(this).toBe(state.background);
    return { remove };
  });
  state.background = {
    async configureStop() {}, async start() { return 1; }, async stop() {},
    async setActivity() {}, async endForIdle() {}, async armSilence() {}, async cancelSilence() {},
  };
  state.rejectLiveKit = false;
  const transport = await createVoiceRoom();
  await transport.closeAudio();
  expect(state.emitterListener).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledTimes(2);
});
