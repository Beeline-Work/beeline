import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { RoomEvent, type Room } from 'livekit-client';

const native = vi.hoisted(() => ({
  createVolumeProcessor: vi.fn((_connection: number, mediaId: string) => mediaId + '-processor'),
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

it('meters the loudest local, agent or other human track, retaining remote audio while muted and releasing on unsubscribe', () => {
  const track = (id: string, connection = -1) => ({ isMuted: false, mediaStreamTrack: { id, _peerConnectionId: connection } });
  const mic = track('mic'), agent = track('agent', 7), human = track('human', 8);
  const remotes = new Map([['agent', { track: agent }], ['human', { track: human }]]);
  const room = Object.assign(new EventEmitter(), {
    localParticipant: { audioTrackPublications: new Map([['mic', { track: mic }]]) },
    remoteParticipants: new Map([['remote', { audioTrackPublications: remotes }]]),
  });
  const level = vi.fn();
  const stop = subscribeVoiceMicrophone(room as unknown as Room, level);
  expect(native.createVolumeProcessor).toHaveBeenCalledWith(-1, 'mic');
  expect(native.createVolumeProcessor).toHaveBeenCalledWith(7, 'agent');
  native.receive!({ id: 'mic-processor', volume: .4 });
  native.receive!({ id: 'agent-processor', volume: .8 });
  native.receive!({ id: 'human-processor', volume: .9 });
  expect(level).toHaveBeenLastCalledWith(.9);
  native.receive!({ id: 'human-processor', volume: 0 });
  expect(level).toHaveBeenLastCalledWith(.8);
  mic.isMuted = true; room.emit(RoomEvent.TrackMuted);
  expect(native.deleteVolumeProcessor).toHaveBeenCalledWith('mic-processor', -1, 'mic');
  expect(level).toHaveBeenLastCalledWith(.8);
  remotes.delete('agent'); room.emit(RoomEvent.TrackUnsubscribed);
  expect(level).toHaveBeenLastCalledWith(0);
  stop();
  expect(native.deleteVolumeProcessor).toHaveBeenCalledWith('agent-processor', 7, 'agent');
  expect(native.deleteVolumeProcessor).toHaveBeenCalledWith('human-processor', 8, 'human');
  expect(native.remove).toHaveBeenCalledOnce();
  expect(room.eventNames()).toEqual([]);
});
