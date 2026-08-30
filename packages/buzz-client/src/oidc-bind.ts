import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { authEndpoint, OidcBindError, requestAuthJson } from './auth-json.js';
import type { Identity } from './types.js';
import { parseManagedIdentity, type ManagedIdentity } from './nip05.js';

export { OidcBindError } from './auth-json.js';

export const OIDC_BIND_PROTOCOL = 1 as const;
export const OIDC_BIND_KIND = 24_250 as const;
export const OIDC_BIND_MARKER = 'beeline-oidc-bind-v1' as const;
// Exact native identities from apps/mobile/app.config.js. Keep this closed set in sync.
export const MOBILE_APP_SCHEMES = ['beeline'] as const;

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

export interface AuthCapabilities {
  github: boolean;
  oidc: boolean;
}

export interface OidcBindResult {
  linked: true;
  idempotent: boolean;
  pubkey: string;
  identity?: ManagedIdentity;
}

export interface OidcRecoveryResult {
  linked: true;
  replaced: boolean;
  pubkey: string;
  identity?: ManagedIdentity;
}

export interface OidcIdentityLink {
  community: string;
  provider: string;
  audience: string;
  subject: string;
  pubkey: string;
  created_at: string;
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
  const base = authEndpoint(baseUrl, '/');
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
  const url = authEndpoint(baseUrl, `/auth/${provider}/start`);
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

/** Submit the signed challenge. The Nostr secret never enters the request body. */
export async function finishOidcBind(
  baseUrl: string,
  challenge: OidcBindChallenge,
  event: NostrEvent,
): Promise<OidcBindResult> {
  assertChallenge(challenge);
  assertBindEvent(challenge, event);
  const { body, status } = await requestAuthJson(baseUrl, '/auth/oidc/bind', {
    method: 'POST',
    body: { ticket: challenge.ticket, event },
  });
  if (
    body.linked !== true ||
    typeof body.idempotent !== 'boolean' ||
    typeof body.pubkey !== 'string' ||
    !HEX_KEY_RE.test(body.pubkey) ||
    body.pubkey !== event.pubkey ||
    (body.identity !== undefined && !parseManagedIdentity(body.identity))
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid bind result',
      status,
    );
  }
  return {
    linked: true,
    idempotent: body.idempotent as boolean,
    pubkey: body.pubkey as string,
    ...(body.identity ? { identity: parseManagedIdentity(body.identity)! } : {}),
  };
}

/**
 * Deliberately replace an existing device-key link after the normal bind has
 * returned identity_conflict. The short-lived OAuth ticket and signed event
 * are reused, and replacement is a separate explicit protocol action.
 */
export async function recoverOidcBind(
  baseUrl: string,
  challenge: OidcBindChallenge,
  event: NostrEvent,
): Promise<OidcRecoveryResult> {
  assertChallenge(challenge);
  assertBindEvent(challenge, event);
  const { body, status } = await requestAuthJson(baseUrl, '/auth/oidc/recover', {
    method: 'POST',
    body: {
      ticket: challenge.ticket,
      event,
      confirm_replace: true,
    },
  });
  if (
    body.linked !== true ||
    typeof body.replaced !== 'boolean' ||
    typeof body.pubkey !== 'string' ||
    !HEX_KEY_RE.test(body.pubkey) ||
    body.pubkey !== event.pubkey ||
    (body.identity !== undefined && !parseManagedIdentity(body.identity))
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid recovery result',
      status,
    );
  }
  return {
    linked: true,
    replaced: body.replaced as boolean,
    pubkey: body.pubkey as string,
    ...(body.identity ? { identity: parseManagedIdentity(body.identity)! } : {}),
  };
}

/** Read the canonical hosted handle assigned to the key on this device. */
export async function lookupManagedIdentity(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<ManagedIdentity | null> {
  if (!HEX_KEY_RE.test(identity.publicKey))
    throw new OidcBindError('invalid_identity', 'invalid public key');
  const { body, status } = await requestAuthJson(
    baseUrl,
    `/auth/identity/${identity.publicKey}`,
    { identity },
  );
  if (body.identity === null) return null;
  const managed = parseManagedIdentity(body.identity);
  if (!managed) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid managed identity',
      status,
    );
  }
  return managed;
}

/** Consume the single rename to the verified GitHub login after an in-place link. */
export async function adoptGitHubHandle(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<ManagedIdentity> {
  if (!HEX_KEY_RE.test(identity.publicKey))
    throw new OidcBindError('invalid_identity', 'invalid public key');
  const { body, status } = await requestAuthJson(
    baseUrl,
    `/auth/identity/${identity.publicKey}/github-handle`,
    { method: 'POST', identity, body: { confirm_rename: true } },
  );
  const managed = parseManagedIdentity(body.identity);
  if (body.renamed !== true || !managed) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid handle rename',
      status,
    );
  }
  return managed;
}

/** Authenticated, tenant-scoped link lookup for a key already held on this device. */
export async function lookupRecovery(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<OidcIdentityLink[]> {
  if (!HEX_KEY_RE.test(identity.publicKey))
    throw new OidcBindError('invalid_identity', 'invalid public key');
  const { body, status } = await requestAuthJson(
    baseUrl,
    `/auth/oidc/links/${identity.publicKey}`,
    { identity },
  );
  if (!Array.isArray(body.links)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned invalid recovery links',
      status,
    );
  }
  return body.links.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OidcBindError(
        'invalid_response',
        'auth service returned invalid recovery link',
        status,
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
        status,
      );
    }
    return link as unknown as OidcIdentityLink;
  });
}

/** Discover which sign-in surface the deployed auth sidecar has enabled. */
export async function getAuthCapabilities(baseUrl: string): Promise<AuthCapabilities> {
  const { body, status } = await requestAuthJson(baseUrl, '/auth/capabilities', {
    headers: { accept: 'application/json' },
  });
  if (typeof body.github !== 'boolean' || typeof body.oidc !== 'boolean') {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned invalid capabilities',
      status,
    );
  }
  return { github: body.github, oidc: body.oidc };
}
