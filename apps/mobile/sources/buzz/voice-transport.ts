import { monolithSession } from '@/auth/monolith-session';
import { Room } from 'livekit-client';

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
