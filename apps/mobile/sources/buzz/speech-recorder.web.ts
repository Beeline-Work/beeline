/**
 * Records dictation in the browser for the server's Whisper transcription.
 *
 * Desktop webviews (WKWebView, WebView2, WebKitGTK) and Firefox have no
 * working Web Speech recognizer, but all of them record through
 * getUserMedia. This recorder speaks the same event contract as
 * expo-speech-recognition (volumechange, audioend with a recording URI, error,
 * end) and never emits `result`: the text comes only from the server.
 */
import type { SpeechRecognitionInterface } from './speech-recognition-adapter';

// Whisper's native format, as on iOS and Android.
const SAMPLE_RATE = 16000;
// A piece closes at the first quiet frame after this much audio, so it
// uploads while the user keeps talking.
const PIECE_MINIMUM_SECONDS = 8;
// A piece without a pause still closes here.
const PIECE_MAXIMUM_SECONDS = 30;
// Same envelope as expo-speech-recognition on iOS: -60..0 dBFS maps to -2..10.
const VOLUME_FLOOR_DB = -60;
// Below this level a frame is a pause, so a piece may close there.
const QUIET_DB = -45;
const VOLUME_INTERVAL_MS = 160;
const FRAME_SIZE = 4096;

type Handler = (...args: any[]) => void;

type Capture = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  samples: Float32Array[];
  sampleCount: number;
  lastVolumeAt: number;
};

export function recordingAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window !== 'undefined' &&
    typeof (window.AudioContext ?? (window as any).webkitAudioContext) === 'function'
  );
}

/** Mono 16-bit PCM WAV at SAMPLE_RATE from samples at `inputRate`. */
function encodeDictationWav(chunks: readonly Float32Array[], inputRate: number): Uint8Array {
  const inputLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const ratio = inputRate / SAMPLE_RATE;
  const outputLength = Math.floor(inputLength / ratio);
  const bytes = new Uint8Array(44 + outputLength * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + outputLength * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, outputLength * 2, true);

  const input = new Float32Array(inputLength);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  // Each output sample averages the input samples it covers.
  for (let i = 0; i < outputLength; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += input[j]!;
    const sample = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function frameDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / frame.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function volumeValue(db: number): number {
  const fraction = Math.max(0, Math.min(1, (db - VOLUME_FLOOR_DB) / -VOLUME_FLOOR_DB));
  return -2 + fraction * 12;
}

export function createSpeechRecorder(): SpeechRecognitionInterface {
  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, payload?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  let capture: Capture | null = null;
  // Voids a start whose permission prompt outlived a stop or abort.
  let attempt = 0;

  const closePiece = (current: Capture) => {
    if (!current.sampleCount) return;
    const wav = encodeDictationWav(current.samples, current.context.sampleRate);
    current.samples = [];
    current.sampleCount = 0;
    const uri = URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' }));
    emit('audioend', { uri });
  };

  const release = (current: Capture) => {
    current.processor.onaudioprocess = null;
    current.source.disconnect();
    current.processor.disconnect();
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => {});
  };

  const end = (keep: boolean) => {
    attempt += 1;
    const current = capture;
    capture = null;
    if (current) {
      release(current);
      if (keep) closePiece(current);
    }
    emit('end');
  };

  const start = async () => {
    if (capture) return;
    const mine = ++attempt;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      if (mine !== attempt) return;
      const name = error instanceof DOMException ? error.name : '';
      emit('error', {
        error:
          name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture',
        message: error instanceof Error ? error.message : 'Microphone unavailable',
      });
      emit('end');
      return;
    }
    if (mine !== attempt) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const Context: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    let context: AudioContext | undefined;
    try {
      context = new Context();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);
      const current: Capture = {
        stream,
        context,
        source,
        processor,
        samples: [],
        sampleCount: 0,
        lastVolumeAt: 0,
      };
      processor.onaudioprocess = (event) => {
        if (capture !== current) return;
        const frame = new Float32Array(event.inputBuffer.getChannelData(0));
        current.samples.push(frame);
        current.sampleCount += frame.length;
        const db = frameDb(frame);
        const now = Date.now();
        if (now - current.lastVolumeAt >= VOLUME_INTERVAL_MS) {
          current.lastVolumeAt = now;
          emit('volumechange', { value: volumeValue(db) });
        }
        const seconds = current.sampleCount / current.context.sampleRate;
        if (
          seconds >= PIECE_MAXIMUM_SECONDS ||
          (seconds >= PIECE_MINIMUM_SECONDS && db < QUIET_DB)
        ) {
          closePiece(current);
        }
      };
      source.connect(processor);
      // A ScriptProcessor runs only while connected to the destination; its
      // output buffer stays silent.
      processor.connect(context.destination);
      capture = current;
      void context.resume().catch((error) => {
        if (capture !== current) return;
        emit('error', { error: 'audio-capture', message: String(error) });
        end(false);
      });
      emit('start');
    } catch (error) {
      if (capture?.stream === stream) {
        const current = capture;
        capture = null;
        release(current);
      } else {
        for (const track of stream.getTracks()) track.stop();
        void context?.close().catch(() => {});
      }
      emit('error', { error: 'audio-capture', message: String(error) });
      emit('end');
    }
  };

  return {
    start: () => {
      void start();
    },
    stop: () => end(true),
    abort: () => end(false),
    // getUserMedia owns the browser permission prompt, on the first start.
    getPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
    requestPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
    supportsRecording: () => true,
    transcribesOnServerOnly: true,
    addListener: (event, handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      handlers.set(event, set);
      set.add(handler);
      return { remove: () => set.delete(handler) };
    },
  };
}
