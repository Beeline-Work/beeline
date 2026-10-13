import { expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ registerGlobals: vi.fn(),
  AudioSession: { startAudioSession: vi.fn(async () => {}), stopAudioSession: vi.fn(async () => {}) } }));
vi.mock('@livekit/react-native', () => native);
vi.mock('livekit-client', () => ({ Room: class {} }));
import { createVoiceRoom } from './voice-transport.native';

it('starts native audio only when voice mode opens and exposes cleanup for leave/unmount', async () => {
  expect(native.AudioSession.startAudioSession).not.toHaveBeenCalled();
  const transport = await createVoiceRoom();
  expect(native.registerGlobals).toHaveBeenCalledOnce();
  expect(native.AudioSession.startAudioSession).toHaveBeenCalledOnce();
  await transport.closeAudio();
  expect(native.AudioSession.stopAudioSession).toHaveBeenCalledOnce();
});
