import { Room } from 'livekit-client';

export async function createVoiceRoom(): Promise<{ room: Room; closeAudio(): Promise<void> }> {
  const room = new Room({ adaptiveStream: false, dynacast: false });
  // Called from the original mic gesture, so browser playback has user activation.
  void room.startAudio();
  return { room, closeAudio: async () => {} };
}
