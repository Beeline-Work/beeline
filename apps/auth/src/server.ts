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
import { AuthStore } from './store.js';
import { OidcClient } from './oidc.js';
import { GitHubAppClient, GitHubOAuthClient, type GitHubIdentity } from './github.js';
import { extractGitHubRepoEvent } from './github-repo-events.js';
import {
  isValidNip05Name,
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
  ) {
    super(message);
  }
}

function noStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
  reply.header('referrer-policy', 'no-referrer');
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

export function buildAuthServer(options: AuthServerOptions): FastifyInstance {
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
      const installationIds = await options.github!.app.listUserInstallationIds(
        decryptGitHubToken(sealedUserToken),
      );
      const verifiedInstallations = await Promise.all(
        installationIds.map(async (installationId) => {
          const [account, repositories] = await Promise.all([
            options.github!.app.installationAccount(installationId),
            options.github!.app.listRepositories(installationId),
          ]);
          return { installationId, account, repositories };
        }),
      );
      for (const { installationId, account, repositories } of verifiedInstallations) {
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

  // A successful Room authority proof costs several authenticated relay reads.
  // Reusing it for a short window keeps a long-polling daemon from re-reading
  // relay state every request; the cache is authorized results only, so a
  // refusal is always re-derived from current truth.
  const roomAuthorityCache = new Map<
    string,
    {
      authorizedBy: string;
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
    identity: { issuer: string; audience: string; subject: string },
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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProtocolError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
      void reply.status(413).send({ error: 'request_too_large' });
      return;
    }
    void reply.status(500).send({ error: 'internal_error' });
  });

  app.get('/health', async () => ({ ok: true }));

  /** Public feature discovery. Missing GitHub config deliberately means dark. */
  app.get('/auth/capabilities', async (request, reply) => {
    tenantFor(request);
    noStore(reply);
    return reply.send({ github: Boolean(options.github), oidc: true });
  });

  app.get('/auth/github/mobile-callback', async (request, reply) => {
    const tenant = tenantFor(request);
    const callback = new URL(publicUrl(tenant, request));
    const target = new URL(
      callback.searchParams.get('installed') === '1'
        ? GITHUB_INSTALLATION_DEEP_LINK
        : GITHUB_SIGN_IN_DEEP_LINK,
    );
    target.search = callback.search;
    noStore(reply);
    reply.header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    return reply.type('text/html; charset=utf-8').send(nativeReturnPage(target));
  });

  app.get('/.well-known/nostr.json', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const name = typeof query.name === 'string' ? query.name : null;
    const names: Record<string, string> = {};
    if (name && isValidNip05Name(name)) {
      const pubkey = await options.store.resolveNip05Name(name);
      if (pubkey) names[name] = pubkey;
    }
    reply.header('access-control-allow-origin', '*');
    return reply.type('application/json').send({ names });
  });

  app.get('/auth/oidc/start', async (request, reply) => {
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const appRedirect = query.app_redirect;
    const appState = query.app_state;
    if ((appRedirect === undefined) !== (appState === undefined)) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'app redirect and state must be supplied together',
      );
    }
    let appRedirectUri: string | null = null;
    let boundAppState: string | null = null;
    if (appRedirect !== undefined && appState !== undefined) {
      const associatedRedirect = `${tenant.origin}/auth/oidc/mobile-callback`;
      if (
        typeof appRedirect !== 'string' ||
        !isAllowedAppRedirect(appRedirect, associatedRedirect)
      ) {
        throw new ProtocolError(
          400,
          'invalid_request',
          'native completion redirect is not allowed',
        );
      }
      if (typeof appState !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(appState)) {
        throw new ProtocolError(400, 'invalid_request', 'native completion state is invalid');
      }
      appRedirectUri = appRedirect;
      boundAppState = appState;
    }
    const issuedAt = now();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const browserSession = randomToken();
    const codeChallenge = Buffer.from(sha256Bytes(verifier)).toString('base64url');
    const redirectUri = `${tenant.origin}/auth/oidc/callback`;
    await options.store.createFlow(sha256(state), {
      community: tenant.community,
      issuer: options.oidc.config.issuer,
      audience: options.oidc.config.clientId,
      nonce,
      pkceVerifier: verifier,
      browserSessionHash: sha256(browserSession),
      redirectUri,
      appRedirectUri,
      appState: boundAppState,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    noStore(reply);
    reply.header(
      'set-cookie',
      `${flowCookieName}=${browserSession}; Path=/; Max-Age=${Math.floor(flowTtlMs / 1_000)};${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    return reply.redirect(
      options.oidc.authorizationUrl({ state, nonce, codeChallenge, redirectUri }),
      302,
    );
  });

  app.get('/auth/github/start', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub sign-in is not configured');
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const appRedirect = query.app_redirect;
    const appState = query.app_state;
    if ((appRedirect === undefined) !== (appState === undefined)) {
      throw new ProtocolError(
        400,
        'invalid_request',
        'app redirect and state must be supplied together',
      );
    }
    let appRedirectUri: string | null = null;
    let boundAppState: string | null = null;
    if (appRedirect !== undefined && appState !== undefined) {
      const associatedRedirect = `${tenant.origin}/auth/github/mobile-callback`;
      if (
        typeof appRedirect !== 'string' ||
        !isAllowedAppRedirect(appRedirect, associatedRedirect)
      ) {
        throw new ProtocolError(
          400,
          'invalid_request',
          'native completion redirect is not allowed',
        );
      }
      if (typeof appState !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(appState)) {
        throw new ProtocolError(400, 'invalid_request', 'native completion state is invalid');
      }
      appRedirectUri = appRedirect;
      boundAppState = appState;
    }
    const issuedAt = now();
    const state = randomToken();
    const verifier = randomToken();
    const browserSession = randomToken();
    const codeChallenge = Buffer.from(sha256Bytes(verifier)).toString('base64url');
    const redirectUri = `${tenant.origin}/auth/github/callback`;
    await options.store.createFlow(sha256(state), {
      community: tenant.community,
      issuer: 'https://github.com',
      audience: options.github.oauth.config.clientId,
      nonce: randomToken(),
      pkceVerifier: verifier,
      browserSessionHash: sha256(browserSession),
      redirectUri,
      appRedirectUri,
      appState: boundAppState,
      createdAt: issuedAt,
      expiresAt: new Date(issuedAt.getTime() + flowTtlMs),
    });
    noStore(reply);
    reply.header(
      'set-cookie',
      `${flowCookieName}=${browserSession}; Path=/; Max-Age=${Math.floor(flowTtlMs / 1_000)};${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    return reply.redirect(
      options.github.oauth.authorizationUrl({ state, codeChallenge, redirectUri }),
      302,
    );
  });

  app.get('/auth/github/callback', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub sign-in is not configured');
    const query = request.query as Record<string, unknown>;
    // Request-user-authorization-on-install makes this the GitHub App's only
    // post-install callback too. Repository selection updates carry the
    // installation id/setup action instead of an ordinary sign-in code.
    if (query.installation_id !== undefined || query.setup_action !== undefined) {
      return completeGitHubInstallation(request, reply);
    }
    const tenant = tenantFor(request);
    const state = requiredQueryString(query.state, 'state');
    const browserSession = flowCookie(request, flowCookieName);
    const flow = await options.store.consumeFlow(sha256(state), sha256(browserSession), now());
    if (!flow)
      throw new ProtocolError(
        400,
        'invalid_oauth_flow',
        'GitHub flow is missing, expired, or already used',
      );
    reply.header(
      'set-cookie',
      `${flowCookieName}=; Path=/; Max-Age=0;${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    if (
      flow.community !== tenant.community ||
      flow.issuer !== 'https://github.com' ||
      flow.audience !== options.github.oauth.config.clientId ||
      flow.redirectUri !== `${tenant.origin}/auth/github/callback`
    ) {
      throw new ProtocolError(400, 'invalid_oauth_flow', 'GitHub flow tenant or provider mismatch');
    }
    if (typeof query.error === 'string') {
      const completion = nativeCompletion(flow, {
        error: 'github_denied',
        message: 'GitHub authorization was canceled or denied',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'github_denied', 'GitHub denied the authorization request');
    }
    const code = requiredQueryString(query.code, 'code');
    let identity: GitHubIdentity;
    try {
      identity = await options.github.oauth.exchangeCode(code, flow.redirectUri, flow.pkceVerifier);
    } catch {
      const completion = nativeCompletion(flow, {
        error: 'invalid_github_proof',
        message: 'GitHub authorization expired or could not be verified',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'invalid_github_proof', 'GitHub code exchange failed');
    }
    await options.store.saveGitHubUserToken(
      tenant.community,
      identity.subject,
      encryptGitHubToken(identity.accessToken),
      now(),
    );
    return issueBindChallenge(tenant, flow, identity, reply);
  });

  app.get('/auth/oidc/callback', async (request, reply) => {
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const state = requiredQueryString(query.state, 'state');
    const browserSession = flowCookie(request, flowCookieName);
    const flow = await options.store.consumeFlow(sha256(state), sha256(browserSession), now());
    if (!flow)
      throw new ProtocolError(
        400,
        'invalid_oidc_flow',
        'OIDC flow is missing, expired, or already used',
      );
    reply.header(
      'set-cookie',
      `${flowCookieName}=; Path=/; Max-Age=0;${cookieSecurity} HttpOnly; SameSite=Lax`,
    );
    if (
      flow.community !== tenant.community ||
      flow.issuer !== options.oidc.config.issuer ||
      flow.audience !== options.oidc.config.clientId ||
      flow.redirectUri !== `${tenant.origin}/auth/oidc/callback`
    ) {
      throw new ProtocolError(400, 'invalid_oidc_flow', 'OIDC flow tenant or provider mismatch');
    }
    if (typeof query.error === 'string') {
      const completion = nativeCompletion(flow, {
        error: 'oidc_denied',
        message: 'Google authorization was canceled or denied',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(401, 'oidc_denied', 'OIDC provider denied the authorization request');
    }
    const code = requiredQueryString(query.code, 'code');

    let identity;
    try {
      const idToken = await options.oidc.exchangeCode(code, flow.pkceVerifier, flow.redirectUri);
      identity = await options.oidc.verifyIdToken(idToken, flow.nonce);
    } catch {
      const completion = nativeCompletion(flow, {
        error: 'invalid_oidc_proof',
        message: 'Google authorization expired or could not be verified',
      });
      if (completion) return deliverNativeCompletion(reply, completion);
      throw new ProtocolError(
        401,
        'invalid_oidc_proof',
        'OIDC code exchange or ID token validation failed',
      );
    }

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
  });

  app.post('/auth/oidc/bind', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_bind', 'expected bind request object');
    }
    const body = request.body as Record<string, unknown>;
    const ticketValue = body.ticket;
    if (typeof ticketValue !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticketValue)) {
      throw new ProtocolError(400, 'invalid_bind', 'invalid bind ticket');
    }
    const ticketHash = sha256(ticketValue);
    const ticket = await options.store.findTicket(ticketHash);
    if (!ticket || ticket.community !== tenant.community) {
      throw new ProtocolError(404, 'unknown_ticket', 'bind ticket not found');
    }
    if (ticket.expiresAt.getTime() < now().getTime()) {
      throw new ProtocolError(410, 'ticket_expired', 'bind ticket expired');
    }

    const verification = verifyBindEvent(
      body.event,
      {
        protocol: 1,
        ticket: ticketValue,
        challenge: ticket.challenge,
        issuer: ticket.issuer,
        audience: ticket.audience,
        subject: ticket.subject,
        community: ticket.community,
        issuedAt: ticket.createdAt,
        expiresAt: ticket.expiresAt,
      },
      now(),
    );
    if (!verification.ok) {
      if (ticket.consumedAt)
        throw new ProtocolError(409, 'ticket_used', 'bind ticket already used');
      await options.store.recordFailedTicketAttempt(ticketHash, now());
      throw new ProtocolError(400, 'invalid_bind_event', verification.reason);
    }
    if (ticket.consumedAt) {
      if (ticket.boundPubkey !== verification.event.pubkey) {
        throw new ProtocolError(409, 'ticket_used', 'bind ticket already used');
      }
      const links = await options.store.linksForPubkey(ticket.community, verification.event.pubkey);
      const actuallyLinked = links.some(
        (link) =>
          link.issuer === ticket.issuer &&
          link.audience === ticket.audience &&
          link.subject === ticket.subject,
      );
      if (actuallyLinked) {
        noStore(reply);
        return reply.send({ linked: true, idempotent: true, pubkey: verification.event.pubkey });
      }
      throw new ProtocolError(
        409,
        'identity_conflict',
        'identity is already bound to another public key',
      );
    }

    const result = await options.store.consumeTicketAndLink(
      ticketHash,
      verification.event.pubkey,
      now(),
    );
    if (result.status === 'missing')
      throw new ProtocolError(404, 'unknown_ticket', 'bind ticket not found');
    if (result.status === 'used') {
      const raced = await options.store.findTicket(ticketHash);
      if (raced?.boundPubkey === verification.event.pubkey) {
        const links = await options.store.linksForPubkey(
          raced.community,
          verification.event.pubkey,
        );
        const actuallyLinked = links.some(
          (link) =>
            link.issuer === raced.issuer &&
            link.audience === raced.audience &&
            link.subject === raced.subject,
        );
        if (actuallyLinked) {
          noStore(reply);
          return reply.send({ linked: true, idempotent: true, pubkey: verification.event.pubkey });
        }
        throw new ProtocolError(
          409,
          'identity_conflict',
          'identity is already bound to another public key',
        );
      }
      throw new ProtocolError(409, 'ticket_used', 'bind ticket already used');
    }
    if (result.status === 'expired')
      throw new ProtocolError(410, 'ticket_expired', 'bind ticket expired');
    if (result.status === 'conflict') {
      throw new ProtocolError(
        409,
        'identity_conflict',
        'identity is already bound to another public key',
      );
    }
    if (!('link' in result)) throw new Error('unexpected bind transaction result');
    noStore(reply);
    return reply.status(result.status === 'linked' ? 201 : 200).send({
      linked: true,
      idempotent: result.status === 'idempotent',
      pubkey: result.link.pubkey,
    });
  });

  app.post('/auth/oidc/recover', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_recovery', 'expected recovery request object');
    }
    const body = request.body as Record<string, unknown>;
    if (body.confirm_replace !== true) {
      throw new ProtocolError(
        400,
        'recovery_confirmation_required',
        'explicit device-key replacement confirmation is required',
      );
    }
    const ticketValue = body.ticket;
    if (typeof ticketValue !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticketValue)) {
      throw new ProtocolError(400, 'invalid_recovery', 'invalid recovery ticket');
    }
    const ticketHash = sha256(ticketValue);
    const ticket = await options.store.findTicket(ticketHash);
    if (!ticket || ticket.community !== tenant.community) {
      throw new ProtocolError(404, 'unknown_ticket', 'recovery ticket not found');
    }
    if (ticket.expiresAt.getTime() < now().getTime()) {
      throw new ProtocolError(410, 'ticket_expired', 'recovery ticket expired');
    }
    const verification = verifyBindEvent(
      body.event,
      {
        protocol: 1,
        ticket: ticketValue,
        challenge: ticket.challenge,
        issuer: ticket.issuer,
        audience: ticket.audience,
        subject: ticket.subject,
        community: ticket.community,
        issuedAt: ticket.createdAt,
        expiresAt: ticket.expiresAt,
      },
      now(),
    );
    if (!verification.ok) {
      throw new ProtocolError(400, 'invalid_bind_event', verification.reason);
    }

    const result = await options.store.recoverConsumedTicketLink(
      ticketHash,
      verification.event.pubkey,
      now(),
    );
    if (result.status === 'missing')
      throw new ProtocolError(404, 'recovery_not_available', 'conflicting identity link not found');
    if (result.status === 'unused')
      throw new ProtocolError(
        409,
        'recovery_not_available',
        'normal device bind must be attempted first',
      );
    if (result.status === 'not_eligible')
      throw new ProtocolError(
        409,
        'recovery_not_available',
        'device bind did not produce a conflict',
      );
    if (result.status === 'wrong_key')
      throw new ProtocolError(409, 'ticket_used', 'recovery ticket belongs to another device key');
    if (result.status === 'expired')
      throw new ProtocolError(410, 'ticket_expired', 'recovery ticket expired');
    if (!('link' in result)) throw new Error('unexpected recovery transaction result');

    noStore(reply);
    return reply.send({
      linked: true,
      replaced: result.status === 'replaced',
      pubkey: result.link.pubkey,
    });
  });

  app.get<{ Params: { pubkey: string } }>('/auth/oidc/links/:pubkey', async (request, reply) => {
    const tenant = tenantFor(request);
    const pubkey = request.params.pubkey;
    if (!/^[0-9a-f]{64}$/.test(pubkey))
      throw new ProtocolError(400, 'invalid_pubkey', 'invalid public key');
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'GET',
      now(),
    );
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
    }
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    const links = await options.store.linksForPubkey(tenant.community, pubkey);
    noStore(reply);
    return reply.send({
      links: links.map((link) => ({
        community: link.community,
        provider: link.issuer,
        audience: link.audience,
        subject: link.subject,
        pubkey: link.pubkey,
        created_at: link.createdAt.toISOString(),
      })),
    });
  });

  app.post('/auth/github/install/start', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected GitHub installation request');
    }
    const body = request.body as Record<string, unknown>;
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
    const requestedInstallationId = body.installation_id;
    if (!/^[0-9a-f]{64}$/.test(pubkey))
      throw new ProtocolError(400, 'invalid_pubkey', 'invalid public key');
    let redirect: URL;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw new ProtocolError(400, 'invalid_redirect', 'invalid installation redirect');
    }
    const associatedRedirect = `${tenant.origin}/auth/github/mobile-callback`;
    if (
      !isAllowedAppRedirect(redirectUri, associatedRedirect) ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    ) {
      throw new ProtocolError(400, 'invalid_redirect', 'installation redirect is not allowed');
    }
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'POST',
      now(),
    );
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
    }
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    if (!(await options.store.githubSubjectForPubkey(tenant.community, pubkey))) {
      throw new ProtocolError(
        409,
        'github_not_linked',
        'sign in with GitHub before installing the Beeline GitHub App',
      );
    }
    let requestedInstallation:
      Awaited<ReturnType<typeof options.store.githubInstallationForPubkey>> | undefined;
    if (requestedInstallationId !== undefined) {
      if (
        typeof requestedInstallationId !== 'number' ||
        !Number.isSafeInteger(requestedInstallationId) ||
        requestedInstallationId <= 0
      ) {
        throw new ProtocolError(400, 'invalid_installation', 'invalid GitHub installation id');
      }
      requestedInstallation = (
        await options.store.githubInstallationsForPubkey(tenant.community, pubkey)
      ).find(
        (installation) =>
          installation.installationId === requestedInstallationId &&
          installation.status === 'active',
      );
      if (!requestedInstallation) {
        throw new ProtocolError(
          404,
          'installation_not_found',
          'the GitHub installation is not active for this Beeline identity',
        );
      }
    }
    const state = randomToken();
    await options.store.createGitHubInstallFlow(sha256(state), {
      community: tenant.community,
      pubkey,
      redirectUri: redirect.toString(),
      createdAt: authNow,
      expiresAt: new Date(authNow.getTime() + flowTtlMs),
    });
    noStore(reply);
    const authorizationUrl = requestedInstallation
      ? new URL(githubInstallationManageUrl(requestedInstallation))
      : new URL(options.github.app.installationUrl(state));
    authorizationUrl.searchParams.set('state', state);
    return reply.send({ authorization_url: authorizationUrl.toString() });
  });

  async function completeGitHubInstallation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    const query = request.query as Record<string, unknown>;
    const state = requiredQueryString(query.state, 'state');
    const rawInstallationId = requiredQueryString(query.installation_id, 'installation_id');
    const installationId = Number(rawInstallationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new ProtocolError(400, 'invalid_installation', 'invalid GitHub installation id');
    }
    const flow = await options.store.consumeGitHubInstallFlow(sha256(state), now());
    if (!flow || flow.community !== tenant.community) {
      throw new ProtocolError(
        400,
        'invalid_installation_flow',
        'GitHub installation flow is missing, expired, or already used',
      );
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
    if (
      !sealedUserToken ||
      !(await options.github.app.userCanAccessInstallation(
        decryptGitHubToken(sealedUserToken),
        installationId,
      ))
    ) {
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
    const completion = new URL(flow.redirectUri);
    completion.searchParams.set('installed', '1');
    return reply.redirect(completion.toString(), 302);
  }

  app.get('/auth/github/install/callback', completeGitHubInstallation);
  // Backward-compatible aliases for installation links issued before the
  // OAuth callback learned to dispatch installation/update returns itself.
  app.get('/auth/github/installed', completeGitHubInstallation);

  app.get<{ Params: { pubkey: string } }>('/auth/github/repos/:pubkey', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    const pubkey = request.params.pubkey;
    if (!/^[0-9a-f]{64}$/.test(pubkey))
      throw new ProtocolError(400, 'invalid_pubkey', 'invalid public key');
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'GET',
      now(),
    );
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
    }
    const authNow = now();
    if (
      !(await options.store.claimNip98Event(
        auth.eventId,
        new Date(authNow.getTime() + 2 * 60_000),
        authNow,
      ))
    ) {
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    }
    let installations = await options.store.githubInstallationsForPubkey(tenant.community, pubkey);
    if (!installations.length) {
      await reconcileGitHubInstallations(tenant.community, pubkey, request.log);
      installations = await options.store.githubInstallationsForPubkey(tenant.community, pubkey);
      if (!installations.length) {
        noStore(reply);
        return reply.send({ installed: false, installations: [], repositories: [] });
      }
    }
    const query = request.query as Record<string, unknown>;
    if (query.refresh === '1') {
      await Promise.all(
        installations
          .filter((installation) => installation.status === 'active')
          .map(async (installation) => {
            const repositories = await options.github!.app.listRepositories(
              installation.installationId,
            );
            await options.store.replaceGitHubRepositories(
              tenant.community,
              installation.installationId,
              repositories,
              now(),
            );
          }),
      );
      installations = await options.store.githubInstallationsForPubkey(tenant.community, pubkey);
    }
    const repositories = await options.store.githubRepositoriesForPubkey(tenant.community, pubkey);
    noStore(reply);
    return reply.send({
      installed: true,
      installations: installations.map((installation) => ({
        installationId: installation.installationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        ...(installation.accountAvatarUrl
          ? { accountAvatarUrl: installation.accountAvatarUrl }
          : {}),
        repositorySelection: installation.repositorySelection,
        status: installation.status,
        repositoryCount: installation.repositoryCount,
        manageUrl: githubInstallationManageUrl(installation),
      })),
      repositories,
    });
  });

  app.post<{ Params: { pubkey: string } }>('/auth/github/repos/:pubkey', async (request, reply) => {
    if (!options.github)
      throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
    const tenant = tenantFor(request);
    const pubkey = request.params.pubkey;
    const url = publicUrl(tenant, request);
    const auth = verifyNip98Header(request.headers.authorization, url, 'POST', now());
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
    }
    const authNow = now();
    if (
      !(await options.store.claimNip98Event(
        auth.eventId,
        new Date(authNow.getTime() + 120_000),
        authNow,
      ))
    ) {
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_request', 'expected repository creation request');
    }
    const body = request.body as Record<string, unknown>;
    const installationId = body.installation_id;
    const name = body.name;
    const description = body.description;
    const isPrivate = body.private;
    if (
      typeof installationId !== 'number' ||
      !Number.isSafeInteger(installationId) ||
      typeof name !== 'string' ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
      (description !== undefined && typeof description !== 'string') ||
      (isPrivate !== undefined && typeof isPrivate !== 'boolean')
    ) {
      throw new ProtocolError(400, 'invalid_request', 'invalid repository creation request');
    }
    const installation = (
      await options.store.githubInstallationsForPubkey(tenant.community, pubkey)
    ).find(
      (candidate) => candidate.installationId === installationId && candidate.status === 'active',
    );
    if (!installation) {
      throw new ProtocolError(
        404,
        'installation_unavailable',
        'GitHub installation is unavailable',
      );
    }
    let userAccessToken: string | undefined;
    if (installation.accountType === 'User') {
      const subject = await options.store.githubSubjectForPubkey(tenant.community, pubkey);
      const sealed = subject
        ? await options.store.githubUserToken(tenant.community, subject)
        : null;
      if (!sealed) {
        throw new ProtocolError(
          409,
          'github_reauthorization_required',
          'sign in with GitHub again before creating a personal repository',
        );
      }
      userAccessToken = decryptGitHubToken(sealed);
    }
    const repository = await options.github.app.createRepository(
      installationId,
      { login: installation.accountLogin, type: installation.accountType },
      {
        name,
        ...(typeof description === 'string' && description ? { description } : {}),
        ...(typeof isPrivate === 'boolean' ? { private: isPrivate } : {}),
      },
      userAccessToken,
    );
    await options.store.applyGitHubRepositoryChanges(installationId, [repository], [], authNow);
    noStore(reply);
    return reply.code(201).send({ repository });
  });

  app.get<{ Params: { pubkey: string } }>(
    '/auth/github/repo-access/:pubkey',
    async (request, reply) => {
      if (!options.github)
        throw new ProtocolError(503, 'github_unavailable', 'GitHub App is not configured');
      const tenant = tenantFor(request);
      const pubkey = request.params.pubkey;
      const auth = verifyNip98Header(
        request.headers.authorization,
        publicUrl(tenant, request),
        'GET',
        now(),
      );
      if (!auth.ok || auth.pubkey !== pubkey) {
        throw new ProtocolError(
          401,
          'unauthorized',
          auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
        );
      }
      const authNow = now();
      if (
        !(await options.store.claimNip98Event(
          auth.eventId,
          new Date(authNow.getTime() + 120_000),
          authNow,
        ))
      ) {
        throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
      }
      const query = request.query as Record<string, unknown>;
      const fullName = requiredQueryString(query.full_name, 'full_name');
      if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
        throw new ProtocolError(400, 'invalid_repository', 'expected owner/repo');
      }
      noStore(reply);
      return reply.send(
        await options.store.githubRepositoryAccess(tenant.community, pubkey, fullName),
      );
    },
  );

  app.post('/auth/github/room-token', async (request, reply) => {
    if (!options.github || !options.authorizeGitHubRoomToken) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub repository access is unavailable');
    }
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_request', 'expected Room token request');
    }
    const body = request.body as Record<string, unknown>;
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
    const roomId = typeof body.room_id === 'string' ? body.room_id : '';
    const relayAuthorizations = Array.isArray(body.relay_authorizations)
      ? body.relay_authorizations.filter((value): value is string => typeof value === 'string')
      : [];
    if (
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !roomId ||
      roomId.length > 200 ||
      relayAuthorizations.length !== 16 ||
      relayAuthorizations.some((value) => !value || value.length > 4_096)
    ) {
      throw new ProtocolError(400, 'invalid_request', 'invalid Room token request');
    }
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'POST',
      now(),
    );
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(
        401,
        'unauthorized',
        auth.ok ? 'NIP-98 signer mismatch' : auth.reason,
      );
    }
    for (const relayAuthorization of relayAuthorizations) {
      const relayAuth = verifyNip98Header(
        relayAuthorization,
        `${tenant.origin}/query`,
        'POST',
        now(),
      );
      if (!relayAuth.ok || relayAuth.pubkey !== pubkey) {
        throw new ProtocolError(
          401,
          'unauthorized_relay_read',
          relayAuth.ok ? 'relay NIP-98 signer mismatch' : relayAuth.reason,
        );
      }
    }
    const authNow = now();
    if (
      !(await options.store.claimNip98Event(
        auth.eventId,
        new Date(authNow.getTime() + 120_000),
        authNow,
      ))
    ) {
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    }
    const authority = await options.authorizeGitHubRoomToken(tenant, {
      agentPubkey: pubkey,
      roomId,
      relayAuthorizations,
    });
    if (!authority.authorized) {
      request.log.warn(
        {
          authorityReason: authority.reason,
          roomId,
          agentPubkey: pubkey,
        },
        'GitHub Room token authority refused request',
      );
      if (authority.reason === 'agent_not_room_member') {
        throw new ProtocolError(
          403,
          'room_membership_required',
          'agent is not a member of this Room',
        );
      }
      if (
        authority.reason === 'room_repository_missing' ||
        authority.reason === 'room_repository_remote_malformed'
      ) {
        throw new ProtocolError(
          403,
          'room_repository_unresolvable',
          'Room repository could not be resolved',
        );
      }
      throw new ProtocolError(
        403,
        'room_repository_unauthorized',
        'agent is not authorized for this Room repository',
      );
    }
    const access = await options.store.githubRepositoryAccess(
      tenant.community,
      authority.authorizedBy,
      authority.fullName,
    );
    if (
      !access.accessible ||
      !access.installationId ||
      !access.repositoryId ||
      (authority.githubInstallationId !== undefined &&
        authority.githubInstallationId !== access.installationId)
    ) {
      request.log.warn(
        {
          authorityReason: 'repository_not_granted',
          repositoryAccessReason: access.reason,
          roomId,
          agentPubkey: pubkey,
          authorizedBy: authority.authorizedBy,
          repository: authority.fullName,
        },
        'GitHub Room token authority refused request',
      );
      throw new ProtocolError(
        403,
        'repository_not_granted',
        'Room repository is not granted to the Beeline GitHub App',
      );
    }
    const installation = await options.github.app.installationToken(access.installationId, {
      repositoryIds: [access.repositoryId],
    });
    noStore(reply);
    return reply.send({
      token: installation.token,
      expires_at: installation.expiresAt,
      installation_id: access.installationId,
      full_name: authority.fullName,
    });
  });

  /**
   * Release stored GitHub repository activity to a daemon serving a Room that
   * owns that repository.
   *
   * This is the outbound-only hop for repository events: webhooks land here
   * (inbound-reachable infrastructure), while Room daemons only ever connect
   * OUT to the relay, so events cannot be pushed to them directly. A daemon
   * long-polls this endpoint per served Room; the response carries the stored
   * events newer than its cursor. Authorization reuses exactly the Room-token
   * authority: the NIP-98 signature proves the agent key, and current relay
   * truth must show that key inside a Room whose admin-authored binding names
   * this repository — the caller never chooses which repository it reads, so
   * private repository activity can only reach Rooms bound to it.
   */
  app.post('/auth/github/room-events', async (request, reply) => {
    if (!options.authorizeGitHubRoomToken) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub repository access is unavailable');
    }
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_request', 'expected Room event request');
    }
    const body = request.body as Record<string, unknown>;
    const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
    const roomId = typeof body.room_id === 'string' ? body.room_id : '';
    const relayAuthorizations = Array.isArray(body.relay_authorizations)
      ? body.relay_authorizations.filter((value): value is string => typeof value === 'string')
      : [];
    if (
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !roomId ||
      roomId.length > 200 ||
      relayAuthorizations.length !== 16 ||
      relayAuthorizations.some((value) => !value || value.length > 4_096)
    ) {
      throw new ProtocolError(400, 'invalid_request', 'invalid Room event request');
    }
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'POST',
      now(),
    );
    if (!auth.ok || auth.pubkey !== pubkey) {
      throw new ProtocolError(401, 'unauthorized', auth.ok ? 'NIP-98 signer mismatch' : auth.reason);
    }
    for (const relayAuthorization of relayAuthorizations) {
      const relayAuth = verifyNip98Header(
        relayAuthorization,
        `${tenant.origin}/query`,
        'POST',
        now(),
      );
      if (!relayAuth.ok || relayAuth.pubkey !== pubkey) {
        throw new ProtocolError(
          401,
          'unauthorized_relay_read',
          relayAuth.ok ? 'relay NIP-98 signer mismatch' : relayAuth.reason,
        );
      }
    }
    const authNow = now();
    if (
      !(await options.store.claimNip98Event(
        auth.eventId,
        new Date(authNow.getTime() + 120_000),
        authNow,
      ))
    ) {
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    }
    // Omitted `since` is the bootstrap read: "start from now" — the response
    // carries no backlog, just the cursor to begin from. An explicit `since`
    // releases everything stored after it (delivered late to a daemon that
    // was offline when the events arrived), oldest first.
    const sinceRaw = body.since;
    let since:
      | number
      | undefined = typeof sinceRaw === 'number' && Number.isSafeInteger(sinceRaw) && sinceRaw >= 0
      ? sinceRaw
      : undefined;
    const waitMsRaw = body.wait_ms;
    const waitMs = Math.max(
      0,
      Math.min(
        GITHUB_REPO_EVENT_MAX_WAIT_MS,
        typeof waitMsRaw === 'number' && Number.isSafeInteger(waitMsRaw) ? waitMsRaw : 0,
      ),
    );

    const cacheKey = `${tenant.community}:${roomId}:${pubkey}`;
    const cachedAuthority = roomAuthorityCache.get(cacheKey);
    const authority =
      cachedAuthority && cachedAuthority.expiresAt > authNow.getTime()
        ? {
            authorized: true as const,
            authorizedBy: cachedAuthority.authorizedBy,
            fullName: cachedAuthority.fullName,
            ...(cachedAuthority.githubInstallationId !== undefined
              ? { githubInstallationId: cachedAuthority.githubInstallationId }
              : {}),
          }
        : await options.authorizeGitHubRoomToken(tenant, {
            agentPubkey: pubkey,
            roomId,
            relayAuthorizations,
          });
    if (!authority.authorized) {
      roomAuthorityCache.delete(cacheKey);
      request.log.warn(
        { authorityReason: authority.reason, roomId, agentPubkey: pubkey },
        'GitHub Room events authority refused request',
      );
      if (authority.reason === 'agent_not_room_member') {
        throw new ProtocolError(403, 'room_membership_required', 'agent is not a member of this Room');
      }
      throw new ProtocolError(
        403,
        authority.reason === 'tenant_room_community_mismatch'
          ? 'room_repository_unauthorized'
          : 'room_repository_unresolvable',
        'agent is not authorized for this Room repository',
      );
    }
    roomAuthorityCache.set(cacheKey, {
      authorizedBy: authority.authorizedBy,
      fullName: authority.fullName,
      ...(authority.githubInstallationId !== undefined
        ? { githubInstallationId: authority.githubInstallationId }
        : {}),
      expiresAt: authNow.getTime() + GITHUB_ROOM_AUTHORITY_CACHE_TTL_MS,
    });

    let events =
      since === undefined ? [] : await options.store.githubRepoEvents(authority.fullName, since, GITHUB_REPO_EVENT_FETCH_LIMIT);
    if (since !== undefined && events.length === 0 && waitMs > 0) {
      await waitForGitHubRepoEvent(authority.fullName, waitMs);
      events = await options.store.githubRepoEvents(authority.fullName, since, GITHUB_REPO_EVENT_FETCH_LIMIT);
    }
    const head = await options.store.latestGitHubRepoEventId(authority.fullName);
    noStore(reply);
    return reply.send({
      full_name: authority.fullName,
      head,
      cursor: events.length > 0 ? events[events.length - 1]!.id : head,
      events: events.map((eventRecord) => ({
        id: eventRecord.id,
        type: eventRecord.eventType,
        action: eventRecord.action,
        actor: eventRecord.actor,
        summary: eventRecord.summary,
        received_at: eventRecord.receivedAt,
        ...(eventRecord.number !== undefined ? { number: eventRecord.number } : {}),
        ...(eventRecord.title ? { title: eventRecord.title } : {}),
        ...(eventRecord.url ? { url: eventRecord.url } : {}),
      })),
    });
  });

  app.post('/auth/github/webhook', async (request, reply) => {
    if (!options.github?.webhookSecret) {
      throw new ProtocolError(503, 'github_unavailable', 'GitHub webhook is not configured');
    }
    tenantFor(request);
    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (
      !rawBody ||
      !verifyGitHubWebhookSignature(
        options.github.webhookSecret,
        rawBody,
        request.headers['x-hub-signature-256'],
      )
    ) {
      throw new ProtocolError(401, 'invalid_signature', 'invalid GitHub webhook signature');
    }
    const deliveryId = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    if (typeof deliveryId !== 'string' || !deliveryId || typeof event !== 'string') {
      throw new ProtocolError(400, 'invalid_webhook', 'missing GitHub webhook headers');
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new ProtocolError(400, 'invalid_webhook', 'invalid GitHub webhook body');
    }
    const body = request.body as Record<string, unknown>;
    const isRepoActivityEvent = GITHUB_REPO_EVENT_TYPES.has(event);
    if (event !== 'installation' && event !== 'installation_repositories' && !isRepoActivityEvent) {
      return reply.code(202).send({ accepted: true, ignored: true });
    }
    if (!(await options.store.claimGitHubWebhookDelivery(deliveryId, now()))) {
      return reply.code(202).send({ accepted: true, duplicate: true });
    }
    if (isRepoActivityEvent) {
      try {
        const record = extractGitHubRepoEvent(event, body);
        if (record) {
          await options.store.saveGitHubRepoEvents(
            [{ ...record, deliveryId }],
            now(),
          );
          wakeGitHubRepoEventWaiters(record.fullName);
        }
      } catch (error) {
        await options.store.releaseGitHubWebhookDelivery(deliveryId);
        throw error;
      }
      return reply.code(202).send({ accepted: true });
    }
    try {
      const installationId = githubInstallationId(body.installation);
      const action = typeof body.action === 'string' ? body.action : '';
      if (event === 'installation') {
        if (action === 'deleted') {
          await options.store.markGitHubInstallationStatus(installationId, 'revoked', now());
        } else if (action === 'suspend') {
          await options.store.markGitHubInstallationStatus(installationId, 'suspended', now());
        } else if (action === 'unsuspend') {
          await options.store.markGitHubInstallationStatus(installationId, 'active', now());
        }
      } else if (event === 'installation_repositories') {
        const addedRaw = Array.isArray(body.repositories_added) ? body.repositories_added : [];
        const removedRaw = Array.isArray(body.repositories_removed)
          ? body.repositories_removed
          : [];
        const added = addedRaw.map((repository) =>
          githubRepositoryFromPayload(repository, installationId),
        );
        const removedIds = removedRaw.map((repository) => {
          if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
            throw new ProtocolError(400, 'invalid_webhook', 'invalid removed repository payload');
          }
          const id = (repository as Record<string, unknown>).id;
          if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
            throw new ProtocolError(400, 'invalid_webhook', 'invalid removed repository payload');
          }
          return id;
        });
        await options.store.applyGitHubRepositoryChanges(installationId, added, removedIds, now());
      }
    } catch (error) {
      await options.store.releaseGitHubWebhookDelivery(deliveryId);
      throw error;
    }
    return reply.code(202).send({ accepted: true });
  });

  app.post('/nip05/claim', async (request, reply) => {
    const tenant = tenantFor(request);
    if (!request.body || typeof request.body !== 'object') {
      throw new ProtocolError(400, 'invalid_request', 'expected claim request object');
    }
    const body = request.body as Record<string, unknown>;
    const name = body.name;
    if (typeof name !== 'string' || !isValidNip05Name(name)) {
      throw new ProtocolError(
        400,
        'invalid_name',
        'handle must be 1-30 lowercase letters, numbers, dashes, or underscores, and not reserved',
      );
    }
    const auth = verifyNip98Header(
      request.headers.authorization,
      publicUrl(tenant, request),
      'POST',
      now(),
    );
    if (!auth.ok) throw new ProtocolError(401, 'unauthorized', auth.reason);
    const authNow = now();
    const claimed = await options.store.claimNip98Event(
      auth.eventId,
      new Date(authNow.getTime() + 2 * 60_000),
      authNow,
    );
    if (!claimed)
      throw new ProtocolError(401, 'replayed_auth', 'NIP-98 authentication was already used');
    const outcome = await options.store.claimNip05Name(name, auth.pubkey, authNow);
    if (outcome === 'taken')
      throw new ProtocolError(409, 'name_taken', 'handle is already claimed');
    noStore(reply);
    return reply.status(outcome === 'claimed' ? 201 : 200).send({
      claimed: true,
      idempotent: outcome === 'idempotent',
      name,
      pubkey: auth.pubkey,
    });
  });

  return app;
}

function sha256Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(sha256(value), 'hex'));
}
