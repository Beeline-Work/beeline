import { describe, expect, it } from 'vitest';
import { readAgentUsage, usagePrompt } from './agent-usage.js';

describe('usage projection', () => {
  it('tolerates absent reports and rejects invalid provider figures', () => {
    expect(readAgentUsage(undefined)).toBeUndefined();
    expect(readAgentUsage({ updatedAt: 1, windows: [{ rateLimitType: 'five_hour', updatedAt: 1, status: 'allowed', utilization: Infinity }] })).toBeUndefined();
    expect(usagePrompt()).toBe('Usage: unknown (harness reports none).');
  });
  it('treats unknown window names as data rather than object properties', () => {
    const usage = readAgentUsage({ updatedAt: 1, windows: [{ rateLimitType: 'constructor', updatedAt: 1, status: 'allowed', utilization: 0.42 }] });
    expect(usagePrompt(usage)).toContain('constructor 42%');
  });
});
