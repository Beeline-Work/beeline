import { encodeNpub, type DirectMessage } from '@beeline/buzz-client';

export function shortMemberNpub(pubkey: string): string {
  try {
    const npub = encodeNpub(pubkey);
    return `${npub.slice(0, 8)}…`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}

export function directMessagePeer(dm: DirectMessage, viewerPubkey: string): string {
  const peer = dm.participants.find((pubkey) => pubkey !== viewerPubkey);
  if (!peer) throw new Error('viewer is not a participant in this direct message');
  return peer;
}
