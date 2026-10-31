import { ExternalServiceTimeoutError, githubFetch } from './external-fetch.js';
import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';

const GITHUB_ISSUER = 'https://github.com';
/** Stable logical audience shared by browser OAuth and monolith phone sign-in. */
export const GITHUB_IDENTITY_AUDIENCE = 'github';
const DEFAULT_API = 'https://api.github.com';

/** Only GitHub's unresolved answer should be retried as mergeability unknown. */
export function githubMergeability(value: unknown): 'clean' | 'dirty' | 'draft' | 'unknown' | 'other' {
  if (value === 'clean' || value === 'dirty' || value === 'draft') return value;
  if (typeof value === 'string' && value !== 'unknown') return 'other';
  return 'unknown';
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'beeline-auth',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export class GitHubHttpError extends Error {
  constructor(
    label: string,
    readonly status: number,
    readonly retryAfter?: string | null,
  ) {
    super(`${label} failed: HTTP ${status}`);
    if (this.rateLimited) {
      this.message = `GitHub rate limit; checks readable again at ${new Date(Date.now() + githubRetryDelay(this, 0)).toISOString()}`;
    }
  }

  get rateLimited(): boolean {
    return (this.status === 403 || this.status === 429) && retryAfterTime(this.retryAfter) !== undefined;
  }
}

function retryAfterTime(value: string | null | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const time = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value);
  return Number.isFinite(time) && time >= 0 && time <= 8.64e15 &&
    (!Number.isFinite(seconds) || seconds >= 0) ? time : undefined;
}

function responseRetryAfter(response: Response): string | null {
  const retry = response.headers.get('retry-after');
  if (retryAfterTime(retry) !== undefined) return retry;
  const reset = response.headers.get('x-ratelimit-reset');
  const epoch = Number(reset);
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset?.trim() &&
      Number.isFinite(epoch) && epoch >= 0 && epoch * 1000 <= 8.64e15) {
    return new Date(epoch * 1000).toUTCString();
  }
  return null;
}

export function transientGitHubError(error: unknown): boolean {
  if (error instanceof GitHubHttpError) return error.rateLimited || error.status === 429 || (error.status >= 500 && error.status < 600);
  if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) return true;
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(code?.code ?? code?.cause?.code ?? '');
}

export function githubRetryDelay(error: unknown, fallback: number): number {
  const value = error instanceof GitHubHttpError ? error.retryAfter : undefined;
  if (!value) return fallback;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(fallback, delay) : fallback;
}

export async function retryGitHubRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (!transientGitHubError(error) || attempt === 3) throw error;
      const delay = githubRetryDelay(error, 1000 * 2 ** attempt);
      // Long rate limits belong to the durable queue, not a sleeping webhook.
      if (delay > 30_000) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/** A listed workflow whose file or runs are gone is not dispatchable; auth/permission failures are not this. */
function isMissingGitHubResource(error: unknown): boolean {
  return error instanceof GitHubHttpError && error.status === 404;
}

export class GitHubCredentialRejectedError extends Error {}

/** A GitHub refusal with GitHub's own explanation, when it gave one. */
export class GitHubRequestError extends GitHubHttpError {
  constructor(
    label: string,
    status: number,
    readonly reason?: string,
    retryAfter?: string | null,
  ) {
    super(label, status, retryAfter);
    if (reason) this.message = `${this.message}: ${reason}`;
  }
}

/** An explicit integration permission refusal from a head-check registration read. */
export class GitHubCheckPermissionError extends GitHubRequestError {}

async function jsonResponseObject(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof ExternalServiceTimeoutError) throw error;
    if (!response.ok) throw new GitHubHttpError(label, response.status, responseRetryAfter(response));
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    if (!response.ok) throw new GitHubHttpError(label, response.status, responseRetryAfter(response));
    throw new Error(`${label} returned invalid JSON`);
  }
  return body as Record<string, unknown>;
}

async function jsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await jsonResponseObject(response, label);
  if (!response.ok) throw new GitHubHttpError(label, response.status, responseRetryAfter(response));
  return body;
}

