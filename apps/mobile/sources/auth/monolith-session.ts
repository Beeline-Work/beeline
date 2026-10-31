import { readWebXAttribution, loadXPixel, trackXSignup } from '@beeline/api-contract/x-attribution';
import type { SigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { OidcBindError } from '@beeline/buzz-client';
import { monolithSecureStorage, type MonolithSecureStorage } from '@/auth/monolith-secure-storage';
import { isDesktopShell } from '@/utils/isDesktopShell';
import { webRuntimeStorage } from '@/utils/web-storage';
import { resetClientState } from '@/sync/client-reset';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { beginNetworkResponseTiming } from './network-response-timing';
import { isOptionalRoomRequest, waitForRoomDraw } from '@/buzz/room-draw-barrier';
import { reportRequestDeadlineMissed } from '@/sync/transport/request-deadline';

// Capture before OAuth leaves the landing URL; the shared first-party cookie survives it.
loadXPixel(readWebXAttribution());

const REFRESH_KEY = 'buzzy.monolith.refresh.v1';
const IDENTITY_KEY = 'buzzy.monolith.identity.v1';
const ACCESS_KEY = 'buzzy.monolith.access.v1';

async function monolithFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktopShell()) {
    return fetch(input, init);
  }
  const { fetch: desktopFetch } = await import('@tauri-apps/plugin-http');
  return desktopFetch(input, init);
}

export interface MonolithTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  identityId: string;
  xSignup?: { eventId: string; conversionId: string };
}

/** Deadline for room/workspace reads; long uploads stay unbounded by default. */
export const MONOLITH_REQUEST_TIMEOUT_MS = 15_000;
/** Shorter than a read's deadline, so a read that waited on it can retry. */
const MONOLITH_REFRESH_TIMEOUT_MS = 10_000;
export function monolithOrigins(baseUrl: string): readonly string[] {
  return [baseUrl];
}

