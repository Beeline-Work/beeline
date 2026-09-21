import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
    select: (c: any) => c.default,
  },
}));
vi.mock('./speech-recognition-adapter', () => ({
  getRecognitionModule: vi.fn(),
}));
vi.mock('./speech-locale', () => ({
  getDeviceSpeechLocale: () => 'en-GB',
}));

const platformState = vi.hoisted(() => ({ OS: 'android' }));

const mockMod = {
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  supportsOnDeviceRecognition: vi.fn(),
  addListener: vi.fn(),
};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const handlerMap = new Map<string, (...args: any[]) => void>();
function fireEvent(event: string, data?: any) {
  handlerMap.get(event)?.(data);
}

function Harness({ onResult }: { onResult: (t: string) => void }) {
  const speech = useSpeechInput(onResult);
  // Expose state through serializable props so react-test-renderer can find them.
  return React.createElement('div', {
    'data-state': speech.state,
    'data-capability': speech.capability,
    'data-partial': speech.partialText,
    speechRef: speech,
  } as any);
}

function renderHook(onResult = vi.fn()) {
  let renderer: any;
  act(() => {
    renderer = create(React.createElement(Harness, { onResult }));
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

  it('falls back to the platform default when on-device is unsupported', async () => {
    vi.useFakeTimers();
    mockMod.supportsOnDeviceRecognition.mockReturnValue(false);
    const { speech, probe } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
  });

  it('falls back when the optional on-device capability probe throws', async () => {
    mockMod.supportsOnDeviceRecognition.mockImplementation(() => {
      throw new Error('capability unavailable');
    });
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
  });

  it('uses on-device recognition on iOS when the platform supports it', async () => {
    platformState.OS = 'ios';
    const { speech } = renderHook();
    await act(async () => {
      await speech().start();
    });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: true, lang: 'en-GB' }),
    );
    platformState.OS = 'android';
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
