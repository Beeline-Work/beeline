import { nip98AuthHeader, signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { Identity } from './types.js';

export const OIDC_BIND_PROTOCOL = 1 as const;
export const OIDC_BIND_KIND = 24_250 as const;
export const OIDC_BIND_MARKER = 'beeline-oidc-bind-v1' as const;
// Exact native identities from apps/mobile/app.config.js. Keep this closed set in sync.
export const MOBILE_APP_SCHEMES = ['buzzy-dev', 'buzzy-preview', 'buzzy'] as const;

const MOBILE_APP_PROTOCOLS = new Set<string>(MOBILE_APP_SCHEMES.map((scheme) => `${scheme}:`));
const GITHUB_SIGN_IN_DEEP_LINKS = MOBILE_APP_SCHEMES.map(
  (scheme) => `${scheme}://buzz/github-callback`,
);

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

export interface OidcBindChallenge {
  protocol: typeof OIDC_BIND_PROTOCOL;
  kind: typeof OIDC_BIND_KIND;
  marker: typeof OIDC_BIND_MARKER;
  ticket: string;
  challenge: string;
  provider: string;
  audience: string;
  subject: string;
  community: string;
  issued_at: number;
  expires_at: number;
}

export interface OidcBindStart {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
}

export interface GitHubRepositoryAccess {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  remote: string;
  defaultBranch: string;
}

export interface GitHubInstallationAccess {
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  accountAvatarUrl?: string;
  repositorySelection: 'all' | 'selected';
  status: 'active' | 'revoked' | 'suspended';
  repositoryCount: number;
  manageUrl: string;
}

export interface GitHubRepositoryAccessResult {
  accessible: boolean;
  installationId?: number;
  reason?: 'revoked' | 'not_granted';
}

export interface AuthCapabilities {
  github: boolean;
  oidc: boolean;
}

export interface OidcBindResult {
  linked: true;
  idempotent: boolean;
  pubkey: string;
}

export interface OidcIdentityLink {
  community: string;
  provider: string;
  audience: string;
  subject: string;
  pubkey: string;
  created_at: string;
}

export class OidcBindError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OidcBindError';
  }

  get retryable(): boolean {
    return this.code === 'offline' || (this.status !== undefined && this.status >= 500);
  }
}

function endpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new OidcBindError('invalid_configuration', 'auth base URL must use HTTP or HTTPS');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new OidcBindError('invalid_configuration', 'auth base URL must be an origin');
  }
  return new URL(path, `${base.origin}/`);
}

function exactParam(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new OidcBindError('invalid_callback', `OIDC callback has missing or duplicate ${name}`);
  }
  return values[0];
}

function integerParam(params: URLSearchParams, name: string): number {
  const raw = exactParam(params, name);
  if (!/^\d{1,12}$/.test(raw)) {
    throw new OidcBindError('invalid_callback', `OIDC callback has invalid ${name}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new OidcBindError('invalid_callback', `OIDC callback has invalid ${name}`);
  }
  return value;
}

function normalizedIssuer(value: string): string {
  const issuer = new URL(value);
  if (
    issuer.protocol !== 'https:' &&
    !(
      issuer.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(issuer.hostname)
    )
  ) {
    throw new OidcBindError('invalid_callback', 'OIDC provider must use HTTPS');
  }
  if (issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new OidcBindError('invalid_callback', 'OIDC provider URL is malformed');
  }
  const port =
    (issuer.protocol === 'https:' && issuer.port === '443') ||
    (issuer.protocol === 'http:' && issuer.port === '80') ||
    !issuer.port
      ? ''
      : `:${issuer.port}`;
  return `${issuer.protocol}//${issuer.hostname.toLowerCase()}${port}${issuer.pathname}`.replace(
    /\/$/,
    '',
  );
}

function exactRedirect(raw: string, expected: string): boolean {
  return raw === expected || (!expected.endsWith('/') && raw === `${expected}/`);
}

function rawUrlHasCredentials(raw: string): boolean {
  return /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)/i.exec(raw)?.[2]?.includes('@') ?? false;
}

