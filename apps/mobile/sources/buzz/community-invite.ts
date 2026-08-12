import {
  createBuzzClient,
  createIdentity,
  findCommunityInvite,
  inviteTokenHash,
  type Community,
  type CommunityInviteRecord,
  type Identity,
} from '@beeline/buzz-client';
import { WORKSPACE_LABEL } from './vocabulary';

const TOKEN_PATTERN = /^bzi_[0-9a-f]{64}$/;

export type CommunityInvitePreview = {
  community: Community;
  invite: CommunityInviteRecord;
};

type CommunityInviteCreator = {
  createInvite: (communityId: string) => Promise<{ token: string }>;
};

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function parseCommunityInviteToken(value: string | string[] | undefined): string | null {
  const input = firstValue(value).trim();
  if (!input) return null;
  if (TOKEN_PATTERN.test(input)) return input;

  try {
    const url = new URL(input);
    let candidate = '';
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const match = url.pathname.match(/^\/join\/([^/]+)\/?$/);
      candidate = match?.[1] ?? '';
    } else if (url.protocol === 'buzzy:' && url.hostname === 'join') {
      candidate = url.pathname.replace(/^\//, '');
    }
    const decoded = decodeURIComponent(candidate);
    return TOKEN_PATTERN.test(decoded) ? decoded : null;
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

export async function loadCommunityInvitePreview(
  baseUrl: string,
  token: string,
  identity?: Identity,
): Promise<CommunityInvitePreview> {
  const parsedToken = parseCommunityInviteToken(token);
  if (!parsedToken) throw new Error('invalid invite link');

  const reader = identity ?? createIdentity('buzzy-invite-preview');
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const host = new URL(normalizedBaseUrl).host;
  const tokenHash = inviteTokenHash(parsedToken);
  const invite = await findCommunityInvite(
    { baseUrl: normalizedBaseUrl, host, identity: reader },
    tokenHash,
    reader.publicKey,
  );
  if (!invite) throw new Error('invite not found');
  if (invite.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('invite has expired');
  }

  const client = createBuzzClient({ baseUrl: normalizedBaseUrl, host, identity: reader });
  const [community, members] = await Promise.all([
    client.getCommunity(invite.communityId),
    client.communityMembers(invite.communityId),
  ]);
  if (!community) throw new Error(`${WORKSPACE_LABEL} not found`);
  if (!members.some((member) => member.pubkey === invite.mintedBy)) {
    throw new Error('invite is no longer valid');
  }
  return { community, invite };
}
