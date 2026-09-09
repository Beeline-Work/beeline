import { isCommunityInviteToken } from '@beeline/api-contract/phone';

// Keep custom invite parsing aligned with the installed schemes in app.config.js.
const MOBILE_APP_SCHEMES = ['beeline'] as const;

type CommunityInviteCreator = {
  createInvite: (communityId: string) => Promise<{ token: string }>;
};

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function parseCommunityInviteToken(value: string | string[] | undefined): string | null {
  const input = firstValue(value).trim();
  if (!input) return null;
  if (isCommunityInviteToken(input)) return input;

  try {
    const url = new URL(input);
    let candidate = '';
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const match = url.pathname.match(/^\/join\/([^/]+)\/?$/);
      candidate = match?.[1] ?? '';
    } else if (
      MOBILE_APP_SCHEMES.some((scheme) => url.protocol === `${scheme}:`) &&
      url.hostname === 'join'
    ) {
      candidate = url.pathname.replace(/^\//, '');
    }
    const decoded = decodeURIComponent(candidate);
    return isCommunityInviteToken(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function buildCommunityInviteUrl(token: string, relayUrl: string): string {
  const parsed = parseCommunityInviteToken(token);
  if (!parsed) throw new Error('invalid invite token');
  const relay = new URL(relayUrl);
  if (relay.protocol !== 'https:' && relay.protocol !== 'http:') {
    throw new Error('relay URL must use HTTP or HTTPS');
  }
  return `${relay.origin}/join/${encodeURIComponent(parsed)}`;
}

export function resolveCommunityInvitePublicOrigin(
  effectiveRelayUrl: string,
  runtime: { readonly monolithEnabled: boolean; readonly relayUrl: string },
): string {
  return runtime.monolithEnabled ? runtime.relayUrl : effectiveRelayUrl;
}

export function resolveCommunityInviteRelayUrl(
  inviteUrl: string | null | undefined,
  token: string,
  fallbackRelayUrl: string,
): string {
  if (!inviteUrl || parseCommunityInviteToken(inviteUrl) !== parseCommunityInviteToken(token)) {
    return fallbackRelayUrl;
  }
  try {
    const url = new URL(inviteUrl);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  } catch {
    // Raw tokens and malformed URLs use the configured relay.
  }
  return fallbackRelayUrl;
}

export async function createCommunityInviteUrl(
  client: CommunityInviteCreator,
  communityId: string,
  relayUrl: string,
): Promise<string> {
  const invite = await client.createInvite(communityId);
  return buildCommunityInviteUrl(invite.token, relayUrl);
}
