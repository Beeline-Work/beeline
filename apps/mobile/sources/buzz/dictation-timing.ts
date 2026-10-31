/** Content-free timings, readable in Android logcat or the JS console. */
export type DictationStage = 'recording_started' | 'send_tapped' | 'native_end' |
  'audio_closed' | 'upload_start' | 'upload_response' | 'groq_text_back' |
  'fallback' | 'server_accepted';
export type DictationTiming = { mark(stage: DictationStage): void };
let sequence = 0;
export function createDictationTiming(): DictationTiming {
  const take = ++sequence;
  const start = performance.now();
  return {
    mark(stage) {
      // Production disables info output; this content-free trace must remain
      // readable from a phone's native log for the before/after check.
      console.warn('[dictation-timing]', JSON.stringify({
        take, stage, elapsedMs: Math.round(performance.now() - start),
      }));
    },
  };
}
// Event IDs stay in memory only; a disconnected send expires from diagnostics.
const pending = new Map<string, { timing: DictationTiming; expires: number }>();
export function trackDictatedMessage(id: string, timing?: DictationTiming): void {
  for (const [key, entry] of pending) if (entry.expires < Date.now()) pending.delete(key);
  if (!timing) return;
  if (pending.size >= 100) pending.delete(pending.keys().next().value!);
  pending.set(id, { timing, expires: Date.now() + 120_000 });
}
export function markDictatedMessageAccepted(id: string): void {
  const entry = pending.get(id);
  pending.delete(id);
  if (entry && entry.expires >= Date.now()) entry.timing.mark('server_accepted');
}
