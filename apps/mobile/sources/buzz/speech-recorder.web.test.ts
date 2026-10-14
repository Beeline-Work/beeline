import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createSpeechRecorder,
  MAXIMUM_RECORDING_MS,
  speechRecordingAvailable,
} from './speech-recorder.web';

let processAudio: ((event: any) => void) | null;
let ended: (() => void) | null;
const track = {
  stop: vi.fn(),
  addEventListener: vi.fn((_event, handler) => {
    ended = handler;
  }),
};
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
const capture = vi.fn();
const disconnect = vi.fn();
const close = vi.fn(async () => {});
const urls: Blob[] = [];
let recorder: ReturnType<typeof createSpeechRecorder>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  processAudio = null;
  ended = null;
  urls.length = 0;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } });
  capture.mockResolvedValue(stream);
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 16000;
      destination = {};
      resume = async () => {};
      close = close;
      createMediaStreamSource = () => ({ connect() {}, disconnect });
      createScriptProcessor = () => ({
        set onaudioprocess(handler) {
          processAudio = handler;
        },
        connect() {},
        disconnect,
      });
    },
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    urls.push(blob as Blob);
    return `blob:piece-${urls.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  recorder = createSpeechRecorder();
});
afterEach(() => {
  recorder.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
function audio(length = 4096, value = 0.25) {
  const output = new Float32Array(length).fill(1);
  processAudio!({
    inputBuffer: { getChannelData: () => new Float32Array(length).fill(value) },
    outputBuffer: { getChannelData: () => output },
  });
  expect(output.every((sample) => sample === 0)).toBe(true);
}

it('checks capture support without opening the microphone', () => {
  expect(speechRecordingAvailable()).toBe(true);
  expect(capture).not.toHaveBeenCalled();
  vi.stubGlobal('AudioContext', undefined);
  expect(speechRecordingAvailable()).toBe(false);
});

it('captures mono WAV with echo cancellation and never plays microphone samples', async () => {
  const pieces = vi.fn();
  const end = vi.fn();
  const volume = vi.fn();
  recorder.addListener!('audioend', pieces);
  recorder.addListener!('end', end);
  recorder.addListener!('volumechange', volume);
  recorder.start({});
  await settle();
  audio();
  recorder.stop();
  await vi.runAllTicks();
  expect(capture).toHaveBeenCalledWith({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    video: false,
  });
  expect(pieces).toHaveBeenCalledWith({ uri: 'blob:piece-1' });
  const view = new DataView(await urls[0]!.arrayBuffer());
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getInt16(44, true)).toBe(8192);
  expect(volume).toHaveBeenCalledWith({ value: expect.any(Number) });
  expect(end).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('stops a stream that arrives after abort during the permission prompt', async () => {
  let allow!: (value: unknown) => void;
  capture.mockReturnValue(
    new Promise((resolve) => {
      allow = resolve;
    }),
  );
  const started = vi.fn();
  recorder.addListener!('start', started);
  recorder.start({});
  recorder.abort();
  allow(stream);
  await settle();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(started).not.toHaveBeenCalled();
  expect(processAudio).toBeNull();
});

it('settles stop before permission arrives without starting late capture', async () => {
  let allow!: (value: unknown) => void;
  capture.mockReturnValue(
    new Promise((resolve) => {
      allow = resolve;
    }),
  );
  const end = vi.fn();
  recorder.addListener!('end', end);
  recorder.start({});
  recorder.stop();
  await vi.runAllTicks();
  allow(stream);
  await settle();
  expect(end).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(processAudio).toBeNull();
});

it('reports denial, then can retry capture', async () => {
  capture.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
  const error = vi.fn();
  recorder.addListener!('error', error);
  recorder.start({});
  await settle();
  expect(error).toHaveBeenCalledWith({ error: 'not-allowed' });
  recorder.start({});
  await settle();
  expect(processAudio).toBeTypeOf('function');
});

it('closes pieces while recording and bounds a long take', async () => {
  const piece = vi.fn();
  const end = vi.fn();
  recorder.addListener!('audioend', piece);
  recorder.addListener!('end', end);
  recorder.start({});
  await settle();
  audio(16000 * 30);
  expect(piece).toHaveBeenCalledOnce();
  expect(track.stop).not.toHaveBeenCalled();
  audio();
  await vi.advanceTimersByTimeAsync(MAXIMUM_RECORDING_MS);
  expect(piece).toHaveBeenCalledTimes(2);
  expect(end).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
});

it('drops aborted audio and closes capture errors without leaking resources', async () => {
  const piece = vi.fn();
  recorder.addListener!('audioend', piece);
  recorder.start({});
  await settle();
  audio();
  recorder.abort();
  expect(piece).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('handles a lost microphone once and releases an unclaimed recording', async () => {
  const end = vi.fn();
  recorder.addListener!('end', end);
  recorder.start({});
  await settle();
  audio();
  ended!();
  await vi.runAllTicks();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:piece-1');
  expect(end).toHaveBeenCalledOnce();
});

it('does not upload silence when stopped before speech', async () => {
  const piece = vi.fn();
  recorder.addListener!('audioend', piece);
  recorder.start({});
  await settle();
  audio(4096, 0);
  recorder.stop();
  await vi.runAllTicks();
  expect(piece).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalledOnce();
});

it('can start another take after stopping the first', async () => {
  recorder.addListener!('audioend', () => {});
  recorder.start({});
  await settle();
  audio();
  recorder.stop();
  await vi.runAllTicks();
  recorder.start({});
  await settle();
  audio();
  recorder.stop();
  await vi.runAllTicks();
  expect(capture).toHaveBeenCalledTimes(2);
  expect(track.stop).toHaveBeenCalledTimes(2);
  expect(urls).toHaveLength(2);
});

it('releases the microphone and context when audio setup fails', async () => {
  const Context = globalThis.AudioContext;
  vi.stubGlobal(
    'AudioContext',
    class extends Context {
      createScriptProcessor = () => {
        throw new Error('audio setup failed');
      };
    },
  );
  const error = vi.fn();
  const end = vi.fn();
  recorder.addListener!('error', error);
  recorder.addListener!('end', end);
  recorder.start({});
  await settle();
  expect(error).toHaveBeenCalledWith({ error: 'audio-capture' });
  expect(end).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
