import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AuthStore, type ManagedIdentity } from './store.js';
import { OidcClient } from './oidc.js';
import { GitHubAppClient, GitHubOAuthClient, type GitHubIdentity } from './github.js';
import {
  appSetupEnvBlock,
  buildAppManifest,
  checkGitHubAppDriftBestEffort,
  convertAppManifestCode,
  setupTokenMatches,
} from './github-manifest.js';
import { extractGitHubRepoEvent } from './github-repo-events.js';
import { resolveGitHubRepositoryAccess } from './github-repository-access.js';
import {
  isValidNip05Name,
  isResolvableNip05Name,
  normalizeHost,
  OIDC_BIND_KIND,
  OIDC_BIND_MARKER,
  randomToken,
  sha256,
  verifyBindEvent,
  verifyNip98Header,
} from './protocol.js';

const DEFAULT_FLOW_TTL_MS = 5 * 60_000;
const DEFAULT_TICKET_TTL_MS = 2 * 60_000;
const GITHUB_INSTALLATION_RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Repository-activity event types the webhook stores for Room delivery. */
export const GITHUB_REPO_EVENT_TYPES = new Set(['star', 'issues', 'pull_request']);
/** Max stored events released per room-events read; a longer backlog needs more reads. */
const GITHUB_REPO_EVENT_FETCH_LIMIT = 100;
/** Hard ceiling on a room-events long-poll hold. */
const GITHUB_REPO_EVENT_MAX_WAIT_MS = 25_000;
/** How long a successful Room authority proof is reused before relay truth re-proves it. */
const GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS = 5 * 60_000;
const FLOW_COOKIE = '__Host-beeline_oidc_flow';
// Exact native identities from apps/mobile/app.config.js. Never derive these from request input.
const GITHUB_SIGN_IN_DEEP_LINK = 'beeline://buzz/github-callback';
const GITHUB_INSTALLATION_DEEP_LINK = 'beeline://buzz/github-installation';

function githubInstallationManageUrl(installation: {
  accountType: 'User' | 'Organization';
  accountLogin: string;
  installationId: number;
}): string {
  return installation.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;
}

function exactRedirect(value: string, expected: string): boolean {
  return value === expected || (!expected.endsWith('/') && value === `${expected}/`);
}

export interface AuthTenant {
  host: string;
  /** Stable namespace for identity links. Kept across relay host aliases. */
  community: string;
  /** Server-stamped relay community UUIDs whose Rooms this tenant may serve. */
  roomCommunityIds: readonly string[];
  origin: string;
}

export type GitHubRoomTokenAuthorityFailureReason =
  | 'tenant_room_community_mismatch'
  | 'agent_not_room_member'
  | 'room_repository_missing'
  | 'room_repository_remote_malformed'
  | 'room_repository_authority_missing';

export type GitHubRoomTokenAuthorityResult =
  | {
      authorized: true;
      authorizedBy: string;
      /** The binding author's CURRENT key after key succession (equal to
       * `authorizedBy` when no succession recorded). Pubkey-keyed lookups
       * (GitHub installations, owner comparisons) use this value. */
      currentAuthorizedBy?: string;
      fullName: string;
      githubInstallationId?: number;
    }
  | { authorized: false; reason: GitHubRoomTokenAuthorityFailureReason };

export interface AuthServerOptions {
  store: AuthStore;
  oidc: OidcClient;
  /** GitHub is the shipped sign-in and repository-access provider. */
  github?: { oauth: GitHubOAuthClient; app: GitHubAppClient; webhookSecret?: string };
  tenants: AuthTenant[];
  now?: () => Date;
  flowTtlMs?: number;
  ticketTtlMs?: number;
  logger?: FastifyServerOptions['logger'];
  /** Exact native completion URLs; never accept an arbitrary OAuth open redirect. */
  nativeRedirectUris?: string[];
  /** Local device emulators only. Production browser-session cookies stay Secure. */
  secureCookies?: boolean;
  /**
   * Shared secret gating the GitHub App manifest setup pages
   * (/auth/github/app-setup, /auth/github/app-drift). When unset those
   * endpoints refuse — the setup surface is operator-only, never public.
   */
  githubSetupToken?: string;
  /** Relay-backed proof that an agent currently belongs to a Room and that Room names this repo. */
  authorizeGitHubRoomToken?: (
    tenant: AuthTenant,
    input: { agentPubkey: string; roomId: string; relayAuthorizations: readonly string[] },
  ) => Promise<GitHubRoomTokenAuthorityResult>;
}

