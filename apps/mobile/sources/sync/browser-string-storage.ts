export type BrowserStringStorage = {
  getString(key: string): string | undefined;
  set(key: string, value: string | number | boolean): void;
  delete(key: string): void;
  getAllKeys(): string[];
};

/** The store itself only where the browser gives no storage. Beside a real
 * storage it would bring back keys another tab removed (a sign-out). */
const memoryFallback = new Map<string, string>();

export function webStringStorage(storage?: Storage, namespace = ''): BrowserStringStorage {
  const namespaced = (key: string) => `${namespace}${key}`;
  if (!storage)
    return {
      getString: (key) => memoryFallback.get(namespaced(key)),
      set: (key, value) => {
        memoryFallback.set(namespaced(key), String(value));
      },
      delete: (key) => {
        memoryFallback.delete(namespaced(key));
      },
      getAllKeys: () =>
        [...memoryFallback.keys()]
          .filter((key) => key.startsWith(namespace))
          .map((key) => key.slice(namespace.length)),
    };
  return {
    getString(key) {
      try {
        return storage.getItem(namespaced(key)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        storage.setItem(namespaced(key), String(value));
      } catch {
        /* a full or denied storage keeps no copy */
      }
    },
    delete(key) {
      try {
        storage.removeItem(namespaced(key));
      } catch {
        /* already unreadable */
      }
    },
    getAllKeys() {
      const keys: string[] = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(namespace)) keys.push(key.slice(namespace.length));
        }
      } catch {
        /* no readable keys */
      }
      return keys;
    },
  };
}
