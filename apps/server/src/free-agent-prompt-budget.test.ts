import { describe, expect, it } from 'vitest';
import { FreeAgentPromptCache, promptTextBytes } from './free-agent-prompt-budget.js';

describe('free agent prompt accounting', () => {
  it('counts fragmented reasoning text once while leaving the wire payload intact', () => {
    const details = Array.from({ length: 31_901 }, () => ({ type: 'reasoning.text', text: 'reason.', format: 'unknown', index: 0 }));
    const body = { messages: [{ role: 'assistant', reasoning_details: details }] };
    const original = JSON.stringify(body);
    expect(Buffer.byteLength(original)).toBeGreaterThan(2_000_000);
    expect(promptTextBytes(body)).toBeLessThan(250_000);
    expect(JSON.stringify(body)).toBe(original);
  });
  it('counts unknown detail types and extra fields instead of trusting their type label', () => {
    for (const detail of [
      { type: 'foreign', data: 'x'.repeat(100_000) },
      { type: 'reasoning.text', text: 'short', extra: 'x'.repeat(100_000) },
    ]) expect(promptTextBytes({ messages: [{ reasoning_details: [detail] }] })).toBeGreaterThan(100_000);
  });
  it('requires recent upstream cache evidence and an unchanged prefix/model/tools', () => {
    const cache = new FreeAgentPromptCache();
    const body = { model: 'model', tools: [], messages: [{ role: 'user', content: 'first' }] };
    expect(cache.cached('agent', body, 0)).toBe(0);
    cache.observe('agent', body, 1_000, 10);
    const next = { ...body, messages: [...body.messages, { role: 'user', content: 'second' }] };
    expect(cache.cached('agent', next, 11)).toBe(1_000);
    expect(cache.cached('other', next, 11)).toBe(0);
    expect(cache.cached('agent', { ...next, model: 'changed' }, 11)).toBe(0);
    expect(cache.cached('agent', { ...next, tools: ['changed'] }, 11)).toBe(0);
    expect(cache.cached('agent', { ...next, messages: [{ role: 'user', content: 'changed' }] }, 11)).toBe(0);
    expect(cache.cached('agent', next, 300_011)).toBe(0);
    cache.observe('agent', next, 0, 12);
    expect(cache.cached('agent', next, 13)).toBe(0);
  });
});
