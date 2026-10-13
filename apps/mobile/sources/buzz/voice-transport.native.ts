import { Room } from 'livekit-client';

export async function createVoiceRoom(): Promise<{ room: Room; closeAudio(): Promise<void> }> {
  // Lazy: installed binaries without WebRTC can still dictate/use the Room.
  const { registerGlobals, AudioSession } = await import('@livekit/react-native');
  registerGlobals();
  await AudioSession.startAudioSession();
  try {
    const room = new Room({ adaptiveStream: false, dynacast: false });
    return { room, closeAudio: () => AudioSession.stopAudioSession() };
  } catch (cause) {
    await AudioSession.stopAudioSession().catch(() => {});
    throw cause;
  }
}
