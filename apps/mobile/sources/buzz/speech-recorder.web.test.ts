import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSpeechRecorder } from './speech-recorder.web';

let processor: { onaudioprocess: ((event: any) => void) | null; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
let stop: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let media: ReturnType<typeof vi.fn>;
let captureRate: number;
beforeEach(() => {
  captureRate = 16000;
  stop = vi.fn(); close = vi.fn(async () => {});
  processor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
  media = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  class Context {
    sampleRate = captureRate; destination = {};
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createScriptProcessor() { return processor; }
    resume = vi.fn(async () => {}); close = close;
  }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } });
  vi.stubGlobal('window', { AudioContext: Context });
});
afterEach(() => vi.unstubAllGlobals());

it('captures mono echo-cancelled audio, closes a quiet piece, and releases on stop', async () => {
  const recorder = createSpeechRecorder();
  const audio = vi.fn(); const result = vi.fn();
  recorder.addListener?.('audioend', audio); recorder.addListener?.('result', result);
  recorder.start({}); await Promise.resolve();
  expect(media).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true, channelCount: 1 }) });
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(16000 * 9) } });
  expect(audio).toHaveBeenCalledOnce();
  const uri = audio.mock.calls[0]![0].uri;
  const bytes = await (await fetch(uri)).arrayBuffer(); URL.revokeObjectURL(uri);
  expect(new DataView(bytes).getUint32(24, true)).toBe(16000);
  expect(bytes.byteLength).toBe(44 + 16000 * 9 * 2);
  recorder.stop();
  expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  expect(processor.onaudioprocess).toBeNull(); expect(result).not.toHaveBeenCalled();
});

it('abort discards the take and cancels a pending permission grant', async () => {
  let grant!: (value: any) => void;
  media.mockReturnValue(new Promise(resolve => { grant = resolve; }));
  const recorder = createSpeechRecorder(); const audio = vi.fn();
  recorder.addListener?.('audioend', audio);
  recorder.start({}); recorder.abort();
  grant({ getTracks: () => [{ stop }] }); await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce(); expect(audio).not.toHaveBeenCalled();
  expect(processor.connect).not.toHaveBeenCalled();
});

it('permission denial emits the existing recognizer error/end contract', async () => {
  media.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  const recorder = createSpeechRecorder(); const error = vi.fn(); const end = vi.fn();
  recorder.addListener?.('error', error); recorder.addListener?.('end', end);
  recorder.start({}); await Promise.resolve();
  expect(error).toHaveBeenCalledWith({ error: 'not-allowed', message: 'Denied' });
  expect(end).toHaveBeenCalledOnce();
});

it('setup failure stops tracks instead of leaking a microphone', async () => {
  vi.stubGlobal('window', { AudioContext: class { constructor() { throw new Error('No context'); } } });
  const recorder = createSpeechRecorder(); const error = vi.fn();
  recorder.addListener?.('error', error); recorder.start({}); await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'audio-capture' }));
});

it('resamples captured 48 kHz audio to a clipped 16 kHz mono PCM WAV', async () => {
  captureRate = 48000;
  const recorder = createSpeechRecorder(); const audio = vi.fn();
  recorder.addListener?.('audioend', audio); recorder.start({}); await Promise.resolve();
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from([2, 2, 2, -2, -2, -2]) } });
  recorder.stop();
  const uri = audio.mock.calls[0]![0].uri;
  const wav = await (await fetch(uri)).arrayBuffer(); URL.revokeObjectURL(uri);
  const view = new DataView(wav);
  expect(wav.byteLength).toBe(48);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getInt16(44, true)).toBe(32767);
  expect(view.getInt16(46, true)).toBe(-32768);
});
