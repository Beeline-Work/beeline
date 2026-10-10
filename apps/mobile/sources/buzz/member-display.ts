import {
  fallbackPersonName,
  personHandle,
  type DirectMessage,
  type PersonProfile,
  type RoomViewIdentity,
} from '@beeline/buzz-client';
import type { Nip05VerificationStatus } from '@beeline/buzz-client';
import { directMessageTitle } from '@beeline/api-contract/phone';

export function fallbackMemberName(pubkey: string): string {
  return fallbackPersonName(pubkey);
}

export function fallbackMemberHandle(pubkey: string): string {
  return personHandle(fallbackMemberName(pubkey), pubkey);
}

/**
 * Verified NIP-05 wins, then the app-local @handle, then the display name, then a friendly
 * local name as a last resort. A present-but-unverified/mismatched nip05 never renders as the label —
 * an honest fallback is safer than showing an identifier that hasn't been confirmed.
 */
export function personIdentityLabel(
  profile: Pick<PersonProfile, 'name' | 'handle' | 'nip05'> | undefined,
  pubkey: string,
  nip05Status?: Nip05VerificationStatus | 'checking' | 'none',
): string {
  if (profile?.nip05 && nip05Status === 'verified') return profile.nip05;
  if (profile?.handle) return `@${profile.handle}`;
  if (profile?.name) return profile.name;
  return fallbackMemberName(pubkey);
}

/**
 * Every DM header — ordinary, connector or read-only announcement — uses the
 * shared `@<handle>` title from the same peer identity the Room list row and
 * the notification read, so the three never disagree. An announcement DM
 * whose hidden peer is absent uses its indexed author; the profile is the last
 * fallback.
 */
export function directMessageHeaderName(
  peer: RoomViewIdentity | undefined,
  profile: Pick<PersonProfile, 'name' | 'handle'> | undefined,
  pubkey: string,
  announcementsOnly: boolean,
  announcementAuthor?: RoomViewIdentity,
): string {
  const named = (identity: { name?: string; handle?: string | null } | undefined) =>
    Boolean(identity?.name?.trim() || identity?.handle?.trim());
  const identity = named(peer)
    ? peer
    : announcementsOnly && named(announcementAuthor)
      ? announcementAuthor
      : profile;
  if (identity && named(identity))
    return directMessageTitle({ ...identity, name: identity.name ?? '' });
  return fallbackMemberName(pubkey);
}

export function directMessagePeer(dm: DirectMessage, viewerPubkey: string): string {
  const peer = dm.participants.find((pubkey) => pubkey !== viewerPubkey);
  if (!peer) throw new Error('viewer is not a participant in this direct message');
  return peer;
}
