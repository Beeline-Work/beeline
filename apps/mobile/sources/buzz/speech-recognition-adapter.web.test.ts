import { beforeEach, expect, it, vi } from 'vitest';

const module = vi.hoisted(() => ({
  isRecognitionAvailable: vi.fn(), start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  getPermissionsAsync: vi.fn(), requestPermissionsAsync: vi.fn(),
}));
vi.mock('expo-speech-recognition/build/ExpoSpeechRecognitionModule', () => ({ ExpoSpeechRecognitionModule: module }));
import { getRecognitionModule } from './speech-recognition-adapter.web';

beforeEach(() => vi.clearAllMocks());

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
