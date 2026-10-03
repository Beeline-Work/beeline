export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

// Reads, writes and deletes share the fence, including across remounts.
const queues = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();
let nextRevision = 0;
function ordered<T>(key: string, action: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  const settled = result.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return result;
}

export function textDraftKey(identity: string, context: string): string {
  return `beeline.text-draft.v1:${encodeURIComponent(identity)}:${encodeURIComponent(context)}`;
}

export class TextDraft<T extends string | string[]> {
  value: T;
  private revision = 0;
  private storageRevision: number;
  private edited = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(
    readonly key: string | null,
    private storage: DraftStorage,
    private initial: T,
    private legacyKey?: string,
  ) {
    this.value = initial;
    this.storageRevision = key ? (revisions.get(key) ?? 0) : 0;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    for (const listener of this.listeners) listener();
  }
  get hasEdits() {
    return this.edited;
  }
  async hydrate(): Promise<void> {
    this.disposed = false;
    if (!this.key) return;
    const hydrationRevision = this.revision;
    try {
      const raw = await ordered(this.key, async () => {
        const stored = await this.storage.getItem(this.key!);
        if (stored !== null || !this.legacyKey) return stored;
        const legacy = await this.storage.getItem(this.legacyKey);
        if (legacy !== null) {
          await this.storage.setItem(this.key!, JSON.stringify(legacy));
          await this.storage.removeItem(this.legacyKey);
        }
        return legacy === null ? null : JSON.stringify(legacy);
      });
      if (
        raw === null ||
        this.edited ||
        this.revision !== hydrationRevision ||
        this.revision > 0 ||
        this.disposed
      )
        return;
      const value: unknown = JSON.parse(raw);
      if (
        typeof this.initial === 'string'
          ? typeof value === 'string'
          : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ) {
        this.value = value as T;
        this.notify();
      }
    } catch {
      /* Storage cannot interrupt the controlled input. */
    }
  }
  initialize = (value: T) => {
    if (this.edited) return;
    // Server defaults may arrive after hydration; a restored draft wins.
    if (JSON.stringify(this.value) !== JSON.stringify(this.initial)) return;
    this.initial = value;
    this.value = value;
    this.notify();
  };
  set = (update: T | ((previous: T) => T)) => {
    this.value = typeof update === 'function' ? update(this.value) : update;
    this.edited = true;
    this.revision++;
    this.markStorageRevision();
    this.notify();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 500);
  };
  private markStorageRevision() {
    this.storageRevision = ++nextRevision;
    if (this.key) revisions.set(this.key, this.storageRevision);
  }
  private isCurrentStorageRevision() {
    return !this.key || (revisions.get(this.key) ?? 0) === this.storageRevision;
  }
  capture = (reset = true) => {
    const revision = this.revision;
    const storageRevision = this.storageRevision;
    return () => {
      if (
        this.revision !== revision ||
        this.storageRevision !== storageRevision ||
        !this.isCurrentStorageRevision()
      )
        return false;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.edited = false;
      this.revision++;
      this.markStorageRevision();
      if (!reset) this.initial = this.value;
      if (reset)
        this.value = (typeof this.initial === 'string' ? '' : this.initial.map(() => '')) as T;
      if (reset) this.initial = this.value;
      this.notify();
      if (this.key)
        void ordered(this.key, () => this.storage.removeItem(this.key!)).catch(() => undefined);
      return true;
    };
  };
  /** Message composers consume sent text while retaining typing appended during a send. */
  captureMessage = () => {
    const submitted = this.value;
    const clearUnchanged = this.capture();
    let settled = false;
    return () => {
      if (settled) return false;
      settled = true;
      if (clearUnchanged()) return true;
      if (
        typeof submitted !== 'string' ||
        !submitted ||
        typeof this.value !== 'string' ||
        this.value === submitted ||
        !this.value.startsWith(submitted) ||
        !this.isCurrentStorageRevision()
      )
        return false;
      this.set(this.value.slice(submitted.length) as T);
      // Order the remaining text after any pending save of the submitted prefix.
      void this.flush();
      return true;
    };
  };
  flush = async () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.key || !this.edited || !this.isCurrentStorageRevision()) return;
    const value = this.value;
    const empty = typeof value === 'string' ? value === '' : value.every((item) => item === '');
    await ordered(this.key, () =>
      empty
        ? this.storage.removeItem(this.key!)
        : this.storage.setItem(this.key!, JSON.stringify(value)),
    ).catch(() => undefined);
  };
  dispose = () => {
    this.disposed = true;
    void this.flush();
  };
}
