import { expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ roomFailure: null as Error | null, registerGlobals: vi.fn(),
  AudioSession: { startAudioSession: vi.fn(async () => {}), stopAudioSession: vi.fn(async () => {}) } }));
vi.mock('@livekit/react-native', () => native);
vi.mock('livekit-client', () => ({ Room: class { constructor() { if (native.roomFailure) throw native.roomFailure; } } }));
import { createVoiceRoom } from './voice-transport.native';

it('starts native audio only when voice mode opens and exposes cleanup for leave/unmount', async () => {
  expect(native.AudioSession.startAudioSession).not.toHaveBeenCalled();
  const transport = await createVoiceRoom();
  expect(native.registerGlobals).toHaveBeenCalledOnce();
  expect(native.AudioSession.startAudioSession).toHaveBeenCalledOnce();
  await transport.closeAudio();
  expect(native.AudioSession.stopAudioSession).toHaveBeenCalledOnce();
});

it('releases native audio if creating the Room fails before the join request', async () => {
  native.roomFailure = new Error('Room initialization failed');
  native.AudioSession.stopAudioSession.mockClear();
  try {
    await expect(createVoiceRoom()).rejects.toThrow('Room initialization failed');
    expect(native.AudioSession.stopAudioSession).toHaveBeenCalledOnce();
  } finally { native.roomFailure = null; }
});
