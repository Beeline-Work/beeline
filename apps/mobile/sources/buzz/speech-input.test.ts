import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeechInput } from './speech-input';
import { getRecognitionModule } from './speech-recognition-adapter';

vi.mock('react-native', () => ({
  Platform: { get OS() { return platformState.OS; }, select: (c: any) => c.default },
}));
vi.mock('./speech-recognition-adapter', () => ({
  getRecognitionModule: vi.fn(),
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
    speech: () => (renderer.root.findByProps({ 'data-capability': 'available' }).props.speechRef as any),
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
  mockMod.getPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true });
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

    await act(async () => { await speech().start(); });
    expect(speech().state).toBe('listening');
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: true, interimResults: true, continuous: true }),
    );

    await act(async () => { fireEvent('result', { results: [{ transcript: 'hello' }], isFinal: false }); });
    expect(probe()['data-partial']).toBe('hello');
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => { fireEvent('result', { results: [{ transcript: 'hello world' }], isFinal: true }); });
    expect(onResult).toHaveBeenCalledWith('hello world');
    expect(speech().partialText).toBe('');

    await act(async () => { speech().stop(); });
    expect(speech().state).toBe('idle');
    expect(mockMod.stop).toHaveBeenCalled();
  });

  it('falls back to the platform default when on-device is unsupported', async () => {
    vi.useFakeTimers();
    mockMod.supportsOnDeviceRecognition.mockReturnValue(false);
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });
    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({ requiresOnDeviceRecognition: false }),
    );
  });

  it('auto-stops after ~2 s of silence', async () => {
    vi.useFakeTimers();
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });

    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(speech().state).toBe('nothing-recognised');
    expect(mockMod.stop).toHaveBeenCalled();
  });

  it('interim results keep resetting the silence timer', async () => {
    vi.useFakeTimers();
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        fireEvent('result', { results: [{ transcript: `word ${i}` }], isFinal: false });
        vi.advanceTimersByTime(1500);
      });
      expect(speech().state).toBe('listening');
    }

    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(speech().state).not.toBe('listening');
  });

  it('restarts the session transparently when the platform ends it', async () => {
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });
    mockMod.start.mockClear();

    await act(async () => { fireEvent('end', null); });
    expect(mockMod.start).toHaveBeenCalledOnce();
    expect(speech().state).toBe('listening');

    await act(async () => { fireEvent('nomatch', null); });
    expect(mockMod.start).toHaveBeenCalledTimes(2);
  });

  it('permission denied sets the permission-denied state', async () => {
    mockMod.getPermissionsAsync.mockResolvedValue({ status: 'denied', granted: false, canAskAgain: false });
    mockMod.requestPermissionsAsync.mockResolvedValue({ status: 'denied', granted: false, canAskAgain: false });
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });
    expect(speech().state).toBe('permission-denied');
    expect(mockMod.start).not.toHaveBeenCalled();
  });

  it('runtime not-allowed error sets permission-denied', async () => {
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });
    await act(async () => { fireEvent('error', { error: 'not-allowed' }); });
    expect(speech().state).toBe('permission-denied');
  });

  it('stopping with nothing recognised reports the nothing-recognised state', async () => {
    const { speech, probe } = renderHook();
    await act(async () => { await speech().start(); });
    await act(async () => { speech().stop(); });
    expect(speech().state).toBe('nothing-recognised');
  });

  it('is unavailable off device platforms', async () => {
    platformState.OS = 'web';
    vi.mocked(getRecognitionModule).mockReturnValue(null);
    const { probe } = renderHook();
    await act(async () => {});
    expect(probe()['data-capability']).toBe('unavailable');
    platformState.OS = 'android';
  });
});