function assertChallenge(value: OidcBindChallenge): void {
  if (value.protocol !== OIDC_BIND_PROTOCOL || value.kind !== OIDC_BIND_KIND) {
    throw new OidcBindError('unsupported_protocol', 'OIDC bind protocol is not supported');
  }
  if (value.marker !== OIDC_BIND_MARKER) {
    throw new OidcBindError('invalid_callback', 'OIDC bind marker is invalid');
  }
  if (!TOKEN_RE.test(value.ticket) || !TOKEN_RE.test(value.challenge)) {
    throw new OidcBindError('invalid_callback', 'OIDC bind ticket or challenge is invalid');
  }
  if (
    !value.audience ||
    !value.subject ||
    !value.community ||
    value.audience.length > 512 ||
    value.subject.length > 512 ||
    value.community.length > 512
  ) {
    throw new OidcBindError('invalid_callback', 'OIDC bind identity fields are invalid');
  }
  if (normalizedIssuer(value.provider) !== value.provider) {
    throw new OidcBindError('invalid_callback', 'OIDC provider is not normalized');
  }
  if (
    !Number.isSafeInteger(value.issued_at) ||
    !Number.isSafeInteger(value.expires_at) ||
    value.expires_at <= value.issued_at ||
    value.expires_at - value.issued_at > 5 * 60
  ) {
    throw new OidcBindError('invalid_callback', 'OIDC bind time window is invalid');
  }
}

/** Build the server-owned OAuth start URL. PKCE and nonce stay server-side. */
function startProviderBind(
  baseUrl: string,
  input: { redirectUri: string; state: string },
  provider: 'oidc' | 'github',
): OidcBindStart {
  if (!TOKEN_RE.test(input.state)) {
    throw new OidcBindError('invalid_state', 'OIDC app state must be 32 random bytes');
  }
  const base = endpoint(baseUrl, '/');
  const redirect = new URL(input.redirectUri);
  const associatedRedirect = `${base.origin}/auth/${provider}/mobile-callback`;
  const isAssociatedLink =
    redirect.protocol === 'https:' &&
    exactRedirect(input.redirectUri, associatedRedirect) &&
    !redirect.search &&
    !redirect.hash;
  const isLoopback = ['localhost', '127.0.0.1', '10.0.2.2'].includes(base.hostname);
  const isEmulatorScheme = isLoopback && MOBILE_APP_PROTOCOLS.has(redirect.protocol);
  const isGitHubAppScheme =
    provider === 'github' &&
    GITHUB_SIGN_IN_DEEP_LINKS.some((deepLink) => exactRedirect(input.redirectUri, deepLink));
  if (
    (!isAssociatedLink && !isEmulatorScheme && !isGitHubAppScheme) ||
    redirect.username ||
    redirect.password ||
    rawUrlHasCredentials(input.redirectUri) ||
    ((isEmulatorScheme || isGitHubAppScheme) && (redirect.search || redirect.hash))
  ) {
    throw new OidcBindError(
      'invalid_redirect',
      'OIDC completion must use an allowed associated link or app deep link',
    );
  }
  const url = endpoint(baseUrl, `/auth/${provider}/start`);
  url.searchParams.set('app_redirect', input.redirectUri);
  url.searchParams.set('app_state', input.state);
  return { authorizationUrl: url.toString(), redirectUri: input.redirectUri, state: input.state };
}

export function startOidcBind(
  baseUrl: string,
  input: { redirectUri: string; state: string },
): OidcBindStart {
  return startProviderBind(baseUrl, input, 'oidc');
}

/** GitHub OAuth enters the exact same one-use npub bind protocol as OIDC. */
export function startGitHubBind(
  baseUrl: string,
  input: { redirectUri: string; state: string },
): OidcBindStart {
  return startProviderBind(baseUrl, input, 'github');
}

/** Parse and strictly validate the native completion URL before any key signs it. */
export function parseOidcBindCallback(
  callbackUrl: string,
  expectedState: string,
): OidcBindChallenge {
  const url = new URL(callbackUrl);
  const state = exactParam(url.searchParams, 'state');
  if (state !== expectedState)
    throw new OidcBindError('state_mismatch', 'OIDC callback state mismatch');
  const errors = url.searchParams.getAll('error');
  if (errors.length > 1)
    throw new OidcBindError('invalid_callback', 'OIDC callback has duplicate error');
  if (errors[0]) {
    const message = url.searchParams.getAll('message');
    if (message.length > 1)
      throw new OidcBindError('invalid_callback', 'OIDC callback has duplicate message');
    throw new OidcBindError(errors[0], message[0] || 'Account authorization did not complete');
  }
  const allowed = new Set([
    'state',
    'protocol',
    'kind',
    'marker',
    'ticket',
    'challenge',
    'provider',
    'audience',
    'subject',
    'community',
    'issued_at',
    'expires_at',
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key))
      throw new OidcBindError('invalid_callback', `unexpected OIDC callback field: ${key}`);
  }
  const challenge: OidcBindChallenge = {
    protocol: integerParam(url.searchParams, 'protocol') as 1,
    kind: integerParam(url.searchParams, 'kind') as 24_250,
    marker: exactParam(url.searchParams, 'marker') as typeof OIDC_BIND_MARKER,
    ticket: exactParam(url.searchParams, 'ticket'),
    challenge: exactParam(url.searchParams, 'challenge'),
    provider: exactParam(url.searchParams, 'provider'),
    audience: exactParam(url.searchParams, 'audience'),
    subject: exactParam(url.searchParams, 'subject'),
    community: exactParam(url.searchParams, 'community'),
    issued_at: integerParam(url.searchParams, 'issued_at'),
    expires_at: integerParam(url.searchParams, 'expires_at'),
  };
  assertChallenge(challenge);
  return challenge;
}

