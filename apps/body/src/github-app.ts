import { importPKCS8, SignJWT } from 'jose';
import { gitWithInstallationToken, type GitResult } from '@beeline/gate';
import {
  getGitHubRoomInstallationToken,
  type Identity,
  type RepositoryBinding,
} from '@beeline/buzz-client';
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

export interface GitHubTokenBrokerConfig {
  baseUrl: string;
  identity: Pick<Identity, 'secretKey' | 'publicKey'>;
}

function githubRepository(remote: string | undefined): { owner: string; repo: string } | undefined {
  const match = remote?.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** GitHub repository credentials without ambient gh/git credential state. */
export class GitHubAppRuntime {
  #config?: Required<Omit<GitHubAppRuntimeConfig, 'now'>>;
  #broker?: GitHubTokenBrokerConfig;
  readonly #now: () => number;
  readonly #tokens = new Map<number, CachedToken>();
  readonly #brokerTokens = new Map<
    string,
    CachedToken & { installationId: number; fullName: string }
  >();

  constructor(config: GitHubAppRuntimeConfig | GitHubTokenBrokerConfig) {
    if ('identity' in config) {
      this.#broker = config;
      this.#now = Date.now;
      return;
    }
    if (!/^\d+$/.test(config.appId) || !config.privateKey.trim()) {
      throw new Error('BEELINE_GITHUB_APP_ID and BEELINE_GITHUB_APP_PRIVATE_KEY are required');
    }
    this.#config = {
      appId: config.appId,
      privateKey: config.privateKey.replace(/\\n/g, '\n'),
      apiBaseUrl: config.apiBaseUrl ?? 'https://api.github.com',
    };
    this.#now = config.now ?? Date.now;
  }

  static fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    broker?: GitHubTokenBrokerConfig,
  ): GitHubAppRuntime | undefined {
    // Shipped daemons always use the broker. App credentials may still exist
    // in development/live-test environments, but they are never preferred on
    // an end-user runtime when the auth-service path is available.
    if (broker) return new GitHubAppRuntime(broker);
    const appId = env.BEELINE_GITHUB_APP_ID?.trim();
    const privateKey = env.BEELINE_GITHUB_APP_PRIVATE_KEY?.trim();
    if (appId && privateKey) return new GitHubAppRuntime({ appId, privateKey });
    return undefined;
  }

  private async appJwt(): Promise<string> {
    if (!this.#config) throw new Error('GitHub App private key is not configured');
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
    const response = await fetch(`${this.#config?.apiBaseUrl ?? 'https://api.github.com'}${path}`, {
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
    if (!this.#config) throw new Error('installation token requires a Room repository');
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
    if (!this.#config) throw new Error('installation lookup requires a Room repository');
    const body = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      await this.appJwt(),
    );
    const id = typeof body.id === 'number' ? body.id : NaN;
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error('GitHub installation lookup is invalid');
    return id;
  }

  private async repositoryToken(
    binding: RepositoryBinding,
    roomId?: string,
  ): Promise<{ token: string; installationId: number; fullName: string }> {
    const repository = githubRepository(binding.remote);
    if (!repository) throw new Error('installation-token git requires a GitHub repository');
    if (this.#config) {
      const installationId =
        binding.githubInstallationId ??
        (await this.installationForRepository(repository.owner, repository.repo));
      return {
        token: await this.installationToken(installationId),
        installationId,
        fullName: `${repository.owner}/${repository.repo}`,
      };
    }
    if (!this.#broker || !roomId) {
      throw new Error('GitHub repository access requires a Room-scoped installation token');
    }
    const cacheKey = `${roomId}:${binding.remote?.toLowerCase() ?? ''}`;
    const cached = this.#brokerTokens.get(cacheKey);
    if (cached && cached.expiresAt - this.#now() > 5 * 60_000) {
      return {
        token: cached.token,
        installationId: cached.installationId,
        fullName: cached.fullName,
      };
    }
    const granted = await getGitHubRoomInstallationToken(
      this.#broker.baseUrl,
      this.#broker.identity,
      roomId,
    );
    const requested = `${repository.owner}/${repository.repo}`;
    if (granted.fullName.toLowerCase() !== requested.toLowerCase()) {
      throw new Error('auth service granted a different Room repository');
    }
    this.#brokerTokens.set(cacheKey, {
      token: granted.token,
      expiresAt: Date.parse(granted.expiresAt),
      installationId: granted.installationId,
      fullName: granted.fullName,
    });
    return {
      token: granted.token,
      installationId: granted.installationId,
      fullName: granted.fullName,
    };
  }

  async repositoryInstallationToken(binding: RepositoryBinding, roomId?: string): Promise<string> {
    return (await this.repositoryToken(binding, roomId)).token;
  }

  async resolveIdentity(
    binding: RepositoryBinding,
    roomId?: string,
  ): Promise<RemoteRepositoryIdentity | undefined> {
    const repository = githubRepository(binding.remote);
    if (!repository) return undefined;
    const { token } = await this.repositoryToken(binding, roomId);
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

  async git(
    cwd: string,
    args: string[],
    binding: RepositoryBinding,
    roomId?: string,
  ): Promise<GitResult> {
    const repository = githubRepository(binding.remote);
    if (!repository) throw new Error('installation-token git requires a GitHub repository');
    return gitWithInstallationToken(
      cwd,
      await this.repositoryInstallationToken(binding, roomId),
      args,
    );
  }
}
