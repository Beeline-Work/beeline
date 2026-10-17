import { getBuzzRuntimeConfig } from './runtime-config';
import { monolithSession } from '@/auth/monolith-session';
import { Room } from 'livekit-client';
import { Linking, NativeModules, PermissionsAndroid, Platform } from 'react-native';

export async function createVoiceRoom(onStop: () => void = () => {}, roomId?: string, onIdle: () => void = () => {}): Promise<{ room: Room; closeAudio(): Promise<void>; configureStop(callId: string, token: string): Promise<void>; parkAudio(agentName: string): Promise<void>; resumeAudio(): Promise<void>; idleEnd(): Promise<void>; armSilence(): Promise<void>; cancelSilence(): Promise<void> }> {
  if (Platform.OS === 'ios') {
    // Check before evaluating LiveKit/WebRTC: their emitters throw during import
    // on store binaries without the native half, before our join recovery runs.
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const background = requireOptionalNativeModule<Record<string, unknown>>('VoiceBackgroundAudio');
    const methods = ['configureStop', 'start', 'stop', 'setActivity', 'endForIdle', 'armSilence', 'cancelSilence', 'addListener'];
    if (!NativeModules.WebRTCModule || !NativeModules.LivekitReactNativeModule ||
      !background || methods.some(method => typeof background[method] !== 'function')) {
      throw new Error('Conversation mode is not available in this iPhone version yet. It arrives in the next App Store update.');
    }
  }
  // Lazy: installed binaries without WebRTC can still dictate/use the Room.
  const { registerGlobals, AudioSession } = await import('@livekit/react-native');
  const { requireNativeModule } = await import('expo-modules-core');
  const background = requireNativeModule<{
    configureStop(url: string, token: string, generation: number): Promise<void>;
    start(resumeUrl?: string): Promise<number>; stop(generation: number): Promise<void>;
    setActivity(active: boolean, waitingFor: string | null, generation: number): Promise<void>;
    endForIdle(resumeUrl: string | undefined, generation: number): Promise<void>;
    armSilence(generation: number): Promise<void>; cancelSilence(generation: number): Promise<void>;
    addListener(event: 'stopRequested' | 'idleRequested', listener: (event: { generation: number }) => void): { remove(): void };
  }>('VoiceBackgroundAudio');
  if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
      !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission is required for Conversation mode.');
  registerGlobals();
  let generation: number | undefined;
  const subscription = background.addListener('stopRequested', event => { if (event.generation === generation) onStop(); });
  let closed = false;
  const idleSubscription = background.addListener('idleRequested', event => { if (!closed && event.generation === generation) onIdle(); });
  let cleanup: Promise<void> | undefined;
  const closeAudio = () => cleanup ??= (async () => {
    closed = true;
    subscription.remove(); idleSubscription.remove();
    try { await AudioSession.stopAudioSession(); } finally { if (generation !== undefined) await background.stop(generation); }
  })();
  try {
    generation = await background.start(roomId ? `beeline:///beeline/chat/${encodeURIComponent(roomId)}?voiceResume=${Date.now()}` : undefined);
    await AudioSession.startAudioSession();
    const room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { stopMicTrackOnMute: true },
      reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => Math.min(5000, 500 * 2 ** Math.min(retryCount, 4)) } });
    return { room, closeAudio,
      configureStop: async (callId, token) => {
        if (!closed && generation !== undefined) await background.configureStop(`${getBuzzRuntimeConfig().monolithUrl}/v1/phone/voice/${callId}/native-stop`, token, generation);
      },
      armSilence: async () => { if (!closed && generation !== undefined) await background.armSilence(generation); },
      cancelSilence: async () => { if (!closed && generation !== undefined) await background.cancelSilence(generation); },
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
let routedResumeUrl: string | null = null;

/** The root retains the restart intent before clearing Expo's cold response. */
export async function routeVoiceResumeNotification(url: unknown, ready: () => Promise<void> = async () => {}): Promise<boolean> {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'beeline:' || parsed.host || !/^\/beeline\/chat\/[^/]+$/.test(parsed.pathname) || !parsed.searchParams.get('voiceResume')) return false;
  if (url === consumedResumeUrl || url === routedResumeUrl) return true;
  await ready();
  if (url === consumedResumeUrl || url === routedResumeUrl) return true;
  pendingResumeUrl = url;
  routedResumeUrl = url;
  try {
    await Linking.openURL(url);
  } catch (error) {
    if (routedResumeUrl === url) routedResumeUrl = null;
    throw error;
  }
  return true;
}


/** Retain one notification intent across the Room navigation it initiates. */
export function subscribeVoiceResume(roomId: string, resume: () => void): () => void {
  let disposed = false;
  let remove = () => {};
  // import('react-native') makes Metro enumerate every lazy native export,
  // including PushNotificationIOS whose manager is absent in Expo iOS builds.
  void Promise.resolve().then(() => {
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
    remove = () => { link.remove(); };
    accept(pendingResumeUrl);
    void Linking.getInitialURL().then(url => { if (!disposed) accept(url); });
  }).catch(error => { if (!disposed) console.warn('Conversation notification unavailable', error); });
  return () => { disposed = true; remove(); };
}

/** Expo fetch delivers native responses without background-paused JS timers. */
export async function voiceFetch(input: string, init: RequestInit): Promise<Response> {
  const { fetch } = await import('expo/fetch');
  return monolithSession.fetch(input, init, { fetchImpl: fetch as typeof globalThis.fetch });
}
