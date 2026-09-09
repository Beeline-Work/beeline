import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { monolithSecureStorage, type MonolithSecureStorage } from '@/auth/monolith-secure-storage';

const REFRESH_KEY = 'buzzy.monolith.refresh.v1';
const IDENTITY_KEY = 'buzzy.monolith.identity.v1';

export interface MonolithTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  identityId: string;
}

export class MonolithSessionRequiredError extends Error {
  constructor() {
    super('GitHub sign-in is required');
    this.name = 'MonolithSessionRequiredError';
  }
}

export class GitHubAccountMismatchError extends Error {
  constructor() {
    super('Reconnect the GitHub account already linked to this identity.');
  }
}

export class MonolithSession {
  private readonly identityListeners = new Set<() => void>();
  private access?: { token: string; expiresAt: number; identityId: string };
  private refreshInFlight?: Promise<string>;

  constructor(
    private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly secureStorage: () => Promise<MonolithSecureStorage> = monolithSecureStorage,
  ) {}

  async exchangeGitHubTicket(ticket: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: ticket }),
    });
    if (!response.ok) throw new MonolithSessionRequiredError();
    const tokens = (await response.json()) as MonolithTokens;
    await this.accept(tokens, true);
    return tokens.identityId;
  }

  async reconnectGitHubTicket(ticket: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/github/reconnect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.authorization()}`,
      },
      body: JSON.stringify({ oidcToken: ticket }),
    });
    if (response.status === 409) throw new GitHubAccountMismatchError();
    if (!response.ok) throw new Error('Could not reconnect GitHub. Try again.');
  }

  /**
   * Sign in as the fixed Google Play review identity. The same session a GitHub
   * ticket issues — the reviewer gets the ordinary app, not a special mode. The
   * server is the only judge of the secret: anything but a real one is a 404,
   * which surfaces here as the ordinary "sign in" requirement.
   */
  async exchangeReviewSecret(secret: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/review/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!response.ok) throw new MonolithSessionRequiredError();
    const tokens = (await response.json()) as MonolithTokens;
    await this.accept(tokens, true);
    return tokens.identityId;
  }

  async identityId(): Promise<string | null> {
    return this.access?.identityId ?? (await this.secureStorage()).getItemAsync(IDENTITY_KEY);
  }

  /** Session consumers must observe sign-in after the root layout has mounted. */
  subscribeIdentityChange(listener: () => void): () => void {
    this.identityListeners.add(listener);
    return () => {
      this.identityListeners.delete(listener);
    };
  }

  private identityChanged(): void {
    for (const listener of this.identityListeners) {
      try {
        listener();
      } catch {
        // Optional consumers cannot turn an accepted sign-in into a failure.
      }
    }
  }

  async clear(): Promise<void> {
    this.access = undefined;
    const storage = await this.secureStorage();
    await Promise.all([
      storage.deleteItemAsync(REFRESH_KEY),
      storage.deleteItemAsync(IDENTITY_KEY),
    ]);
    this.identityChanged();
  }

  async authorization(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 30_000) return this.access.token;
    return this.refresh();
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const perform = async () =>
      this.fetchImpl(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${await this.authorization()}`,
        },
      });
    let response = await perform();
    if (response.status !== 401) return response;
    this.access = undefined;
    response = await perform();
    return response;
  }

  private refresh(): Promise<string> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<string> {
    const refreshToken = await (await this.secureStorage()).getItemAsync(REFRESH_KEY);
    if (!refreshToken) throw new MonolithSessionRequiredError();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      await this.clear();
      throw new MonolithSessionRequiredError();
    }
    const tokens = (await response.json()) as MonolithTokens;
    await this.accept(tokens);
    return tokens.accessToken;
  }

  private async accept(tokens: MonolithTokens, signedIn = false): Promise<void> {
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.identityId)
      throw new Error('Invalid monolith session response');
    const storage = await this.secureStorage();
    const previousId = this.access?.identityId ?? (await storage.getItemAsync(IDENTITY_KEY));
    await Promise.all([
      storage.setItemAsync(REFRESH_KEY, tokens.refreshToken),
      storage.setItemAsync(IDENTITY_KEY, tokens.identityId),
    ]);
    this.access = {
      token: tokens.accessToken,
      expiresAt: tokens.accessExpiresAt,
      identityId: tokens.identityId,
    };
    // A new sign-in may repair an expired session for the same identity.
    // Token refresh alone must not start another registration/refresh loop.
    if (signedIn || previousId !== tokens.identityId) this.identityChanged();
  }
}

export const monolithSession = new MonolithSession();
