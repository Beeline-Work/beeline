/**
 * Sends a dictation's recorded pieces to the Beeline server as they close; the
 * server transcribes them with Groq Whisper. The Groq key stays on the server.
 * Any failure answers null so the caller keeps the on-device transcript.
 */
import { monolithSession } from '@/auth/monolith-session';
import { readFileBytes } from '@/utils/readFileBytes';
import { getBuzzRuntimeConfig } from './runtime-config';
import { joinSpeechPieces } from './speech-correction';
import {
  compressDictationWav,
  concatDictationWavs,
  dictationWavSeconds,
  splitDictationWav,
} from './wav-adpcm';

// Pieces upload while the user talks, so stop waits only for the last one.
export const DICTATION_TRANSCRIPTION_TIMEOUT_MS = 5000;
// A long last piece needs time to upload: 8 KB of ADPCM per second of speech
// is 64 ms on a 1 Mbit/s uplink. Stop waits this much more per second still out.
const STOP_WAIT_PER_AUDIO_SECOND_MS = 150;
const MAXIMUM_STOP_WAIT_MS = 30_000;
// Longer pieces go to Groq as chunks of this length, sent together, so each
// request stays well inside PIECE_TIMEOUT_MS.
const CHUNK_SECONDS = 60;
// One piece may be long and sent on a weak link while the user keeps talking.
const PIECE_TIMEOUT_MS = 15_000;
// A shorter piece is a word or two; Whisper hears it better with the next one.
export const MERGE_BELOW_SECONDS = 2;
// The server cuts prompts here (Whisper reads at most 224 tokens).
const PROMPT_MAXIMUM_CHARACTERS = 600;
// The end of the text so far that each piece is prompted to continue.
const PROMPT_CONTEXT_CHARACTERS = 200;

// A server without GROQ_API_KEY answers 503; stop recording for this app run.
let serverTranscriptionUnavailable = false;

export function dictationTranscriptionAvailable(): boolean {
  return !serverTranscriptionUnavailable;
}

/** Deletes recordings that will not be transcribed again. */
export async function discardDictationRecordings(uris: readonly string[]): Promise<void> {
  if (!uris.length) return;
  try {
    const { File } = await import('expo-file-system');
    for (const uri of uris) {
      try {
        new File(uri).delete();
      } catch {
        // The recording lives in the cache directory; the OS clears it eventually.
      }
    }
  } catch {
    // Without the file module the cache directory keeps the recording.
  }
}

