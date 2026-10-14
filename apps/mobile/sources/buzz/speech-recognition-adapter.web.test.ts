import { beforeEach, expect, it, vi } from 'vitest';

const module = vi.hoisted(() => ({
  isRecognitionAvailable: vi.fn(), start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  getPermissionsAsync: vi.fn(), requestPermissionsAsync: vi.fn(),
}));
vi.mock('expo-speech-recognition/build/ExpoSpeechRecognitionModule', () => ({ ExpoSpeechRecognitionModule: module }));
import { getRecognitionModule } from './speech-recognition-adapter.web';

const recorder = vi.hoisted(() => ({ available: vi.fn(), create: vi.fn(() => ({ requiresServerTranscription: true })) }));
vi.mock('./speech-recorder.web', () => ({ speechRecordingAvailable: recorder.available, createSpeechRecorder: recorder.create }));
beforeEach(() => { vi.clearAllMocks(); recorder.available.mockReturnValue(false); });

it('hides speech only when neither recognition nor recording is available', () => {
  module.isRecognitionAvailable.mockReturnValue(false);
  expect(getRecognitionModule()).toBeNull();
  expect(module.start).not.toHaveBeenCalled();
  expect(module.requestPermissionsAsync).not.toHaveBeenCalled();
});

it('uses the browser recognizer without calling native permission or recording methods', async () => {
  module.isRecognitionAvailable.mockReturnValue(true);
  const recognition = getRecognitionModule()!;
  expect(module.start).not.toHaveBeenCalled();
  expect(await recognition.getPermissionsAsync()).toMatchObject({ granted: true });
  expect(await recognition.requestPermissionsAsync()).toMatchObject({ granted: true });
  expect(module.getPermissionsAsync).not.toHaveBeenCalled();
  expect(module.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(recognition.supportsRecording?.()).toBe(false);
  recognition.start({ lang: 'en-US' });
  recognition.stop(); recognition.abort();
  expect(module.start).toHaveBeenCalledWith({ lang: 'en-US' });
  expect(module.stop).toHaveBeenCalledOnce();
  expect(module.abort).toHaveBeenCalledOnce();
  const listener = vi.fn();
  recognition.addListener?.('result', listener);
  expect(module.addListener).toHaveBeenCalledWith('result', listener);
});

it('offers the server recorder when Web Speech is unavailable', () => {
  module.isRecognitionAvailable.mockReturnValue(false);
  recorder.available.mockReturnValue(true);
  expect(getRecognitionModule()).toMatchObject({ requiresServerTranscription: true });
  expect(module.start).not.toHaveBeenCalled();
});

it('keeps working Web Speech even when recording is also available', () => {
  module.isRecognitionAvailable.mockReturnValue(true);
  recorder.available.mockReturnValue(true);
  expect(getRecognitionModule()?.supportsRecording?.()).toBe(false);
  expect(recorder.create).not.toHaveBeenCalled();
});
