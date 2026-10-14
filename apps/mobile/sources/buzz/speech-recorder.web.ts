import type { SpeechRecognitionInterface } from './speech-recognition-adapter';

// Closed WAV pieces use the existing dictation uploader, retry and lexicon.
const PIECE_SECONDS = 30;
// The same -50 dB floor used for the emitted recognizer volume.
const SPEECH_RMS_FLOOR = 10 ** (-50 / 20);
export const MAXIMUM_RECORDING_MS = 5 * 60_000;
const permission = async () => ({ status: 'granted', granted: true, canAskAgain: true });

export function speechRecordingAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioContext !== 'undefined'
  );
}

function wavBlob(parts: readonly Float32Array[], samples: number, rate: number): Blob {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const part of parts) {
    for (const sample of part) {
      const clipped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Captures mono WAV without requiring Web Speech or MediaRecorder codecs. */
export function createSpeechRecorder(): SpeechRecognitionInterface {
  const listeners = new Map<string, Set<(event?: any) => void>>();
  let epoch = 0;
  let pending = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let parts: Float32Array[] = [];
  let samples = 0;
  let hasSpeech = false;
  const emit = (event: string, value?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const flush = () => {
    if (!samples || !context) return;
    if (!hasSpeech) {
      parts = [];
      samples = 0;
      hasSpeech = false;
      return;
    }
    const uri = URL.createObjectURL(wavBlob(parts, samples, context.sampleRate));
    parts = [];
    samples = 0;
    hasSpeech = false;
    // A stopped/unmounted hook cannot own a newly created recording.
    if (listeners.get('audioend')?.size) emit('audioend', { uri });
    else URL.revokeObjectURL(uri);
  };
  const cleanup = () => {
    clearTimeout(limit);
    limit = undefined;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      processor = null;
    }
    source?.disconnect();
    source = null;
    // Disconnect before stopping tracks, whose ended event can call stop.
    const captured = stream;
    stream = null;
    captured?.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
    context = null;
    parts = [];
    samples = 0;
    hasSpeech = false;
  };
  const abort = () => {
    epoch++;
    pending = false;
    cleanup();
  };
  const stop = () => {
    if (!pending && !stream) return;
    const stoppedEpoch = ++epoch;
    pending = false;
    flush();
    cleanup();
    // Let the hook enter finalizing before delivering the capture's end.
    queueMicrotask(() => {
      if (epoch === stoppedEpoch) emit('end');
    });
  };
  return {
    requiresServerTranscription: true,
    supportsRecording: () => true,
    getPermissionsAsync: permission,
    requestPermissionsAsync: permission,
    addListener(event, listener) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(listener);
      return {
        remove: () => {
          handlers.delete(listener);
        },
      };
    },
    start() {
      abort();
      const startedEpoch = epoch;
      pending = true;
      void (async () => {
        try {
          const captured = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
            video: false,
          });
          if (startedEpoch !== epoch) {
            captured.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = captured;
          context = new AudioContext();
          source = context.createMediaStreamSource(captured);
          // ScriptProcessor also works in WebKit engines without MediaRecorder.
          // Its output stays zero: only the silent node connects to destination
          // to keep capture callbacks running; microphone audio is never played.
          processor = context.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (event) => {
            if (startedEpoch !== epoch || !context) return;
            event.outputBuffer.getChannelData(0).fill(0);
            const input = event.inputBuffer.getChannelData(0);
            parts.push(input.slice());
            samples += input.length;
            let energy = 0;
            for (const sample of input) energy += sample * sample;
            const rms = Math.sqrt(energy / input.length);
            if (rms > SPEECH_RMS_FLOOR) hasSpeech = true;
            // Match the recognizer's silence floor and approximate level range.
            emit('volumechange', { value: Math.max(-2, Math.min(10, 20 * Math.log10(rms) + 50)) });
            if (samples >= context.sampleRate * PIECE_SECONDS) flush();
          };
          source.connect(processor);
          processor.connect(context.destination);
          await context.resume();
          if (startedEpoch !== epoch) return;
          pending = false;
          captured
            .getAudioTracks()
            .forEach((track) => track.addEventListener('ended', stop, { once: true }));
          limit = setTimeout(stop, MAXIMUM_RECORDING_MS);
          emit('start');
        } catch (error) {
          if (startedEpoch !== epoch) return;
          pending = false;
          cleanup();
          const denied =
            error instanceof Error && ['NotAllowedError', 'SecurityError'].includes(error.name);
          emit('error', { error: denied ? 'not-allowed' : 'audio-capture' });
          emit('end');
        }
      })();
    },
    stop,
    abort,
  };
}