/** Sign every authoritative field supplied by the one-use bind challenge. */
export function buildOidcBindEvent(
  challenge: OidcBindChallenge,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  createdAt = Math.floor(Date.now() / 1_000),
): NostrEvent {
  assertChallenge(challenge);
  if (!HEX_KEY_RE.test(identity.publicKey) || !Number.isSafeInteger(createdAt)) {
    throw new OidcBindError('invalid_identity', 'OIDC bind signer is invalid');
  }
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: createdAt,
      kind: OIDC_BIND_KIND,
      tags: [
        ['t', OIDC_BIND_MARKER],
        ['protocol', String(challenge.protocol)],
        ['ticket', challenge.ticket],
        ['challenge', challenge.challenge],
        ['provider', challenge.provider],
        ['audience', challenge.audience],
        ['subject', challenge.subject],
        ['community', challenge.community],
        ['issued_at', String(challenge.issued_at)],
        ['expires_at', String(challenge.expires_at)],
      ],
      content: '',
    },
    identity.secretKey,
  );
}

function assertBindEvent(challenge: OidcBindChallenge, event: NostrEvent): void {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['t', OIDC_BIND_MARKER],
    ['protocol', String(challenge.protocol)],
    ['ticket', challenge.ticket],
    ['challenge', challenge.challenge],
    ['provider', challenge.provider],
    ['audience', challenge.audience],
    ['subject', challenge.subject],
    ['community', challenge.community],
    ['issued_at', String(challenge.issued_at)],
    ['expires_at', String(challenge.expires_at)],
  ];
  if (
    event.kind !== OIDC_BIND_KIND ||
    event.content !== '' ||
    event.tags.length !== expected.length
  ) {
    throw new OidcBindError('invalid_bind_event', 'bind event shape is invalid');
  }
  for (const [name, value] of expected) {
    const matches = event.tags.filter((tag) => tag[0] === name);
    if (matches.length !== 1 || matches[0]!.length !== 2 || matches[0]![1] !== value) {
      throw new OidcBindError(
        'invalid_bind_event',
        `bind event has missing, duplicate, or mismatched ${name}`,
      );
    }
  }
  if (
    event.created_at < challenge.issued_at - 60 ||
    event.created_at > challenge.expires_at ||
    !verifyEvent(event)
  ) {
    throw new OidcBindError('invalid_bind_event', 'bind event signature or timestamp is invalid');
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid response',
      response.status,
    );
  }
  return body as Record<string, unknown>;
}

function serviceError(body: Record<string, unknown>, status: number): OidcBindError {
  const code = typeof body.error === 'string' ? body.error : 'auth_service_error';
  const message =
    typeof body.message === 'string' ? body.message : `auth service returned HTTP ${status}`;
  return new OidcBindError(code, message, status);
}

/** Submit the signed challenge. The Nostr secret never enters the request body. */
export async function finishOidcBind(
  baseUrl: string,
  challenge: OidcBindChallenge,
  event: NostrEvent,
): Promise<OidcBindResult> {
  assertChallenge(challenge);
  assertBindEvent(challenge, event);
  let response: Response;
  try {
    response = await fetch(endpoint(baseUrl, '/auth/oidc/bind'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: challenge.ticket, event }),
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  if (
    body.linked !== true ||
    typeof body.idempotent !== 'boolean' ||
    typeof body.pubkey !== 'string' ||
    !HEX_KEY_RE.test(body.pubkey) ||
    body.pubkey !== event.pubkey
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid bind result',
      response.status,
    );
  }
  return body as unknown as OidcBindResult;
}

