import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { monolithSecureStorage, type MonolithSecureStorage } from '@/auth/monolith-secure-storage';
import { isDesktopShell } from '@/utils/isDesktopShell';

const REFRESH_KEY = 'buzzy.monolith.refresh.v1';
const IDENTITY_KEY = 'buzzy.monolith.identity.v1';
const ACCESS_KEY = 'buzzy.monolith.access.v1';

async function monolithFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktopShell()) return fetch(input, init);
  const { fetch: desktopFetch } = await import('@tauri-apps/plugin-http');
  return desktopFetch(input, init);
}

/** Monotonic timing of the winning HTTP attempt, ending when response headers arrive. */
const responseTimings = new WeakMap<Response, { requestStartMs: number; firstByteMs: number }>();

export function monolithResponseTiming(response: Response):
  { requestStartMs: number; firstByteMs: number } | null {
  return responseTimings.get(response) ?? null;
}

export interface MonolithTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  identityId: string;
}

/** Deadline for room/workspace reads; long uploads stay unbounded by default. */
export const MONOLITH_REQUEST_TIMEOUT_MS = 15_000;
/** Shorter than a read's deadline, so a read that waited on it can retry. */
const MONOLITH_REFRESH_TIMEOUT_MS = 10_000;
/**
 * A repeatable request still unanswered after this long is sent again on a
 * fresh connection, and whichever answers first is used. The server answers
 * a phone read in well under a second.
 */
export const MONOLITH_STALL_PROBE_MS = 4_000;

/**
 * Another origin for the same server, whose certificate the primary's does
 * not cover. React Native's Android HTTP client (OkHttp, configured with no
 * read timeout) keeps a pooled HTTP/2 connection that went silently dead (a
 * NAT mapping lost while the phone slept, a network change) and multiplexes
 * every later request onto it; aborting a request never evicts it. A request
 * to a host the pooled connection's certificate cannot serve must open a new
 * connection, so the alternate origin is the one path guaranteed fresh.
 */
const ALTERNATE_MONOLITH_ORIGINS: Readonly<Record<string, string>> = {
  'https://server.usebeeline.app': 'https://beeline-server.fly.dev',
};

export function monolithOrigins(baseUrl: string): readonly string[] {
  const alternate = ALTERNATE_MONOLITH_ORIGINS[baseUrl];
  return alternate ? [baseUrl, alternate] : [baseUrl];
}

