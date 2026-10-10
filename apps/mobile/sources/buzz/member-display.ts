import {
  fallbackPersonName,
  personHandle,
  type DirectMessage,
  type PersonProfile,
  type RoomViewIdentity,
} from '@beeline/buzz-client';
import type { Nip05VerificationStatus } from '@beeline/buzz-client';
import { isConnectorKind } from '@beeline/api-contract/workbench';
import { directMessageTitle } from '@beeline/api-contract/phone';

/** Connector peer names come from the server, even when an old profile exists. */
function isConnectorPeer(peer: RoomViewIdentity | undefined): boolean {
  return peer?.kind === 'human' && isConnectorKind(peer.handle);
}

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
 * A read-only announcement DM uses the server-owned peer name verbatim so its
 * header and message byline cannot disagree. Ordinary DMs use the shared
 * `@<handle>` title, from the same peer identity the Room list row reads, so
 * header and list never disagree; the profile is only a fallback.
 */
export function directMessageHeaderName(
  peer: RoomViewIdentity | undefined,
  profile: Pick<PersonProfile, 'name' | 'handle'> | undefined,
  pubkey: string,
  announcementsOnly: boolean,
  announcementAuthor?: RoomViewIdentity,
): string {
  if ((announcementsOnly || isConnectorPeer(peer)) && peer?.name.trim()) return peer.name.trim();
  if (announcementsOnly && announcementAuthor?.name.trim()) return announcementAuthor.name.trim();
  const identity = peer?.name.trim() || peer?.handle?.trim() ? peer : profile;
  if (identity && (identity.name?.trim() || identity.handle?.trim()))
    return directMessageTitle({ name: identity.name ?? '', handle: identity.handle });
  return fallbackMemberName(pubkey);
}

export function directMessagePeer(dm: DirectMessage, viewerPubkey: string): string {
  const peer = dm.participants.find((pubkey) => pubkey !== viewerPubkey);
  if (!peer) throw new Error('viewer is not a participant in this direct message');
  return peer;
}
