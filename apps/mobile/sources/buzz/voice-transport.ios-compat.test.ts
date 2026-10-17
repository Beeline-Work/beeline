import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  modules: {} as Record<string, unknown>,
  background: null as null | Record<string, unknown>,
  rejectLiveKit: true,
  loadLiveKit: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }, NativeModules: state.modules, PermissionsAndroid: {}, Linking: {},
}));
vi.mock('expo-modules-core', () => ({
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
import { createVoiceRoom } from './voice-transport.native';

beforeEach(() => {
  for (const key of Object.keys(state.modules)) delete state.modules[key];
  state.background = null;
  state.rejectLiveKit = true;
  state.loadLiveKit.mockClear();
});

it('does not evaluate WebRTC on an App Store iOS runtime without its native modules', async () => {
  await expect(createVoiceRoom()).rejects.toThrow('Update Beeline from the App Store');
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
  await expect(createVoiceRoom()).rejects.toThrow('Update Beeline from the App Store');
  expect(state.loadLiveKit).not.toHaveBeenCalled();
});
