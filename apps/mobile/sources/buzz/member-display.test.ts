import { describe, expect, it } from 'vitest';
import { directMessagePeer, personIdentityLabel, shortMemberNpub } from './member-display';

const pubkey = 'a'.repeat(64);

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

describe('personIdentityLabel', () => {
  it('renders the verified NIP-05 identifier when verification succeeded', () => {
    expect(
      personIdentityLabel({ nip05: 'ada@example.com', handle: 'ada' }, pubkey, 'verified'),
    ).toBe('ada@example.com');
  });

  it('does not show nip05 as verified on a mismatch, and falls back to the handle', () => {
    expect(
      personIdentityLabel({ nip05: 'ada@example.com', handle: 'ada' }, pubkey, 'mismatch'),
    ).toBe('@ada');
  });

  it('does not show nip05 while verification is still checking', () => {
    expect(
      personIdentityLabel({ nip05: 'ada@example.com', handle: 'ada' }, pubkey, 'checking'),
    ).toBe('@ada');
  });

  it('does not show nip05 when the domain was unreachable', () => {
    expect(
      personIdentityLabel({ nip05: 'ada@example.com', handle: 'ada' }, pubkey, 'unreachable'),
    ).toBe('@ada');
  });

  it('falls back to the handle when no nip05 is present', () => {
    expect(personIdentityLabel({ handle: 'ada' }, pubkey)).toBe('@ada');
  });

  it('falls back to the display name when no handle is present', () => {
    expect(personIdentityLabel({ name: 'Ada Lovelace' }, pubkey)).toBe('Ada Lovelace');
  });

  it('falls back to a truncated npub when the profile is missing entirely', () => {
    expect(personIdentityLabel(undefined, pubkey)).toBe(shortMemberNpub(pubkey));
  });
});
