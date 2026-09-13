import { describe, expect, it } from 'vitest';

import { directMessageHeaderPresence } from './direct-message-header-presence';

const NOW = Date.UTC(2026, 0, 15, 14);
const person = { pubkey: 'person', kind: 'human' as const, name: 'Ada' };
const agent = { pubkey: 'agent', kind: 'agent' as const, name: 'Moth' };
const item = (
  peer: typeof person | typeof agent,
  status?: 'online' | 'offline',
  observedAt?: number,
  agentState?: 'working',
) => ({
  directMessage: {
    peer,
    ...(status && observedAt ? { presence: { status, observedAt } } : {}),
  },
  ...(agentState ? { agentState } : {}),
});

describe('directMessageHeaderPresence', () => {
  it('shows online and last-seen copy for a person', () => {
    const nowSeconds = Math.floor(NOW / 1_000);
    expect(directMessageHeaderPresence(item(person, 'online', nowSeconds), NOW)).toBe('online');
    expect(directMessageHeaderPresence(item(person, 'offline', nowSeconds - 2 * 3_600), NOW)).toBe(
      'last seen 2h',
    );
    expect(
      directMessageHeaderPresence(
        item(person, 'offline', Math.floor(Date.UTC(2026, 0, 14, 20) / 1_000)),
        NOW,
      ),
    ).toBe('yesterday');
  });

  it('shows working, idle, and offline copy for an agent', () => {
    const observedAt = Math.floor(NOW / 1_000);
    expect(directMessageHeaderPresence(item(agent, 'online', observedAt, 'working'), NOW)).toBe(
      'working',
    );
    expect(directMessageHeaderPresence(item(agent, 'online', observedAt), NOW)).toBe('idle');
    expect(directMessageHeaderPresence(item(agent, 'offline', observedAt), NOW)).toBe('offline');
  });

  it('shows no subtitle when the peer or a person presence is unknown', () => {
    expect(directMessageHeaderPresence(null, NOW)).toBe('');
    expect(directMessageHeaderPresence(item(person), NOW)).toBe('');
  });
});
