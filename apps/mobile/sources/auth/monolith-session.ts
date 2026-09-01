import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

const REFRESH_KEY = 'buzzy.monolith.refresh.v1';
const IDENTITY_KEY = 'buzzy.monolith.identity.v1';

async function secureStore() {
  return import('expo-secure-store');
}

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

export class MonolithSession {
  private access?: { token: string; expiresAt: number; identityId: string };
  private refreshInFlight?: Promise<string>;

  constructor(
    private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async exchangeGitHubTicket(ticket: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcToken: ticket }),
    });
    if (!response.ok) throw new MonolithSessionRequiredError();
    const tokens = (await response.json()) as MonolithTokens;
    await this.accept(tokens);
    return tokens.identityId;
  }

  async identityId(): Promise<string | null> {
    return this.access?.identityId ?? (await secureStore()).getItemAsync(IDENTITY_KEY);
  }

  async clear(): Promise<void> {
    this.access = undefined;
    const storage = await secureStore();
    await Promise.all([
      storage.deleteItemAsync(REFRESH_KEY),
      storage.deleteItemAsync(IDENTITY_KEY),
    ]);
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
    const refreshToken = await (await secureStore()).getItemAsync(REFRESH_KEY);
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

  private async accept(tokens: MonolithTokens): Promise<void> {
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.identityId)
      throw new Error('Invalid monolith session response');
    const storage = await secureStore();
    await Promise.all([
      storage.setItemAsync(REFRESH_KEY, tokens.refreshToken),
      storage.setItemAsync(IDENTITY_KEY, tokens.identityId),
    ]);
    this.access = {
      token: tokens.accessToken,
      expiresAt: tokens.accessExpiresAt,
      identityId: tokens.identityId,
    };
  }
}

export const monolithSession = new MonolithSession();
