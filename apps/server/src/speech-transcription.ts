/**
 * Server-side dictation transcription through Groq Whisper. The phone records
 * while its on-device recognizer shows live words, then posts the audio here;
 * the Groq key never leaves the server. Absent key = the route answers 503 and
 * the phone keeps its on-device text.
 */

export const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
// 16 kHz mono 16-bit PCM is 32 KB/s: about five minutes of dictation.
export const TRANSCRIPTION_MAXIMUM_BYTES = 10 * 1024 * 1024;
// Whisper reads at most 224 prompt tokens; longer lexicons are cut, not refused.
const PROMPT_MAXIMUM_CHARACTERS = 600;
const GROQ_TIMEOUT_MS = 15_000;

export class SpeechTranscriber {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Returns Groq's transcript; throws when Groq refuses or times out. */
  async transcribe(input: {
    audio: Uint8Array;
    mimeType: string;
    prompt?: string;
    language?: string;
  }): Promise<string> {
    const form = new FormData();
    const extension = input.mimeType.includes('wav') ? 'wav' : 'audio';
    form.append(
      'file',
      new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: input.mimeType }),
      `dictation.${extension}`,
    );
    form.append('model', GROQ_TRANSCRIPTION_MODEL);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const prompt = input.prompt?.trim().slice(0, PROMPT_MAXIMUM_CHARACTERS);
    if (prompt) form.append('prompt', prompt);
    if (input.language && /^[a-z]{2,3}$/.test(input.language)) {
      form.append('language', input.language);
    }
    const response = await this.fetchImpl(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`groq transcription failed (${response.status})`);
    const value = (await response.json()) as { text?: unknown };
    if (typeof value.text !== 'string') throw new Error('groq transcription had no text');
    return value.text.trim();
  }
}

export function speechTranscriberFromEnv(
  env: Record<string, string | undefined> = process.env,
): SpeechTranscriber | undefined {
  const key = env.GROQ_API_KEY?.trim();
  return key ? new SpeechTranscriber(key) : undefined;
}