async function transcribeOne(
  wav: Uint8Array,
  prompt: string,
  language: string,
): Promise<string | null> {
  const audio = compressDictationWav(wav);
  const response = await monolithSession.fetch(
    `${getBuzzRuntimeConfig().monolithUrl}/v1/phone/transcriptions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-speech-language': language,
        ...(prompt ? { 'x-speech-prompt': encodeURIComponent(prompt) } : {}),
      },
      body: audio as unknown as BodyInit,
    },
    { timeoutMs: PIECE_TIMEOUT_MS },
  );
  if (response.status === 503) serverTranscriptionUnavailable = true;
  if (!response.ok) {
    console.warn(`[dictation] server transcription failed (${response.status})`);
    return null;
  }
  const value = (await response.json()) as { text?: unknown };
  return typeof value.text === 'string' ? value.text.trim() : null;
}

/**
 * Whisper reads its prompt as the text before the audio. The end of the text
 * so far comes last so the piece continues it; the Room lexicon fills the rest
 * of the server's limit.
 */
export function dictationPrompt(lexicon: readonly string[], previous: string): string {
  let context = previous.trim();
  if (context.length > PROMPT_CONTEXT_CHARACTERS) {
    context = context.slice(-PROMPT_CONTEXT_CHARACTERS).replace(/^\S*\s+/, '');
  }
  const budget = PROMPT_MAXIMUM_CHARACTERS - context.length - 2;
  let names = '';
  for (const term of lexicon) {
    const next = names ? `${names}, ${term}` : term;
    if (next.length > budget) break;
    names = next;
  }
  return names && context ? `${names}. ${context}` : names || context;
}

export type DictationUpload = {
  /** Queues one closed recording; it uploads after the pieces before it. */
  add(uri: string): void;
  /**
   * Answers the joined text once every piece is back, or null when any piece
   * failed or the wait passed `timeoutMs`. The recordings are deleted.
   */
  finish(timeoutMs?: number): Promise<string | null>;
  /** Ends the take without a result and deletes its recordings. */
  discard(): void;
};

/**
 * Uploads one dictation piece by piece while the user still talks, so stop
 * waits only for the last piece. Pieces go in order, each prompted with the
 * text before it; a piece under MERGE_BELOW_SECONDS joins the next one.
 */
export function startDictationUpload(lexicon: readonly string[], locale: string): DictationUpload {
  const language = locale.split(/[-_]/)[0]!.toLowerCase();
  const uris: string[] = [];
  const texts: string[] = [];
  let held: Uint8Array | null = null;
  let failed = false;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  // Seconds of audio sent but not yet answered; stop waits longer for them.
  let outSeconds = 0;
  let onOut: (() => void) | null = null;

  const send = async (wav: Uint8Array) => {
    const previous = joinSpeechPieces(texts, lexicon, locale);
    const prompt = dictationPrompt(lexicon, previous);
    const seconds = dictationWavSeconds(wav) ?? 0;
    outSeconds += seconds;
    onOut?.();
    try {
      const chunks = splitDictationWav(wav, CHUNK_SECONDS);
      const results = await Promise.all(
        chunks.map((chunk) => transcribeOne(chunk, prompt, language)),
      );
      if (results.some((text) => text === null)) failed = true;
      else texts.push(...(results as string[]));
    } finally {
      outSeconds -= seconds;
    }
  };
  const step = (work: () => Promise<void>) => {
    queue = queue.then(async () => {
      if (failed || closed) return;
      try {
        await work();
      } catch (error) {
        console.warn(
          '[dictation] server transcription failed:',
          error instanceof Error ? error.message : 'unknown',
        );
        failed = true;
      }
    });
  };

  return {
    add(uri) {
      if (closed) {
        void discardDictationRecordings([uri]);
        return;
      }
      uris.push(uri);
      step(async () => {
        const recorded = await readFileBytes(uri);
        if (!recorded.length) {
          failed = true;
          return;
        }
        let wav = recorded;
        if (held) {
          const merged = concatDictationWavs([held, recorded]);
          if (!merged) await send(held);
          else wav = merged;
          held = null;
          if (failed) return;
        }
        const seconds = dictationWavSeconds(wav);
        if (seconds !== null && seconds < MERGE_BELOW_SECONDS) {
          held = wav;
          return;
        }
        await send(wav);
      });
    },
    async finish(timeoutMs = DICTATION_TRANSCRIPTION_TIMEOUT_MS) {
      step(async () => {
        if (!held) return;
        const wav = held;
        held = null;
        await send(wav);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stoppedAt = Date.now();
      const late = new Promise<false>((resolve) => {
        // The wait grows with audio still out, never past MAXIMUM_STOP_WAIT_MS.
        const arm = () => {
          const extra = Math.min(
            outSeconds * STOP_WAIT_PER_AUDIO_SECOND_MS,
            MAXIMUM_STOP_WAIT_MS - timeoutMs,
          );
          clearTimeout(timer);
          timer = setTimeout(
            () => resolve(false),
            stoppedAt + timeoutMs + Math.max(0, extra) - Date.now(),
          );
        };
        onOut = arm;
        arm();
      });
      try {
        const done = await Promise.race([queue.then(() => true as const), late]);
        if (!done) console.warn('[dictation] server transcription missed the stop deadline');
        if (!done || failed) return null;
        return joinSpeechPieces(texts, lexicon, locale) || null;
      } finally {
        clearTimeout(timer);
        onOut = null;
        closed = true;
        await discardDictationRecordings(uris);
      }
    },
    discard() {
      closed = true;
      void discardDictationRecordings(uris);
    },
  };
}
