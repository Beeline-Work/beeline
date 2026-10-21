import { createHash } from 'node:crypto';

/** OpenRouter may replay thousands of reasoning.text fragments. Their transport
 * envelopes are not model text; concatenate the fragments for token estimation.
 * Unknown detail types remain counted in full rather than creating a bypass. */
export function promptTextBytes(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages) ? body.messages.map(message => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.reasoning_details)) return message;
    const text: string[] = [];
    const unknown: unknown[] = [];
    for (const detail of message.reasoning_details) {
      if (detail && detail.type === 'reasoning.text' && typeof detail.text === 'string' &&
          Object.keys(detail).every(key => ['type', 'text', 'format', 'index', 'id'].includes(key))) text.push(detail.text);
      else if (detail && detail.type === 'reasoning.summary' && typeof detail.summary === 'string' &&
          Object.keys(detail).every(key => ['type', 'summary', 'format', 'index', 'id'].includes(key))) text.push(detail.summary);
      else unknown.push(detail);
    }
    return { ...message, reasoning_details: { text: text.join(''), unknown } };
  }) : body.messages;
  return Buffer.byteLength(JSON.stringify({ ...body, messages }), 'utf8');
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Server-observed cache evidence only. A changed prefix, model, tools or expired
 * entry starts cold. Hashes retain no user content; a process restart is cold. */
export class FreeAgentPromptCache {
  private readonly entries = new Map<string, { at: number; count: number; prefix: string; settings: string; cached: number }>();

  cached(agent: string, body: Record<string, unknown>, now: number): number {
    const entry = this.entries.get(agent);
    if (!entry || now < entry.at || now - entry.at > 5 * 60_000 || !Array.isArray(body.messages)) return 0;
    const { messages, ...settings } = body;
    return messages.length >= entry.count && digest(settings) === entry.settings &&
      digest(messages.slice(0, entry.count)) === entry.prefix ? entry.cached : 0;
  }

  observe(agent: string, body: Record<string, unknown>, cached: number, now: number): void {
    if (!Number.isSafeInteger(cached) || cached <= 0 || !Array.isArray(body.messages)) {
      this.entries.delete(agent);
      return;
    }
    const { messages, ...settings } = body;
    this.entries.delete(agent);
    if (this.entries.size >= 1_000) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(agent, { at: now, count: messages.length, prefix: digest(messages), settings: digest(settings), cached });
  }
}
