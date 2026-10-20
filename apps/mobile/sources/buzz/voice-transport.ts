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

/** Sample local captured audio each frame; remote audio never drives the mic meter. */
export function subscribeVoiceMicrophone(room: Room, onLevel: (level: number) => void): () => void {
  let release = () => {};
  const update = () => {
    release(); release = () => {}; onLevel(0);
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track || track.isMuted) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    const sample = () => {
      analyser.getFloatTimeDomainData(samples);
      onLevel(Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
      frame = requestAnimationFrame(sample);
    };
    sample();
    release = () => { cancelAnimationFrame(frame); source.disconnect(); void context.close(); };
  };
  const events = [RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted];
  events.forEach(event => room.on(event, update)); update();
  return () => { events.forEach(event => room.off(event, update)); release(); release = () => {}; };
}