export class MonolithRequestTimeoutError extends Error {
  constructor() {
    super(
      'The server did not answer in time. The result is unknown. Refresh to check before trying again.',
    );
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

export class MonolithRefreshError extends Error {
  constructor(readonly status: number) {
    super('Could not renew the session. Try again.');
    this.name = 'MonolithRefreshError';
  }
}

export class MonolithSessionChangedError extends Error {
  constructor() {
    super('The signed-in session changed while credentials were being renewed.');
    this.name = 'MonolithSessionChangedError';
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
  private sessionRevision = 0;
  private credentialMutation: Promise<void> = Promise.resolve();
  constructor(
    private readonly baseUrl = getBuzzRuntimeConfig().monolithUrl,
    private readonly fetchImpl: typeof fetch = monolithFetch,
    private readonly secureStorage: () => Promise<MonolithSecureStorage> = monolithSecureStorage,
    _origins: readonly string[] = monolithOrigins(baseUrl),
  ) {}

  /**
   * A request past its deadline makes the shared socket suspect. HTTP keeps
   * its configured primary origin; recovery rides the one live socket.
   */
  noteStalled(_input: string): void {
    reportRequestDeadlineMissed();
  }

  async exchangeGitHubTicket(ticket: string, funnel?: SigninFunnelEvent): Promise<string> {
    return this.exchangeProviderTicket('github', ticket, funnel);
  }

  async exchangeGoogleTicket(ticket: string, funnel?: SigninFunnelEvent): Promise<string> {
    return this.exchangeProviderTicket('google', ticket, funnel);
  }

  private async exchangeProviderTicket(
    provider: 'github' | 'google',
    ticket: string,
    funnel?: SigninFunnelEvent,
  ): Promise<string> {
    const revision = this.credentialRevision;
    const xAttribution = readWebXAttribution();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/${provider}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oidcToken: ticket,
        ...(funnel ? { funnel } : {}),
        ...(xAttribution ? { xAttribution } : {}),
      }),
    });
    if (!response.ok) throw new MonolithSessionRequiredError();
    const tokens = (await response.json()) as MonolithTokens;
    await this.accept(tokens, true, revision);
    trackXSignup(tokens.xSignup);
    return tokens.identityId;
  }

  async linkGoogleTicket(ticket: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.authorization()}`,
      },
      body: JSON.stringify({ oidcToken: ticket }),
    });
    if (response.status === 409)
      throw new Error('That Google account belongs to another Beeline account.');
    if (!response.ok) throw new Error('Could not connect Google. Try again.');
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
    const revision = this.credentialRevision;
    const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/review/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!response.ok) throw new MonolithSessionRequiredError();
    const tokens = (await response.json()) as MonolithTokens;
    await this.accept(tokens, true, revision);
    const acceptedRevision = this.credentialRevision;
    await this.mutateCredentials(async () => {
      if (acceptedRevision !== this.credentialRevision) throw new MonolithSessionChangedError();
      await (
        await this.secureStorage()
      ).setItemAsync(
        ACCESS_KEY,
        JSON.stringify({
          token: tokens.accessToken,
          expiresAt: tokens.accessExpiresAt,
          identityId: tokens.identityId,
          reviewSecretHash: bytesToHex(sha256(utf8ToBytes(secret))),
        }),
      );
      if (acceptedRevision !== this.credentialRevision) throw new MonolithSessionChangedError();
    });
    return tokens.identityId;
  }

  /** An already redeemed launch link must not replace the session on an OTA reload. */
  async reviewIdentityForSecret(secret: string): Promise<string | null> {
    const storage = await this.secureStorage();
    const raw = await storage.getItemAsync(ACCESS_KEY);
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as { reviewSecretHash?: unknown; identityId?: unknown };
      const identityId = await this.identityId();
      return identityId &&
        saved.identityId === identityId &&
        saved.reviewSecretHash === bytesToHex(sha256(utf8ToBytes(secret))) &&
        (await storage.getItemAsync(REFRESH_KEY))
        ? identityId
        : null;
    } catch {
      return null;
    }
  }

  /** Current account only when this process has already authenticated it. */
  peekIdentityId(): string | null {
    return this.access?.identityId ?? null;
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

  /**
   * Browser tabs of one origin share the session in localStorage. When another
   * tab signs in or out, this tab forgets its own copy and reads the shared one.
   */
  watchOtherTabs(target: Pick<Window, 'addEventListener'>, storage: Storage): void {
    target.addEventListener('storage', (event) => {
      if (
        event.storageArea !== storage ||
        (event.key !== null && event.key !== IDENTITY_KEY && event.key !== REFRESH_KEY)
      )
        return;
      this.credentialRevision += 1;
      this.sessionRevision += 1;
      this.access = undefined;
      this.refreshToken = undefined;
      this.accessRestoreAttempted = false;
      this.accessRestoreInFlight = undefined;
      this.identityChanged();
    });
  }

  async clear(): Promise<void> {
    this.credentialRevision += 1;
    this.sessionRevision += 1;
    this.access = undefined;
    this.refreshToken = undefined;
    this.accessRestoreAttempted = true;
    await this.mutateCredentials(async () => {
      const storage = await this.secureStorage();
      await Promise.all([
        storage.deleteItemAsync(REFRESH_KEY),
        storage.deleteItemAsync(IDENTITY_KEY),
        storage.deleteItemAsync(ACCESS_KEY),
      ]);
    });
    this.identityChanged();
  }

  async signOut(): Promise<void> {
    const credential =
      this.refreshToken ?? (await (await this.secureStorage()).getItemAsync(REFRESH_KEY));
    await this.clear();
    if (!credential) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      await untilAborted(
        this.fetchImpl(`${this.baseUrl}/v1/auth/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: credential }),
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch {
      // Signing out also works offline: the device has already erased its credential.
    } finally {
      clearTimeout(timer);
    }
  }

  private mutateCredentials(operation: () => Promise<void>): Promise<void> {
    const result = this.credentialMutation.then(operation, operation);
    this.credentialMutation = result.catch(() => undefined);
    return result;
  }

  private assertSharedRefresh(credential: string): void {
    const shared = isDesktopShell() ? undefined : webRuntimeStorage()?.storage;
    if (!shared || shared.getItem(REFRESH_KEY) === credential) return;
    // A storage event can arrive after the HTTP reply. Check the origin's
    // current credential before clearing or writing, so a delayed old tab
    // cannot erase a newer sign-in, including one for the same identity.
    this.credentialRevision += 1;
    this.access = undefined;
    this.refreshToken = undefined;
    this.accessRestoreAttempted = false;
    this.accessRestoreInFlight = undefined;
    this.identityChanged();
    throw new MonolithSessionChangedError();
  }

  async authorization(fetchImpl: typeof fetch = this.fetchImpl): Promise<string> {
    const current = this.validAccessToken();
    if (current) return current;
    if (!this.access) {
      if (!this.accessRestoreAttempted) this.accessRestoreInFlight ??= this.restoreAccess();
      if (this.accessRestoreInFlight) await this.accessRestoreInFlight;
      const restored = this.validAccessToken();
      if (restored) return restored;
    }
    return this.refresh(fetchImpl);
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
        value &&
        typeof value === 'object' &&
        typeof (value as { token?: unknown }).token === 'string' &&
        typeof (value as { expiresAt?: unknown }).expiresAt === 'number' &&
        typeof (value as { identityId?: unknown }).identityId === 'string' &&
        (value as { identityId: string }).identityId === identityId
      )
        this.access = value as { token: string; expiresAt: number; identityId: string };
    } catch {
      // An old or partial secure-store value simply takes the refresh path.
    }
  }

  /**
   * A request gets its one configured deadline. It is never hedged to another
   * origin; a missed deadline marks the shared live socket suspect instead.
   */
  async fetch(
    input: string,
    init: RequestInit = {},
    options: {
      timeoutMs?: number;
      idempotent?: boolean;
      fetchImpl?: typeof fetch;
      afterRoomDraw?: boolean;
    } = {},
  ): Promise<Response> {
    const sessionRevision = this.sessionRevision;
    if (options.afterRoomDraw ?? isOptionalRoomRequest(input)) {
      const draw = waitForRoomDraw(init.signal);
      if (draw) await draw;
      if (sessionRevision !== this.sessionRevision) throw new MonolithSessionChangedError();
    }
    const dispatch = () =>
      options.fetchImpl
        ? this.perform(input, init, options.timeoutMs, options.fetchImpl)
        : this.dispatch(input, init, options);
    let response = await dispatch();
    if (response.status !== 401) return response;
    if (sessionRevision !== this.sessionRevision) throw new MonolithSessionChangedError();
    this.access = undefined;
    this.accessRestoreAttempted = true;
    response = await dispatch();
    return response;
  }

  private async dispatch(
    input: string,
    init: RequestInit,
    options: { timeoutMs?: number; idempotent?: boolean },
  ): Promise<Response> {
    try {
      return await this.perform(input, init, options.timeoutMs);
    } catch (error) {
      if (error instanceof MonolithRequestTimeoutError) reportRequestDeadlineMissed();
      throw error;
    }
  }

  private async perform(
    input: string,
    init: RequestInit,
    timeoutMs: number | undefined,
    fetchImpl: typeof fetch = this.fetchImpl,
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
      const tracingRoom = /\/v1\/phone\/rooms\/[^/?]+$/.test(input);
      if (tracingRoom) markRoomOpen('wire-authorizing');
      // A warm Room tap must dispatch before navigation starts rendering.
      // Awaiting an already available token lets that render hold the GET.
      const available = this.validAccessToken();
      const authorized =
        available && !controller.signal.aborted
          ? available
          : await untilAborted(this.authorization(fetchImpl), controller.signal);
      const finishTiming = tracingRoom ? beginNetworkResponseTiming(input) : undefined;
      if (tracingRoom) markRoomOpen('wire-dispatch');
      let response: Response;
      try {
        response = await fetchImpl(input, {
          ...init,
          signal: controller.signal,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            authorization: `Bearer ${authorized}`,
          },
        });
      } catch (error) {
        finishTiming?.();
        throw error;
      }
      finishTiming?.();
      if (tracingRoom) markRoomOpen('wire-headers');

      return response;
    } catch (error) {
      if (timedOut) throw new MonolithRequestTimeoutError();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      init.signal?.removeEventListener('abort', forwardExternalAbort);
    }
  }

  private refresh(fetchImpl: typeof fetch = this.fetchImpl): Promise<string> {
    this.refreshInFlight ??= this.performRefresh(fetchImpl).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(fetchImpl: typeof fetch): Promise<string> {
    const revision = this.credentialRevision;
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
    try {
      response = await untilAborted(
        fetchImpl(`${this.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (revision !== this.credentialRevision) throw new MonolithSessionChangedError();
      this.assertSharedRefresh(refreshToken);
      if (response.status === 401) {
        await this.clear();
        throw new MonolithSessionRequiredError();
      }
      if (!response.ok) throw new MonolithRefreshError(response.status);
      const tokens = await untilAborted(
        response.json() as Promise<MonolithTokens>,
        controller.signal,
      );
      await this.accept(tokens, false, revision, refreshToken);
      return tokens.accessToken;
    } catch (error) {
      if (timedOut) {
        reportRequestDeadlineMissed();
        throw new MonolithRequestTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async accept(
    tokens: MonolithTokens,
    signedIn = false,
    expectedRevision = this.credentialRevision,
    previousRefresh?: string,
  ): Promise<void> {
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.identityId)
      throw new Error('Invalid monolith session response');
    if (expectedRevision !== this.credentialRevision) throw new MonolithSessionChangedError();
    if (previousRefresh) this.assertSharedRefresh(previousRefresh);
    const revision = ++this.credentialRevision;
    await this.mutateCredentials(async () => {
      if (revision !== this.credentialRevision) throw new MonolithSessionChangedError();
      const storage = await this.secureStorage();
      const previousId = this.access?.identityId ?? (await storage.getItemAsync(IDENTITY_KEY));
      if (signedIn || previousId !== tokens.identityId) this.sessionRevision += 1;
      let reviewSecretHash: string | undefined;
      if (!signedIn && previousId === tokens.identityId) {
        try {
          const saved = JSON.parse((await storage.getItemAsync(ACCESS_KEY)) ?? 'null') as {
            reviewSecretHash?: unknown;
          } | null;
          if (typeof saved?.reviewSecretHash === 'string')
            reviewSecretHash = saved.reviewSecretHash;
        } catch {
          // An older or partial access record has no review-link metadata.
        }
      }
      if (previousRefresh) this.assertSharedRefresh(previousRefresh);
      await Promise.all([
        storage.setItemAsync(REFRESH_KEY, tokens.refreshToken),
        storage.setItemAsync(IDENTITY_KEY, tokens.identityId),
        storage.setItemAsync(
          ACCESS_KEY,
          JSON.stringify({
            token: tokens.accessToken,
            expiresAt: tokens.accessExpiresAt,
            identityId: tokens.identityId,
            ...(reviewSecretHash ? { reviewSecretHash } : {}),
          }),
        ),
      ]);
      if (revision !== this.credentialRevision) throw new MonolithSessionChangedError();
      this.refreshToken = tokens.refreshToken;
      this.access = {
        token: tokens.accessToken,
        expiresAt: tokens.accessExpiresAt,
        identityId: tokens.identityId,
      };
      // A new sign-in may repair an expired session for the same identity.
      // Token refresh alone must not start another registration/refresh loop.
      if (signedIn || previousId !== tokens.identityId) this.identityChanged();
      if (signedIn)
        void import('./signin-funnel')
          .then((module) => module.funnelSignedIn(tokens.accessToken))
          .catch(() => undefined);
    });
  }
}

export const monolithSession = new MonolithSession();
monolithSession.subscribeIdentityChange(resetClientState);

const sharedSessionStorage = isDesktopShell() ? undefined : webRuntimeStorage()?.storage;
if (sharedSessionStorage && typeof window.addEventListener === 'function')
  monolithSession.watchOtherTabs({ addEventListener: ((type: string, listener: EventListenerOrEventListenerObject) => window.addEventListener(type, listener)) as Window['addEventListener'] }, sharedSessionStorage);
