import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANDROID_GOOGLE_RECOGNITION_SERVICE,
  SPEECH_FINALIZATION_TIMEOUT_MS,
  SPEECH_SILENCE_TIMEOUT_MS,
  useSpeechInput,
} from './speech-input';
import { getRecognitionModule } from './speech-recognition-adapter';

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformState.OS;
    },
    get Version() {
      return platformState.Version;
    },
    select: (c: any) => c.default,
  },
}));
vi.mock('./speech-recognition-adapter', () => ({
  getRecognitionModule: vi.fn(),
}));
vi.mock('./speech-locale', () => ({
  getDeviceSpeechLocale: () => 'en-GB',
}));

// Android 13 never offers the on-device model, so most tests start straight away.
const platformState = vi.hoisted(() => ({ OS: 'android', Version: 33 }));

const mockMod = {
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  supportsOnDeviceRecognition: vi.fn(),
  getSupportedLocales: vi.fn(),
  androidTriggerOfflineModelDownload: vi.fn(),
  getSpeechRecognitionServices: vi.fn(),
  addListener: vi.fn(),
};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const handlerMap = new Map<string, (...args: any[]) => void>();
function fireEvent(event: string, data?: any) {
  handlerMap.get(event)?.(data);
}

function Harness({
  onResult,
  contextualStrings,
}: {
  onResult: (t: string) => void;
  contextualStrings?: string[];
}) {
  const speech = useSpeechInput(onResult, contextualStrings);
  // Expose state through serializable props so react-test-renderer can find them.
  return React.createElement('div', {
    'data-state': speech.state,
    'data-capability': speech.capability,
    'data-partial': speech.partialText,
    speechRef: speech,
  } as any);
}

