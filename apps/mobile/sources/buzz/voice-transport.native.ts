import { getBuzzRuntimeConfig } from './runtime-config';
import { monolithSession } from '@/auth/monolith-session';
import { Room, RoomEvent, Track } from 'livekit-client';
import { Linking, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform, TurboModuleRegistry } from 'react-native';

let reportedIOSCapabilityFailure = false;
let reportedAndroidCapabilityFailure = false;

export async function createVoiceRoom(onStop: () => void = () => {}, roomId?: string): Promise<{ room: Room; closeAudio(): Promise<void>; configureStop(callId: string, token: string): Promise<void> }> {
  if (Platform.OS === 'ios') {
    // Check before evaluating LiveKit/WebRTC: their emitters throw during import
    // on store binaries without the native half, before our join recovery runs.
    const { requireOptionalNativeModule, EventEmitter } = await import('expo-modules-core');
    const background = requireOptionalNativeModule<Record<string, unknown>>('VoiceBackgroundAudio');
    const methods = ['configureStop', 'start', 'stop'];
    const missing_methods = methods.filter(method => typeof background?.[method] !== 'function');
    if (typeof background?.addListener !== 'function' && typeof EventEmitter?.prototype.addListener !== 'function') {
      missing_methods.push('addListener');
    }
    const failures = {
      webrtc: !(TurboModuleRegistry.get('WebRTCModule') ?? NativeModules.WebRTCModule),
      livekit: !(TurboModuleRegistry.get('LivekitReactNativeModule') ?? NativeModules.LivekitReactNativeModule),
      background_module: !background,
      missing_methods,
    };
    if (failures.webrtc || failures.livekit || failures.background_module || missing_methods.length) {
      if (!reportedIOSCapabilityFailure) {
        reportedIOSCapabilityFailure = true;
        // A separate diagnostic bypasses expected-refusal filtering without changing the visible copy.
        void (async () => {
          const [application, updates, { reportClientError }] = await Promise.all([
            import('expo-application'), import('expo-updates'), import('./client-error-report'),
          ]);
          const architecture = globalThis as typeof globalThis & { RN$Bridgeless?: boolean; nativeFabricUIManager?: unknown; __turboModuleProxy?: unknown };
          await reportClientError('voice-join', new Error(`iOS voice capability check failed: ${JSON.stringify({
            ...failures, appVersion: application.nativeApplicationVersion, build: application.nativeBuildVersion,
            runtime: updates.runtimeVersion, bridgeless: !!architecture.RN$Bridgeless,
            fabric: !!architecture.nativeFabricUIManager, turboModules: !!architecture.__turboModuleProxy,
          })}`));
        })().catch(() => {});
      }
      throw new Error('Update Beeline in the App Store to join calls.');
    }
  }
  if (Platform.OS === 'android') {
    const { requireOptionalNativeModule, EventEmitter } = await import('expo-modules-core');
    const background = requireOptionalNativeModule<Record<string, unknown>>('VoiceBackgroundAudio');
    const missing_methods = ['configureStop', 'start', 'stop'].filter(method => typeof background?.[method] !== 'function');
    if (typeof background?.addListener !== 'function' && typeof EventEmitter?.prototype.addListener !== 'function') {
      missing_methods.push('addListener');
    }
    if (!background || missing_methods.length) {
      if (!reportedAndroidCapabilityFailure) {
        reportedAndroidCapabilityFailure = true;
        void (async () => {
          const [application, updates, { reportClientError }] = await Promise.all([
            import('expo-application'), import('expo-updates'), import('./client-error-report'),
          ]);
          await reportClientError('voice-join', new Error(`Android voice capability check failed: ${JSON.stringify({
            background_module: !background, missing_methods,
            appVersion: application.nativeApplicationVersion, build: application.nativeBuildVersion,
            runtime: updates.runtimeVersion,
          })}`));
        })().catch(() => {});
      }
      throw new Error('Update Beeline from the Play Store to join calls.');
    }
  }
  // Lazy: installed binaries without WebRTC can still dictate/use the Room.
  const { registerGlobals, AudioSession } = await import('@livekit/react-native');
  const { requireNativeModule } = await import('expo-modules-core');
  const background = requireNativeModule<{
    configureStop(url: string, token: string, generation: number): Promise<void>;
    start(resumeUrl?: string): Promise<number>; stop(generation: number): Promise<void>;
    addListener(event: 'stopRequested', listener: (event: { generation: number }) => void): { remove(): void };
  }>('VoiceBackgroundAudio');
  if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
      !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission is required for Conversation mode.');
  registerGlobals();
  let generation: number | undefined;
  const addListener = typeof background.addListener === 'function' ? background.addListener.bind(background)
    : (await import('expo-modules-core')).EventEmitter.prototype.addListener.bind(background) as typeof background.addListener;
  const subscription = addListener('stopRequested', event => { if (event.generation === generation) onStop(); });
  let closed = false;
  let cleanup: Promise<void> | undefined;
  const closeAudio = () => cleanup ??= (async () => {
    closed = true;
    subscription.remove();
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

/** Use the same native processor for the microphone and every remote audio track. */
export function subscribeVoiceMicrophone(room: Room, onLevel: (level: number) => void): () => void {
  const native = NativeModules.LivekitReactNativeModule;
  const meters = new Map<Track, { id: string; connection: number; mediaId: string; level: number }>();
  const publish = () => onLevel(Math.max(0, ...[...meters.values()].map(meter => meter.level)));
  const update = () => {
    const tracks = [room.localParticipant, ...room.remoteParticipants.values()]
      .flatMap(participant => [...participant.audioTrackPublications.values()])
      .flatMap(publication => publication.track && !publication.track.isMuted ? [publication.track] : []);
    const active = new Set<Track>(tracks);
    for (const [track, meter] of meters) if (!active.has(track)) {
      native.deleteVolumeProcessor(meter.id, meter.connection, meter.mediaId); meters.delete(track);
    }
    for (const track of tracks) if (!meters.has(track)) {
      const media = track.mediaStreamTrack as unknown as { id: string; _peerConnectionId?: number };
      const connection = media._peerConnectionId ?? -1;
      const id = native.createVolumeProcessor(connection, media.id) as string;
      meters.set(track, { id, connection, mediaId: media.id, level: 0 });
    }
    publish();
  };
  const listener = new NativeEventEmitter(native).addListener('LK_VOLUME_PROCESSED', (event: { id: string; volume: number }) => {
    for (const meter of meters.values()) if (event.id === meter.id) meter.level = event.volume;
    publish();
  });
  const events = [RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantDisconnected, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted];
  events.forEach(event => room.on(event, update)); update();
  return () => {
    events.forEach(event => room.off(event, update)); listener.remove();
    for (const meter of meters.values()) native.deleteVolumeProcessor(meter.id, meter.connection, meter.mediaId);
    meters.clear();
  };
}
