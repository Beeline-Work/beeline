import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { RoomEvent, type Room } from 'livekit-client';
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {} }));
import { subscribeVoiceMicrophone } from './voice-transport';

it('samples the loudest web audio source per frame and disconnects removed tracks and the context', () => {
  const sources: any[] = [];
  const analysers: any[] = [];
  const close = vi.fn(async () => {});
  let next!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { next = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('MediaStream', class { constructor(readonly tracks: unknown[]) {} });
  vi.stubGlobal('AudioContext', class {
    close = close;
    createMediaStreamSource() { const source = { connect: vi.fn(), disconnect: vi.fn() }; sources.push(source); return source; }
    createAnalyser() {
      const analyser = { fftSize: 256, smoothingTimeConstant: 1, amplitude: 0,
        getFloatTimeDomainData(samples: Float32Array) { samples.fill(this.amplitude); } };
      analysers.push(analyser); return analyser;
    }
  });
  try {
    const mic = { isMuted: false, mediaStreamTrack: {} }, agent = { isMuted: false, mediaStreamTrack: {} };
    const remote = new Map([['agent', { track: agent }]]);
    const room = Object.assign(new EventEmitter(), {
      localParticipant: { audioTrackPublications: new Map([['mic', { track: mic }]]) },
      remoteParticipants: new Map([['remote', { audioTrackPublications: remote }]]),
    });
    const level = vi.fn();
    const stop = subscribeVoiceMicrophone(room as unknown as Room, level);
    analysers[0].amplitude = .2; analysers[1].amplitude = .8; next(0);
    expect(level.mock.calls.at(-1)![0]).toBeCloseTo(.8);
    mic.isMuted = true; room.emit(RoomEvent.TrackMuted); next(0);
    expect(level.mock.calls.at(-1)![0]).toBeCloseTo(.8);
    remote.clear(); room.emit(RoomEvent.TrackUnsubscribed); next(0);
    expect(level).toHaveBeenLastCalledWith(0);
    expect(sources.every(source => source.disconnect.mock.calls.length === 1)).toBe(true);
    stop(); expect(close).toHaveBeenCalledOnce(); expect(room.eventNames()).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});
