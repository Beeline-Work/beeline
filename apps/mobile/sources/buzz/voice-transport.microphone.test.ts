import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { RoomEvent, type Room } from 'livekit-client';

const native = vi.hoisted(() => ({
  createVolumeProcessor: vi.fn(() => 'mic-processor'),
  deleteVolumeProcessor: vi.fn(),
  remove: vi.fn(),
  receive: undefined as undefined | ((event: { id: string; volume: number }) => void),
}));
vi.mock('react-native', () => ({
  NativeModules: { LivekitReactNativeModule: native },
  NativeEventEmitter: class {
    addListener(_name: string, receive: typeof native.receive) {
      native.receive = receive;
      return { remove: native.remove };
    }
  },
  Linking: {}, PermissionsAndroid: {}, Platform: {}, TurboModuleRegistry: {},
}));
vi.mock('./runtime-config', () => ({ getBuzzRuntimeConfig: () => ({}) }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {} }));
import { subscribeVoiceMicrophone } from './voice-transport.native';

it('meters only captured microphone frames immediately and releases native capture on mute and leave', () => {
  const track = { isMuted: false, mediaStreamTrack: { id: 'local-mic' } };
  const room = Object.assign(new EventEmitter(), {
    localParticipant: { getTrackPublication: () => ({ track }) },
  });
  const level = vi.fn();
  const stop = subscribeVoiceMicrophone(room as unknown as Room, level);
  expect(native.createVolumeProcessor).toHaveBeenCalledWith(-1, 'local-mic');
  level.mockClear();
  native.receive!({ id: 'remote-agent', volume: 1 });
  expect(level).not.toHaveBeenCalled();
  native.receive!({ id: 'mic-processor', volume: .4 });
  native.receive!({ id: 'mic-processor', volume: 0 });
  expect(level.mock.calls).toEqual([[.4], [0]]);
  track.isMuted = true;
  room.emit(RoomEvent.TrackMuted);
  expect(native.remove).toHaveBeenCalledOnce();
  expect(native.deleteVolumeProcessor).toHaveBeenCalledWith('mic-processor', -1, 'local-mic');
  expect(level).toHaveBeenLastCalledWith(0);
  stop();
  expect(room.eventNames()).toEqual([]);
});