class ProtocolError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Extra machine-readable fields merged into the JSON error body. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function noStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
  reply.header('referrer-policy', 'no-referrer');
}

function managedIdentityJson(identity: ManagedIdentity) {
  return {
    handle: identity.handle,
    display_name: identity.displayName,
    nip05: identity.nip05,
    source: identity.source,
    ...(identity.githubLogin ? { github_login: identity.githubLogin } : {}),
    github_rename_available: identity.githubRenameAvailable,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function nativeReturnPage(target: URL): string {
  const href = escapeHtml(target.toString());
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="refresh" content="0;url=${href}">
    <title>Return to Beeline</title>
    <style>
      body { background: #090909; color: #f2f2f2; font: 16px system-ui, sans-serif; margin: 0; }
      main { box-sizing: border-box; margin: 0 auto; max-width: 36rem; padding: 20vh 1.5rem 3rem; }
      a { color: #f2f2f2; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>Beeline sign-in complete</h1>
      <p>Beeline should open automatically.</p>
      <p><a href="${href}">Return to Beeline</a></p>
    </main>
  </body>
</html>`;
}

// A GitHub App install that did NOT originate inside Beeline (share link,
// marketplace) lands back on this service carrying installation_id/setup_action
// but no state marker — there is no flow to consume and no session to bind.
// That return is purely informational: render a friendly landing (never raw
// JSON, never a 4xx), perform NO session binding and mint NO token. Server-side
// discovery already ingests the grant — the installation webhook records it and
// reconcileGitHubInstallations enumerates with the App JWT — so no reconcile
// kick is fired here: without a bound pubkey there is nothing cheap to kick
// that the webhook has not already covered.
function githubInstallReturnPage(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Beeline — GitHub</title>
    <style>
      body { background: #090909; color: #f2f2f2; font: 16px system-ui, sans-serif; margin: 0; }
      main { box-sizing: border-box; margin: 0 auto; max-width: 36rem; padding: 20vh 1.5rem 3rem; }
      h1 { font-size: 1.5rem; }
      .mark { color: #d7af5f; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <main>
      <p class="mark">Beeline</p>
      <h1>${escapeHtml(heading)}</h1>
      ${body}
    </main>
  </body>
</html>`;
}

function githubInstallConnectedPage(): string {
  return githubInstallReturnPage(
    'GitHub connected',
    `<p>The Beeline GitHub App was installed successfully. You can close this tab and return to the app now.</p>
      <p>If someone sent you this link, let them know you are connected.</p>`,
  );
}

function githubInstallErrorPage(): string {
  return githubInstallReturnPage(
    'This connection link has expired',
    `<p>This GitHub connection link is invalid or has already been used.</p>
      <p>If the installation itself succeeded on GitHub, Beeline will discover it automatically. Otherwise, start again from the app (or ask for a fresh link) and the connection will complete normally.</p>`,
  );
}

const GITHUB_SETUP_PAGE_STYLE = `
      body { background: #090909; color: #f2f2f2; font: 16px system-ui, sans-serif; margin: 0; }
      main { box-sizing: border-box; margin: 0 auto; max-width: 44rem; padding: 14vh 1.5rem 3rem; }
      pre { background: #161616; border: 1px solid #333; overflow-x: auto; padding: 1rem; }
      code { font-family: ui-monospace, monospace; font-size: 0.85em; }
      button { background: #d7af5f; border: none; color: #111; cursor: pointer; font: inherit; font-weight: 700; padding: 0.6rem 1.2rem; }
    `;

function setupPage(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Beeline GitHub App setup</title>
    <style>${GITHUB_SETUP_PAGE_STYLE}</style>
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

/** The manifest creation form: one click submits everything to GitHub. */
function githubAppSetupFormPage(manifest: Record<string, unknown>): string {
  const manifestJson = escapeHtml(JSON.stringify(manifest));
  return setupPage(`
      <h1>Beeline GitHub App setup</h1>
      <p>This creates your Beeline GitHub App with every event and permission preconfigured &mdash; no checkbox assembly required.</p>
      <p>After GitHub creates the App you will land back here with a copy-paste environment block for the auth service.</p>
      <form method="post" action="https://github.com/settings/apps/new">
        <input type="hidden" name="manifest" value="${manifestJson}">
        <button type="submit">Create the Beeline GitHub App on GitHub</button>
      </form>`);
}

/** The one-time conversion result: copy-paste env block, never logged. */
function githubAppSetupEnvPage(envBlock: string, appUrl: string | undefined): string {
  const install = appUrl ? `${escapeHtml(appUrl)}/installations/new` : '';
  return setupPage(`
      <h1>GitHub App created</h1>
      <p>Copy this block into the auth service environment and restart it:</p>
      <pre><code>${escapeHtml(envBlock)}</code></pre>
      ${appUrl ? `<p>Next: <a href="${install}">install the App on your account or organization</a>.</p>` : ''}
      <p>Keep the private key out of chat logs and version control.</p>`);
}

function githubAppSetupErrorPage(message: string): string {
  return setupPage(`
      <h1>GitHub App setup failed</h1>
      <p>${escapeHtml(message)}</p>
      <p>The conversion code is single-use; start over from the setup page.</p>`);
}

function requiredQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) {
    throw new ProtocolError(400, 'invalid_request', `missing or invalid ${name}`);
  }
  return value;
}

function githubRepositoryFromPayload(
  value: unknown,
  installationId: number,
): {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  remote: string;
  defaultBranch: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub repository payload');
  }
  const repository = value as Record<string, unknown>;
  const id = repository.id;
  const name = repository.name;
  const fullName = repository.full_name;
  const remote = repository.clone_url;
  const defaultBranch = repository.default_branch;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    typeof name !== 'string' ||
    typeof fullName !== 'string' ||
    typeof remote !== 'string' ||
    typeof defaultBranch !== 'string'
  ) {
    throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub repository payload');
  }
  return { id, installationId, name, fullName, remote, defaultBranch };
}

/**
 * Whether a user-token listing failure means the STORED OAuth credential was
 * rejected (401/403) rather than GitHub being unreachable — the signal that
 * the app should silently re-auth next session.
 */
function isGitHubUserTokenAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 40[13]\b/.test(message);
}

