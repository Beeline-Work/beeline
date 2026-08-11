import { describe, expect, it } from 'vitest';

import { fallbackAgentName, resolveAgentDisplayIdentity } from './agent-display';

describe('agent display identity', () => {
  it('creates a stable friendly fallback without exposing key fragments', () => {
    const pubkey = 'abcdef0123456789abcdef0123456789';
    const first = resolveAgentDisplayIdentity(pubkey);

    expect(first).toEqual(resolveAgentDisplayIdentity(pubkey));
    expect(first.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
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
        name: 'Chrome Warden',
        personality: 'Keeps the suite green.',
        avatarSeed: 'chrome-warden-soul',
        updatedAt: 1,
        raw: {} as never,
      },
    });

    expect(display).toMatchObject({
      name: 'Chrome Warden',
      personality: 'Keeps the suite green.',
      avatarSeed: 'chrome-warden-soul',
      avatarUrl: 'https://example.test/agent.png',
      hasSoul: true,
    });
  });

  it('produces different names across representative keys', () => {
    expect(fallbackAgentName('agent-a')).not.toBe(fallbackAgentName('agent-b'));
  });
});