export class MonolithRequestTimeoutError extends Error {
  constructor() {
    super('The server timed out before it responded.');
    this.name = 'MonolithRequestTimeoutError';
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('The request was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
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
  private refreshToken?: string;
  private refreshInFlight?: Promise<string>;
  private accessRestoreInFlight?: Promise<void>;
  private accessRestoreAttempted = false;
  private credentialRevision = 0;
  /** Each origin with when a request on it last went unanswered (0: never). */
  private readonly origins: { readonly origin: string; stalledAt: number }[];
  private currentOrigin = 0;

  constructor(
    private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl,
    private readonly fetchImpl: typeof fetch = monolithFetch,
    private readonly secureStorage: () => Promise<MonolithSecureStorage> = monolithSecureStorage,
    origins: readonly string[] = monolithOrigins(baseUrl),
  ) {
    this.origins = origins.map((origin) => ({ origin, stalledAt: 0 }));
  }

  /**
   * A request on the origin `input` names went unanswered past its deadline
   * (headers or body): the connection under it is presumed dead, so every
   * later request moves to another origin.
   */
  noteStalled(input: string): void {
    const index = this.origins.findIndex(({ origin }) => input.startsWith(origin));
    this.markStalled(index >= 0 ? index : this.currentOrigin);
  }

  private markStalled(index: number): void {
    this.origins[index]!.stalledAt = Date.now();
    if (index === this.currentOrigin) this.currentOrigin = this.freshestOther(index);
  }

  /** The other origin that stalled longest ago (or never); `index` when there is none. */
  private freshestOther(index: number): number {
    let best = index;
    for (let candidate = 0; candidate < this.origins.length; candidate += 1) {
      if (candidate === index) continue;
      if (best === index || this.origins[candidate]!.stalledAt < this.origins[best]!.stalledAt)
        best = candidate;
    }
    return best;
  }

  private onOrigin(input: string, index: number): string {
    return input.startsWith(this.baseUrl)
      ? `${this.origins[index]!.origin}${input.slice(this.baseUrl.length)}`
      : input;
  }

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
    this.credentialRevision += 1;
    this.access = undefined;
    this.refreshToken = undefined;
    this.accessRestoreAttempted = true;
    const storage = await this.secureStorage();
    await Promise.all([
      storage.deleteItemAsync(REFRESH_KEY),
      storage.deleteItemAsync(IDENTITY_KEY),
      storage.deleteItemAsync(ACCESS_KEY),
    ]);
    this.identityChanged();
  }

  async authorization(): Promise<string> {
    const current = this.validAccessToken();
    if (current) return current;
    if (!this.access) {
      if (!this.accessRestoreAttempted) this.accessRestoreInFlight ??= this.restoreAccess();
      if (this.accessRestoreInFlight) await this.accessRestoreInFlight;
      const restored = this.validAccessToken();
      if (restored) return restored;
    }
    return this.refresh();
  }

  private validAccessToken(): string | undefined {
    return this.access && this.access.expiresAt > Date.now() + 30_000
      ? this.access.token
      : undefined;
  }

  private async restoreAccess(): Promise<void> {
    this.accessRestoreAttempted = true;
    const revision = this.credentialRevision;
    const storage = await this.secureStorage();
    const [raw, identityId] = await Promise.all([
      storage.getItemAsync(ACCESS_KEY),
      storage.getItemAsync(IDENTITY_KEY),
    ]);
    if (!raw || this.access || revision !== this.credentialRevision) return;
    try {
      const value: unknown = JSON.parse(raw);
      if (
        value && typeof value === 'object' &&
        typeof (value as { token?: unknown }).token === 'string' &&
        typeof (value as { expiresAt?: unknown }).expiresAt === 'number' &&
        typeof (value as { identityId?: unknown }).identityId === 'string' &&
        (value as { identityId: string }).identityId === identityId
      ) this.access = value as { token: string; expiresAt: number; identityId: string };
    } catch {
      // An old or partial secure-store value simply takes the refresh path.
    }
  }

  /**
   * `idempotent` marks a request the server answers the same however often
   * it arrives (a read, or a write keyed by its own id). With a deadline, one
   * still unanswered after {@link MONOLITH_STALL_PROBE_MS} is repeated on the
   * alternate origin's fresh connection. Any request that reaches its
   * deadline moves every later request off its origin.
   */
  async fetch(
    input: string,
    init: RequestInit = {},
    options: { timeoutMs?: number; idempotent?: boolean } = {},
  ): Promise<Response> {
    let response = await this.dispatch(input, init, options);
    if (response.status !== 401) return response;
    this.access = undefined;
    this.accessRestoreAttempted = true;
    response = await this.dispatch(input, init, options);
    return response;
  }

  private dispatch(
    input: string,
    init: RequestInit,
    options: { timeoutMs?: number; idempotent?: boolean },
  ): Promise<Response> {
    const first = this.currentOrigin;
    if (
      !options.idempotent ||
      options.timeoutMs === undefined ||
      this.origins.length < 2 ||
      !input.startsWith(this.baseUrl)
    )
      return this.attempt(input, first, init, options.timeoutMs);
    return this.hedged(input, first, init, options.timeoutMs);
  }

  private async attempt(
    input: string,
    index: number,
    init: RequestInit,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    try {
      return await this.perform(this.onOrigin(input, index), init, timeoutMs);
    } catch (error) {
      if (error instanceof MonolithRequestTimeoutError) this.markStalled(index);
      throw error;
    }
  }

  /** The request on its origin, then again on the alternate if the first is still silent. */
  private hedged(
    input: string,
    first: number,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const startedAt = Date.now();
      const attempts: { index: number; controller: AbortController; failed: boolean }[] = [];
      let settled = false;
      let probe: ReturnType<typeof setTimeout> | undefined;
      const abortAll = () => attempts.forEach(({ controller }) => controller.abort());
      init.signal?.addEventListener('abort', abortAll);
      const finish = () => {
        settled = true;
        if (probe) clearTimeout(probe);
        init.signal?.removeEventListener('abort', abortAll);
      };
      const launch = (index: number, budgetMs: number) => {
        const entry = { index, controller: new AbortController(), failed: false };
        attempts.push(entry);
        if (init.signal?.aborted) entry.controller.abort();
        this.attempt(input, index, { ...init, signal: entry.controller.signal }, budgetMs).then(
          (response) => {
            if (settled) return;
            finish();
            for (const other of attempts) {
              if (other === entry) continue;
              other.controller.abort();
              // The alternate answered while this one stayed silent.
              if (!other.failed) this.markStalled(other.index);
            }
            resolve(response);
          },
          (error: unknown) => {
            entry.failed = true;
            if (settled) return;
            // The first attempt failed outright: try the other path at once.
            if (attempts.length === 1 && !init.signal?.aborted) {
              const other = this.freshestOther(index);
              if (other !== index) {
                if (probe) clearTimeout(probe);
                launch(other, Math.max(1, timeoutMs - (Date.now() - startedAt)));
                return;
              }
            }
            if (attempts.every((attempt) => attempt.failed)) {
              finish();
              reject(error);
            }
          },
        );
      };
      launch(first, timeoutMs);
      probe = setTimeout(() => {
        probe = undefined;
        if (settled || attempts.length > 1) return;
        const other = this.freshestOther(first);
        if (other === first) return;
        launch(other, Math.max(1, timeoutMs - (Date.now() - startedAt)));
      }, Math.min(MONOLITH_STALL_PROBE_MS, timeoutMs));
    });
  }

  private async perform(
    input: string,
    init: RequestInit,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    const forwardExternalAbort = () => controller.abort();
    init.signal?.addEventListener('abort', forwardExternalAbort);
    if (init.signal?.aborted) controller.abort();
    try {
      // Token restore or refresh can stall too; the deadline covers it.
      const authorized = await untilAborted(this.authorization(), controller.signal);
      const requestStartMs = performance.now();
      const response = await this.fetchImpl(input, {
        ...init,
        signal: controller.signal,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${authorized}`,
        },
      });
      responseTimings.set(response, { requestStartMs, firstByteMs: performance.now() });
      return response;
    } catch (error) {
      if (timedOut) throw new MonolithRequestTimeoutError();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      init.signal?.removeEventListener('abort', forwardExternalAbort);
    }
  }

  private refresh(): Promise<string> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<string> {
    const refreshToken =
      this.refreshToken ?? (await (await this.secureStorage()).getItemAsync(REFRESH_KEY));
    if (!refreshToken) throw new MonolithSessionRequiredError();
    // Every caller shares this refresh, so a stalled one must still settle.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MONOLITH_REFRESH_TIMEOUT_MS);
    let response: Response;
    const origin = this.currentOrigin;
    try {
      response = await this.fetchImpl(`${this.origins[origin]!.origin}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        // Never repeated: a refresh rotates its token. The next one goes elsewhere.
        this.markStalled(origin);
        throw new MonolithRequestTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    this.credentialRevision += 1;
    const storage = await this.secureStorage();
    const previousId = this.access?.identityId ?? (await storage.getItemAsync(IDENTITY_KEY));
    await Promise.all([
      storage.setItemAsync(REFRESH_KEY, tokens.refreshToken),
      storage.setItemAsync(IDENTITY_KEY, tokens.identityId),
      storage.setItemAsync(ACCESS_KEY, JSON.stringify({
        token: tokens.accessToken,
        expiresAt: tokens.accessExpiresAt,
        identityId: tokens.identityId,
      })),
    ]);
    this.refreshToken = tokens.refreshToken;
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
