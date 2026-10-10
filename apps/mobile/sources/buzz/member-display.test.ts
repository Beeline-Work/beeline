import { describe, expect, it } from 'vitest';
import { directMessageTitle } from '@beeline/api-contract/phone';
import { roomRowName } from './room-list-row';
import {
  directMessageHeaderName,
  directMessagePeer,
  fallbackMemberHandle,
  fallbackMemberName,
  personIdentityLabel,
} from './member-display';

const pubkey = 'a'.repeat(64);

describe('direct-message member display', () => {
  it('titles a grant DM header with the shared connector title', () => {
    expect(
      directMessageHeaderName(
        { pubkey: 's'.repeat(64), kind: 'human', name: 'Trusty Squire', handle: 'trusty-squire' },
        undefined,
        's'.repeat(64),
        true,
      ),
    ).toBe('@Trusty Squire');
  });
  it('uses the server connector identity over an older Lena profile', () => {
    expect(
      directMessageHeaderName(
        { pubkey: 's'.repeat(64), kind: 'human', name: 'Trusty Squire', handle: 'trusty-squire' },
        { name: 'Lena', handle: 'lena', nip05: 'lena@example.com' },
        's'.repeat(64),
        false,
      ),
    ).toBe('@Trusty Squire');
  });
  it('uses another server connector name without hardcoding it', () => {
    expect(
      directMessageHeaderName(
        {
          pubkey: 'g'.repeat(64),
          kind: 'human',
          name: 'Google Drive',
          handle: 'google-drive',
          avatar: 'https://server.test/v1/connectors/logo/google-drive.svg',
        },
        { name: 'Lena' },
        'g'.repeat(64),
        false,
      ),
    ).toBe('@Google Drive');
  });
  it('titles an ordinary DM from the same peer identity as the Room list row', () => {
    expect(
      directMessageHeaderName(
        { pubkey, kind: 'human', name: 'Ada', handle: 'ada' },
        { name: 'Lena', handle: 'lena' },
        pubkey,
        false,
      ),
    ).toBe('@ada');
  });
  // G9-R4: a connector header showed `Trusty Squire` while its notification
  // title is `@Trusty Squire`.
  it('titles a connector header like its notification', () => {
    const peer = {
      pubkey: 'b'.repeat(64),
      kind: 'human' as const,
      name: 'Trusty Squire',
      handle: 'trusty-squire',
    };
    expect(directMessageHeaderName(peer, undefined, peer.pubkey, false)).toBe(
      directMessageTitle(peer),
    );
  });
  // G9-R4: the header showed `@alice@host` while the shared title is `@alice`.
  it('uses the shared title rules for a domain handle', () => {
    const peer = { pubkey, kind: 'human' as const, name: 'Alice', handle: 'alice@host' };
    expect(directMessageHeaderName(peer, undefined, pubkey, false)).toBe(directMessageTitle(peer));
    expect(directMessageHeaderName(peer, undefined, pubkey, false)).toBe('@alice');
    expect(roomRowName({ room: { id: 'dm' }, directMessage: { peer } } as never)).toEqual({
      sigil: '@',
      name: 'alice',
    });
  });
  it('falls back to the profile, then a friendly name', () => {
    expect(
      directMessageHeaderName(undefined, { name: 'Lena', handle: 'lena' }, pubkey, false),
    ).toBe('@lena');
    expect(directMessageHeaderName(undefined, undefined, pubkey, false)).toBe(
      fallbackMemberName(pubkey),
    );
  });
  it('titles an announcements-only DM header from its System peer', () => {
    expect(
      directMessageHeaderName(
        { pubkey: 's'.repeat(64), kind: 'human', name: 'System', handle: 'system' },
        undefined,
        's'.repeat(64),
        true,
      ),
    ).toBe('@system');
  });

  it('uses the indexed announcement author when the hidden System peer is absent', () => {
    expect(
      directMessageHeaderName(undefined, undefined, 's'.repeat(64), true, {
        pubkey: 's'.repeat(64),
        kind: 'human',
        name: 'System',
        handle: 'system',
      }),
    ).toBe('@system');
  });

  it('resolves the other participant', () => {
    expect(
      directMessagePeer(
        { participants: ['a'.repeat(64), 'b'.repeat(64)] } as never,
        'a'.repeat(64),
      ),
    ).toBe('b'.repeat(64));
  });

  it('keeps keys out of fallback names and handles', () => {
    expect(fallbackMemberName('a'.repeat(64))).toMatch(/^\p{Lu}\p{Ll}+$/u);
    expect(fallbackMemberHandle('a'.repeat(64))).toBe(
      fallbackMemberName('a'.repeat(64)).toLowerCase(),
    );
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

  it('falls back to a friendly local name when the profile is missing entirely', () => {
    expect(personIdentityLabel(undefined, pubkey)).toBe(fallbackMemberName(pubkey));
  });
});
