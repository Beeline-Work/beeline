/**
 * A scripted stand-in for expo-speech-recognition. The proof shims
 * `./speech-recognition-adapter` to return `recognizerModule`, so the real
 * useSpeechInput runs in the page.
 * The locale model is not installed, as on a phone that has never dictated.
 */
type Handler = (event?: unknown) => void;

const handlers = new Map<string, Handler>();

export const speechProofRecognizer = {
  module: undefined as unknown,
  started: 0,
  lastStartOptions: null as null | { contextualStrings?: string[] },
  downloadRequests: [] as string[],
  emit(event: string, payload?: unknown) {
    handlers.get(event)?.(payload);
  },
};

const recognizerModule = {
  start(options: { contextualStrings?: string[] }) {
    speechProofRecognizer.started += 1;
    speechProofRecognizer.lastStartOptions = options;
  },
  stop() {
    handlers.get('end')?.();
  },
  abort() {},
  getPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
  supportsOnDeviceRecognition: () => true,
  getSupportedLocales: async () => ({ locales: ['en-US'], installedLocales: [] as string[] }),
  androidTriggerOfflineModelDownload: async ({ locale }: { locale: string }) => {
    speechProofRecognizer.downloadRequests.push(locale);
    return { status: 'download_success' };
  },
  addListener(event: string, handler: Handler) {
    handlers.set(event, handler);
    return { remove: () => handlers.delete(event) };
  },
};

speechProofRecognizer.module = recognizerModule;
