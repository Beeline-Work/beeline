import { fnv1a32 } from './identity-mark';

/** Keep the server-assigned animal while deriving its generated palette from the soul. */
export function agentAvatarSeed(pubkey: string, soul: string): string {
  return `soul:${pubkey}:${fnv1a32(soul.trim()).toString(16).padStart(8, '0')}`;
}