function renderHook(onResult = vi.fn(), contextualStrings?: string[]) {
  let renderer: any;
  act(() => {
    renderer = create(React.createElement(Harness, { onResult, contextualStrings }));
  });
  return {
    renderer,
    onResult,
    speech: () =>
      renderer.root.findByProps({ 'data-capability': 'available' }).props.speechRef as any,
    probe: () => renderer.root.findByType('div').props as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlerMap.clear();
  mockMod.addListener.mockImplementation((event: string, handler: (...args: any[]) => void) => {
    handlerMap.set(event, handler);
    return { remove: () => handlerMap.delete(event) };
  });
  mockMod.getPermissionsAsync.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  });
  mockMod.supportsOnDeviceRecognition.mockReturnValue(true);
  // Most Android tests cover a phone without Google's recognizer.
  mockMod.getSpeechRecognitionServices.mockReturnValue([]);
  mockMod.getSupportedLocales.mockResolvedValue({ locales: [], installedLocales: [] });
  mockMod.androidTriggerOfflineModelDownload.mockResolvedValue({
    status: 'download_success',
    message: '',
  });
  platformState.Version = 33;
  vi.mocked(getRecognitionModule).mockReturnValue(mockMod as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSpeechInput', () => {
  it('start -> interim -> final -> stop commits finals immediately', async () => {
    vi.useFakeTimers();
    const { renderer, onResult, speech, probe } = renderHook();

    await act(async () => {
      await speech().start();
    });
    expect(speech().state).toBe('listening');
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({
        lang: 'en-GB',
        requiresOnDeviceRecognition: false,
        interimResults: true,
        continuous: true,
        volumeChangeEventOptions: { enabled: true, intervalMillis: 160 },
      }),
    );

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'hello' }], isFinal: false });
    });
    expect(probe()['data-partial']).toBe('hello');
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'hello world' }], isFinal: true });
    });
    expect(onResult).toHaveBeenCalledWith('hello world');
    expect(speech().partialText).toBe('');

    await act(async () => {
      speech().stop();
      fireEvent('end');
    });
    expect(speech().state).toBe('idle');
    expect(mockMod.stop).toHaveBeenCalled();
  });

  it('passes contextual names to the recogniser only when there are some', async () => {
    const { speech } = renderHook(vi.fn(), ['Niglet', 'Emberus']);
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextualStrings: ['Niglet', 'Emberus'] }),
    );

    const bare = renderHook();
    await act(async () => {
      await bare.speech().start();
    });
    expect(mockMod.start.mock.lastCall?.[0]).not.toHaveProperty('contextualStrings');
  });

  it("uses Apple's server recognizer on iOS even when on-device is supported", async () => {
    platformState.OS = 'ios';
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false, lang: 'en-GB' }),
    );
    expect(mockMod.start.mock.lastCall?.[0]).not.toHaveProperty('androidRecognitionServicePackage');
    platformState.OS = 'android';
  });

  it("pins Google's server recognizer on Android when it is installed, without the model offer", async () => {
    platformState.Version = 34;
    mockMod.getSpeechRecognitionServices.mockReturnValue([
      'com.samsung.android.bixby.agent',
      ANDROID_GOOGLE_RECOGNITION_SERVICE,
    ]);
    mockMod.getSupportedLocales.mockResolvedValue({ locales: [], installedLocales: ['en-GB'] });
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(speech().modelDownloadOffered).toBe(false);
    expect(mockMod.getSupportedLocales).not.toHaveBeenCalled();
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresOnDeviceRecognition: false,
        androidRecognitionServicePackage: ANDROID_GOOGLE_RECOGNITION_SERVICE,
        addsPunctuation: true,
      }),
    );
  });

  it('commits the alternative that names Room terms, snapped to the lexicon', async () => {
    const { speech, probe, onResult } = renderHook(vi.fn(), ['Groq', 'OpenRouter']);
    await act(async () => {
      await speech().start();
    });
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'try croc' }], isFinal: false });
    });
    expect(probe()['data-partial']).toBe('try Groq');
    await act(async () => {
      fireEvent('result', {
        results: [
          { transcript: 'try crack and open router' },
          { transcript: 'try croc and open rotor' },
        ],
        isFinal: true,
      });
    });
    expect(onResult).toHaveBeenCalledWith('try Groq and OpenRouter');
  });

  it('uses the Android on-device recognizer, which punctuates, when the locale is installed', async () => {
    mockMod.getSupportedLocales.mockResolvedValue({
      locales: ['en-GB', 'en-US'],
      installedLocales: ['en_gb'],
    });
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: true, addsPunctuation: true }),
    );
    expect(mockMod.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
  });

  it('offers the missing model on Android 14+ and requests it only when accepted', async () => {
    platformState.Version = 34;
    mockMod.getSupportedLocales.mockResolvedValue({ locales: [], installedLocales: ['en-US'] });
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(speech().modelDownloadOffered).toBe(true);
    expect(mockMod.start).not.toHaveBeenCalled();
    expect(mockMod.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();

    act(() => speech().acceptModelDownload());
    expect(speech().modelDownloadOffered).toBe(false);
    expect(mockMod.androidTriggerOfflineModelDownload).toHaveBeenCalledWith({ locale: 'en-GB' });
    expect(mockMod.start).not.toHaveBeenCalled();

    // The next mic tap dictates through the platform recognizer, without asking again.
    await act(async () => {
      await speech().start();
    });
    expect(speech().modelDownloadOffered).toBe(false);
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
  });

  it('starts dictating without the model when its offer is declined', async () => {
    platformState.Version = 34;
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(speech().modelDownloadOffered).toBe(true);
    await act(async () => {
      await speech().declineModelDownload();
    });
    expect(speech().modelDownloadOffered).toBe(false);
    expect(speech().state).toBe('listening');
    expect(mockMod.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
  });

  it('does not offer the model on Android 13, where the platform owns the whole download', async () => {
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
    expect(speech().modelDownloadOffered).toBe(false);
    expect(mockMod.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
  });

  it('falls back to the Android platform recognizer when the on-device one rejects the locale', async () => {
    mockMod.getSupportedLocales.mockResolvedValue({ locales: [], installedLocales: ['en-GB'] });
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    await act(async () => {
      fireEvent('error', { error: 'language-not-supported' });
      fireEvent('end');
    });
    expect(mockMod.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
  });

  it('maps native volume changes to the mic activity range', async () => {
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });
    await act(async () => {
      fireEvent('volumechange', { value: 4 });
    });
    expect(probe().speechRef.volumeLevel).toBe(0.5);
    await act(async () => {
      fireEvent('volumechange', { value: 20 });
    });
    expect(probe().speechRef.volumeLevel).toBe(1);
  });

  it('auto-stops after silence with nothing recognised', async () => {
    vi.useFakeTimers();
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });

    await act(async () => {
      vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS + 100);
    });
    expect(speech().state).toBe('nothing-recognised');
    expect(mockMod.stop).toHaveBeenCalled();
  });

  it('does not pair captured text with a nothing-caught error', async () => {
    vi.useFakeTimers();
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
    });

    await act(async () => {
      vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS + 100);
    });
    expect(speech().state).toBe('nothing-recognised');

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'Sally sell' }], isFinal: false });
      fireEvent('end');
    });

    expect(onResult).toHaveBeenCalledWith('Sally sell');
    expect(speech().state).toBe('idle');
    expect(speech().partialText).toBe('');
  });

  it('does not stop mid-utterance when interim results are sparse', async () => {
    vi.useFakeTimers();
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
    });

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'Sally sell' }], isFinal: false });
    });

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(speech().state).toBe('listening');

    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'Sally sells seashells by the seashore' }],
        isFinal: true,
      });
    });
    expect(onResult).toHaveBeenCalledWith('Sally sells seashells by the seashore');
    expect(speech().state).toBe('listening');
  });

  it('gives a short phrase time to produce its first hypothesis', async () => {
    vi.useFakeTimers();
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(speech().state).toBe('listening');
  });

  it('does not treat silent volume as speech', async () => {
    vi.useFakeTimers();
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });

    await act(async () => {
      fireEvent('volumechange', { value: -2 });
      vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS + 100);
    });
    expect(speech().state).toBe('nothing-recognised');
    expect(speech().partialText).toBe('');
  });

  it('keeps listening while speech volume continues without new hypotheses', async () => {
    vi.useFakeTimers();
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });

    await act(async () => {
      fireEvent('volumechange', { value: 4 });
      vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS - 500);
      fireEvent('volumechange', { value: 6 });
      vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS - 500);
    });
    expect(speech().state).toBe('listening');
  });

  it('interim results keep resetting the silence timer', async () => {
    vi.useFakeTimers();
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        fireEvent('result', { results: [{ transcript: `word ${i}` }], isFinal: false });
        vi.advanceTimersByTime(1500);
      });
      expect(speech().state).toBe('listening');
    }

    await act(async () => {
      vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS + 100);
    });
    expect(speech().state).not.toBe('listening');
  });

  it('restarts the session transparently when the platform ends it', async () => {
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });
    mockMod.start.mockClear();

    await act(async () => {
      fireEvent('end', null);
    });
    expect(mockMod.start).toHaveBeenCalledOnce();
    expect(speech().state).toBe('listening');

    await act(async () => {
      fireEvent('nomatch', null);
    });
    expect(mockMod.start).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent('end', null);
    });
    expect(mockMod.start).toHaveBeenCalledTimes(2);
  });

  it('waits for end after an error so error and end cannot start two recognizers', async () => {
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    mockMod.start.mockClear();
    await act(async () => {
      fireEvent('error', { error: 'network' });
    });
    expect(mockMod.start).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent('end', null);
    });
    expect(mockMod.start).toHaveBeenCalledOnce();
  });

  it('permission denied sets the permission-denied state', async () => {
    mockMod.getPermissionsAsync.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: false,
    });
    mockMod.requestPermissionsAsync.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: false,
    });
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(speech().state).toBe('permission-denied');
    expect(mockMod.start).not.toHaveBeenCalled();
  });

  it('runtime not-allowed error sets permission-denied', async () => {
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });
    await act(async () => {
      fireEvent('error', { error: 'not-allowed' });
    });
    expect(speech().state).toBe('permission-denied');
  });

  it('treats an explicit empty stop as neutral', async () => {
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    await act(async () => {
      speech().stop();
      fireEvent('end');
    });
    expect(speech().state).toBe('idle');
  });

  it('commits the latest interim when Android ends a requested stop without a final', async () => {
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
      fireEvent('result', { results: [{ transcript: 'keep these words' }], isFinal: false });
    });
    await act(async () => {
      speech().stop();
      fireEvent('error', { error: 'client' });
      fireEvent('end');
    });
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith('keep these words');
    expect(speech().state).toBe('idle');
  });

  it('waits for the final transcript after stop instead of committing a truncated interim', async () => {
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
      fireEvent('result', { results: [{ transcript: 'send these words' }], isFinal: false });
    });
    let stopResult: Promise<boolean>;
    await act(async () => {
      stopResult = speech().stop();
    });
    expect(speech().state).toBe('finalizing');
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'send these words completely' }],
        isFinal: true,
      });
    });
    await expect(stopResult!).resolves.toBe(true);
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith('send these words completely');
    expect(speech().state).toBe('idle');
    expect(speech().partialText).toBe('');
  });

  it('falls back to the latest interim when Android ends without a final result', async () => {
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
      fireEvent('result', { results: [{ transcript: 'hello' }], isFinal: false });
    });
    await act(async () => {
      speech().stop();
      fireEvent('end');
    });
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith('hello');
  });

  it('bounds finalization when the recognizer emits neither final nor end', async () => {
    vi.useFakeTimers();
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
      fireEvent('result', { results: [{ transcript: 'bounded fallback' }], isFinal: false });
    });

    let stopResult: Promise<boolean>;
    await act(async () => {
      stopResult = speech().stop();
    });
    expect(speech().state).toBe('finalizing');
    await act(async () => {
      vi.advanceTimersByTime(SPEECH_FINALIZATION_TIMEOUT_MS);
    });

    await expect(stopResult!).resolves.toBe(true);
    expect(onResult).toHaveBeenCalledWith('bounded fallback');
    expect(speech().state).toBe('idle');
  });

  it('ignores recognizer results after a stopped session has ended', async () => {
    const { onResult, speech } = renderHook();
    await act(async () => {
      await speech().start();
      speech().stop();
      fireEvent('end');
      fireEvent('result', { results: [{ transcript: 'stale words' }], isFinal: true });
    });
    expect(onResult).not.toHaveBeenCalled();
  });

  it('is unavailable off device platforms', async () => {
    platformState.OS = 'web';
    vi.mocked(getRecognitionModule).mockReturnValue(null);
    const { probe } = renderHook();
    await act(async () => {});
    expect(probe()['data-capability']).toBe('unavailable');
    platformState.OS = 'android';
  });

  it('is unavailable when a device build does not contain the native recognizer', async () => {
    vi.mocked(getRecognitionModule).mockReturnValue(null);
    const { probe } = renderHook();
    expect(probe()['data-capability']).toBe('unavailable');
  });
});
