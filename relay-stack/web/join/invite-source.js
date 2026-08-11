import {
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
  createIdentity,
  inviteTokenHash,
  parseCommunityInvite,
  queryEvents,
} from '@beeline/buzz-client';
import { verifyEvent } from '@beeline/nostr';

const TOKEN_PATTERN = /^\/join\/(bzi_[0-9a-f]{64})\/?$/;

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function parseWorkspaceName(event, communityId) {
  if (event.kind !== KIND_CREATE_GROUP || !verifyEvent(event)) return null;
  if (tagValue(event, 'h') !== communityId) return null;
  if (tagValue(event, TAG_COMMUNITY) !== communityId) return null;
  const name = tagValue(event, 'name')?.trim();
  return name || null;
}

export async function resolveWorkspaceName(baseUrl, token) {
  const identity = createIdentity('beeline-invite-preview');
  const relay = new URL(baseUrl);
  const http = {
    baseUrl: relay.origin,
    host: relay.host,
    identity,
  };
  const tokenHash = inviteTokenHash(token);
  const inviteEvents = await queryEvents(
    http,
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        '#d': [tokenHash],
        '#t': [TAG_COMMUNITY_INVITE],
        limit: 20,
      },
    ],
    identity.publicKey,
  );
  const invite = inviteEvents
    .map(parseCommunityInvite)
    .find((record) => record?.tokenHash === tokenHash);
  if (!invite || invite.expiresAt <= Math.floor(Date.now() / 1000)) return null;

  const communityEvents = await queryEvents(
    http,
    [{ kinds: [KIND_CREATE_GROUP], '#h': [invite.communityId], limit: 5 }],
    identity.publicKey,
  );
  return (
    communityEvents
      .sort((left, right) => left.created_at - right.created_at)
      .map((event) => parseWorkspaceName(event, invite.communityId))
      .find(Boolean) ?? null
  );
}

export function startInviteLanding() {
  const match = window.location.pathname.match(TOKEN_PATTERN);
  const join = document.querySelector('#join-workspace');
  const heading = document.querySelector('#invite-heading');
  const status = document.querySelector('#status');

  if (!match || !join || !heading || !status) {
    if (status) status.textContent = 'This invite link is malformed.';
    return;
  }

  const token = match[1];
  join.href = `buzzy://join/${encodeURIComponent(token)}`;

  void resolveWorkspaceName(window.location.origin, token)
    .then((workspaceName) => {
      if (!workspaceName) {
        status.textContent = 'Workspace details will appear in Beeline.';
        return;
      }
      join.textContent = `Join ${workspaceName}`;
      heading.textContent = `You're invited to ${workspaceName}`;
      document.title = `Join ${workspaceName} | Beeline`;
      status.textContent = 'Signed invite verified.';
    })
    .catch(() => {
      status.textContent = 'Workspace details will appear in Beeline.';
    });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  startInviteLanding();
}