function githubInstallationId(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub installation payload');
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub installation payload');
  }
  return id;
}

function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: unknown,
): boolean {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const actual = Buffer.from(signature.slice(7), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function flowCookie(request: FastifyRequest, cookieName = FLOW_COOKIE): string {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (matches.length !== 1)
    throw new ProtocolError(400, 'invalid_oidc_flow', 'OIDC browser session is missing');
  const value = matches[0]!.slice(cookieName.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ProtocolError(400, 'invalid_oidc_flow', 'OIDC browser session is invalid');
  }
  return value;
}

function publicUrl(tenant: AuthTenant, request: FastifyRequest): string {
  const path = request.raw.url;
  if (!path?.startsWith('/'))
    throw new ProtocolError(400, 'invalid_request', 'invalid request URL');
  return `${tenant.origin}${path}`;
}

function sha256Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(sha256(value), 'hex'));
}

export function createAuthRouteContext(options: AuthServerOptions) {
  const now = options.now ?? (() => new Date());
  const flowTtlMs = options.flowTtlMs ?? DEFAULT_FLOW_TTL_MS;
  const ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  const nativeRedirectUris = new Set([
    GITHUB_SIGN_IN_DEEP_LINK,
    GITHUB_INSTALLATION_DEEP_LINK,
    ...(options.nativeRedirectUris ?? []),
  ]);
  const isAllowedAppRedirect = (value: string, associatedRedirect: string): boolean =>
    exactRedirect(value, associatedRedirect) ||
    [...nativeRedirectUris].some((nativeRedirect) => exactRedirect(value, nativeRedirect));
  const cookieSecurity = options.secureCookies === false ? '' : ' Secure;';
  const flowCookieName = options.secureCookies === false ? 'beeline_oidc_flow' : FLOW_COOKIE;
  const githubTokenKey = options.github
    ? createHash('sha256').update(options.github.oauth.config.clientSecret).digest()
    : undefined;
  const encryptGitHubToken = (token: string): string => {
    if (!githubTokenKey) throw new Error('GitHub token encryption is unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', githubTokenKey, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.');
  };
  const decryptGitHubToken = (sealed: string): string => {
    if (!githubTokenKey) throw new Error('GitHub token encryption is unavailable');
    const parts = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16) {
      throw new Error('stored GitHub token is invalid');
    }
    const decipher = createDecipheriv('aes-256-gcm', githubTokenKey, parts[0]!);
    decipher.setAuthTag(parts[1]!);
    return Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString('utf8');
  };
  type AgentConnectIdentity = {
    issuer: string;
    audience: string;
    subject: string;
  };
  let agentConnectApproval: (
    tenant: AuthTenant,
    flow: import('./store.js').OidcFlow,
    identity: AgentConnectIdentity,
  ) => Promise<boolean> = async () => false;
  const completeAgentConnectApproval = (
    tenant: AuthTenant,
    flow: import('./store.js').OidcFlow,
    identity: AgentConnectIdentity,
  ) => agentConnectApproval(tenant, flow, identity);
  const setAgentConnectApproval = (approval: typeof agentConnectApproval): void => {
    agentConnectApproval = approval;
  };
  const reconcileGitHubInstallations = async (
    community: string,
    pubkey: string,
    log: FastifyRequest['log'],
  ): Promise<void> => {
    try {
      const subject = await options.store.githubSubjectForPubkey(community, pubkey);
      if (!subject) return;
      const sealedUserToken = await options.store.githubUserToken(community, subject);
      if (!sealedUserToken) return;
      const attemptedAt = now();
      if (
        !(await options.store.claimGitHubInstallationReconciliation(
          community,
          subject,
          attemptedAt,
          new Date(attemptedAt.getTime() - GITHUB_INSTALLATION_RECONCILE_INTERVAL_MS),
        ))
      ) {
        return;
      }
      // Enumerate with the APP's own credential: GET /user/installations is
      // keyed to the OAuth lookup token's visibility, and an unscoped token
      // cannot see organization installations — production stranded a real
      // org install behind exactly that blindness. The App JWT sees every
      // installation, so an install whose callback never persisted is
      // discovered here without the owner re-running the install flow.
      const installations = await options.github!.app.listInstallations();
      // One user-token listing answers "which installations does this user
      // administer" for every candidate at once; computed only when a
      // not-yet-recorded installation actually needs the ownership gate.
      let userInstallationIds: Promise<Set<number> | 'unavailable'> | undefined;
      const administeredByUser = async (): Promise<Set<number> | 'unavailable'> => {
        if (!userInstallationIds) {
          userInstallationIds = options
            .github!.app.listUserInstallationIds(decryptGitHubToken(sealedUserToken))
            .then(
              (ids) => {
                // The stored credential demonstrably still works.
                void options.store.clearGitHubUserTokenStale(community, subject).catch(() => {});
                return new Set(ids);
              },
              (error: unknown) => {
                log.warn(
                  { err: error, community, pubkey },
                  'GitHub installation listing unavailable for organization verification',
                );
                if (isGitHubUserTokenAuthError(error)) {
                  // GitHub answered 401/403 for the STORED user token: mark
                  // it stale so the app can offer a silent re-auth next
                  // session. Best-effort — never blocks the reconcile.
                  void options.store
                    .markGitHubUserTokenStale(community, subject, now())
                    .catch(() => {});
                }
                return 'unavailable' as const;
              },
            );
        }
        return userInstallationIds;
      };
      for (const { installationId, account } of installations) {
        const known = await options.store.githubInstallation(community, installationId);
        if (!known) {
          // A NEWLY discovered installation is only claimed for a user who
          // can administer it. A User-type account is always verifiable, so
          // it demands positive confirmation; an Organization-type account
          // follows the install-callback precedent — GitHub's state-bound
          // redirect is absent here, but an unavailable listing is logged
          // and proceeded with, while a definitive denial refuses.
          const administered = await administeredByUser();
          if (administered !== 'unavailable') {
            if (!administered.has(installationId)) continue;
          } else if (account.type !== 'Organization') {
            continue;
          }
        }
        // An already recorded installation refreshes through the same
        // guarded upsert the callback uses: the store's conflict guard keeps
        // another GitHub account's link untouched and lets a matching
        // subject move the row onto the current pubkey (identity recovery);
        // a refusal there is the honest answer, not an error.
        const repositories = await options.github!.app.listRepositories(installationId);
        await options.store.replaceGitHubInstallationSnapshot(
          {
            community,
            pubkey,
            authorizedSubject: subject,
            accountId: account.id,
            accountLogin: account.login,
            accountType: account.type,
            ...(account.avatarUrl ? { accountAvatarUrl: account.avatarUrl } : {}),
            installationId,
            repositorySelection: account.repositorySelection,
            status: 'active',
            repositoryCount: repositories.length,
          },
          repositories,
          attemptedAt,
        );
        // Reconcile is the backstop that discovers an owner's NEW install
        // without any callback, so it is also a completion path for pending
        // Room links (failures are swallowed by this function's outer catch).
        await completeActivatedRoomLinks(
          community,
          repositories.map((repository) => repository.fullName),
        );
      }
    } catch (error) {
      log.warn({ err: error, community, pubkey }, 'GitHub installation reconciliation failed');
    }
  };
  if (flowTtlMs < 30_000 || flowTtlMs > 10 * 60_000)
    throw new Error('flow TTL is outside safe bounds');
  if (ticketTtlMs < 30_000 || ticketTtlMs > 5 * 60_000)
    throw new Error('ticket TTL is outside safe bounds');

  const tenants = new Map<string, AuthTenant>();
  for (const configured of options.tenants) {
    const host = normalizeHost(configured.host);
    if (!configured.community || configured.community.length > 512)
      throw new Error('invalid tenant community');
    if (
      !Array.isArray(configured.roomCommunityIds) ||
      configured.roomCommunityIds.length === 0 ||
      configured.roomCommunityIds.length > 64 ||
      configured.roomCommunityIds.some(
        (communityId) =>
          typeof communityId !== 'string' || !communityId || communityId.length > 512,
      )
    ) {
      throw new Error('invalid tenant Room community ids');
    }
    const origin = new URL(configured.origin);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    ) {
      throw new Error('tenant origin must be an origin without a path');
    }
    const normalizedOrigin = origin.origin;
    if (normalizeHost(origin.host) !== host) throw new Error('tenant origin and Host must match');
    if (tenants.has(host)) throw new Error(`duplicate auth tenant Host: ${host}`);
    tenants.set(host, {
      host,
      community: configured.community,
      roomCommunityIds: [...new Set(configured.roomCommunityIds)],
      origin: normalizedOrigin,
    });
  }
  if (tenants.size === 0) throw new Error('at least one auth tenant is required');

  const tenantFor = (request: FastifyRequest): AuthTenant => {
    let host: string;
    try {
      host = normalizeHost(request.headers.host ?? '');
    } catch {
      throw new ProtocolError(400, 'invalid_host', 'invalid Host header');
    }
    const tenant = tenants.get(host);
    if (!tenant) throw new ProtocolError(404, 'unknown_tenant', 'unknown tenant Host');
    return tenant;
  };

  // Long-poll waiters for stored repository events, keyed by lowercased
  // full_name. A verified webhook insert wakes every daemon parked on that
  // repository so a Room sees a star/issue/PR within milliseconds of the
  // delivery instead of on the next poll tick.
  const githubRepoEventWaiters = new Map<string, Set<() => void>>();
  const wakeGitHubRepoEventWaiters = (fullName: string): void => {
    const waiters = githubRepoEventWaiters.get(fullName.toLowerCase());
    if (!waiters) return;
    githubRepoEventWaiters.delete(fullName.toLowerCase());
    for (const waiter of waiters) waiter();
  };
  const waitForGitHubRepoEvent = (fullName: string, waitMs: number): Promise<void> => {
    const key = fullName.toLowerCase();
    let waiters = githubRepoEventWaiters.get(key);
    if (!waiters) {
      waiters = new Set();
      githubRepoEventWaiters.set(key, waiters);
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      waiters.add(done);
    });
  };

  // Complete pending Room→repo links whose repository just became covered by
  // an installation (install callback, webhook, or reconcile), and announce
  // each completion into the stored repository-event feed the daemon already
  // long-polls — so the Room card announcing "access granted" rides exactly
  // the path stars and issues ride, with no new delivery mechanism. The
  // deterministic per-link delivery id makes re-announcement impossible: a
  // second activation attempt finds nothing to flip, and a replayed event row
  // conflicts on delivery_id and is dropped.
  const completeActivatedRoomLinks = async (
    community: string,
    fullNames: readonly string[],
  ): Promise<void> => {
    const activated = await options.store.activateGitHubRoomLinks(community, fullNames, now());
    if (activated.length === 0) return;
    await options.store.saveGitHubRepoEvents(
      activated.map((link) => ({
        fullName: link.fullName,
        deliveryId: `room-link-${sha256(`${community}|${link.roomId}|${link.fullName.toLowerCase()}`).slice(0, 32)}`,
        eventType: 'beeline_room_link',
        action: 'granted',
        actor: '',
        summary: `Beeline access granted: ${link.fullName} is now linked.`,
      })),
      now(),
    );
    for (const link of activated) wakeGitHubRepoEventWaiters(link.fullName);
  };

  // A successful Room authority proof costs several authenticated relay reads.
  // Reusing it for a short window keeps a long-polling daemon from re-reading
  // relay state every request; the cache is authorized results only, so a
  // refusal is always re-derived from current truth.
  const roomAuthorityCache = new Map<
    string,
    {
      authorizedBy: string;
      currentAuthorizedBy?: string;
      fullName: string;
      githubInstallationId?: number;
      expiresAt: number;
    }
  >();

  const nativeCompletion = (
    flow: { appRedirectUri: string | null; appState: string | null },
    values: Record<string, string | number>,
  ): URL | null => {
    if (!flow.appRedirectUri || !flow.appState) return null;
    const target = new URL(flow.appRedirectUri);
    target.searchParams.set('state', flow.appState);
    for (const [name, value] of Object.entries(values))
      target.searchParams.set(name, String(value));
    return target;
  };

  const deliverNativeCompletion = (reply: FastifyReply, target: URL) => {
    if (target.protocol === 'http:' || target.protocol === 'https:') {
      return reply.redirect(target.toString(), 302);
    }
    noStore(reply);
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    // Android Custom Tabs can briefly expose the terminal response while the
    // app deep link is dispatched. Give that transition a real immediate
    // handoff page instead of a blank document.
    return reply.type('text/html; charset=utf-8').send(nativeReturnPage(target));
  };

  const issueBindChallenge = async (
    tenant: AuthTenant,
    flow: { appRedirectUri: string | null; appState: string | null },
    identity: {
      issuer: string;
      audience: string;
      subject: string;
      login?: string;
      displayName?: string;
    },
    reply: FastifyReply,
  ) => {
    const ticket = randomToken();
    const challenge = randomToken();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ticketTtlMs);
    await options.store.createTicket(sha256(ticket), {
      challenge,
      community: tenant.community,
      issuer: identity.issuer,
      audience: identity.audience,
      subject: identity.subject,
      createdAt: issuedAt,
      expiresAt,
      attemptCount: 0,
      consumedAt: null,
      boundPubkey: null,
      providerLogin: identity.login?.toLowerCase() ?? null,
      providerDisplayName: identity.displayName?.trim() || identity.login || null,
    });
    noStore(reply);
    const bindChallenge = {
      protocol: 1,
      kind: OIDC_BIND_KIND,
      marker: OIDC_BIND_MARKER,
      ticket,
      challenge,
      provider: identity.issuer,
      audience: identity.audience,
      subject: identity.subject,
      community: tenant.community,
      issued_at: Math.floor(issuedAt.getTime() / 1_000),
      expires_at: Math.floor(expiresAt.getTime() / 1_000),
    } as const;
    const completion = nativeCompletion(flow, bindChallenge);
    if (completion) return deliverNativeCompletion(reply, completion);
    return reply.send(bindChallenge);
  };

  const provisionManagedIdentity = async (
    ticket: NonNullable<Awaited<ReturnType<AuthStore['findTicket']>>>,
    pubkey: string,
  ): Promise<ManagedIdentity | undefined> => {
    if (ticket.issuer !== 'https://github.com') return undefined;
    const login = ticket.providerLogin?.toLowerCase() ?? '';
    if (!isResolvableNip05Name(login)) {
      throw new Error('verified GitHub identity is missing a valid login');
    }
    const displayName = ticket.providerDisplayName?.trim().slice(0, 60) || login;
    return options.store.provisionGitHubIdentity(
      ticket.community,
      ticket.subject,
      pubkey,
      login,
      displayName,
      now(),
    );
  };

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProtocolError) {
      void reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
      void reply.status(413).send({ error: 'request_too_large' });
      return;
    }
    // Never a silent 500: log the exception against the request id and give
    // the caller an actionable body. Upstream client errors carry their own
    // plain-language message (e.g. "GitHub user installations failed: HTTP
    // 404") and never contain credentials, so surfacing them — plus the id to
    // correlate with this log line — beats a bare internal_error.
    const reqId = request.id;
    request.log.error({ err: error, reqId }, 'auth request failed unexpectedly');
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim().slice(0, 300)
        : 'the request failed while contacting GitHub or the database';
    void reply.status(500).send({
      error: 'internal_error',
      message: `${detail} (request id ${reqId} — retry; if it persists, search the auth logs for this id)`,
      reqId,
    });
  });

  async function completeGitHubInstallation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    // Three shapes reach this route. (a) In-app-initiated: state present and a
    // matching flow exists — complete the binding exactly as before. (b)
    // Stateless/foreign: no state at all — a share-link or marketplace install;
    // answer a friendly landing page and touch nothing. (c) State present but
    // wrong — keep an error, but as a readable page rather than raw JSON.
    if (query.state === undefined) {
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply.status(200).type('text/html; charset=utf-8').send(githubInstallConnectedPage());
    }
    const state = requiredQueryString(query.state, 'state');
    const rawInstallationId = query.installation_id;
    const installationId =
      typeof rawInstallationId === 'string' ? Number(rawInstallationId) : Number.NaN;
    const flowInvalid = () => {
      noStore(reply);
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      );
      return reply.status(400).type('text/html; charset=utf-8').send(githubInstallErrorPage());
    };
    if (typeof state !== 'string' || !Number.isSafeInteger(installationId) || installationId <= 0) {
      return flowInvalid();
    }
    const flow = await options.store.consumeGitHubInstallFlow(sha256(state), now());
    if (!flow || flow.community !== tenant.community) {
      return flowInvalid();
    }
    const [linkedAccountId, installedAccount, repositories] = await Promise.all([
      options.store.githubSubjectForPubkey(tenant.community, flow.pubkey),
      options.github.app.installationAccount(installationId),
      options.github.app.listRepositories(installationId),
    ]);
    if (!linkedAccountId) {
      throw new ProtocolError(
        403,
        'github_not_linked',
        'sign in with GitHub before installing the Beeline GitHub App',
      );
    }
    const sealedUserToken = await options.store.githubUserToken(tenant.community, linkedAccountId);
    if (!sealedUserToken) {
      throw new ProtocolError(
        403,
        'installation_account_mismatch',
        'the signed-in GitHub user cannot administer this installation',
      );
    }
    // GET /user/installations is keyed to the OAuth lookup token's visibility:
    // user-owned installations always appear, but an unscoped OAuth token
    // generally cannot list ORGANIZATION installations, so demanding a
    // positive match here strands every org install behind an exception or a
    // false negative. For an Organization target, GitHub's state-bound
    // redirect — only the installing admin's browser receives it, bound to
    // this flow's one-time state — is the authority; the listing still refuses
    // when it definitively denies access, and its failures are logged rather
    // than fatal.
    let userCanAdminister: boolean | undefined;
    try {
      userCanAdminister = await options.github.app.userCanAccessInstallation(
        decryptGitHubToken(sealedUserToken),
        installationId,
      );
    } catch (error) {
      if (installedAccount.type !== 'Organization') throw error;
      request.log.warn(
        { err: error, installationId },
        'GitHub installation listing unavailable for organization verification',
      );
    }
    const accessConfirmed =
      installedAccount.type === 'User' ? userCanAdminister === true : userCanAdminister !== false;
    if (!accessConfirmed) {
      throw new ProtocolError(
        403,
        'installation_account_mismatch',
        'the signed-in GitHub user cannot administer this installation',
      );
    }
    const installationSaved = await options.store.saveGitHubInstallation(
      {
        community: tenant.community,
        pubkey: flow.pubkey,
        authorizedSubject: linkedAccountId,
        accountId: installedAccount.id,
        accountLogin: installedAccount.login,
        accountType: installedAccount.type,
        ...(installedAccount.avatarUrl ? { accountAvatarUrl: installedAccount.avatarUrl } : {}),
        installationId,
        repositorySelection: installedAccount.repositorySelection,
        status: 'active',
        repositoryCount: repositories.length,
      },
      now(),
    );
    if (!installationSaved) {
      throw new ProtocolError(
        409,
        'installation_account_mismatch',
        'the GitHub installation is already linked through another GitHub account',
      );
    }
    await options.store.replaceGitHubRepositories(
      tenant.community,
      installationId,
      repositories,
      now(),
    );
    // A pending Room link for one of these repositories may now be grantable —
    // best-effort: the callback must not fail AFTER a successful save, and any
    // later webhook/reconcile completes it instead.
    try {
      await completeActivatedRoomLinks(
        tenant.community,
        repositories.map((repository) => repository.fullName),
      );
    } catch (error) {
      request.log.warn({ err: error, installationId }, 'Room link completion check failed');
    }
    const completion = new URL(flow.redirectUri);
    completion.searchParams.set('installed', '1');
    return reply.redirect(completion.toString(), 302);
  }

  return {
    app,
    options,
    now,
    flowTtlMs,
    ticketTtlMs,
    isAllowedAppRedirect,
    cookieSecurity,
    flowCookieName,
    encryptGitHubToken,
    decryptGitHubToken,
    completeAgentConnectApproval,
    setAgentConnectApproval,
    reconcileGitHubInstallations,
    tenantFor,
    wakeGitHubRepoEventWaiters,
    waitForGitHubRepoEvent,
    completeActivatedRoomLinks,
    roomAuthorityCache,
    nativeCompletion,
    deliverNativeCompletion,
    issueBindChallenge,
    provisionManagedIdentity,
    completeGitHubInstallation,
    githubInstallationManageUrl,
    noStore,
    managedIdentityJson,
    nativeReturnPage,
    githubInstallConnectedPage,
    githubInstallErrorPage,
    githubAppSetupFormPage,
    githubAppSetupEnvPage,
    githubAppSetupErrorPage,
    requiredQueryString,
    githubRepositoryFromPayload,
    githubInstallationId,
    verifyGitHubWebhookSignature,
    flowCookie,
    publicUrl,
    ProtocolError,
    GITHUB_REPO_EVENT_TYPES,
    GITHUB_REPO_EVENT_FETCH_LIMIT,
    GITHUB_REPO_EVENT_MAX_WAIT_MS,
    GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS,
    GITHUB_SIGN_IN_DEEP_LINK,
    GITHUB_INSTALLATION_DEEP_LINK,
    sha256Bytes,
    extractGitHubRepoEvent,
    resolveGitHubRepositoryAccess,
    appSetupEnvBlock,
    buildAppManifest,
    checkGitHubAppDriftBestEffort,
    convertAppManifestCode,
    setupTokenMatches,
    isValidNip05Name,
    isResolvableNip05Name,
    OIDC_BIND_KIND,
    OIDC_BIND_MARKER,
    randomToken,
    sha256,
    verifyBindEvent,
    verifyNip98Header,
  };
}

export type AuthRouteContext = ReturnType<typeof createAuthRouteContext>;
