import type { VoiceAgent, VoiceBrain, VoiceSearchContext, VoiceProviderTiming } from './voice-providers.js';

type History = Parameters<VoiceBrain['answer']>[1];

/** A speculative brain may compute, but searches and announcements require the
 * committed turn's context. Cancellation also releases a pending tool gate. */
export class VoiceEagerReply {
  readonly controller = new AbortController();
  private readonly key: string;
  private readonly deltas: string[] = [];
  private diagnostics: VoiceProviderTiming[] = [];
  private diagnostic?: VoiceSearchContext['diagnostic'];
  private onText?: (text: string) => void;
  private commit!: (context: VoiceSearchContext) => void;
  private readonly result: ReturnType<VoiceBrain['answer']>;
  constructor(brain: VoiceBrain, agent: VoiceAgent, history: History,
    agents: VoiceSearchContext['agents']) {
    this.key = JSON.stringify([agent, history, agents]);
    const gate = new Promise<VoiceSearchContext>((resolve, reject) => {
      this.commit = resolve;
      this.controller.signal.addEventListener('abort', () => reject(this.controller.signal.reason), { once: true });
    });
    void gate.catch(() => {});
    this.result = brain.answer(agent, history, text => {
      if (this.controller.signal.aborted) return;
      if (this.onText) this.onText(text); else this.deltas.push(text);
    }, this.controller.signal, {
      agents,
      diagnostic: timing => { if (this.diagnostic) this.diagnostic(timing); else this.diagnostics.push(timing); },
      announce: async text => (await gate).announce(text),
      search: async (request, signal) => (await gate).search(request, signal),
    });
    void this.result.catch(() => {});
  }
  matches(agent: VoiceAgent, history: History, agents: VoiceSearchContext['agents']) {
    return !this.controller.signal.aborted && this.key === JSON.stringify([agent, history, agents]);
  }
  async consume(onText: (text: string) => void, context: VoiceSearchContext, signal: AbortSignal) {
    const stop = () => this.cancel();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    this.onText = onText;
    this.diagnostic = context.diagnostic;
    for (const timing of this.diagnostics.splice(0)) this.diagnostic?.(timing);
    for (const text of this.deltas.splice(0)) onText(text);
    this.commit(context);
    try { return await this.result; }
    finally { signal.removeEventListener('abort', stop); }
  }
  cancel() { this.controller.abort(new DOMException('Speculative turn cancelled', 'AbortError')); }
}
