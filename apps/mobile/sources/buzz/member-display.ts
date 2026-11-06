import {
  fallbackPersonName as fallbackMemberName,
  personHandle,
  type DirectMessage,
  type PersonProfile,
  type RoomViewIdentity,
} from '@beeline/buzz-client';
import type { ChatTitleIdentity } from '@beeline/api-contract/phone';

export { fallbackMemberName };

export function fallbackMemberHandle(pubkey: string): string {
  return personHandle(fallbackMemberName(pubkey), pubkey);
}

/**
 * The peer identity every DM header is titled from — ordinary, connector or
 * read-only announcement — so `directMessageTitle` reads the same identity the
 * Room list row and the notification read. An announcement DM whose hidden
 * peer is absent uses its indexed author; the profile, then a friendly name,
 * are the fallbacks.
 */
export function directMessageHeaderIdentity(
  peer: RoomViewIdentity | undefined,
  profile: Pick<PersonProfile, 'name' | 'handle'> | undefined,
  pubkey: string,
  announcementsOnly: boolean,
  announcementAuthor?: RoomViewIdentity,
): ChatTitleIdentity {
  const named = (identity: { name?: string; handle?: string | null } | undefined) =>
    Boolean(identity?.name?.trim() || identity?.handle?.trim());
  const identity = named(peer)
    ? peer
    : announcementsOnly && named(announcementAuthor)
      ? announcementAuthor
      : profile;
  if (identity && named(identity)) return { ...identity, name: identity.name ?? '' };
  return { name: fallbackMemberName(pubkey) };
}
