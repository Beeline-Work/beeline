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
  it('keeps unresolved agent keys out of presentation', () => {
    const codexPubkey = `54f4d261${'0'.repeat(56)}`;
    expect(fallbackAgentName(codexPubkey)).toBe('Agent');
    expect(fallbackAgentName('ab'.repeat(32))).toBe('Agent');
    expect(agentHandle('Quiet Keeper')).toBe('quiet_keeper');
  });

  it('keeps the stable friendly first-name fallback exclusive to people', () => {
    const pubkey = 'cd'.repeat(32);
    expect(fallbackPersonName(pubkey)).toMatch(/^\p{Lu}\p{Ll}+$/u);
    expect(fallbackPersonName(pubkey)).not.toBe(fallbackAgentName(pubkey));
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
    // Genuinely unusable authored values still take the deterministic fallback.
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

  it('uses a neutral fallback for every system marker', () => {
    // The daemon mints `beeline-agent` (the Beeline-rebrand default); that is
    // a placeholder which resolves to the neutral agent label.
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

  it('never exposes keys when assigned names are unavailable', () => {
    const first = '11'.repeat(32);
    const second = '22'.repeat(32);
    expect(first).not.toBe(second);
    const firstName = deriveAgentDisplayName(DEFAULT_AGENT_IDENTITY_NAME, first);
    const secondName = deriveAgentDisplayName(DEFAULT_AGENT_IDENTITY_NAME, second);
    expect(firstName).toBe('Agent');
    expect(secondName).toBe('Agent');
  });
});
