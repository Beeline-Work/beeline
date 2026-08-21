import {
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
  createIdentity,
  findCommunityInvite,
  inviteTokenHash,
  queryEvents,
} from '@beeline/buzz-client';
import { verifyEvent } from '@beeline/nostr';

const TOKEN_PATTERN = /^\/join\/(bzi_[0-9a-f]{64})\/?$/;
export const APK_DOWNLOAD_URL = '/dl/beeline-android.apk';
export const RESOLVE_TIMEOUT_MS = 8_000;
export const APP_OPEN_TIMEOUT_MS = 1_800;

let invitePreviewIdentity;

function getInvitePreviewIdentity() {
  // This reader exists only in page memory. It authenticates relay reads without
  // creating or persisting a Beeline account for the visitor.
  invitePreviewIdentity ??= createIdentity('beeline-anonymous-invite-preview');
  return invitePreviewIdentity;
}

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
  const identity = getInvitePreviewIdentity();
  const relay = new URL(baseUrl);
  const http = {
    baseUrl: relay.origin,
    host: relay.host,
    identity,
  };
  const tokenHash = inviteTokenHash(token);
  const invite = await findCommunityInvite(http, tokenHash, identity.publicKey);
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

export function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('Invite resolution timed out')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

export function startInviteLanding({
  resolveWorkspace = resolveWorkspaceName,
  openApp = (url) => window.location.assign(url),
  resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
  appOpenTimeoutMs = APP_OPEN_TIMEOUT_MS,
} = {}) {
  const match = window.location.pathname.match(TOKEN_PATTERN);
  const join = document.querySelector('#join-workspace');
  const heading = document.querySelector('#invite-heading');
  const details = document.querySelector('#invite-details');
  const status = document.querySelector('#status');

  if (!match || !join || !heading || !details || !status) {
    if (status) status.textContent = 'This invite link is malformed.';
    return;
  }

  const token = match[1];
  const deepLink = `beeline://join/${encodeURIComponent(token)}`;
  let resolveAttempt = 0;

  function setAction(label, href, onClick) {
    join.textContent = label;
    join.href = href;
    join.removeAttribute('aria-disabled');
    join.onclick = onClick;
  }

  function showInstall() {
    details.textContent =
      'Beeline is not installed yet. Install the Android app, then return to this invite to join the Workspace.';
    status.textContent = 'Your signed invite stays ready on this page.';
    setAction('Get Beeline', APK_DOWNLOAD_URL, () => {
      status.textContent = 'Install the download, then return here. This invite stays ready.';
      window.setTimeout(() => setAction('Open Beeline and join', deepLink, attemptAppOpen), 0);
    });
  }

  function attemptAppOpen(event) {
    event?.preventDefault();
    status.textContent = 'Opening Beeline…';

    let appOpened = document.hidden;
    const onVisibilityChange = () => {
      if (!document.hidden) return;
      appOpened = true;
      window.clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    const fallbackTimer = window.setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (!appOpened && !document.hidden) showInstall();
    }, appOpenTimeoutMs);
    document.addEventListener('visibilitychange', onVisibilityChange);

    try {
      openApp(deepLink);
    } catch {
      window.clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      showInstall();
    }
  }

  async function resolveInvite() {
    const attempt = ++resolveAttempt;
    join.textContent = 'Resolving invite…';
    join.removeAttribute('href');
    join.setAttribute('aria-disabled', 'true');
    join.onclick = (event) => event.preventDefault();
    status.textContent = 'Resolving signed invite…';

    try {
      const workspaceName = await withTimeout(
        resolveWorkspace(window.location.origin, token),
        resolveTimeoutMs,
      );
      if (attempt !== resolveAttempt) return;
      if (!workspaceName) throw new Error('Invite record was not found');

      join.textContent = `Join ${workspaceName}`;
      heading.textContent = `You're invited to ${workspaceName}`;
      document.title = `Join ${workspaceName} | Beeline`;
      status.textContent = 'Signed invite verified.';
      setAction(`Join ${workspaceName}`, deepLink, attemptAppOpen);
    } catch {
      if (attempt !== resolveAttempt) return;
      status.textContent = "Couldn't reach the Workspace. Check your connection and retry.";
      setAction('Retry', '#', (event) => {
        event.preventDefault();
        void resolveInvite();
      });
    }
  }

  void resolveInvite();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  startInviteLanding();
}
