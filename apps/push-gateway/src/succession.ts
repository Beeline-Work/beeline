const PUBKEY = /^[0-9a-f]{64}$/;

export type SuccessionResolution = {
  readonly mappings: Readonly<Record<string, string>>;
  readonly stale: boolean;
};

export interface SnapshotSuccessionClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

type CacheEntry = { readonly current: string; readonly loadedAt: number };

/** Bounded/coalesced internal auth-service succession resolver. */
export class SnapshotSuccessionClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<SuccessionResolution>>();
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SnapshotSuccessionClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async resolve(
    relayTenantId: string,
    inputPubkeys: readonly string[],
  ): Promise<SuccessionResolution> {
    const pubkeys = [...new Set(inputPubkeys.filter((pubkey) => PUBKEY.test(pubkey)))].sort();
    const staleKeys = pubkeys.filter((pubkey) => {
      const cached = this.cache.get(`${relayTenantId}:${pubkey}`);
      return !cached || this.now() - cached.loadedAt >= this.cacheTtlMs;
    });
    if (staleKeys.length === 0)
      return { mappings: this.cached(relayTenantId, pubkeys), stale: false };
    const key = `${relayTenantId}:${staleKeys.join(',')}`;
    const pending = this.inFlight.get(key) ?? this.refresh(relayTenantId, pubkeys, staleKeys);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private cached(relayTenantId: string, pubkeys: readonly string[]): Record<string, string> {
    return Object.fromEntries(
      pubkeys.map((pubkey) => [
        pubkey,
        this.cache.get(`${relayTenantId}:${pubkey}`)?.current ?? pubkey,
      ]),
    );
  }

  private async refresh(
    relayTenantId: string,
    allPubkeys: readonly string[],
    staleKeys: readonly string[],
  ): Promise<SuccessionResolution> {
    if (!this.options.token) {
      return { mappings: this.cached(relayTenantId, allPubkeys), stale: true };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const endpoint = new URL('/internal/snapshot/current-identities', this.options.baseUrl);
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ relay_tenant_id: relayTenantId, pubkeys: staleKeys }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`identity succession HTTP ${response.status}`);
      const body = (await response.json()) as { mappings?: unknown };
      if (!body.mappings || typeof body.mappings !== 'object' || Array.isArray(body.mappings)) {
        throw new Error('identity succession response is malformed');
      }
      const mappings = body.mappings as Record<string, unknown>;
      const loadedAt = this.now();
      for (const pubkey of staleKeys) {
        const current = mappings[pubkey];
        if (typeof current !== 'string' || !PUBKEY.test(current)) {
          throw new Error('identity succession response omitted a requested key');
        }
        this.cache.set(`${relayTenantId}:${pubkey}`, { current, loadedAt });
      }
      return { mappings: this.cached(relayTenantId, allPubkeys), stale: false };
    } catch {
      // A prior verified mapping remains presentation input. An unseen key
      // falls back to itself and is never promoted into another key's role.
      return { mappings: this.cached(relayTenantId, allPubkeys), stale: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
