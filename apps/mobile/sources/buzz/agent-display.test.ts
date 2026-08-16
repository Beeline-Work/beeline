import { describe, expect, it } from 'vitest';

import {
  fallbackAgentName,
  resolveAgentDisplayIdentity,
  resolveCornerCardAgentPubkey,
} from './agent-display';

describe('agent display identity', () => {
  it('creates a stable friendly fallback without exposing key fragments', () => {
    const pubkey = 'abcdef0123456789abcdef0123456789';
    const first = resolveAgentDisplayIdentity(pubkey);

    expect(first).toEqual(resolveAgentDisplayIdentity(pubkey));
    expect(first.name).toMatch(/^[A-Z][a-z]+$/);
    expect(first.handle).toBe(first.name.toLowerCase());
    expect(first.name.toLowerCase()).not.toContain(pubkey.slice(0, 6));
    expect(first.avatarSeed).toBe(pubkey);
  });

  it('uses a validated soul overlay for name, personality, and avatar seed', () => {
    const pubkey = 'agent-public-key';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      avatar: 'https://example.test/agent.png',
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human-public-key',
        name: 'Ada',
        personality: 'Keeps the suite green.',
        avatarSeed: 'chrome-warden-soul',
        avatar: 'https://example.test/ada-soul.png',
        updatedAt: 1,
        raw: {} as never,
      },
    });

    expect(display).toMatchObject({
      name: 'Ada',
      handle: 'ada',
      personality: 'Keeps the suite green.',
      avatarSeed: 'chrome-warden-soul',
      avatarUrl: 'https://example.test/ada-soul.png',
      hasSoul: true,
    });
  });

  it('does not expose a legacy compound overlay as an agent handle', () => {
    const pubkey = 'legacy-agent';
    const display = resolveAgentDisplayIdentity(pubkey, {
      pubkey,
      soulProfile: {
        communityId: 'workspace',
        agentPubkey: pubkey,
        authoredBy: 'human',
        name: 'Chrome Warden',
        personality: 'Legacy copy.',
        avatarSeed: pubkey,
        updatedAt: 1,
        raw: {} as never,
      },
    });
    expect(display.name).toMatch(/^[A-Z][a-z]+$/);
    expect(display.handle).not.toContain('chrome');
    expect(display.hasSoul).toBe(false);
  });

  it('produces different names across representative keys', () => {
    expect(fallbackAgentName('agent-a')).not.toBe(fallbackAgentName('agent-b'));
  });
});

describe('corner card agent identity resolution', () => {
  const registered = new Set(['beebee-pubkey']);
  const isRegisteredAgent = (pubkey: string) => registered.has(pubkey);

  it('uses the declared agent pubkey when it is a registered agent', () => {
    expect(
      resolveCornerCardAgentPubkey('beebee-pubkey', 'someone-else', isRegisteredAgent),
    ).toBe('beebee-pubkey');
  });

  it('falls back to the message signer when the declared tag misses the roster', () => {
    // A stale/mismatched `agent` tag must not force the pubkey-hash fallback
    // name ("Alden") when the event's own signer is a known registered agent.
    expect(
      resolveCornerCardAgentPubkey('stale-tag-pubkey', 'beebee-pubkey', isRegisteredAgent),
    ).toBe('beebee-pubkey');
  });

  it('prefers the declared pubkey when both resolve (no signer ambiguity)', () => {
    const bothRegistered = (pubkey: string) => pubkey === 'a' || pubkey === 'b';
    expect(resolveCornerCardAgentPubkey('a', 'b', bothRegistered)).toBe('a');
  });

  it('falls back to whatever is available when neither resolves', () => {
    expect(resolveCornerCardAgentPubkey('unknown', 'also-unknown', isRegisteredAgent)).toBe(
      'unknown',
    );
    expect(resolveCornerCardAgentPubkey(undefined, 'also-unknown', isRegisteredAgent)).toBe(
      'also-unknown',
    );
    expect(resolveCornerCardAgentPubkey(undefined, undefined, isRegisteredAgent)).toBeUndefined();
  });
});
