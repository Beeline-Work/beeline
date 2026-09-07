import { isCommunityInviteToken } from '@beeline/api-contract/phone';

const TOKEN_PATH_PATTERN = /^\/join\/([^/]+)\/?$/;
export const APK_DOWNLOAD_URL =
  'https://github.com/Beeline-Work/beeline/releases/download/apk-v27/beeline-v27-loop-brass.apk';
export const MONOLITH_ORIGIN = 'https://server.usebeeline.app';
export const RESOLVE_TIMEOUT_MS = 8_000;
export const APP_OPEN_TIMEOUT_MS = 1_800;

export async function resolveInvitePreview(baseUrl, token) {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/v1/public/invite-preview?token=${encodeURIComponent(token)}`,
    { headers: { accept: 'application/json' } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Invite resolution failed: HTTP ${response.status}`);
  const preview = await response.json();
  if (
    !preview ||
    typeof preview !== 'object' ||
    preview.valid !== true ||
    typeof preview.workspaceName !== 'string' ||
    typeof preview.inviterName !== 'string' ||
    !Number.isSafeInteger(preview.expiresAt) ||
    Object.keys(preview).some(
      (key) => !['valid', 'workspaceName', 'inviterName', 'expiresAt'].includes(key),
    )
  ) {
    throw new Error('Invite preview response was invalid');
  }
  return preview;
}

export function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('Invite resolution timed out')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

export function startInviteLanding({
  resolvePreview = resolveInvitePreview,
  openApp = (url) => window.location.assign(url),
  resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
  appOpenTimeoutMs = APP_OPEN_TIMEOUT_MS,
} = {}) {
  const match = window.location.pathname.match(TOKEN_PATH_PATTERN);
  const join = document.querySelector('#join-workspace');
  const heading = document.querySelector('#invite-heading');
  const details = document.querySelector('#invite-details');
  const status = document.querySelector('#status');

  if (!match || !isCommunityInviteToken(match[1]) || !join || !heading || !details || !status) {
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
      const preview = await withTimeout(resolvePreview(MONOLITH_ORIGIN, token), resolveTimeoutMs);
      if (attempt !== resolveAttempt) return;
      if (!preview) {
        status.textContent = 'This invite is invalid or expired.';
        setAction('Retry', '#', (event) => {
          event.preventDefault();
          void resolveInvite();
        });
        return;
      }

      const { workspaceName, inviterName } = preview;
      join.textContent = `Join ${workspaceName}`;
      heading.textContent = `You're invited to ${workspaceName}`;
      details.textContent = `${inviterName} invited you to join this Workspace. Open Beeline to preview it and become a member.`;
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
