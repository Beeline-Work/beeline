import {
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY_INVITE,
  createBuzzClient,
  createIdentity,
  inviteTokenHash,
  parseCommunityInvite,
  queryEvents,
  type Community,
  type CommunityInviteRecord,
  type Identity,
} from '@buzzy/buzz-client';

export const COMMUNITY_INVITE_ORIGIN = 'https://buzzrouter.com';
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
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.toLowerCase() === 'buzzrouter.com'
    ) {
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

export function buildCommunityInviteUrl(token: string): string {
  const parsed = parseCommunityInviteToken(token);
  if (!parsed) throw new Error('invalid invite token');
  return `${COMMUNITY_INVITE_ORIGIN}/join/${encodeURIComponent(parsed)}`;
}

export async function createCommunityInviteUrl(
  client: CommunityInviteCreator,
  communityId: string,
): Promise<string> {
  const invite = await client.createInvite(communityId);
  return buildCommunityInviteUrl(invite.token);
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
  const events = await queryEvents(
    { baseUrl: normalizedBaseUrl, host },
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        '#d': [tokenHash],
        '#t': [TAG_COMMUNITY_INVITE],
        limit: 20,
      },
    ],
    reader.publicKey,
  );
  const invite = events
    .map(parseCommunityInvite)
    .find((record): record is CommunityInviteRecord => record?.tokenHash === tokenHash);
  if (!invite) throw new Error('invite not found');
  if (invite.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('invite has expired');
  }

  const client = createBuzzClient({ baseUrl: normalizedBaseUrl, host, identity: reader });
  const [community, members] = await Promise.all([
    client.getCommunity(invite.communityId),
    client.communityMembers(invite.communityId),
  ]);
  if (!community) throw new Error('community not found');
  if (!members.some((member) => member.pubkey === invite.mintedBy)) {
    throw new Error('invite is no longer valid');
  }
  return { community, invite };
}
