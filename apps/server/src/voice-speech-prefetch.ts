/** Speculate on synthesis, never on playback or dispatch. One bounded opening
 * phrase is reusable only when it exactly matches the committed answer. */
export class VoiceSpeechPrefetch {
  private readonly controller = new AbortController();
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private finished = false;
  private failure: unknown;
  private wake?: () => void;
  constructor(readonly text: string, parent: AbortSignal,
    synthesize: (signal: AbortSignal) => AsyncIterable<Uint8Array>) {
    const stop = () => this.cancel();
    parent.addEventListener('abort', stop, { once: true });
    if (parent.aborted) stop();
    void (async () => {
      try {
        for await (const bytes of synthesize(this.controller.signal)) {
          this.controller.signal.throwIfAborted();
          this.bytes += bytes.length;
          if (this.bytes > 1_048_576) throw new Error('Voice opening exceeded prefetch budget');
          this.chunks.push(bytes.slice()); this.wake?.();
        }
      } catch (error) { this.failure = error; }
      finally { this.finished = true; parent.removeEventListener('abort', stop); this.wake?.(); }
    })();
  }
  cancel() { this.controller.abort(); this.chunks.length = 0; this.wake?.(); }
  async *read(): AsyncIterable<Uint8Array> {
    while (true) {
      this.controller.signal.throwIfAborted();
      const next = this.chunks.shift();
      if (next) { yield next; continue; }
      if (this.finished) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}
