import { beforeEach, describe, expect, it, vi } from 'vitest';

// The captain's runtime-23 Android binary predates expo-speech-recognition's
// native half. Requiring the JS package there throws `Cannot find native module
// 'ExpoSpeechRecognition'` from inside the package, and that throw reached React
// through ConversationComposer: the whole Room screen rendered blank
// (2026-09-14). The adapter must ask whether the native module exists before it
// requires the package at all, and must never let a failure escape.
describe('speech recognition adapter without the native module', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
  });

  it('reports no recogniser and never requires the package', async () => {
    const requirePackage = vi.fn(() => {
      throw new Error("Cannot find native module 'ExpoSpeechRecognition'");
    });
    vi.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
    vi.doMock('expo-speech-recognition', requirePackage);

    const { getRecognitionModule } = await import('./speech-recognition-adapter');
    expect(getRecognitionModule()).toBeNull();
    expect(requirePackage).not.toHaveBeenCalled();
  });

  it('reports no recogniser when expo-modules-core cannot answer', async () => {
    vi.doMock('expo-modules-core', () => ({}));
    const { getRecognitionModule } = await import('./speech-recognition-adapter');
    expect(getRecognitionModule()).toBeNull();
  });

  it('swallows a package that throws while loading', async () => {
    vi.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({}) }));
    vi.doMock('expo-speech-recognition', () => {
      throw new Error("Cannot find native module 'ExpoSpeechRecognition'");
    });
    const { getRecognitionModule } = await import('./speech-recognition-adapter');
    expect(() => getRecognitionModule()).not.toThrow();
    expect(getRecognitionModule()).toBeNull();
  });
});
