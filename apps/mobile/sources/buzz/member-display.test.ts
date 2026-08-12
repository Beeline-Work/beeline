import { describe, expect, it } from 'vitest';
import { directMessagePeer, shortMemberNpub } from './member-display';

describe('direct-message member display', () => {
  it('resolves the other participant', () => {
    expect(
      directMessagePeer(
        { participants: ['a'.repeat(64), 'b'.repeat(64)] } as never,
        'a'.repeat(64),
      ),
    ).toBe('b'.repeat(64));
  });

  it('uses a compact stable npub fallback', () => {
    expect(shortMemberNpub('a'.repeat(64))).toMatch(/^npub1.{3}…$/);
  });
});
