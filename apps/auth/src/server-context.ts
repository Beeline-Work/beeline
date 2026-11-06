import type { FunnelAuthObservation, SigninAttemptObservation } from '@beeline/api-contract/signin-funnel';
import { type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthStore, type ManagedIdentity } from './store.js';
import { OidcClient } from './oidc.js';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';
import { sha256 } from './protocol.js';
export { createAuthRouteContext } from './server-context-create-auth-route-context.js';
export { type AuthRouteContext } from './server-context-auth-route-context.js';



export const DEFAULT_FLOW_TTL_MS = 5 * 60_000;

export const DEFAULT_TICKET_TTL_MS = 2 * 60_000;

export const GITHUB_INSTALLATION_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Repository-activity event types the webhook stores for Room delivery. */
export const GITHUB_REPO_EVENT_TYPES = new Set(['star', 'issues', 'pull_request']);

/** Max stored events released per room-events read; a longer backlog needs more reads. */
export const GITHUB_REPO_EVENT_FETCH_LIMIT = 100;

/** Hard ceiling on a room-events long-poll hold. */
export const GITHUB_REPO_EVENT_MAX_WAIT_MS = 25_000;

/** How long a successful Room authority proof is reused before relay truth re-proves it. */
export const GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS = 5 * 60_000;

export const FLOW_COOKIE = '__Host-beeline_oidc_flow';

// Exact native identities from apps/mobile/app.config.js. Never derive these from request input.
export const GITHUB_SIGN_IN_DEEP_LINK = 'beeline://beeline/github-callback';

export const GITHUB_INSTALLATION_DEEP_LINK = 'beeline://beeline/github-installation';

export const LEGACY_GITHUB_SIGN_IN_DEEP_LINK = 'beeline://buzz/github-callback';

export const LEGACY_GITHUB_INSTALLATION_DEEP_LINK = 'beeline://buzz/github-installation';


export function githubInstallationManageUrl(installation: {
  accountType: 'User' | 'Organization';
  accountLogin: string;
  installationId: number;
}): string {
  return installation.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;
}


export function exactRedirect(value: string, expected: string): boolean {
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
  onSigninAttempt?: (input: SigninAttemptObservation) => Promise<void>;
  onFunnelAuth?: (input: FunnelAuthObservation) => Promise<void>;
  store: AuthStore;
  /** Existing committed LISTEN owner; keys are ticket hashes, never recovery secrets. */
  subscribeCompletion?: (ticketHash: string, wake: () => void) => () => void;
  oidc: OidcClient;
  /** GitHub is the shipped sign-in and repository-access provider. */
  github?: {
    oauth: GitHubOAuthClient;
    app: GitHubAppClient;
    webhookSecret?: string;
    /**
     * Optional consumer for the monolith's repository catalog. This runs
     * only after the auth store has verified and claimed a GitHub delivery.
     */
    onWebhook?: (eventType: string, payload: unknown) => Promise<void>;
  };
  /** Complete a monolith-owned installation using its single-use state and existing user grant. */
  completeRepositoryInstallation?: (state: string, installationId?: number, code?: string, callbackUri?: string) => Promise<string>;
  tenants: AuthTenant[];
  now?: () => Date;
  flowTtlMs?: number;
  ticketTtlMs?: number;
  logger?: FastifyServerOptions['logger'];
  /** Exact native completion URLs; never accept an arbitrary OAuth open redirect. */
  nativeRedirectUris?: string[];
  /** Exact browser origins shared with the monolith HTTP API CORS allowlist. */
  webAppOrigins?: readonly string[];
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
  /**
   * Atomically reserves an app-minted pairing code for the generated agent and
   * assigns its seeded identity. Name, animal and soul are the server's to
   * choose — only it knows the Workspace roster the animal must be unique in —
   * so they come back out of the claim, never in.
   */
  claimAgentPairingCode?: (input: {
    code: string;
    agentPubkey: string;
    model: string;
    /** The wizard's reasoning-effort pick, when the harness had an axis to ask about. */
    effort?: string;
    avatarSeed?: string;
    /** Server event kinds this agent reacts to; spent only on the immediate, legacy join below. */
    eventSubscriptions?: readonly string[];
    /**
     * Sent by a CLI that will call `finishAgentConnectPairing` itself once its
     * rename decision settles. Omitted by any CLI built before that two-step
     * flow existed, which gets the original immediate join instead.
     */
    deferJoin?: boolean;
    /** Stable machine identifier for the host running this agent. */
    machineId?: string;
    /** Human-readable machine name (e.g. hostname). */
    machineName?: string;
  }) => Promise<
    | {
        status: 'claimed';
        workspaceId: string;
        workspaceName: string;
        pairedBy: string;
        agentName: string;
        soul: string;
        face: string;
        /** Whether this claim newly added the agent to the Workspace (vs. already a member). */
        workspaceJoined: boolean;
        /** One-use credential promoted by the installed daemon on first activation. */
        daemonExchangeToken: string;
      }
    | { status: 'not_found' | 'expired' | 'already_claimed' }
  >;
  /**
   * The connect wizard's one rename, authorized by the pairing code the person
   * typed out of the app and bounded to shortly after the claim.
   */
  renameConnectedAgent?: (input: {
    code: string;
    name: string;
  }) => Promise<{ status: 'renamed'; agentName: string } | { status: 'not_found' | 'expired' }>;
  /**
   * The wizard's last step: joins the agent to the Workspace's live top-level
   * Rooms and writes the "joined" announcement, run after the one rename
   * window above has closed so the announcement carries the agent's final
   * name, never the seeded placeholder.
   */
  finishAgentConnectPairing?: (input: {
    code: string;
    workspaceJoined: boolean;
    /** Server event kinds this agent reacts to, in the Rooms it is joined to. */
    eventSubscriptions?: readonly string[];
  }) => Promise<{ status: 'finished' } | { status: 'not_found' | 'expired' }>;
}


