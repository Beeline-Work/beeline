import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type KeyLike,
  type JWTPayload,
} from 'jose';
import { normalizeIssuer } from './protocol.js';

const MAX_JWKS_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 32 * 1024;

export interface OidcProviderConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret?: string;
  allowInsecure?: boolean;
}

export interface OidcIdentity {
  issuer: string;
  audience: string;
  subject: string;
}

export interface JwksCacheOptions {
  fetch?: typeof fetch;
  now?: () => number;
  defaultMaxAgeMs?: number;
  maximumMaxAgeMs?: number;
  staleIfErrorMs?: number;
  refreshCooldownMs?: number;
}

function cacheMaxAge(header: string | null): number | null {
  if (!header) return null;
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(header)) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(header);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

function validateEndpoint(value: string, allowInsecure: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('OIDC endpoint URL is invalid');
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new Error('OIDC endpoint must use https');
  }
  return url.toString();
}

export class RotatingJwksCache {
  readonly #jwksUri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #defaultMaxAgeMs: number;
  readonly #maximumMaxAgeMs: number;
  readonly #staleIfErrorMs: number;
  readonly #refreshCooldownMs: number;
  #keys = new Map<string, KeyLike>();
  #freshUntil = 0;
  #staleUntil = 0;
  #lastRefreshAttemptAt = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<void> | null = null;

  constructor(jwksUri: string, options: JwksCacheOptions = {}) {
    this.#jwksUri = jwksUri;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#defaultMaxAgeMs = options.defaultMaxAgeMs ?? 5 * 60_000;
    this.#maximumMaxAgeMs = options.maximumMaxAgeMs ?? 60 * 60_000;
    this.#staleIfErrorMs = options.staleIfErrorMs ?? 15 * 60_000;
    this.#refreshCooldownMs = options.refreshCooldownMs ?? 5_000;
  }

  async key(kid: string): Promise<KeyLike> {
    if (!kid || kid.length > 256) throw new Error('ID token kid is missing or invalid');
    const now = this.#now();
    const cached = this.#keys.get(kid);
    if (cached && now < this.#freshUntil) return cached;

    let refreshedNow = false;
    try {
      refreshedNow = await this.#refresh();
    } catch (error) {
      if (cached && this.#now() <= this.#staleUntil) return cached;
      throw new Error(
        `OIDC JWKS refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const refreshed = this.#keys.get(kid);
    if (!refreshed || (!refreshedNow && this.#now() > this.#staleUntil)) {
      throw new Error('ID token signing key is not in a usable provider JWKS');
    }
    return refreshed;
  }

  async #refresh(): Promise<boolean> {
    const now = this.#now();
    if (this.#refreshing) {
      await this.#refreshing;
      return true;
    }
    if (now - this.#lastRefreshAttemptAt < this.#refreshCooldownMs) return false;
    this.#lastRefreshAttemptAt = now;
    this.#refreshing = this.#load();
    try {
      await this.#refreshing;
      return true;
    } finally {
      this.#refreshing = null;
    }
  }

  async #load(): Promise<void> {
    const response = await this.#fetch(this.#jwksUri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_JWKS_BYTES)
      throw new Error('JWKS response too large');
    const document = JSON.parse(text) as { keys?: unknown };
    if (!Array.isArray(document.keys) || document.keys.length === 0 || document.keys.length > 100) {
      throw new Error('invalid JWKS document');
    }

    const next = new Map<string, KeyLike>();
    for (const candidate of document.keys) {
      if (!candidate || typeof candidate !== 'object') continue;
      const jwk = candidate as JWK;
      if (
        jwk.kty !== 'RSA' ||
        typeof jwk.kid !== 'string' ||
        !jwk.kid ||
        (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        next.has(jwk.kid)
      ) {
        continue;
      }
      const imported = await importJWK(jwk, 'RS256');
      if (imported instanceof Uint8Array) continue;
      next.set(jwk.kid, imported);
    }
    if (next.size === 0) throw new Error('JWKS contains no usable RS256 keys');

    const fetchedAt = this.#now();
    const advertised = cacheMaxAge(response.headers.get('cache-control')) ?? this.#defaultMaxAgeMs;
    const maxAge = Math.max(0, Math.min(advertised, this.#maximumMaxAgeMs));
    this.#keys = next;
    this.#freshUntil = fetchedAt + maxAge;
    this.#staleUntil =
      this.#freshUntil +
      (/\bno-store\b/i.test(response.headers.get('cache-control') ?? '')
        ? 0
        : this.#staleIfErrorMs);
  }
}

export class OidcClient {
  readonly config: OidcProviderConfig;
  readonly #jwks: RotatingJwksCache;
  readonly #fetch: typeof fetch;

  constructor(config: OidcProviderConfig, options: JwksCacheOptions = {}) {
    const allowInsecure = config.allowInsecure === true;
    this.config = {
      ...config,
      issuer: normalizeIssuer(config.issuer, allowInsecure),
      authorizationEndpoint: validateEndpoint(config.authorizationEndpoint, allowInsecure),
      tokenEndpoint: validateEndpoint(config.tokenEndpoint, allowInsecure),
      jwksUri: validateEndpoint(config.jwksUri, allowInsecure),
    };
    if (!this.config.clientId || this.config.clientId.length > 512)
      throw new Error('invalid OIDC client id');
    this.#fetch = options.fetch ?? fetch;
    this.#jwks = new RotatingJwksCache(this.config.jwksUri, options);
  }

  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<string> {
    if (!code || code.length > 4_096 || !codeVerifier || codeVerifier.length > 128) {
      throw new Error('invalid authorization code exchange input');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    const response = await this.#fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_TOKEN_BYTES)
      throw new Error('OIDC token response too large');
    if (!response.ok) throw new Error(`OIDC code exchange failed: HTTP ${response.status}`);
    const tokenResponse = JSON.parse(text) as { id_token?: unknown };
    if (typeof tokenResponse.id_token !== 'string' || !tokenResponse.id_token) {
      throw new Error('OIDC token response is missing id_token');
    }
    return tokenResponse.id_token;
  }

  async verifyIdToken(token: string, expectedNonce: string): Promise<OidcIdentity> {
    if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES)
      throw new Error('invalid ID token');
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256') throw new Error('ID token algorithm must be RS256');
    if (typeof header.kid !== 'string' || !header.kid) throw new Error('ID token kid is required');
    const key = await this.#jwks.key(header.kid);
    const verified = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer: this.config.issuer,
      audience: this.config.clientId,
      clockTolerance: 5,
      maxTokenAge: '1h',
      requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'nonce'],
    });
    this.#validateClaims(verified.payload, expectedNonce);
    return {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      subject: verified.payload.sub!,
    };
  }

  #validateClaims(payload: JWTPayload, expectedNonce: string): void {
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 512) {
      throw new Error('ID token subject is empty or invalid');
    }
    if (payload.nonce !== expectedNonce) throw new Error('ID token nonce mismatch');
    const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
    if (!Array.isArray(audiences) || !audiences.includes(this.config.clientId)) {
      throw new Error('ID token audience mismatch');
    }
    const authorizedParty = payload.azp;
    if (audiences.length > 1 && typeof authorizedParty !== 'string') {
      throw new Error('multi-audience ID token requires azp');
    }
    if (authorizedParty !== undefined && authorizedParty !== this.config.clientId) {
      throw new Error('ID token authorized party mismatch');
    }
  }
}
