import { Room } from 'livekit-client';

export async function createVoiceRoom(_onStop: () => void = () => {}, roomId?: string): Promise<{ room: Room; closeAudio(): Promise<void>; parkAudio(agentName: string): Promise<void>; resumeAudio(): Promise<void>; idleEnd(): Promise<void> }> {
  const room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { stopMicTrackOnMute: true },
    reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => Math.min(5000, 500 * 2 ** Math.min(retryCount, 4)) } });
  // Called from the original mic gesture, so browser playback has user activation.
  void room.startAudio();
  return { room, closeAudio: async () => {}, parkAudio: async () => {}, resumeAudio: async () => {}, idleEnd: async () => {} };
}

export function subscribeVoiceResume(_roomId: string, _resume: () => void): () => void {
  return () => {};
}

export async function routeVoiceResumeNotification(_url: unknown, _ready?: () => Promise<void>): Promise<boolean> {
  return false;
}
