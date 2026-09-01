export const COMMUNITY_INVITE_TOKEN_PREFIX = 'bzi_';
export const COMMUNITY_INVITE_TOKEN_ENTROPY_BYTES = 32;

const CANONICAL_INVITE_TOKEN = /^bzi_[0-9a-f]{64}$/;
// Monolith releases before the shared contract encoded the same 32 bytes as base64url.
const LEGACY_BASE64URL_INVITE_TOKEN = /^bzi_[A-Za-z0-9_-]{43}$/;

export function isCommunityInviteToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (CANONICAL_INVITE_TOKEN.test(value) || LEGACY_BASE64URL_INVITE_TOKEN.test(value))
  );
}

export function createCommunityInviteToken(entropy: Uint8Array): string {
  if (entropy.length !== COMMUNITY_INVITE_TOKEN_ENTROPY_BYTES) {
    throw new Error(`invite token entropy must be ${COMMUNITY_INVITE_TOKEN_ENTROPY_BYTES} bytes`);
  }
  const encoded = Array.from(entropy, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${COMMUNITY_INVITE_TOKEN_PREFIX}${encoded}`;
}