/** Some App endpoints (e.g. GET /app/installations) answer a bare JSON array, not an envelope. */
async function jsonArray(response: Response, label: string): Promise<Record<string, unknown>[]> {
  if (!response.ok) throw new GitHubHttpError(label, response.status, responseRetryAfter(response));
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof ExternalServiceTimeoutError) throw error;
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!Array.isArray(body)) {
    throw new GitHubHttpError(label, response.status, responseRetryAfter(response));
  }
  for (const entry of body) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} entry is invalid`);
    }
  }
  return body as Record<string, unknown>[];
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  apiBaseUrl?: string;
}

export interface GitHubIdentity {
  issuer: typeof GITHUB_ISSUER;
  audience: string;
  subject: string;
  login: string;
  /** Human-facing GitHub profile name. Login remains the canonical handle. */
  displayName?: string;
  /** Server-side credential used to prove installation membership and create personal repos. */
  accessToken: string;
  /** GitHub OAuth refresh grant token; user-to-server tokens expire after 8 hours. */
  refreshToken?: string;
  /** Access-token lifetime in seconds, as reported by the token endpoint. */
  tokenExpiresIn?: number;
}

/** GitHub OAuth is only an account lookup proof; the Nostr key bind stays unchanged. */
export class GitHubOAuthClient {
  readonly config: Required<GitHubOAuthConfig>;

  constructor(config: GitHubOAuthConfig) {
    if (!config.clientId.trim() || !config.clientSecret.trim()) {
      throw new Error('GitHub OAuth client id and secret are required');
    }
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authorizationEndpoint:
        config.authorizationEndpoint ?? 'https://github.com/login/oauth/authorize',
      tokenEndpoint: config.tokenEndpoint ?? 'https://github.com/login/oauth/access_token',
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API,
    };
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri?: string }): string {
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('client_id', this.config.clientId);
    if (input.redirectUri) url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<GitHubIdentity> {
    const tokenResponse = await githubFetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }),
    });
    const tokenBody = await jsonObject(tokenResponse, 'GitHub OAuth exchange');
    const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
    if (!accessToken) throw new Error('GitHub OAuth response is missing access_token');
    const refreshToken = typeof tokenBody.refresh_token === 'string' ? tokenBody.refresh_token : '';
    const tokenExpiresIn =
      typeof tokenBody.expires_in === 'number' && Number.isFinite(tokenBody.expires_in)
        ? tokenBody.expires_in
        : undefined;
    const userBody = await jsonObject(
      await githubFetch(`${this.config.apiBaseUrl}/user`, {
        headers: githubHeaders(accessToken),
      }),
      'GitHub user lookup',
    );
    const id = typeof userBody.id === 'number' ? userBody.id : NaN;
    const login = typeof userBody.login === 'string' ? userBody.login : '';
    const displayName = typeof userBody.name === 'string' ? userBody.name.trim() : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !login)
      throw new Error('GitHub user response is invalid');
    return {
      issuer: GITHUB_ISSUER,
      audience: GITHUB_IDENTITY_AUDIENCE,
      subject: String(id),
      login,
      ...(displayName ? { displayName } : {}),
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(tokenExpiresIn !== undefined ? { tokenExpiresIn } : {}),
    };
  }

  /** Exchanges a refresh token for a fresh user-to-server access token (GitHub OAuth refresh grant). */
  async refreshUserToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken?: string; tokenExpiresIn?: number }> {
    const tokenResponse = await githubFetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const tokenBody = await jsonResponseObject(tokenResponse, 'GitHub OAuth refresh');
    if (
      tokenBody.error === 'bad_refresh_token' ||
      tokenBody.error === 'invalid_grant' ||
      tokenBody.error === 'expired_token'
    ) {
      throw new GitHubCredentialRejectedError('GitHub refresh grant rejected');
    }
    if (!tokenResponse.ok) throw new GitHubHttpError('GitHub OAuth refresh', tokenResponse.status);
    const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
    if (!accessToken) throw new Error('GitHub OAuth refresh response is missing access_token');
    const nextRefreshToken =
      typeof tokenBody.refresh_token === 'string' ? tokenBody.refresh_token : '';
    const tokenExpiresIn =
      typeof tokenBody.expires_in === 'number' && Number.isFinite(tokenBody.expires_in)
        ? tokenBody.expires_in
        : undefined;
    return {
      accessToken,
      ...(nextRefreshToken ? { refreshToken: nextRefreshToken } : {}),
      ...(tokenExpiresIn !== undefined ? { tokenExpiresIn } : {}),
    };
  }
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  slug: string;
  apiBaseUrl?: string;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
}

export interface GitHubInstallationRepository {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  remote: string;
  defaultBranch: string;
  /** GitHub's `private` flag; an absent flag is treated as private. */
  private: boolean;
  /** GitHub's repository-level auto-merge toggle; an absent flag is treated as off. */
  allowAutoMerge: boolean;
}

export interface GitHubDispatchableWorkflow {
  readonly id: number;
  readonly name: string;
  readonly lastRunAt?: number;
  readonly conclusion?: string;
}

/** A listed workflow or suite GitHub has not finished. An unreadable row stays open. */
function registrationStillOpen(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
  const status = (item as { status?: unknown }).status;
  return typeof status !== 'string' || status !== 'completed';
}

/**
 * Installed apps get a check suite even when they never add a check run.
 * Those suites stay queued forever and are not pending work. A suite that
 * already has runs, or that omits its run count, still blocks.
 */
function suiteHasUnfinishedRuns(item: unknown): boolean {
  if (!registrationStillOpen(item)) return false;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
  const count = (item as { latest_check_runs_count?: unknown }).latest_check_runs_count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return true;
  return count > 0;
}

/** A branch-protection requirement. `appId` null accepts the context from any GitHub App. */
type RequiredCheck = { readonly name: string; readonly appId: number | null };

/**
 * `checks` carries the GitHub App that must report each context. The legacy
 * `contexts` list is only the names, so it must not widen an app-pinned check
 * into a match against any app.
 */
function requiredChecks(body: Record<string, unknown>): RequiredCheck[] {
  const checks = body.checks;
  const contexts = body.contexts;
  if (!Array.isArray(checks) && !Array.isArray(contexts))
    throw new Error('GitHub required status checks are invalid');
  const required: RequiredCheck[] = [];
  const named = new Set<string>();
  if (Array.isArray(checks)) {
    for (const check of checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
      const context = (check as { context?: unknown }).context;
      if (typeof context !== 'string' || !context) continue;
      const rawApp = (check as { app_id?: unknown }).app_id;
      // -1 is GitHub's explicit "any app". Null and omission mean the same.
      const appId = typeof rawApp === 'number' && Number.isSafeInteger(rawApp) && rawApp > 0
        ? rawApp
        : null;
      required.push({ name: context, appId });
      named.add(context);
    }
  }
  if (Array.isArray(contexts)) {
    for (const context of contexts) {
      if (typeof context === 'string' && context && !named.has(context))
        required.push({ name: context, appId: null });
    }
  }
  return required;
}

/** REST `app.id` is GraphQL `App.databaseId` on the check run's suite. */
function checkRunAppId(context: Record<string, unknown>): number | null {
  const suite = context.checkSuite;
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) return null;
  const app = (suite as { app?: unknown }).app;
  if (!app || typeof app !== 'object' || Array.isArray(app)) return null;
  const id = (app as { databaseId?: unknown }).databaseId;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface GitHubCheckRollup {
  readonly state: 'passed' | 'failed' | 'pending';
  readonly total: number;
  /** Registered workflows or suites still running, even without contexts. */
  readonly pendingRegistrations?: boolean;
  readonly failing: readonly string[];
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed' | 'pending' | 'cancelled';
    readonly conclusion?: string;
    readonly url?: string;
  }[];
}

function repositoryPath(fullName: string): string {
  const parts = fullName.split('/');
  if (parts.length !== 2 || parts.some((part) => !part))
    throw new Error('invalid GitHub repository');
  return parts.map((part) => encodeURIComponent(part)).join('/');
}

/** Recognize workflow_dispatch under the top-level YAML `on` key without treating comments as config. */
function hasWorkflowDispatch(source: string): boolean {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s|^\s*#/.test(line)) continue;
    const match = /^(?:on|'on'|"on")\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const inline = match[1]!.replace(/\s+#.*$/, '');
    if (/(?:^|[\s,[{])workflow_dispatch(?:[\s,\]}:]|$)/.test(inline)) return true;
    let childIndent: number | undefined;
    for (let child = index + 1; child < lines.length; child++) {
      const candidate = lines[child]!;
      if (!candidate.trim() || /^\s*#/.test(candidate)) continue;
      if (!/^\s/.test(candidate)) break;
      const indent = /^\s*/.exec(candidate)![0].length;
      childIndent ??= indent;
      if (
        indent === childIndent &&
        /^\s+(?:workflow_dispatch|'workflow_dispatch'|"workflow_dispatch")\s*:/.test(candidate)
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface GitHubAppInstallation {
  installationId: number;
  account: GitHubInstallationAccount;
}

/**
 * A user's own membership in an organization, as their token reports it.
 * 'unknown' means GitHub would not answer — never treat it as a denial.
 */
export type GitHubOrganizationMembership = 'active' | 'pending' | 'none' | 'unknown';

export interface GitHubInstallationAccount {
  id: string;
  login: string;
  type: 'User' | 'Organization';
  avatarUrl?: string;
  repositorySelection: 'all' | 'selected';
}

export class GitHubAppClient {
  readonly #config: Required<GitHubAppConfig>;

  constructor(config: GitHubAppConfig) {
    if (!/^\d+$/.test(config.appId) || !config.privateKey.trim() || !config.slug.trim()) {
      throw new Error('GitHub App id, slug, and private key are required');
    }
    this.#config = { ...config, apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API };
  }

  // Tokens from different repositories share one installation quota. Keep only
  // token digests in the scope map; mint caching preserves the exact grant.
  readonly #tokenScopes = new Map<string, { installationId: number; expiresAt: number }>();
  readonly #tokens = new Map<string, GitHubInstallationToken>();
  readonly #mints = new Map<string, Promise<GitHubInstallationToken>>();
  readonly #retryAt = new Map<string, number>();
  #activeRequests = 0;
  readonly #requestQueue: Array<() => void> = [];
  #rateLimitStore?: {
    get(installationId: number): Promise<number>;
    set(installationId: number, retryAt: number): Promise<void>;
  };

  /** Shared server storage makes an installation cooldown survive deploys and replicas. */
  setRateLimitStore(store: { get(installationId: number): Promise<number>; set(installationId: number, retryAt: number): Promise<void> }): void {
    this.#rateLimitStore = store;
  }

  private async request(input: string | URL, init: RequestInit = {}): Promise<Response> {
    if (this.#activeRequests >= 4) await new Promise<void>(resolve => this.#requestQueue.push(resolve));
    else this.#activeRequests++;
    try {
      const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
      const digest = token ? createHash('sha256').update(token).digest('hex') : '';
      const scope = this.#tokenScopes.get(digest);
      const mint = new URL(input).pathname.match(/\/app\/installations\/(\d+)\/access_tokens$/);
      const installationId = mint ? Number(mint[1]) : scope?.installationId;
      const key = installationId ? `installation:${installationId}` : `token:${digest}`;
      const sharedRetryAt = installationId && this.#rateLimitStore
        ? await this.#rateLimitStore.get(installationId) : 0;
      const retryAt = Math.max(this.#retryAt.get(key) ?? 0, sharedRetryAt);
      if (retryAt > Date.now())
        throw new GitHubHttpError('GitHub installation cooldown', 429, new Date(retryAt).toUTCString());
      this.#retryAt.delete(key);
      const response = await githubFetch(input, init);
      const retry = responseRetryAfter(response);
      if (retry && (response.status === 403 || response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0')) {
        const until = retryAfterTime(retry)!;
        this.#retryAt.set(key, until);
        if (installationId && this.#rateLimitStore) await this.#rateLimitStore.set(installationId, until);
      }
      return response;
    } finally {
      const next = this.#requestQueue.shift();
      if (next) next();
      else this.#activeRequests--;
    }
  }

  installationUrl(state: string, selectTarget = false): string {
    const url = new URL(`https://github.com/apps/${this.#config.slug}/installations/${selectTarget ? 'select_target' : 'new'}`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * The STATE-LESS public install URL for this App — the shareable link handed
   * to a repository OWNER who does not use Beeline themselves. Unlike
   * {@link installationUrl} it carries no flow state, so anyone can open it:
   * completing the installation records through the normal webhook/reconcile
   * path, never through the sharer's session.
   */
  get publicInstallUrl(): string {
    return `https://github.com/apps/${this.#config.slug}/installations/new`;
  }

  /**
   * THIS App's own live configuration (GET /app, App-JWT authenticated):
   * the subscribed events and permission levels the drift check compares
   * against the required set.
   */
  async fetchApp(): Promise<{ slug: string; events?: unknown; permissions?: unknown }> {
    const body = await jsonObject(
      await this.request(`${this.#config.apiBaseUrl}/app`, {
        headers: githubHeaders(await this.appJwt()),
      }),
      'GitHub app lookup',
    );
    const slug = body.slug;
    if (typeof slug !== 'string' || !slug) {
      throw new Error('GitHub app lookup response is invalid');
    }
    return { slug, events: body.events, permissions: body.permissions };
  }

  private async appJwt(): Promise<string> {
    const key = await importPKCS8(this.#config.privateKey.replace(/\\n/g, '\n'), 'RS256');
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(this.#config.appId)
      .sign(key);
  }

  async installationToken(
    installationId: number,
    options: {
      repositoryIds?: readonly number[];
      /** Explicit permission downgrade sent verbatim to GitHub's token mint. */
      permissions?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<GitHubInstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('invalid GitHub installation id');
    }
    const now = Date.now();
    for (const [key, value] of this.#tokens) if (Date.parse(value.expiresAt) <= now + 5 * 60_000) this.#tokens.delete(key);
    for (const [key, value] of this.#tokenScopes) if (value.expiresAt <= now) this.#tokenScopes.delete(key);
    const key = JSON.stringify([installationId, [...(options.repositoryIds ?? [])].sort((a,b) => a-b),
      options.permissions === undefined ? null : Object.entries(options.permissions).sort(([a],[b]) => a.localeCompare(b))]);
    const cached = this.#tokens.get(key);
    if (cached) return { ...cached };
    const pending = this.#mints.get(key);
    if (pending) return { ...await pending };
    const mint = this.mintInstallationToken(installationId, options).then(value => {
      this.#tokenScopes.set(createHash('sha256').update(value.token).digest('hex'),
        { installationId, expiresAt: Date.parse(value.expiresAt) });
      if (Date.parse(value.expiresAt) > Date.now() + 5 * 60_000) this.#tokens.set(key, value);
      return value;
    });
    this.#mints.set(key, mint);
    try { return { ...await mint }; }
    finally { this.#mints.delete(key); }
  }

  private async mintInstallationToken(installationId: number, options: {
    repositoryIds?: readonly number[]; permissions?: Readonly<Record<string, string>>;
  }): Promise<GitHubInstallationToken> {
    const hasBody = Boolean(options.repositoryIds?.length) || Boolean(options.permissions);
    const response = await this.request(`${this.#config.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        ...githubHeaders(await this.appJwt()),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody
        ? {
            body: JSON.stringify({
              ...(options.repositoryIds?.length ? { repository_ids: options.repositoryIds } : {}),
              ...(options.permissions ? { permissions: options.permissions } : {}),
            }),
          }
        : {}),
    });
    if (!response.ok) {
      try {
        const requestId = response.headers.get('x-github-request-id') ?? '';
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        const mediaType = contentType === 'application/json' || contentType === 'application/vnd.github+json'
          ? 'json' : contentType === 'text/html' ? 'html' : contentType ? 'other' : 'missing';
        // Only bounded correlation metadata; never retain bodies, credentials or request scope.
        console.warn('[github-installation-token]', {
          status: response.status,
          requestId: requestId.length <= 128 && /^[0-9a-f]+(?::[0-9a-f]+)+$/i.test(requestId)
            ? requestId : 'unavailable',
          mediaType,
        });
      } catch { /* Diagnostics must not replace the original GitHub failure. */ }
    }
    const body = await jsonObject(response, 'GitHub installation token');
    const token = typeof body.token === 'string' ? body.token : '';
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : '';
    if (!token || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('GitHub installation token response is invalid');
    }
    return { token, expiresAt };
  }

  /** List only workflows a person can dispatch, with the latest run on any branch. */
  async listDispatchableWorkflows(
    accessToken: string,
    fullName: string,
    defaultBranch: string,
  ): Promise<GitHubDispatchableWorkflow[]> {
    const path = repositoryPath(fullName);
    const candidates: { id: number; name: string; path: string; state: string }[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await this.request(
          `${this.#config.apiBaseUrl}/repos/${path}/actions/workflows?per_page=100&page=${page}`,
          { headers: githubHeaders(accessToken) },
        ),
        'GitHub workflow list',
      );
      if (!Array.isArray(body.workflows)) throw new Error('GitHub workflow list is invalid');
      for (const entry of body.workflows) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('GitHub workflow entry is invalid');
        }
        const record = entry as Record<string, unknown>;
        const id = record.id;
        const name = record.name;
        const workflowPath = record.path;
        const state = record.state;
        if (
          typeof id !== 'number' ||
          !Number.isSafeInteger(id) ||
          id <= 0 ||
          typeof name !== 'string' ||
          !name.trim() ||
          typeof workflowPath !== 'string' ||
          !workflowPath ||
          typeof state !== 'string'
        ) {
          throw new Error('GitHub workflow entry is invalid');
        }
        candidates.push({ id, name: name.trim(), path: workflowPath, state });
      }
      if (body.workflows.length < 100) break;
    }
    const workflows = await Promise.all(
      candidates.map(async (workflow): Promise<GitHubDispatchableWorkflow | undefined> => {
        if (workflow.state !== 'active') return undefined;
        let content: Record<string, unknown>;
        try {
          content = await jsonObject(
            await this.request(
              `${this.#config.apiBaseUrl}/repos/${path}/contents/${workflow.path
                .split('/')
                .map((part) => encodeURIComponent(part))
                .join('/')}?ref=${encodeURIComponent(defaultBranch)}`,
              { headers: githubHeaders(accessToken) },
            ),
            'GitHub workflow source',
          );
        } catch (error) {
          if (isMissingGitHubResource(error)) return undefined;
          throw error;
        }
        if (content.encoding !== 'base64' || typeof content.content !== 'string') {
          return undefined;
        }
        const source = Buffer.from(content.content.replace(/\s/g, ''), 'base64').toString('utf8');
        if (!hasWorkflowDispatch(source)) return undefined;
        let runs: Record<string, unknown>;
        try {
          runs = await jsonObject(
            await this.request(
              `${this.#config.apiBaseUrl}/repos/${path}/actions/workflows/${workflow.id}/runs?per_page=1`,
              { headers: githubHeaders(accessToken) },
            ),
            'GitHub workflow runs',
          );
        } catch (error) {
          if (isMissingGitHubResource(error)) return undefined;
          throw error;
        }
        if (!Array.isArray(runs.workflow_runs)) throw new Error('GitHub workflow runs are invalid');
        const latest = runs.workflow_runs[0];
        if (!latest) return { id: workflow.id, name: workflow.name };
        if (typeof latest !== 'object' || Array.isArray(latest)) {
          throw new Error('GitHub workflow run entry is invalid');
        }
        const run = latest as Record<string, unknown>;
        const runAt = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
        const conclusion = typeof run.conclusion === 'string' ? run.conclusion.trim() : '';
        return {
          id: workflow.id,
          name: workflow.name,
          ...(Number.isFinite(runAt) ? { lastRunAt: Math.floor(runAt / 1_000) } : {}),
          ...(conclusion ? { conclusion } : {}),
        };
      }),
    );
    return workflows
      .filter((workflow): workflow is GitHubDispatchableWorkflow => Boolean(workflow))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * The immutable git blob SHA of ONE file, or undefined when that ref does not
   * carry that path as a file.
   *
   * The contents API answers the blob id directly, so a reader compares content
   * identity without downloading or re-hashing bytes, and "this code is not
   * here" (a 404, or a directory, which answers an array) stays distinct from
   * "the API failed". A code-anchor check turns the first into a stale
   * procedure and must never turn the second into one, so the two answers may
   * not collapse into a generic error.
   */
  async fileBlobSha(input: {
    accessToken: string;
    fullName: string;
    path: string;
    ref: string;
  }): Promise<string | undefined> {
    const url = new URL(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(input.fullName)}/contents/${input.path
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`,
    );
    url.searchParams.set('ref', input.ref);
    const response = await this.request(url, { headers: githubHeaders(input.accessToken) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GitHubHttpError('GitHub file lookup', response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof ExternalServiceTimeoutError) throw error;
      throw new Error('GitHub file lookup returned invalid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const file = body as Record<string, unknown>;
    if (file.type !== 'file') return undefined;
    const sha = file.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('GitHub file lookup returned an invalid blob id');
    }
    return sha;
  }

  async dispatchProductionWorkflow(accessToken: string, fullName: string, inputs: Record<string, string>): Promise<void> {
    if (!inputs.dispatched_by) throw new Error('Production release requires an agent identity');
    // A single match in any active state blocks dispatch; query errors fail closed.
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const result = await this.readRepositoryJson(accessToken, fullName,
        `actions/workflows/unified-release.yml/runs?status=${status}&per_page=1`);
      if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid production release run listing');
      if (result.workflow_runs.length) {
        const run = result.workflow_runs[0] as { id?: unknown };
        throw new Error(`Production release ${run.id} is already ${status}. Wait for it to finish or cancel it in GitHub Actions.`);
      }
    }
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/actions/workflows/unified-release.yml/dispatches`,
      { method: 'POST', headers: { ...githubHeaders(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs }) },
    );
    if (!response.ok) throw new GitHubHttpError('GitHub production release dispatch', response.status);
  }

  async dispatchWorkflow(
    accessToken: string,
    fullName: string,
    workflowId: number,
    defaultBranch: string,
  ): Promise<void> {
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        headers: { ...githubHeaders(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ ref: defaultBranch }),
      },
    );
    if (!response.ok) throw new GitHubHttpError('GitHub workflow dispatch', response.status);
  }

  /** Resolve the current head in the Room's repository, including fork-authored PRs. */
  async readPullRequest(accessToken: string, fullName: string, number: number) {
    const body = await this.readRepositoryJson(accessToken, fullName, `pulls/${number}`);
    const head = body.head as { sha?: unknown; ref?: unknown } | undefined;
    const base = body.base as { sha?: unknown; ref?: unknown } | undefined;
    if (typeof head?.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(head.sha))
      throw new Error('GitHub pull request has no valid head');
    const mergeableState = body.mergeable_state;
    return {
      number,
      url: `https://github.com/${fullName}/pull/${number}`,
      headSha: head.sha,
      ...(typeof head.ref === 'string' ? { headRef: head.ref } : {}),
      ...(typeof base?.ref === 'string' ? { baseRef: base.ref } : {}),
      merged: body.merged === true,
      ...(body.state === 'open' || body.state === 'closed' ? { state: body.state } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.merged_at === 'string' ? { mergedAt: body.merged_at } : {}),
      ...(typeof body.merge_commit_sha === 'string'
        ? { mergeCommitSha: body.merge_commit_sha }
        : {}),
      ...(typeof (body.merged_by as { login?: unknown } | undefined)?.login === 'string'
        ? { mergedBy: (body.merged_by as { login: string }).login }
        : {}),
      ...(typeof base?.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(base.sha)
        ? { baseSha: base.sha }
        : {}),
      mergeability: body.draft === true ? 'draft' as const : githubMergeability(mergeableState),
    };
  }

  async markPullRequestReadyForReview(token: string, fullName: string, number: number, headSha: string): Promise<void> {
    const [owner, name] = fullName.split('/');
    const data = await this.queueGraphql(token, `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid}}
    }`, { owner, name, number }, 'GitHub draft readiness');
    const pr = (data.repository as { pullRequest?: { id: string; headRefOid: string } })?.pullRequest;
    if (!pr?.id || pr.headRefOid !== headSha) throw new Error('PR head changed before marking ready');
    const result = await this.queueGraphql(token, `mutation($id:ID!){
      markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}
    }`, { id: pr.id }, 'GitHub draft readiness');
    const ready = result.markPullRequestReadyForReview as { pullRequest?: { isDraft: boolean } } | undefined;
    if (ready?.pullRequest?.isDraft !== false) throw new Error('PR is still a draft');
  }

  /** A PR's changed files, reviews, inline review comments and conversation comments. */
  async readPullRequestDiscussion(accessToken: string, fullName: string, number: number) {
    const list = async (path: string) => {
      const response = await this.request(
        `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/${path}?per_page=100`,
        { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
      );
      return jsonArray(response, 'GitHub pull request read');
    };
    const [files, reviews, reviewComments, comments] = await Promise.all([
      list(`pulls/${number}/files`),
      list(`pulls/${number}/reviews`),
      list(`pulls/${number}/comments`),
      list(`issues/${number}/comments`),
    ]);
    const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 2_000) : '');
    const author = (value: unknown) =>
      text((value as { login?: unknown } | null | undefined)?.login);
    return {
      files: files.map((file) => ({
        filename: text(file.filename),
        status: text(file.status),
        additions: Number(file.additions) || 0,
        deletions: Number(file.deletions) || 0,
      })),
      reviews: reviews.map((review) => ({
        author: author(review.user),
        state: text(review.state),
        body: text(review.body),
        ...(typeof review.submitted_at === 'string' ? { submittedAt: review.submitted_at } : {}),
      })),
      reviewComments: reviewComments.map((comment) => ({
        author: author(comment.user),
        path: text(comment.path),
        ...(typeof comment.line === 'number' ? { line: comment.line } : {}),
        body: text(comment.body),
        ...(typeof comment.created_at === 'string' ? { createdAt: comment.created_at } : {}),
      })),
      comments: comments.map((comment) => ({
        author: author(comment.user),
        body: text(comment.body),
        ...(typeof comment.created_at === 'string' ? { createdAt: comment.created_at } : {}),
      })),
    };
  }

  /** Resolve a branch at GitHub now; push deliveries can arrive out of order. */
  async readBranchHead(accessToken: string, fullName: string, branch: string): Promise<string> {
    const body = await this.readRepositoryJson(
      accessToken,
      fullName,
      `branches/${encodeURIComponent(branch)}`,
    );
    const sha = (body.commit as { sha?: unknown } | undefined)?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha))
      throw new Error('GitHub branch has no valid head');
    return sha;
  }

  /** One repository-owned branch can have at most one open PR for repair. */
  async openPullRequestsForBranch(accessToken: string, fullName: string, branch: string) {
    const owner = fullName.split('/')[0];
    if (!owner) throw new Error('invalid GitHub repository');
    const url = new URL(`${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/pulls`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('head', `${owner}:${branch}`);
    url.searchParams.set('per_page', '100');
    const response = await this.request(url, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GitHubHttpError('GitHub branch pull requests', response.status, responseRetryAfter(response));
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('GitHub branch pull requests are invalid');
    return body.flatMap((entry): number[] => {
      const pr = entry && typeof entry === 'object'
        ? entry as { number?: unknown; head?: { repo?: { full_name?: unknown } } }
        : undefined;
      const number = pr?.number;
      return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
        && typeof pr?.head?.repo?.full_name === 'string'
        && pr.head.repo.full_name.toLowerCase() === fullName.toLowerCase()
        ? [number]
        : [];
    });
  }

  /** Retry transient provider failures once for every caller of the shared check read. */
  async readCommitCheckRollup(accessToken: string, fullName: string, headSha: string): Promise<GitHubCheckRollup> {
    return retryGitHubRead(() => this.readCommitCheckRollupOnce(accessToken, fullName, headSha));
  }

  /** GitHub's own combined verdict for every check run and commit-status context on a head. */
  private async readCommitCheckRollupOnce(
    accessToken: string,
    fullName: string,
    headSha: string,
  ): Promise<GitHubCheckRollup> {
    const [owner, name] = fullName.split('/');
    if (!owner || !name || !/^[a-f0-9]{40,64}$/i.test(headSha)) {
      throw new Error('invalid GitHub commit check target');
    }
    const response = await this.request(`${this.#config.apiBaseUrl}/graphql`, {
      method: 'POST',
      headers: { ...githubHeaders(accessToken), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        query: `query CommitCheckRollup($owner:String!,$name:String!,$expression:String!){
          repository(owner:$owner,name:$name){object(expression:$expression){... on Commit{
            oid statusCheckRollup{state contexts(first:100){totalCount nodes{
              __typename
              ... on CheckRun{name status conclusion detailsUrl checkSuite{app{databaseId}}}
              ... on StatusContext{context state description targetUrl}
            }}}
          }}}
        }`,
        variables: { owner, name, expression: headSha },
      }),
    });
    const body = await jsonObject(response, 'GitHub commit check rollup');
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error('GitHub commit check rollup returned errors');
    }
    const repository = body.data as Record<string, unknown> | undefined;
    const object = (repository?.repository as Record<string, unknown> | undefined)?.object as
      Record<string, unknown> | undefined;
    if (object?.oid !== headSha) throw new Error('GitHub commit check rollup head mismatch');
    const rollup = object.statusCheckRollup as Record<string, unknown> | null | undefined;
    if (!rollup) return {
      state: 'pending', total: 0, failing: [], checks: [],
      pendingRegistrations: await this.hasUnfinishedChecks(accessToken, fullName, headSha),
    };
    const state =
      rollup.state === 'SUCCESS'
        ? ('passed' as const)
        : rollup.state === 'FAILURE' || rollup.state === 'ERROR'
          ? ('failed' as const)
          : rollup.state === 'PENDING' || rollup.state === 'EXPECTED'
            ? ('pending' as const)
            : undefined;
    if (!state) throw new Error('GitHub commit check rollup state is invalid');
    const contexts = rollup.contexts as Record<string, unknown> | undefined;
    if (!contexts || typeof contexts.totalCount !== 'number' || !Array.isArray(contexts.nodes)) {
      throw new Error('GitHub commit check rollup contexts are invalid');
    }
    const reported: { name: string; appId: number | null }[] = [];
    const checks = contexts.nodes.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const context = value as Record<string, unknown>;
      const isRun = context.__typename === 'CheckRun';
      const checkName = isRun ? context.name : context.context;
      if (typeof checkName !== 'string' || !checkName) return [];
      const checkState = isRun
        ? context.status !== 'COMPLETED' || !context.conclusion
          ? 'pending'
          : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(context.conclusion))
            ? 'passed'
            : String(context.conclusion) === 'CANCELLED'
              ? 'cancelled'
              : 'failed'
        : context.state === 'SUCCESS'
          ? 'passed'
          : context.state === 'FAILURE' || context.state === 'ERROR'
            ? 'failed'
            : 'pending';
      const conclusion = isRun ? context.conclusion : context.description;
      const url = isRun ? context.detailsUrl : context.targetUrl;
      const appId = isRun ? checkRunAppId(context) : null;
      if (checkState === 'passed') reported.push({ name: checkName, appId });
      return [
        {
          name: checkName,
          status: checkState,
          ...(typeof conclusion === 'string' && conclusion ? { conclusion } : {}),
          ...(typeof url === 'string' && url ? { url } : {}),
        } as const,
      ];
    });
    // A workflow can register before it creates a check run, and a suite can
    // already hold queued runs the rollup has not listed. An empty suite is
    // only the placeholder GitHub opens for an installed app. A required
    // check still has to come from the GitHub App branch protection names.
    let pending = await this.hasUnfinishedChecks(accessToken, fullName, headSha);
    if (!pending && state === 'passed') {
      const missing = await this.missingRequiredChecks(
        accessToken, fullName, headSha, reported,
      );
      if (missing.length) {
        pending = true;
        for (const name of missing) checks.push({ name, status: 'pending' });
      }
    }
    return {
      state: pending ? 'pending' : state,
      pendingRegistrations: pending,
      total: contexts.totalCount,
      failing: checks.filter((check) => check.status === 'failed').map((check) => check.name),
      checks,
    };
  }

  private async hasUnfinishedChecks(accessToken: string, fullName: string, headSha: string): Promise<boolean> {
    const unfinished = async (
      path: string, key: string, blocks: (item: unknown) => boolean,
    ): Promise<boolean> => {
      for (let page = 1; ; page++) {
        const separator = path.includes('?') ? '&' : '?';
        const body = await this.readRepositoryJson(
          accessToken, fullName, `${path}${separator}per_page=100&page=${page}`,
        );
        const items = body[key];
        if (!Array.isArray(items) || typeof body.total_count !== 'number' || !Number.isSafeInteger(body.total_count) || body.total_count < 0)
          throw new Error('GitHub head check registration is invalid');
        if (items.some((item) => blocks(item))) return true;
        if (page * 100 >= body.total_count) return false;
        if (!items.length) throw new Error('GitHub head check registration is incomplete');
      }
    };
    const [suites, workflows] = await Promise.all([
      unfinished(`commits/${headSha}/check-suites`, 'check_suites', suiteHasUnfinishedRuns),
      unfinished(`actions/runs?head_sha=${headSha}`, 'workflow_runs', registrationStillOpen),
    ]);
    return suites || workflows;
  }

  /** Branch-protection contexts whose required GitHub App has not passed on this head. */
  private async missingRequiredChecks(
    accessToken: string,
    fullName: string,
    headSha: string,
    reported: readonly { readonly name: string; readonly appId: number | null }[],
  ): Promise<string[]> {
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/commits/${headSha}/pulls?per_page=100`,
      { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
    );
    const pulls = await jsonArray(response, 'GitHub commit pull requests');
    if (pulls.length >= 100) throw new Error('GitHub commit pull requests are incomplete');
    const bases = new Set<string>();
    for (const pull of pulls) {
      if (pull.state !== 'open') continue;
      const base = pull.base;
      if (!base || typeof base !== 'object' || Array.isArray(base)) continue;
      const ref = (base as { ref?: unknown }).ref;
      if (typeof ref === 'string' && ref) bases.add(ref);
    }
    const missing = new Set<string>();
    for (const branch of bases) {
      let body: Record<string, unknown>;
      try {
        body = await this.readRepositoryJson(
          accessToken,
          fullName,
          `branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
        );
      } catch (error) {
        if (error instanceof GitHubHttpError && error.status === 404) continue;
        // Private repositories on GitHub Free cannot configure branch protection.
        if (error instanceof GitHubHttpError && error.status === 403 &&
          (error.message.includes('Upgrade to GitHub Pro') ||
            error.message.includes('make this repository public'))) continue;
        throw error;
      }
      for (const required of requiredChecks(body)) {
        const satisfied = reported.some((check) =>
          check.name === required.name &&
          (required.appId === null || check.appId === required.appId));
        if (!satisfied) missing.add(required.name);
      }
    }
    return [...missing];
  }

  /** Empty rollups can precede registration; establish absence independently. */
  async confirmNoChecks(accessToken: string, fullName: string, headSha: string): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/i.test(headSha)) throw new Error('invalid GitHub commit check target');
    try {
      const permissions = await this.readRepositoryJson(accessToken, fullName, 'actions/permissions');
      if (permissions.enabled === false) return true;
    } catch {
      // Permission reads are optional; retain the workflow registration proof.
    }
    const workflows = await this.readRepositoryJson(accessToken, fullName, 'actions/workflows?per_page=1');
    if (typeof workflows.total_count !== 'number' || workflows.total_count < 0)
      throw new Error('GitHub workflow count is invalid');
    if (workflows.total_count === 0) return true;
    // Workflows may not have created suites when the worker finishes its turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
    const [suites, runs] = await Promise.all([
      this.readRepositoryJson(accessToken, fullName, `commits/${headSha}/check-suites?per_page=1`),
      this.readRepositoryJson(accessToken, fullName, `actions/runs?head_sha=${headSha}&per_page=1`),
    ]);
    return suites.total_count === 0 && runs.total_count === 0;
  }

  /** A completed Actions job's log is available before its workflow run finishes. */
  async readJobLog(accessToken: string, fullName: string, jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error('invalid GitHub job id');
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/actions/jobs/${jobId}/logs`,
      { headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new GitHubHttpError('GitHub job log', response.status, responseRetryAfter(response));
    return response.text();
  }

  private async readRepositoryJson(
    accessToken: string,
    fullName: string,
    path: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/${path}`,
      {
        headers: githubHeaders(accessToken),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      // Only retain bounded diagnostic fields, never the raw response or auth headers.
      const diagnostic = (value: unknown): string | undefined => typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || undefined
        : undefined;
      const details: string[] = [];
      let providerMessage: unknown;
      try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          providerMessage = (body as { message?: unknown }).message;
          const message = diagnostic(providerMessage);
          if (message) details.push(message);
        }
      } catch {
        // A non-JSON refusal must still preserve the HTTP status and retry headers.
      }
      const requestId = diagnostic(response.headers.get('x-github-request-id'));
      const permissions = diagnostic(response.headers.get('x-accepted-github-permissions'));
      if (requestId) details.push(`request ID: ${requestId}`);
      if (permissions) details.push(`accepted permissions: ${permissions}`);
      const checkPermission = path.startsWith('actions/runs?') ? 'actions=read'
        : /^commits\/[a-f0-9]{40,64}\/check-suites\?/.test(path) ? 'checks=read' : undefined;
      const ErrorType = response.status === 403 && providerMessage === 'Resource not accessible by integration' &&
        checkPermission && permissions?.split(/[;,]/).some(value => value.trim() === checkPermission)
        ? GitHubCheckPermissionError : GitHubRequestError;
      throw new ErrorType(
        `GitHub PR checks GET /repos/${repositoryPath(fullName)}/${path}`,
        response.status, details.join('; ') || undefined, responseRetryAfter(response),
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }

  /** Read live repository and branch protection before destructive cleanup. */
  async branchDeletionSafety(accessToken: string, fullName: string, branch: string) {
    const response = await this.request(`${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}`, {
      headers: githubHeaders(accessToken), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GitHubHttpError('GitHub repository', response.status, responseRetryAfter(response));
    const repository = await response.json() as { default_branch?: unknown };
    if (typeof repository.default_branch !== 'string') throw new Error('GitHub default branch is missing');
    let details: Record<string, unknown>;
    try {
      details = await this.readRepositoryJson(accessToken, fullName, `branches/${encodeURIComponent(branch)}`);
    } catch (error) {
      if (error instanceof GitHubHttpError && (error.status === 404 || error.status === 422)) return undefined;
      throw error;
    }
    if (typeof details.protected !== 'boolean') throw new Error('GitHub branch protection is missing');
    const pulls = await this.readRepositoryJson(accessToken, fullName,
      `pulls?state=open&base=${encodeURIComponent(branch)}&per_page=1`);
    if (!Array.isArray(pulls)) throw new Error('GitHub branch pull requests are invalid');
    const comparison = await this.readRepositoryJson(accessToken, fullName,
      `compare/${encodeURIComponent(repository.default_branch)}...${encodeURIComponent(branch)}?per_page=1`);
    if (!Number.isSafeInteger(comparison.ahead_by) || Number(comparison.ahead_by) < 0)
      throw new Error('GitHub branch commit comparison is missing');
    return { defaultBranch: repository.default_branch, protected: details.protected,
      openBasePullRequest: pulls.length > 0, aheadBy: Number(comparison.ahead_by) };
  }

  /** Delete one installation-scoped branch after its corner has been archived. */
  async deleteBranch(
    installationId: number,
    repositoryId: number,
    fullName: string,
    branch: string,
  ): Promise<void> {
    const token = await this.installationToken(installationId, {
      repositoryIds: [repositoryId],
      permissions: { contents: 'write' },
    });
    const repositoryPath = fullName
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const branchPath = branch
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath}/git/refs/heads/${branchPath}`,
      { method: 'DELETE', headers: githubHeaders(token.token), signal: AbortSignal.timeout(15_000) },
    );
    // A 404 means GitHub's delete-on-merge setting already removed the ref.
    if (!response.ok && response.status !== 404 && response.status !== 422) {
      throw new GitHubHttpError('GitHub branch deletion', response.status);
    }
  }

  /** Read the provider's queue entry, including the combined commit under test. */
  async readPullRequestQueue(accessToken: string, fullName: string, number: number) {
    const [owner, name] = fullName.split('/');
    const data = await this.queueGraphql(accessToken, `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid
        mergeQueueEntry{id headCommit{oid}}
      }}
    }`, { owner, name, number });
    const repository = data.repository as Record<string, unknown> | undefined;
    const pr = repository?.pullRequest as {
      id?: string; headRefOid?: string; mergeQueueEntry?: { id: string; headCommit?: { oid: string } } | null;
    } | undefined;
    if (!pr?.id || !pr.headRefOid || !('mergeQueueEntry' in pr))
      throw new Error('GitHub queue read returned no pull request or queue state');
    return { id: pr.id, headSha: pr.headRefOid, entry: pr.mergeQueueEntry ?? null };
  }

  private async queueGraphql(token: string, query: string, variables: Record<string, unknown>, label = 'GitHub merge queue') {
    const response = await this.request(`${this.#config.apiBaseUrl}/graphql`, {
      method: 'POST', headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000), body: JSON.stringify({ query, variables }),
    });
    const body = await jsonObject(response, label);
    if (Array.isArray(body.errors) && body.errors.length) throw new Error(`${label} returned errors`);
    if (!body.data || typeof body.data !== 'object') throw new Error(`${label} returned no data`);
    return body.data as Record<string, unknown>;
  }

  async dequeuePullRequest(accessToken: string, id: string): Promise<void> {
    await this.queueGraphql(accessToken, `mutation($id:ID!){dequeuePullRequest(input:{pullRequestId:$id}){clientMutationId}}`, { id });
  }

  /** Squash-merge one PR using an exact-repository installation grant. */
  async mergePullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    pullRequestNumber: number,
    expectedHeadSha: string,
  ): Promise<'queued' | void> {
    const token = await this.installationToken(installationId, {
      repositoryIds: [repositoryId],
      // A squash that rewrites a workflow file needs workflows write, even when
      // the PR's own diff only matches what main already had.
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
    });
    const pr = await this.readPullRequest(token.token, fullName, pullRequestNumber);
    if (pr.headSha !== expectedHeadSha || !pr.baseRef) throw new Error('GitHub merge target moved');
    const [owner, name] = fullName.split('/');
    const configuration = await this.queueGraphql(token.token, `query($owner:String!,$name:String!,$branch:String!){
      repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}
    }`, { owner, name, branch: pr.baseRef });
    const repository = configuration.repository as { mergeQueue?: { id: string } | null } | undefined;
    if (!repository || !('mergeQueue' in repository)) throw new Error('GitHub queue configuration unavailable');
    if (repository.mergeQueue) {
      const queue = await this.readPullRequestQueue(token.token, fullName, pullRequestNumber);
      if (queue.headSha !== expectedHeadSha) throw new Error('GitHub queue target moved');
      if (!queue.entry) {
        try {
          await this.queueGraphql(token.token, `mutation($id:ID!,$head:GitObjectID!){
            enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id}}
          }`, { id: queue.id, head: expectedHeadSha });
        } catch (error) {
          // A lost response can conceal an accepted enqueue. Recovery must
          // inspect GitHub before releasing the exact-head merge claim.
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { queueAttempted: true });
        }
      }
      return 'queued';
    }
    const encodedRepositoryPath = fullName
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${encodedRepositoryPath}/pulls/${pullRequestNumber}/merge`,
      {
        method: 'PUT',
        headers: { ...githubHeaders(token.token), 'content-type': 'application/json' },
        body: JSON.stringify({ merge_method: 'squash', sha: expectedHeadSha }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      let reason = '';
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === 'string') reason = `: ${body.message}`;
      } catch {}
      const error = new GitHubHttpError('GitHub pull request merge', response.status);
      error.message += reason;
      throw Object.assign(error, { mergeAttempted: true });
    }
  }

  /** Close one PR without merging; its branch and commits stay on GitHub. */
  async closePullRequest(
    installationId: number,
    repositoryId: number,
    fullName: string,
    pullRequestNumber: number,
  ): Promise<void> {
    const token = await this.installationToken(installationId, {
      repositoryIds: [repositoryId],
      permissions: { pull_requests: 'write' },
    });
    const current = await this.readRepositoryJson(token.token, fullName, `pulls/${pullRequestNumber}`);
    if (current.merged === true) throw new Error('The pull request is already merged');
    if (current.state === 'closed') return;
    const head = current.head as { ref?: unknown } | undefined;
    if (current.state !== 'open' || typeof head?.ref !== 'string')
      throw new Error('GitHub pull request state or branch is missing');
    const dependents = await this.readRepositoryJson(token.token, fullName,
      `pulls?state=open&base=${encodeURIComponent(head.ref)}&per_page=1`);
    if (!Array.isArray(dependents)) throw new Error('GitHub dependent pull requests are invalid');
    if (dependents.length) throw new Error('The pull request branch is the base of an open pull request');
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/pulls/${pullRequestNumber}`,
      {
        method: 'PATCH',
        headers: { ...githubHeaders(token.token), 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      let reason = '';
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === 'string') reason = `: ${body.message}`;
      } catch {}
      throw new Error(`GitHub pull request close failed: HTTP ${response.status}${reason}`);
    }
  }

  /**
   * One Issues REST call on `fullName` (the feedback loop's filing path).
   * `path` is relative to the repository, e.g. `issues` or
   * `issues/comments/7`. A refusal carries GitHub's own `message` so the
   * caller can hand the reason back unchanged.
   */
  async issuesRequest(
    accessToken: string,
    fullName: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.request(
      `${this.#config.apiBaseUrl}/repos/${repositoryPath(fullName)}/${path}`,
      {
        method,
        headers: {
          ...githubHeaders(accessToken),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : undefined;
      throw new GitHubRequestError('GitHub issues', response.status, message);
    }
    return parsed;
  }

  #installationAccountFrom(body: Record<string, unknown>): GitHubInstallationAccount {
    const account = body.account;
    const accountRecord =
      account && typeof account === 'object' && !Array.isArray(account)
        ? (account as Record<string, unknown>)
        : undefined;
    const id = accountRecord?.id;
    const login = accountRecord?.login;
    const type = accountRecord?.type;
    const avatarUrl = accountRecord?.avatar_url;
    const repositorySelection = body.repository_selection;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('GitHub installation account is invalid');
    }
    if (
      typeof login !== 'string' ||
      !login ||
      (type !== 'User' && type !== 'Organization') ||
      (repositorySelection !== 'all' && repositorySelection !== 'selected')
    ) {
      throw new Error('GitHub installation account is invalid');
    }
    return {
      id: String(id),
      login,
      type,
      ...(typeof avatarUrl === 'string' && avatarUrl ? { avatarUrl } : {}),
      repositorySelection,
    };
  }

  async installationAccount(installationId: number): Promise<GitHubInstallationAccount> {
    const body = await jsonObject(
      await this.request(`${this.#config.apiBaseUrl}/app/installations/${installationId}`, {
        headers: githubHeaders(await this.appJwt()),
      }),
      'GitHub installation lookup',
    );
    return this.#installationAccountFrom(body);
  }

  /**
   * Every installation of THIS App, authenticated by the App JWT alone.
   *
   * GET /user/installations is keyed to one OAuth token's visibility and is
   * blind to organization installations; the App's own credential sees them
   * all, so server-side reconciliation can discover an install whose callback
   * never persisted without asking the owner to re-run the flow.
   */
  async listInstallations(): Promise<GitHubAppInstallation[]> {
    const installations: GitHubAppInstallation[] = [];
    for (let page = 1; ; page++) {
      // GitHub answers this endpoint with a BARE array of installations —
      // unlike GET /user/installations' {total_count, installations} envelope.
      const entries = await jsonArray(
        await this.request(`${this.#config.apiBaseUrl}/app/installations?per_page=100&page=${page}`, {
          headers: githubHeaders(await this.appJwt()),
        }),
        'GitHub app installation list',
      );
      for (const record of entries) {
        // A suspended installation must never be re-recorded as active.
        if (record.suspended_at) continue;
        const id = record.id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
          throw new Error('GitHub app installation entry is invalid');
        }
        installations.push({ installationId: id, account: this.#installationAccountFrom(record) });
      }
      if (entries.length < 100) return installations;
    }
  }

  /** Compatibility helper for older callers. */
  async installationAccountId(installationId: number): Promise<string> {
    return (await this.installationAccount(installationId)).id;
  }

  async listRepositories(installationId: number): Promise<GitHubInstallationRepository[]> {
    const installation = await this.installationToken(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await this.request(
          `${this.#config.apiBaseUrl}/installation/repositories?per_page=100&page=${page}`,
          { headers: githubHeaders(installation.token) },
        ),
        'GitHub installation repositories',
      );
      if (!Array.isArray(body.repositories)) throw new Error('GitHub repository list is invalid');
      const parsed = body.repositories.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('GitHub repository entry is invalid');
        }
        const repo = entry as Record<string, unknown>;
        const id = typeof repo.id === 'number' ? repo.id : NaN;
        const name = typeof repo.name === 'string' ? repo.name : '';
        const fullName = typeof repo.full_name === 'string' ? repo.full_name : '';
        const remote = typeof repo.clone_url === 'string' ? repo.clone_url : '';
        const defaultBranch = typeof repo.default_branch === 'string' ? repo.default_branch : '';
        if (!Number.isSafeInteger(id) || !name || !fullName || !remote || !defaultBranch) {
          throw new Error('GitHub repository entry is invalid');
        }
        return {
          id,
          installationId,
          name,
          fullName,
          remote,
          defaultBranch,
          private: repo.private !== false,
          allowAutoMerge: repo.allow_auto_merge === true,
        };
      });
      repositories.push(...parsed);
      if (body.repositories.length < 100) return repositories;
    }
  }

  async createRepository(
    installationId: number,
    account: Pick<GitHubInstallationAccount, 'login' | 'type'>,
    input: { name: string; description?: string; private?: boolean },
    userAccessToken?: string,
  ): Promise<GitHubInstallationRepository> {
    const token =
      account.type === 'User'
        ? userAccessToken
        : (await this.installationToken(installationId)).token;
    if (!token)
      throw new Error('GitHub user authorization is required to create a personal repository');
    const path =
      account.type === 'Organization'
        ? `/orgs/${encodeURIComponent(account.login)}/repos`
        : '/user/repos';
    let body: Record<string, unknown>;
    try {
      body = await jsonObject(
        await this.request(`${this.#config.apiBaseUrl}${path}`, {
          method: 'POST',
          headers: { ...githubHeaders(token), 'content-type': 'application/json' },
          // GitHub creates README.md and the default-branch first commit in the
          // same repository creation request. The Room can then fetch main on
          // its first start, including for a selected installation account.
          body: JSON.stringify({ ...input, auto_init: true }),
        }),
        'GitHub repository creation',
      );
    } catch (error) {
      if (error instanceof ExternalServiceTimeoutError)
        throw new ExternalServiceTimeoutError(
          'GitHub did not finish responding. The repository may have been created. The result is unknown; refresh to check before retrying.',
        );
      throw error;
    }
    const id = body.id;
    const name = body.name;
    const fullName = body.full_name;
    const remote = body.clone_url;
    const defaultBranch = body.default_branch;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      typeof name !== 'string' ||
      typeof fullName !== 'string' ||
      typeof remote !== 'string' ||
      typeof defaultBranch !== 'string'
    ) {
      throw new Error('GitHub repository creation response is invalid');
    }
    return {
      id,
      installationId,
      name,
      fullName,
      remote,
      defaultBranch,
      private: body.private !== false,
      allowAutoMerge: body.allow_auto_merge === true,
    };
  }

  async userCanAccessInstallation(accessToken: string, installationId: number): Promise<boolean> {
    return (await this.userInstallationIds(accessToken, installationId)).targetFound;
  }

  /**
   * Follow GitHub's rename/transfer redirect for a repository address. A moved
   * repository answers GET /repos/{old} with a 301 and describes the NEW
   * location in the body, so this resolves a stale owner/name to the current
   * one without any stored state. Undefined when GitHub has no such repository
   * (or the lookup fails); never throws.
   *
   * LIMITATION: GitHub only issues that redirect to viewers already able to
   * see the repository at its new location, and the App JWT alone reads
   * public repositories. A PRIVATE repo transferred to an account whose
   * installation is not (yet) recorded therefore comes back undefined here —
   * `movedTo` stays unknown and callers must rely on installation
   * reconciliation plus immutable-id healing instead of redirect following.
   */
  async repositoryByFullName(
    fullName: string,
  ): Promise<{ id: number; fullName: string } | undefined> {
    const [owner, repository] = fullName.split('/');
    if (!owner || !repository) return undefined;
    try {
      const body = await jsonObject(
        await this.request(
          `${this.#config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository.replace(/\.git$/i, ''))}`,
          { headers: githubHeaders(await this.appJwt()), redirect: 'follow' },
        ),
        'GitHub repository lookup',
      );
      const id = body.id;
      const currentFullName = body.full_name;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
      if (typeof currentFullName !== 'string' || !currentFullName.includes('/')) return undefined;
      return { id, fullName: currentFullName };
    } catch {
      return undefined;
    }
  }

  async listUserInstallationIds(accessToken: string): Promise<number[]> {
    return (await this.userInstallationIds(accessToken)).installationIds;
  }

  /** A linked installation may change owners only with an explicit admin grant. */
  async organizationAdmin(accessToken: string, organization: string): Promise<boolean> {
    const response = await this.request(`${this.#config.apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(organization)}`,
      { headers: githubHeaders(accessToken) });
    if (!response.ok) return false;
    const body = await response.json() as Record<string, unknown>;
    return body.state === 'active' && body.role === 'admin';
  }

  /**
   * What a user's own token can prove about their membership in `organization`.
   *
   * GET /user/memberships/orgs/{org} describes the AUTHENTICATED user only, so
   * it answers the one question the installation listing leaves open: an
   * organization installation missing from GET /user/installations may belong
   * to an org this user is plainly a member of, and membership is the fallback
   * that lets reconciliation claim it (see the caller in server-context.ts).
   *
   * Deliberately total and non-throwing. GitHub answers 404 for a non-member,
   * which is a DEFINITIVE no; every other failure (403 when the App's user
   * token is not allowed to read memberships, a 5xx, a network error) is
   * 'unknown' so callers fall back to their prior behaviour instead of
   * inventing either a claim or a refusal. That matters because the App
   * manifest deliberately requests NO organization permissions — this endpoint
   * may simply be closed to the token, and the fallback must degrade quietly.
   */
  async organizationMembership(
    accessToken: string,
    organization: string,
  ): Promise<GitHubOrganizationMembership> {
    let response: Response;
    try {
      response = await this.request(
        `${this.#config.apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(organization)}`,
        { headers: githubHeaders(accessToken) },
      );
    } catch {
      return 'unknown';
    }
    if (response.status === 404) return 'none';
    if (!response.ok) return 'unknown';
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof ExternalServiceTimeoutError) throw error;
      return 'unknown';
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
    const state = (body as Record<string, unknown>).state;
    if (state === 'active') return 'active';
    // 'pending' is an unaccepted invitation: a real answer, but not membership.
    return state === 'pending' ? 'pending' : 'unknown';
  }

  /**
   * Whether the authenticated user has starred `owner/repo`
   * (GET /user/starred/{owner}/{repo}). 204 is yes and 404 is no. Anything
   * else, including 403 for a token without the Starring permission, is
   * 'unknown'. Never throws.
   */
  async repositoryStarred(accessToken: string, fullName: string): Promise<boolean | 'unknown'> {
    let response: Response;
    try {
      response = await this.request(`${this.#config.apiBaseUrl}/user/starred/${fullName}`, {
        headers: githubHeaders(accessToken),
      });
    } catch {
      return 'unknown';
    }
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    return 'unknown';
  }

  /**
   * Star `owner/repo` as the authenticated user (PUT /user/starred/{owner}/{repo}).
   * Returns false when GitHub refuses, e.g. a 403 for a user token whose App
   * install has not approved the Starring permission yet. Never throws.
   */
  async starRepository(accessToken: string, fullName: string): Promise<boolean> {
    try {
      const response = await this.request(`${this.#config.apiBaseUrl}/user/starred/${fullName}`, {
        method: 'PUT',
        headers: { ...githubHeaders(accessToken), 'content-length': '0' },
      });
      return response.status === 204;
    } catch {
      return false;
    }
  }

  private async userInstallationIds(
    accessToken: string,
    targetId?: number,
  ): Promise<{ installationIds: number[]; targetFound: boolean }> {
    const installationIds: number[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await this.request(`${this.#config.apiBaseUrl}/user/installations?per_page=100&page=${page}`, {
          headers: githubHeaders(accessToken),
        }),
        'GitHub user installations',
      );
      if (!Array.isArray(body.installations))
        throw new Error('GitHub user installation list is invalid');
      for (const entry of body.installations) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('GitHub user installation entry is invalid');
        }
        const id = (entry as Record<string, unknown>).id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
          throw new Error('GitHub user installation entry is invalid');
        }
        installationIds.push(id);
      }
      if (targetId !== undefined && installationIds.includes(targetId)) {
        return { installationIds, targetFound: true };
      }
      if (body.installations.length < 100) {
        return { installationIds: [...new Set(installationIds)], targetFound: false };
      }
    }
  }
}
