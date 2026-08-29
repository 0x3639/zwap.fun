export interface StorageDriver {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStorageDriver implements StorageDriver {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : clone(value);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, clone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class IndexedDbStorageDriver implements StorageDriver {
  constructor(
    private readonly databaseName = "zwap-wallet",
    private readonly storeName = "private-wallet"
  ) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
  }

  private async request<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const database = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(this.storeName, mode);
        const request = operation(transaction.objectStore(this.storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
      });
    } finally {
      database.close();
    }
  }

  async get(key: string): Promise<unknown> {
    return this.request("readonly", (store) => store.get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.request("readwrite", (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.request("readwrite", (store) => store.delete(key));
  }

  async resetDatabase(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
      request.onblocked = () => reject(new Error("IndexedDB reset is blocked by another open profile tab"));
    });
  }
}
