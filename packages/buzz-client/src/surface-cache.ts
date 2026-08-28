const CONTRACT_VERSION = 'room-surfaces-1';

export type SurfaceCacheStorage = {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  readonly keys?: () => Promise<readonly string[]>;
};

export type SurfaceCacheAddress = {
  readonly relayOrigin: string;
  readonly viewerPubkey: string;
  readonly endpoint: string;
  readonly params?: Readonly<Record<string, string | number | undefined>>;
};

export function surfaceCacheKey(address: SurfaceCacheAddress): string {
  const origin = new URL(address.relayOrigin).origin;
  const params = Object.entries(address.params ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([CONTRACT_VERSION, origin, address.viewerPubkey, address.endpoint, params]);
}

/** Stores validated GET DTOs with an optional narrow response sanitizer; it has no relay-event merge API. */
export class SurfaceResponseCache {
  constructor(
    private readonly storage: SurfaceCacheStorage,
    private readonly normalize: (value: unknown) => unknown = (value) => value,
  ) {}

  async read<T>(
    address: SurfaceCacheAddress,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    const value = await this.storage.get(surfaceCacheKey(address));
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      const normalized = this.normalize(parsed);
      if (!guard(normalized)) {
        await this.storage.remove(surfaceCacheKey(address));
        return null;
      }
      if (normalized !== parsed) {
        await this.storage.set(surfaceCacheKey(address), JSON.stringify(normalized));
      }
      return normalized;
    } catch {
      await this.storage.remove(surfaceCacheKey(address));
      return null;
    }
  }

  async write<T>(
    address: SurfaceCacheAddress,
    value: T,
    guard: (value: unknown) => value is T,
  ): Promise<void> {
    const normalized = this.normalize(value);
    if (!guard(normalized)) throw new Error('refusing to cache an invalid surface response');
    await this.storage.set(surfaceCacheKey(address), JSON.stringify(normalized));
  }

  async remove(address: SurfaceCacheAddress): Promise<void> {
    await this.storage.remove(surfaceCacheKey(address));
  }

  async evictViewer(relayOrigin: string, viewerPubkey: string): Promise<void> {
    if (!this.storage.keys) return;
    const origin = new URL(relayOrigin).origin;
    for (const key of await this.storage.keys()) {
      try {
        const parsed = JSON.parse(key) as unknown[];
        if (parsed[0] === CONTRACT_VERSION && parsed[1] === origin && parsed[2] === viewerPubkey) {
          await this.storage.remove(key);
        }
      } catch {}
    }
  }
}
