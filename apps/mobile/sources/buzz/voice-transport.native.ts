import { Room } from 'livekit-client';
import { PermissionsAndroid, Platform } from 'react-native';

export async function createVoiceRoom(onStop: () => void = () => {}, roomId?: string): Promise<{ room: Room; closeAudio(): Promise<void>; parkAudio(agentName: string): Promise<void>; resumeAudio(): Promise<void>; idleEnd(): Promise<void> }> {
  // Lazy: installed binaries without WebRTC can still dictate/use the Room.
  const { registerGlobals, AudioSession } = await import('@livekit/react-native');
  const { requireNativeModule } = await import('expo-modules-core');
  const background = requireNativeModule<{
    start(resumeUrl?: string): Promise<number>; stop(generation: number): Promise<void>;
    setActivity(active: boolean, waitingFor: string | null, generation: number): Promise<void>;
    endForIdle(resumeUrl: string | undefined, generation: number): Promise<void>;
    addListener(event: 'stopRequested', listener: (event: { generation: number }) => void): { remove(): void };
  }>('VoiceBackgroundAudio');
  if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
      !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission is required for Conversation mode.');
  registerGlobals();
  let generation: number | undefined;
  const subscription = background.addListener('stopRequested', event => { if (event.generation === generation) onStop(); });
  let cleanup: Promise<void> | undefined;
  const closeAudio = () => cleanup ??= (async () => {
    subscription.remove();
    try { await AudioSession.stopAudioSession(); } finally { if (generation !== undefined) await background.stop(generation); }
  })();
  try {
    generation = await background.start(roomId ? `beeline:///beeline/chat/${encodeURIComponent(roomId)}?voiceResume=${Date.now()}` : undefined);
    await AudioSession.startAudioSession();
    const room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { stopMicTrackOnMute: true },
      reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => Math.min(5000, 500 * 2 ** Math.min(retryCount, 4)) } });
    return { room, closeAudio,
      parkAudio: async agentName => {
        await AudioSession.stopAudioSession();
        if (generation !== undefined) await background.setActivity(false, agentName, generation);
      },
      resumeAudio: async () => {
        if (generation !== undefined) await background.setActivity(true, null, generation);
        await AudioSession.startAudioSession();
      },
      idleEnd: async () => {
        await AudioSession.stopAudioSession();
        if (generation !== undefined) await background.endForIdle(undefined, generation);
      },
    };
  } catch (cause) {
    await closeAudio().catch(() => {});
    throw cause;
  }
}

let pendingResumeUrl: string | null = null;
let consumedResumeUrl: string | null = null;

/** Retain one notification intent across the Room navigation it initiates. */
export function subscribeVoiceResume(roomId: string, resume: () => void): () => void {
  let disposed = false;
  let remove = () => {};
  void Promise.all([import('react-native'), import('expo-notifications')]).then(([{ Linking }, notifications]) => {
    if (disposed) return;
    const accept = (url: string | null) => {
      if (disposed || !url || url === consumedResumeUrl) return;
      let parsed: URL;
      try { parsed = new URL(url); } catch { return; }
      if (parsed.protocol !== 'beeline:' || !parsed.searchParams.get('voiceResume')) return;
      pendingResumeUrl = url;
      if (parsed.pathname !== `/beeline/chat/${encodeURIComponent(roomId)}`) return;
      consumedResumeUrl = url; pendingResumeUrl = null;
      resume();
    };
    const link = Linking.addEventListener('url', ({ url }) => accept(url));
    const response = notifications.addNotificationResponseReceivedListener(event => {
      const url = event.notification.request.content.data?.resumeUrl;
      if (typeof url !== 'string' || !url.startsWith('beeline:///beeline/chat/')) return;
      pendingResumeUrl = url;
      accept(url);
      void Linking.openURL(url);
    });
    remove = () => { link.remove(); response.remove(); };
    accept(pendingResumeUrl);
    void Linking.getInitialURL().then(url => { if (!disposed) accept(url); });
    void notifications.getLastNotificationResponseAsync().then(event => {
      if (disposed) return;
      const url = event?.notification.request.content.data?.resumeUrl;
      if (typeof url === 'string') { accept(url); if (url.startsWith('beeline:///beeline/chat/')) void Linking.openURL(url); }
    });
  }).catch(error => { if (!disposed) console.warn('Conversation notification unavailable', error); });
  return () => { disposed = true; remove(); };
}
