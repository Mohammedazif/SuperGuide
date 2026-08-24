export interface StoredValue<T> {
  value: T;
  expiresAt: number | null;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export class MemoryStore implements KeyValueStore {
  readonly #entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#entries.set(key, value);
  }
  removeItem(key: string): void {
    this.#entries.delete(key);
  }
  keys(): string[] {
    return [...this.#entries.keys()];
  }
}

export function browserStore(storage: Storage): KeyValueStore {
  return {
    getItem: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch {
        // A host page can disable storage entirely. Durability degrades; nothing else breaks.
      }
    },
    removeItem: (key) => {
      try {
        storage.removeItem(key);
      } catch {
        return;
      }
    },
    keys: () => {
      try {
        return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
          (key): key is string => key !== null,
        );
      } catch {
        return [];
      }
    },
  };
}

export const STORAGE_PREFIX = "sg.";

export class NamespacedStorage {
  readonly #store: KeyValueStore;
  readonly #productId: string;
  readonly #now: () => number;

  constructor(store: KeyValueStore, productId: string, now: () => number = () => Date.now()) {
    this.#store = store;
    this.#productId = productId;
    this.#now = now;
  }

  #key(namespace: string, id: string): string {
    return `${STORAGE_PREFIX}${namespace}.${this.#productId}.${id}`;
  }

  #prefix(namespace: string): string {
    return `${STORAGE_PREFIX}${namespace}.${this.#productId}.`;
  }

  read<T>(namespace: string, id: string): NoInfer<T> | null {
    const raw = this.#store.getItem(this.#key(namespace, id));
    if (raw === null) return null;

    let parsed: StoredValue<NoInfer<T>>;
    try {
      parsed = JSON.parse(raw) as StoredValue<T>;
    } catch {
      this.#store.removeItem(this.#key(namespace, id));
      return null;
    }

    if (parsed.expiresAt !== null && parsed.expiresAt <= this.#now()) {
      this.#store.removeItem(this.#key(namespace, id));
      return null;
    }
    return parsed.value;
  }

  write(namespace: string, id: string, value: unknown, ttlMs: number | null = null): void {
    const entry: StoredValue<unknown> = {
      value,
      expiresAt: ttlMs === null ? null : this.#now() + ttlMs,
    };
    this.#store.setItem(this.#key(namespace, id), JSON.stringify(entry));
  }

  remove(namespace: string, id: string): void {
    this.#store.removeItem(this.#key(namespace, id));
  }

  entries<T>(namespace: string): { id: string; value: NoInfer<T> }[] {
    const prefix = this.#prefix(namespace);
    const found: { id: string; value: NoInfer<T> }[] = [];

    for (const key of this.#store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const value = this.read<T>(namespace, id);
      if (value !== null) found.push({ id, value });
    }
    return found;
  }
}
