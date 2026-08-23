import { importPKCS8, SignJWT } from 'jose';

const GITHUB_ISSUER = 'https://github.com';
const DEFAULT_API = 'https://api.github.com';

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'beeline-auth',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function jsonObject(response: Response, label: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
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
  /** Server-side credential used to prove installation membership and create personal repos. */
  accessToken: string;
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

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
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
    const tokenResponse = await fetch(this.config.tokenEndpoint, {
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
    const userBody = await jsonObject(
      await fetch(`${this.config.apiBaseUrl}/user`, {
        headers: githubHeaders(accessToken),
      }),
      'GitHub user lookup',
    );
    const id = typeof userBody.id === 'number' ? userBody.id : NaN;
    const login = typeof userBody.login === 'string' ? userBody.login : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !login)
      throw new Error('GitHub user response is invalid');
    return {
      issuer: GITHUB_ISSUER,
      audience: this.config.clientId,
      subject: String(id),
      login,
      accessToken,
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
}

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

  installationUrl(state: string): string {
    const url = new URL(`https://github.com/apps/${this.#config.slug}/installations/new`);
    url.searchParams.set('state', state);
    return url.toString();
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
    options: { repositoryIds?: readonly number[] } = {},
  ): Promise<GitHubInstallationToken> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('invalid GitHub installation id');
    }
    const body = await jsonObject(
      await fetch(`${this.#config.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          ...githubHeaders(await this.appJwt()),
          ...(options.repositoryIds?.length ? { 'content-type': 'application/json' } : {}),
        },
        ...(options.repositoryIds?.length
          ? { body: JSON.stringify({ repository_ids: options.repositoryIds }) }
          : {}),
      }),
      'GitHub installation token',
    );
    const token = typeof body.token === 'string' ? body.token : '';
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : '';
    if (!token || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('GitHub installation token response is invalid');
    }
    return { token, expiresAt };
  }

  async installationAccount(installationId: number): Promise<GitHubInstallationAccount> {
    const body = await jsonObject(
      await fetch(`${this.#config.apiBaseUrl}/app/installations/${installationId}`, {
        headers: githubHeaders(await this.appJwt()),
      }),
      'GitHub installation lookup',
    );
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

  /** Compatibility helper for older callers. */
  async installationAccountId(installationId: number): Promise<string> {
    return (await this.installationAccount(installationId)).id;
  }

  async listRepositories(installationId: number): Promise<GitHubInstallationRepository[]> {
    const installation = await this.installationToken(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await fetch(
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
        return { id, installationId, name, fullName, remote, defaultBranch };
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
    const body = await jsonObject(
      await fetch(`${this.#config.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { ...githubHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      'GitHub repository creation',
    );
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
    return { id, installationId, name, fullName, remote, defaultBranch };
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
   */
  async repositoryByFullName(
    fullName: string,
  ): Promise<{ id: number; fullName: string } | undefined> {
    const [owner, repository] = fullName.split('/');
    if (!owner || !repository) return undefined;
    try {
      const body = await jsonObject(
        await fetch(
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

  private async userInstallationIds(
    accessToken: string,
    targetId?: number,
  ): Promise<{ installationIds: number[]; targetFound: boolean }> {
    const installationIds: number[] = [];
    for (let page = 1; ; page++) {
      const body = await jsonObject(
        await fetch(`${this.#config.apiBaseUrl}/user/installations?per_page=100&page=${page}`, {
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