/** Authenticated, tenant-scoped link lookup for a key already held on this device. */
export async function lookupRecovery(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<OidcIdentityLink[]> {
  if (!HEX_KEY_RE.test(identity.publicKey))
    throw new OidcBindError('invalid_identity', 'invalid public key');
  const url = endpoint(baseUrl, `/auth/oidc/links/${identity.publicKey}`).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET'),
      },
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  if (!Array.isArray(body.links)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned invalid recovery links',
      response.status,
    );
  }
  return body.links.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned invalid recovery link',
        response.status,
      );
    }
    const link = entry as Record<string, unknown>;
    if (
      typeof link.community !== 'string' ||
      typeof link.provider !== 'string' ||
      typeof link.audience !== 'string' ||
      typeof link.subject !== 'string' ||
      typeof link.pubkey !== 'string' ||
      !HEX_KEY_RE.test(link.pubkey) ||
      typeof link.created_at !== 'string' ||
      !Number.isFinite(Date.parse(link.created_at))
    ) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned invalid recovery link',
        response.status,
      );
    }
    return link as unknown as OidcIdentityLink;
  });
}

/** Begin the one-per-account Beeline GitHub App installation flow. */
export async function startGitHubInstallation(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  redirectUri: string,
): Promise<string> {
  const url = endpoint(baseUrl, '/auth/github/install/start').toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pubkey: identity.publicKey, redirect_uri: redirectUri }),
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  if (typeof body.authorization_url !== 'string') {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid GitHub App URL',
      response.status,
    );
  }
  return body.authorization_url;
}

/** Repositories granted by the account's Beeline GitHub App installation. */
export async function listGitHubRepositories(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<{
  installed: boolean;
  installations: GitHubInstallationAccess[];
  repositories: GitHubRepositoryAccess[];
}> {
  const url = endpoint(baseUrl, `/auth/github/repos/${identity.publicKey}`).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET'),
      },
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  if (
    typeof body.installed !== 'boolean' ||
    !Array.isArray(body.installations) ||
    !Array.isArray(body.repositories)
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid GitHub repository list',
      response.status,
    );
  }
  const repositories = body.repositories.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub repository',
        response.status,
      );
    }
    const repo = entry as Record<string, unknown>;
    if (
      typeof repo.id !== 'number' ||
      typeof repo.installationId !== 'number' ||
      !Number.isSafeInteger(repo.installationId) ||
      typeof repo.name !== 'string' ||
      typeof repo.fullName !== 'string' ||
      typeof repo.remote !== 'string' ||
      typeof repo.defaultBranch !== 'string'
    ) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub repository',
        response.status,
      );
    }
    return repo as unknown as GitHubRepositoryAccess;
  });
  const installations = body.installations.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub installation',
        response.status,
      );
    }
    const installation = entry as Record<string, unknown>;
    if (
      typeof installation.installationId !== 'number' ||
      !Number.isSafeInteger(installation.installationId) ||
      typeof installation.accountId !== 'string' ||
      typeof installation.accountLogin !== 'string' ||
      (installation.accountType !== 'User' && installation.accountType !== 'Organization') ||
      (installation.repositorySelection !== 'all' &&
        installation.repositorySelection !== 'selected') ||
      (installation.status !== 'active' &&
        installation.status !== 'revoked' &&
        installation.status !== 'suspended') ||
      typeof installation.repositoryCount !== 'number' ||
      typeof installation.manageUrl !== 'string'
    ) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned an invalid GitHub installation',
        response.status,
      );
    }
    return installation as unknown as GitHubInstallationAccess;
  });
  return { installed: body.installed, installations, repositories };
}

export async function createGitHubRepository(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  input: { installationId: number; name: string; description?: string; private?: boolean },
): Promise<GitHubRepositoryAccess> {
  const url = endpoint(baseUrl, `/auth/github/repos/${identity.publicKey}`).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        installation_id: input.installationId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
      }),
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  const repository = body.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid GitHub repository',
      response.status,
    );
  }
  return repository as unknown as GitHubRepositoryAccess;
}

export async function getGitHubRepositoryAccess(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  fullName: string,
): Promise<GitHubRepositoryAccessResult> {
  const endpointUrl = endpoint(baseUrl, `/auth/github/repo-access/${identity.publicKey}`);
  endpointUrl.searchParams.set('full_name', fullName);
  const url = endpointUrl.toString();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET'),
      },
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  if (typeof body.accessible !== 'boolean') {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid repository access result',
      response.status,
    );
  }
  return body as unknown as GitHubRepositoryAccessResult;
}

/** Discover which sign-in surface the deployed auth sidecar has enabled. */
export async function getAuthCapabilities(baseUrl: string): Promise<AuthCapabilities> {
  const url = endpoint(baseUrl, '/auth/capabilities').toString();
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  if (typeof body.github !== 'boolean' || typeof body.oidc !== 'boolean') {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned invalid capabilities',
      response.status,
    );
  }
  return { github: body.github, oidc: body.oidc };
}
