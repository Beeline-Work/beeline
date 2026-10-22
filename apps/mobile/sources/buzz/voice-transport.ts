import { monolithSession } from '@/auth/monolith-session';
import { Room, RoomEvent, Track } from 'livekit-client';

export async function createVoiceRoom(_onStop: () => void = () => {}, _roomId?: string): Promise<{ room: Room; closeAudio(): Promise<void>; configureStop(callId: string, token: string): Promise<void> }> {
  const room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { stopMicTrackOnMute: true },
    reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => Math.min(5000, 500 * 2 ** Math.min(retryCount, 4)) } });
  // Called from the original mic gesture, so browser playback has user activation.
  void room.startAudio();
  return { room, configureStop: async () => {}, closeAudio: async () => {} };
}

export function subscribeVoiceResume(_roomId: string, _resume: () => void): () => void {
  return () => {};
}

export async function routeVoiceResumeNotification(_url: unknown, _ready?: () => Promise<void>): Promise<boolean> {
  return false;
}

export function voiceFetch(input: string, init: RequestInit): Promise<Response> {
  return monolithSession.fetch(input, init);
}

/** Sample every audio source each frame; the loudest speaker drives the waveform. */
export function subscribeVoiceMicrophone(room: Room, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const meters = new Map<Track, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> }>();
  const update = () => {
    const tracks = [room.localParticipant, ...room.remoteParticipants.values()]
      .flatMap(participant => [...participant.audioTrackPublications.values()])
      .flatMap(publication => publication.track && !publication.track.isMuted ? [publication.track] : []);
    const active = new Set<Track>(tracks);
    for (const [track, meter] of meters) if (!active.has(track)) {
      meter.source.disconnect(); meters.delete(track);
    }
    for (const track of tracks) if (!meters.has(track)) {
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      meters.set(track, { source, analyser, samples: new Float32Array(analyser.fftSize) });
    }
  };
  let frame = 0;
  const sample = () => {
    let loudest = 0;
    for (const meter of meters.values()) {
      meter.analyser.getFloatTimeDomainData(meter.samples);
      loudest = Math.max(loudest, Math.sqrt(meter.samples.reduce((sum, value) => sum + value * value, 0) / meter.samples.length));
    }
    onLevel(loudest); frame = requestAnimationFrame(sample);
  };
  const events = [RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantDisconnected, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted];
  events.forEach(event => room.on(event, update)); update(); sample();
  return () => {
    events.forEach(event => room.off(event, update)); cancelAnimationFrame(frame);
    for (const meter of meters.values()) meter.source.disconnect();
    meters.clear(); void context.close();
  };
}
