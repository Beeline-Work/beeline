/** Small registry seam for screen tests whose production owner is SurfaceRegistry. */
export function mockSurfaceStorage() {
  type Address = { endpoint: string; params?: Record<string, unknown> };
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const key = (address: Address) => `${address.endpoint}:${JSON.stringify(address.params ?? {})}`;
  const announce = (address: Address) => listeners.get(key(address))?.forEach((listener) => listener());
  return {
    surfaceAddress: (_relay: string, _viewer: string, endpoint: string,
      params?: Record<string, unknown>) => ({ endpoint, params }),
    clearMobileSurfaceStorage: () => {
      values.clear(); listeners.forEach((set) => set.forEach((listener) => listener()));
    },
    mobileSurfaceCache: {
      clear: () => { values.clear(); listeners.forEach((set) => set.forEach((listener) => listener())); },
      peek: (address: Address) => values.get(key(address)) ?? null,
      read: async (address: Address) => values.get(key(address)) ?? null,
      write: async (address: Address, value: unknown) => {
        values.set(key(address), value); announce(address);
      },
      publish: (address: Address, value: unknown) => {
        values.set(key(address), value); announce(address); return value;
      },
      remove: async (address: Address) => { values.delete(key(address)); announce(address); },
      fetch: async (address: Address, _guard: unknown, request: () => Promise<unknown>) => {
        const value = await request(); values.set(key(address), value); announce(address); return value;
      },
      subscribe: (address: Address, listener: () => void) => {
        const set = listeners.get(key(address)) ?? new Set<() => void>();
        set.add(listener); listeners.set(key(address), set);
        return () => { set.delete(listener); };
      },
    },
  };
}
