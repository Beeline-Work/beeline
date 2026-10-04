import { describe, expect, it } from 'vitest';

import {
  directMessageAgentHeaderMeta,
  directMessageHeaderPresence,
} from './direct-message-header-presence';

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

  it('shows only working for an agent, never idle or offline', () => {
    const observedAt = Math.floor(NOW / 1_000);
    expect(directMessageHeaderPresence(item(agent, 'online', observedAt, 'working'), NOW)).toBe(
      'working',
    );
    expect(directMessageHeaderPresence(item(agent, 'online', observedAt), NOW)).toBe('');
    expect(directMessageHeaderPresence(item(agent, 'offline', observedAt), NOW)).toBe('');
    expect(directMessageHeaderPresence(item(agent, 'online', observedAt - 120), NOW)).toBe('');
  });

  it('shows no subtitle when the peer or a person presence is unknown', () => {
    expect(directMessageHeaderPresence(null, NOW)).toBe('');
    expect(directMessageHeaderPresence(item(person), NOW)).toBe('');
  });
});

describe('directMessageAgentHeaderMeta', () => {
  it('reads model and owner like a member cell, without the handle', () => {
    expect(
      directMessageAgentHeaderMeta(
        { model: 'anthropic/claude-opus-5-5', ownerHandle: 'lunchboxfortwo' },
        '',
      ),
    ).toBe('claude-opus-5-5 · @lunchboxfortwo');
  });

  it('keeps the working word and skips what is unknown', () => {
    expect(directMessageAgentHeaderMeta({ ownerHandle: 'lunchboxfortwo' }, 'working')).toBe(
      '@lunchboxfortwo · working',
    );
    expect(directMessageAgentHeaderMeta({}, '')).toBe('');
  });
});
