import { monolithSession } from '@/auth/monolith-session';
import { Room } from 'livekit-client';

export async function createVoiceRoom(_onStop: () => void = () => {}, roomId?: string, onIdle: () => void = () => {}): Promise<{ room: Room; closeAudio(): Promise<void>; parkAudio(agentName: string): Promise<void>; resumeAudio(): Promise<void>; idleEnd(): Promise<void>; armSilence(): Promise<void>; cancelSilence(): Promise<void> }> {
  const room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { stopMicTrackOnMute: true },
    reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => Math.min(5000, 500 * 2 ** Math.min(retryCount, 4)) } });
  // Called from the original mic gesture, so browser playback has user activation.
  void room.startAudio();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  return { room, closeAudio: async () => { cancel(); }, parkAudio: async () => { cancel(); },
    resumeAudio: async () => {}, idleEnd: async () => { cancel(); },
    armSilence: async () => { cancel(); timer = setTimeout(() => { timer = undefined; onIdle(); }, 20_000); },
    cancelSilence: async () => { cancel(); } };

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
