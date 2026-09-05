import {
  fallbackPersonName,
  personHandle,
  type DirectMessage,
  type PersonProfile,
} from '@beeline/buzz-client';
import type { Nip05VerificationStatus } from '@beeline/buzz-client';

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

export function directMessagePeer(dm: DirectMessage, viewerPubkey: string): string {
  const peer = dm.participants.find((pubkey) => pubkey !== viewerPubkey);
  if (!peer) throw new Error('viewer is not a participant in this direct message');
  return peer;
}
