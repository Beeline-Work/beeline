import { randomBytes } from 'node:crypto';
import type { VoiceAgent } from './voice-providers.js';
import { openingVoiceName } from './voice-target.js';

export interface VoiceRequest {
  id: string;
  text: string;
  agent?: VoiceAgent;
  source: Promise<string>;
  classification: AbortController;
  state: 'assembling' | 'classifying' | 'delivering' | 'retryable' | 'replying' | 'playing' | 'finished';
}

/** A detected resume can reopen a conversational request while its reply plays. */
export class VoiceRequestAssembler {
  private readonly requests = new Map<string, VoiceRequest>();
  private readonly contactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failed = new Map<string, Map<string, VoiceRequest>>();
  private readonly addresses = new Map<string, { agentId: string; until: number; timer: ReturnType<typeof setTimeout> }>();

  private clearContactTimer(human: string) {
    clearTimeout(this.contactTimers.get(human));
    this.contactTimers.delete(human);
  }
  waitForContact(human: string, request: VoiceRequest) {
    this.clearContactTimer(human);
    const timer = setTimeout(() => {
      if (this.requests.get(human) === request) this.cancel(human, 'contact draft expired');
    }, 10_000);
    timer.unref();
    this.contactTimers.set(human, timer);
  }
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
    const request = this.requests.get(human);
    if (request && this.contactTimers.has(human)) this.waitForContact(human, request);
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
    if (request && ['assembling', 'classifying', 'replying', 'playing'].includes(request.state)) {
      request.state = 'assembling';
      request.classification.abort('user resumed speaking');
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
    this.clearContactTimer(human);
    const previous = this.requests.get(human);
    const continuation = previous && ['assembling', 'classifying', 'replying'].includes(previous.state) ? previous : undefined;
    continuation?.classification.abort('superseded');
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
    if (this.requests.get(human) === request) this.clearContactTimer(human);
    request.state = 'finished';
    this.failed.get(human)?.delete(request.id);
    if (!this.failed.get(human)?.size) this.failed.delete(human);
    if (this.requests.get(human) === request) {
      this.requests.delete(human);
      this.clearAddress(human);
    }
  }
  cancel(human: string, reason = 'superseded') {
    this.clearContactTimer(human);
    const request = this.requests.get(human);
    if (request) {
      request.classification.abort(reason); this.requests.delete(human);
    }
    this.failed.delete(human);
    this.clearAddress(human);
  }
  close() {
    for (const human of this.humans()) this.cancel(human, 'call closed');
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

/** Match only a stored contact name, including its short name without a trailing bot label. */
export function voiceContactNameOnly(text: string, contacts: readonly string[] = []): boolean {
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
  const words = normalize(text).replace(/^(hey|hi|hello|okay|ok|yo) /, '');
  return !!words && contacts.some(contact => {
    const name = normalize(contact);
    return words === name || words === name.replace(/ bot$/, '');
  });
}
