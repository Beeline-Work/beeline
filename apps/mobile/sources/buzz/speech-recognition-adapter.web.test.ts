import { beforeEach, expect, it, vi } from 'vitest';

const module = vi.hoisted(() => ({
  isRecognitionAvailable: vi.fn(), start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  getPermissionsAsync: vi.fn(), requestPermissionsAsync: vi.fn(),
}));
const browser = vi.hoisted(() => ({ shell: false, recording: false,
  recorder: { transcribesOnServerOnly: true, start: vi.fn() } }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => browser.shell }));
vi.mock('./speech-recorder.web', () => ({ recordingAvailable: () => browser.recording,
  createSpeechRecorder: () => browser.recorder }));
vi.mock('expo-speech-recognition/build/ExpoSpeechRecognitionModule', () => ({ ExpoSpeechRecognitionModule: module }));
import { getRecognitionModule } from './speech-recognition-adapter.web';

beforeEach(() => { vi.clearAllMocks(); browser.shell = false; browser.recording = false; });

it('keeps Web Speech when recording is also available in an ordinary browser', () => {
  browser.recording = true;
  module.isRecognitionAvailable.mockReturnValue(true);
  expect(getRecognitionModule()?.supportsRecording?.()).toBe(false);
});

it.each([false, true])('records for server transcription when Web Speech is missing (shell %s)', (shell) => {
  browser.shell = shell; browser.recording = true;
  module.isRecognitionAvailable.mockReturnValue(false);
  expect(getRecognitionModule()).toBe(browser.recorder);
});

it('never selects Web Speech in the Tauri shell even when the API exists', () => {
  browser.shell = true; browser.recording = true;
  module.isRecognitionAvailable.mockReturnValue(true);
  expect(getRecognitionModule()).toBe(browser.recorder);
});

it('hides speech where the browser library reports no recognition API', () => {
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
