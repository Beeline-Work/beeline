/**
 * Thin adapter for expo-speech-recognition. Exists in its own module so tests
 * can mock it without vitest trying to resolve the native module chain.
 *
 * On unsupported platforms (web, desktop) getRecognitionModule returns null.
 * Platform check is lazy so the adapter module can be loaded in test
 * environments without parsing react-native's Flow-typed source.
 */

export interface SpeechRecognitionInterface {
  start(options: any): void;
  stop(): void;
  abort(): void;
  getPermissionsAsync(): Promise<{ status: string; granted: boolean; canAskAgain: boolean }>;
  requestPermissionsAsync(): Promise<{ status: string; granted: boolean; canAskAgain: boolean }>;
  supportsOnDeviceRecognition?(): boolean;
  addListener?(event: string, handler: (...args: any[]) => void): { remove(): void };
}

interface SpeechRecognitionModule {
  ExpoSpeechRecognitionModule: {
    start: (options: any) => void;
    stop: () => void;
    abort: () => void;
    getPermissionsAsync: () => Promise<{ status: string; granted: boolean; canAskAgain: boolean }>;
    requestPermissionsAsync: () => Promise<{ status: string; granted: boolean; canAskAgain: boolean }>;
    addListener?: (event: string, handler: (...args: any[]) => void) => { remove(): void };
    supportsOnDeviceRecognition?: () => boolean;
  };
}

let cached: SpeechRecognitionInterface | null | undefined;

function getPlatform(): { OS: string } | null {
  try {
    // Lazy — no module-level import of react-native.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native');
    return Platform;
  } catch {
    return null;
  }
}

function loadModule(): SpeechRecognitionModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-speech-recognition') as SpeechRecognitionModule;
  } catch {
    return null;
  }
}

export function getRecognitionModule(): SpeechRecognitionInterface | null {
  if (cached !== undefined) return cached;

  const platform = getPlatform();
  if (!platform || (platform.OS !== 'ios' && platform.OS !== 'android')) {
    cached = null;
    return null;
  }

  const mod = loadModule();
  if (!mod) {
    cached = null;
    return null;
  }

  cached = {
    start: (options: any) => mod.ExpoSpeechRecognitionModule.start(options),
    stop: () => mod.ExpoSpeechRecognitionModule.stop(),
    abort: () => mod.ExpoSpeechRecognitionModule.abort(),
    getPermissionsAsync: () => mod.ExpoSpeechRecognitionModule.getPermissionsAsync(),
    requestPermissionsAsync: () => mod.ExpoSpeechRecognitionModule.requestPermissionsAsync(),
    supportsOnDeviceRecognition: () =>
      typeof mod.ExpoSpeechRecognitionModule.supportsOnDeviceRecognition === 'function'
        ? mod.ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()
        : false,
    addListener: (event: string, handler: (...args: any[]) => void) => {
      if (typeof mod.ExpoSpeechRecognitionModule.addListener === 'function') {
        return mod.ExpoSpeechRecognitionModule.addListener(event, handler);
      }
      return { remove: () => {} };
    },
  };
  return cached;
}