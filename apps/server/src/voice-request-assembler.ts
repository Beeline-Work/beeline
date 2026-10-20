import { randomBytes } from 'node:crypto';
import type { VoiceAgent } from './voice-providers.js';
import { openingVoiceName } from './voice-target.js';

export interface VoiceRequest {
  id: string;
  text: string;
  agent?: VoiceAgent;
  source: Promise<string>;
  classification: AbortController;
  state: 'assembling' | 'classifying' | 'delivering' | 'retryable' | 'replying' | 'finished';
}

/** One request per human remains editable until its first voiced reply is ready to publish. */
export class VoiceRequestAssembler {
  private readonly requests = new Map<string, VoiceRequest>();
  private readonly failed = new Map<string, Map<string, VoiceRequest>>();
  private readonly addresses = new Map<string, { agentId: string; until: number; timer: ReturnType<typeof setTimeout> }>();

  private expire(human: string) {
    const address = this.addresses.get(human);
    if (address && address.until <= performance.now()) {
      clearTimeout(address.timer);
      this.addresses.delete(human);
    }
  }
  address(human: string, agentId: string) {
    this.clearAddress(human);
    const timer = setTimeout(() => this.expire(human), 3000);
    timer.unref();
    this.addresses.set(human, { agentId, until: performance.now() + 3000, timer });
  }
  speaking(human: string) {
    this.expire(human);
    const address = this.addresses.get(human);
    if (address) this.address(human, address.agentId);
  }
  target(human: string) {
    this.expire(human);
    return this.addresses.get(human)?.agentId;
  }
  clearAddress(human: string) {
    clearTimeout(this.addresses.get(human)?.timer);
    this.addresses.delete(human);
  }
  pause(human: string) {
    const request = this.requests.get(human);
    if (request && ['assembling', 'classifying', 'replying'].includes(request.state)) {
      request.state = 'assembling';
      request.classification.abort();
    }
  }
  humans() { return [...new Set([...this.requests.keys(), ...this.addresses.keys(), ...this.failed.keys()])]; }
  retainFailure(human: string, request: VoiceRequest) {
    request.state = 'retryable';
    let failed = this.failed.get(human);
    if (!failed) this.failed.set(human, failed = new Map());
    failed.set(request.id, request);
  }
  retryable(human: string) {
    const current = this.requests.get(human);
    if (current && current.state !== 'retryable') return;
    return current ?? [...(this.failed.get(human)?.values() ?? [])].at(-1);
  }
  current(human: string) { return this.requests.get(human); }
  begin(human: string, text: string): { request: VoiceRequest; previous?: VoiceRequest } {
    const previous = this.requests.get(human);
    const continuation = previous && ['assembling', 'classifying', 'replying'].includes(previous.state) ? previous : undefined;
    continuation?.classification.abort();
    const request: VoiceRequest = {
      id: continuation?.id ?? randomBytes(32).toString('hex'),
      text: continuation ? `${continuation.text} ${text}` : text,
      agent: continuation?.agent,
      source: continuation?.source ?? Promise.resolve(''),
      classification: new AbortController(), state: 'assembling',
    };
    this.requests.set(human, request);
    return { request, previous: continuation };
  }
  finish(human: string, request: VoiceRequest) {
    request.state = 'finished';
    this.failed.get(human)?.delete(request.id);
    if (!this.failed.get(human)?.size) this.failed.delete(human);
    if (this.requests.get(human) === request) {
      this.requests.delete(human);
      this.clearAddress(human);
    }
  }
  cancel(human: string) {
    const request = this.requests.get(human);
    if (request) {
      request.classification.abort(); this.requests.delete(human);
    }
    this.failed.delete(human);
    this.clearAddress(human);
  }
  close() {
    for (const human of this.humans()) this.cancel(human);
    for (const human of this.addresses.keys()) this.clearAddress(human);
  }
}

export function voiceNameOnly(text: string, agents: readonly VoiceAgent[]): VoiceAgent | undefined {
  const agent = openingVoiceName(text, agents);
  if (!agent) return;
  // Use the same tolerant name matcher, including its optional greeting.
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (/^(hey|hi|hello|okay|ok|yo)$/i.test(words[0] ?? '')) words.shift();
  const lengths = [agent.name, agent.handle].map(name => name.match(/[\p{L}\p{N}]+/gu)?.length ?? 0);
  if (words.length === 1 && lengths.includes(1)) return agent;
  const normalized = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.join(' ');
  return [agent.name, agent.handle].some(alias => normalized(alias) === normalized(words.join(' '))) ? agent : undefined;
}
