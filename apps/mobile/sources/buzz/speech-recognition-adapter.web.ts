// The 3.1.3 barrel exports grammar symbols absent from its web build. Import
// the speech module directly, still letting Metro select its .web implementation.
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition/build/ExpoSpeechRecognitionModule';
import type { SpeechRecognitionInterface } from './speech-recognition-adapter';

// SpeechRecognition.start() owns the browser permission prompt. These methods
// only satisfy the shared hook's native permission contract; they never capture.
const permission = async () => ({ status: 'granted', granted: true, canAskAgain: true });

const recognition: SpeechRecognitionInterface = {
  start: options => ExpoSpeechRecognitionModule.start(options),
  stop: () => ExpoSpeechRecognitionModule.stop(),
  abort: () => ExpoSpeechRecognitionModule.abort(),
  getPermissionsAsync: permission,
  requestPermissionsAsync: permission,
  supportsRecording: () => false,
  addListener: (event, handler) => ExpoSpeechRecognitionModule.addListener(
    event as Parameters<typeof ExpoSpeechRecognitionModule.addListener>[0], handler,
  ),
};

export function getRecognitionModule(): SpeechRecognitionInterface | null {
  return ExpoSpeechRecognitionModule.isRecognitionAvailable() ? recognition : null;
}
