export type BrowserStringStorage = {
  getString(key: string): string | undefined;
  set(key: string, value: string | number | boolean): void;
  delete(key: string): void;
  getAllKeys(): string[];
};

const memoryFallback = new Map<string, string>();

export function webStringStorage(storage?: Storage, namespace = ''): BrowserStringStorage {
  const namespaced = (key: string) => `${namespace}${key}`;
  return {
    getString(key) {
      try {
        return storage?.getItem(namespaced(key)) ?? memoryFallback.get(namespaced(key));
      } catch {
        return memoryFallback.get(namespaced(key));
      }
    },
    set(key, value) {
      const text = String(value);
      memoryFallback.set(namespaced(key), text);
      try {
        storage?.setItem(namespaced(key), text);
      } catch {
        /* memory remains authoritative */
      }
    },
    delete(key) {
      memoryFallback.delete(namespaced(key));
      try {
        storage?.removeItem(namespaced(key));
      } catch {
        /* already removed in memory */
      }
    },
    getAllKeys() {
      const keys = new Set<string>();
      for (const key of memoryFallback.keys())
        if (key.startsWith(namespace)) keys.add(key.slice(namespace.length));
      try {
        if (storage)
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key?.startsWith(namespace)) keys.add(key.slice(namespace.length));
          }
      } catch {
        /* memory keys are still available */
      }
      return [...keys];
    },
  };
}
