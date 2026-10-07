/**
 * Sends a dictation's recorded audio to the Beeline server, which transcribes
 * it with Groq Whisper. The Groq key stays on the server. Any failure answers
 * null so the caller keeps the on-device transcript.
 */
import { monolithSession } from '@/auth/monolith-session';
import { readFileBytes } from '@/utils/readFileBytes';
import { getBuzzRuntimeConfig } from './runtime-config';
import { compressDictationWav } from './wav-adpcm';

// Upload plus Groq normally finishes well under a second for a short message.
export const DICTATION_TRANSCRIPTION_TIMEOUT_MS = 5000;

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
  uri: string,
  prompt: string,
  language: string,
  timeoutMs: number,
): Promise<string | null> {
  const recorded = await readFileBytes(uri);
  if (!recorded.length) return null;
  const audio = compressDictationWav(recorded);
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
    { timeoutMs },
  );
  if (response.status === 503) serverTranscriptionUnavailable = true;
  if (!response.ok) return null;
  const value = (await response.json()) as { text?: unknown };
  return typeof value.text === 'string' ? value.text.trim() : null;
}

/**
 * Transcribes each recorded segment of one dictation, in order, and joins them.
 * Answers null when any segment fails, so a partial result never replaces the
 * on-device text. The recordings are deleted either way.
 */
export async function transcribeDictation(
  uris: readonly string[],
  lexicon: readonly string[],
  locale: string,
  timeoutMs = DICTATION_TRANSCRIPTION_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const prompt = lexicon.join(', ');
    const language = locale.split(/[-_]/)[0]!.toLowerCase();
    const texts = await Promise.all(
      uris.map((uri) => transcribeOne(uri, prompt, language, timeoutMs)),
    );
    if (texts.some((text) => text === null)) return null;
    const joined = texts.filter(Boolean).join(' ').trim();
    return joined || null;
  } catch {
    return null;
  } finally {
    await discardDictationRecordings(uris);
  }
}
