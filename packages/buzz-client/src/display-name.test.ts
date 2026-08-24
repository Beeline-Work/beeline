import { describe, expect, it } from 'vitest';
import {
  agentHandle,
  DEFAULT_AGENT_IDENTITY_NAME,
  deriveAgentDisplayName,
  fallbackAgentName,
  fallbackPersonName,
  isReasonableAgentName,
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

  it('accepts one authored word and replaces only unusable values deterministically', () => {
    expect(isSingleWordAgentName('Ada')).toBe(true);
    expect(isSingleWordAgentName('Quiet Keeper')).toBe(false);
    expect(resolveAgentName('Charles', 'agent')).toBe('Charles');
    expect(resolveAgentName('Quiet Keeper', 'agent')).toBe('Quiet Keeper');
    expect(resolveAgentName('ox-prime', 'agent')).toBe('ox-prime');
    // Genuinely unusable authored values still take the deterministic pool.
    expect(resolveAgentName('   ', 'agent')).toBe(fallbackAgentName('agent'));
    expect(resolveAgentName(undefined, 'agent')).toBe(fallbackAgentName('agent'));
    expect(resolveAgentName('x'.repeat(64), 'agent')).toBe(fallbackAgentName('agent'));
  });

  it('preserves a reasonable authored name and rejects only malformed ones', () => {
    expect(isReasonableAgentName('Ada')).toBe(true);
    expect(isReasonableAgentName('Quiet Keeper')).toBe(true);
    expect(isReasonableAgentName('  ox-prime  ')).toBe(true);
    expect(isReasonableAgentName("O'Brien")).toBe(true);
    expect(isReasonableAgentName('')).toBe(false);
    expect(isReasonableAgentName('x'.repeat(33))).toBe(false);
    expect(isReasonableAgentName('h4x0r')).toBe(false);
  });

  it('derives a distinct pubkey seed name from every system marker, never one shared label', () => {
    // The daemon mints `beeline-agent` (the Beeline-rebrand default); that is
    // a placeholder which resolves to this agent's own stable seed name.
    expect(DEFAULT_AGENT_IDENTITY_NAME).toBe('beeline-agent');
    expect(deriveAgentDisplayName('beeline-agent', 'agent')).toBe(fallbackAgentName('agent'));
    // The pre-rebrand `buzzy-agent` marker is classified the same way.
    expect(deriveAgentDisplayName('buzzy-agent', 'agent')).toBe(fallbackAgentName('agent'));
    // The bare "Agent" guard is a placeholder too.
    expect(deriveAgentDisplayName('Agent', 'agent')).toBe(fallbackAgentName('agent'));
    expect(deriveAgentDisplayName(undefined, 'agent')).toBe(fallbackAgentName('agent'));
    // An authored name — single word or compound — passes through untouched.
    expect(deriveAgentDisplayName('Patch', 'agent')).toBe('Patch');
    expect(deriveAgentDisplayName('Quiet Keeper', 'agent')).toBe('Quiet Keeper');
  });

  it('never gives two agents the same default identity', () => {
    const first = '11'.repeat(32);
    const second = '22'.repeat(32);
    expect(first).not.toBe(second);
    const firstName = deriveAgentDisplayName(DEFAULT_AGENT_IDENTITY_NAME, first);
    const secondName = deriveAgentDisplayName(DEFAULT_AGENT_IDENTITY_NAME, second);
    // Both resolve to real spoken seed names, and they differ per pubkey —
    // the shared "buzzy-agent"/"Buzzy" label is gone.
    expect(firstName).toMatch(/^\p{Lu}\p{Ll}+$/u);
    expect(secondName).toMatch(/^\p{Lu}\p{Ll}+$/u);
    expect(firstName).not.toBe(secondName);
  });
});