export class ProtocolError extends Error {
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


export function noStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
  reply.header('referrer-policy', 'no-referrer');
}


export function managedIdentityJson(identity: ManagedIdentity) {
  return {
    handle: identity.handle,
    display_name: identity.displayName,
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


export function nativeReturnPage(target: URL): string {
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
export function githubInstallReturnPage(heading: string, body: string): string {
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


export function githubInstallConnectedPage(): string {
  return githubInstallReturnPage(
    'GitHub connected',
    `<p>The Beeline GitHub App was installed successfully. You can close this tab and return to the app now.</p>
      <p>If someone sent you this link, let them know you are connected.</p>`,
  );
}


export function githubInstallErrorPage(reason: 'expired' | 'used' | 'invalid'): string {
  if (reason === 'expired') {
    return githubInstallReturnPage(
      'This connection link has expired',
      `<p>This GitHub connection link expired before the installation finished. Start again from the app (or ask for a fresh link) and the connection will complete normally.</p>
      <p>If the installation itself already succeeded on GitHub, Beeline will discover it automatically — open the app and it will appear.</p>`,
    );
  }
  if (reason === 'used') {
    return githubInstallReturnPage(
      'This connection link was already used',
      `<p>This GitHub connection link has already been used to connect an account, so there is nothing further to do with it.</p>
      <p>If that was you, the connection is already in place. If not, start again from the app (or ask for a fresh link) and the connection will complete normally. If an installation succeeded on GitHub, Beeline will discover it automatically.</p>`,
    );
  }
  return githubInstallReturnPage(
    'This connection link is invalid',
    `<p>This GitHub connection link is not valid — it may have been mistyped, altered, or issued for a different account.</p>
      <p>Start again from the app (or ask for a fresh link) and the connection will complete normally.</p>
      <p>If the installation itself already succeeded on GitHub, Beeline will discover it automatically — open the app and it will appear.</p>`,
  );
}


// An organization that requires approval calls back BEFORE any installation
// exists. Spending the flow there would burn the binding, so GitHub's eventual
// install callback (days later) would find it consumed even though nothing was
// ever connected. This is a mid-flow checkpoint, never a completion.
export function githubInstallPendingPage(): string {
  return githubInstallReturnPage(
    'GitHub installation is pending approval',
    `<p>This GitHub installation has not finished yet. If the organization requires approval, your request is waiting on one of its owners.</p>
      <p>Nothing more is needed from you here. Beeline checks for approved installations every five minutes and will pick this up automatically — you can close this tab.</p>`,
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
export function githubAppSetupFormPage(manifest: Record<string, unknown>): string {
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
export function githubAppSetupEnvPage(envBlock: string, appUrl: string | undefined): string {
  const install = appUrl ? `${escapeHtml(appUrl)}/installations/new` : '';
  return setupPage(`
      <h1>GitHub App created</h1>
      <p>Copy this block into the auth service environment and restart it:</p>
      <pre><code>${escapeHtml(envBlock)}</code></pre>
      ${appUrl ? `<p>Next: <a href="${install}">install the App on your account or organization</a>.</p>` : ''}
      <p>Keep the private key out of chat logs and version control.</p>`);
}


export function githubAppSetupErrorPage(message: string): string {
  return setupPage(`
      <h1>GitHub App setup failed</h1>
      <p>${escapeHtml(message)}</p>
      <p>The conversion code is single-use; start over from the setup page.</p>`);
}


export function requiredQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 4_096) {
    throw new ProtocolError(400, 'invalid_request', `missing or invalid ${name}`);
  }
  return value;
}


export function githubRepositoryFromPayload(
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
export function isGitHubUserTokenAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 40[13]\b/.test(message);
}


export function githubInstallationId(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub installation payload');
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub installation payload');
  }
  return id;
}


export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: unknown,
): boolean {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const actual = Buffer.from(signature.slice(7), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}


export function flowCookie(request: FastifyRequest, cookieName = FLOW_COOKIE): string {
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


export function publicUrl(tenant: AuthTenant, request: FastifyRequest): string {
  const path = request.raw.url;
  if (!path?.startsWith('/'))
    throw new ProtocolError(400, 'invalid_request', 'invalid request URL');
  return `${tenant.origin}${path}`;
}


export function sha256Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(sha256(value), 'hex'));
}
