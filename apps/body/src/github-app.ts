import { importPKCS8, SignJWT } from 'jose';
import { gitWithInstallationToken, type GitResult } from '@beeline/gate';
import type { RepositoryBinding } from '@beeline/buzz-client';
import type { RemoteRepositoryIdentity } from './repository-truth.js';

const API_VERSION = '2022-11-28';

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface GitHubAppRuntimeConfig {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  now?: () => number;
}

function githubRepository(remote: string | undefined): { owner: string; repo: string } | undefined {
  const match = remote?.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** Daemon-only GitHub App authority. It never reads gh or git credential state. */
export class GitHubAppRuntime {
  readonly #config: Required<Omit<GitHubAppRuntimeConfig, 'now'>>;
  readonly #now: () => number;
  readonly #tokens = new Map<number, CachedToken>();

  constructor(config: GitHubAppRuntimeConfig) {
    if (!/^\d+$/.test(config.appId) || !config.privateKey.trim()) {
      throw new Error('BUZZY_GITHUB_APP_ID and BUZZY_GITHUB_APP_PRIVATE_KEY are required');
    }
    this.#config = {
      appId: config.appId,
      privateKey: config.privateKey.replace(/\\n/g, '\n'),
      apiBaseUrl: config.apiBaseUrl ?? 'https://api.github.com',
    };
    this.#now = config.now ?? Date.now;
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): GitHubAppRuntime | undefined {
    const appId = env.BUZZY_GITHUB_APP_ID?.trim();
    const privateKey = env.BUZZY_GITHUB_APP_PRIVATE_KEY?.trim();
    return appId && privateKey ? new GitHubAppRuntime({ appId, privateKey }) : undefined;
  }

  private async appJwt(): Promise<string> {
    const key = await importPKCS8(this.#config.privateKey, 'RS256');
    const now = Math.floor(this.#now() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(this.#config.appId)
      .sign(key);
  }

  private async request(
    path: string,
    token: string,
    method = 'GET',
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.#config.apiBaseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'beeline-body',
      },
    });
    const body = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;
    if (!response.ok || !body)
      throw new Error(`GitHub App request failed: HTTP ${response.status}`);
    return body;
  }

  async installationToken(installationId: number): Promise<string> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error('repository has no valid GitHub App installation id');
    }
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - this.#now() > 5 * 60_000) return cached.token;
    const body = await this.request(
      `/app/installations/${installationId}/access_tokens`,
      await this.appJwt(),
      'POST',
    );
    const token = typeof body.token === 'string' ? body.token : '';
    const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
    if (!token || !Number.isFinite(expiresAt))
      throw new Error('GitHub installation token response is invalid');
    this.#tokens.set(installationId, { token, expiresAt });
    return token;
  }

  async installationForRepository(owner: string, repo: string): Promise<number> {
    const body = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      await this.appJwt(),
    );
    const id = typeof body.id === 'number' ? body.id : NaN;
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error('GitHub installation lookup is invalid');
    return id;
  }

  async resolveIdentity(binding: RepositoryBinding): Promise<RemoteRepositoryIdentity | undefined> {
    const repository = githubRepository(binding.remote);
    if (!repository) return undefined;
    const installationId =
      binding.githubInstallationId ??
      (await this.installationForRepository(repository.owner, repository.repo));
    const token = await this.installationToken(installationId);
    const body = await this.request(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
      token,
    );
    const fullName = typeof body.full_name === 'string' ? body.full_name : '';
    const cloneUrl = typeof body.clone_url === 'string' ? body.clone_url : '';
    const parts = fullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !cloneUrl) return undefined;
    return {
      name: fullName,
      remote: `git://github.com/${parts[0]}/${parts[1]}`,
      cloneUrl,
    };
  }

  async git(cwd: string, args: string[], binding: RepositoryBinding): Promise<GitResult> {
    const repository = githubRepository(binding.remote);
    if (!repository) throw new Error('installation-token git requires a GitHub repository');
    const installationId =
      binding.githubInstallationId ??
      (await this.installationForRepository(repository.owner, repository.repo));
    return gitWithInstallationToken(cwd, await this.installationToken(installationId), args);
  }
}
