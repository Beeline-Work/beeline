import { describe, expect, it } from 'vitest';
import {
  agentHandle,
  fallbackAgentName,
  fallbackPersonName,
  isSingleWordAgentName,
  normalizePersonName,
  personHandle,
  resolveAgentName,
} from './display-name.js';

describe('agent presentation names', () => {
  it('derives a stable spoken first name and lowercase handle from the pubkey', () => {
    const name = fallbackAgentName('ab'.repeat(32));
    expect(fallbackAgentName('ab'.repeat(32))).toBe(name);
    expect(name).toMatch(/^\p{Lu}\p{Ll}+$/u);
    expect(agentHandle(name, 'ab'.repeat(32))).toBe(name.toLowerCase());
  });

  it('gives people the same stable friendly default while allowing full authored names', () => {
    const pubkey = 'cd'.repeat(32);
    expect(fallbackPersonName(pubkey)).toBe(fallbackAgentName(pubkey));
    expect(normalizePersonName('  Ada   Lovelace  ')).toBe('Ada Lovelace');
    expect(personHandle('Ada Lovelace', pubkey)).toBe('adalovelace');
    expect(normalizePersonName('   ')).toBeNull();
  });

  it('accepts one authored word and replaces legacy compounds deterministically', () => {
    expect(isSingleWordAgentName('Ada')).toBe(true);
    expect(isSingleWordAgentName('Quiet Keeper')).toBe(false);
    expect(resolveAgentName('Charles', 'agent')).toBe('Charles');
    expect(resolveAgentName('Quiet Keeper', 'agent')).toBe(fallbackAgentName('agent'));
  });
});
