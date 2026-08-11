import { describe, expect, it } from 'vitest';
import {
  agentHandle,
  fallbackAgentName,
  isSingleWordAgentName,
  resolveAgentName,
} from './display-name.js';

describe('agent presentation names', () => {
  it('derives a stable spoken first name and lowercase handle from the pubkey', () => {
    const name = fallbackAgentName('ab'.repeat(32));
    expect(fallbackAgentName('ab'.repeat(32))).toBe(name);
    expect(name).toMatch(/^\p{Lu}\p{Ll}+$/u);
    expect(agentHandle(name, 'ab'.repeat(32))).toBe(name.toLowerCase());
  });

  it('accepts one authored word and replaces legacy compounds deterministically', () => {
    expect(isSingleWordAgentName('Ada')).toBe(true);
    expect(isSingleWordAgentName('Quiet Keeper')).toBe(false);
    expect(resolveAgentName('Charles', 'agent')).toBe('Charles');
    expect(resolveAgentName('Quiet Keeper', 'agent')).toBe(fallbackAgentName('agent'));
  });
});
