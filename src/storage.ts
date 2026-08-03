import type { PersistStorage, StorageValue } from 'zustand/middleware/persist'
import { commitTransaction, promisifyRequest, withStore } from './db'

/**
 * In-memory fallback used when IndexedDB is unavailable (private mode,
 * disabled, SSR, etc.). Keeps Zustand hydration from crashing; state stays
 * usable but is not persisted.
 */
function createMemoryStorage<S>(): PersistStorage<S, Promise<void>> {
  const map = new Map<string, StorageValue<S>>()
  return {
    // Async like the IndexedDB path so hydration stays asynchronous and
    // `onFinishHydration` / `hasHydrated` behave the same with or without it.
    getItem: async (name) => map.get(name) ?? null,
    setItem: async (name, value) => {
      map.set(name, value)
    },
    removeItem: async (name) => {
      map.delete(name)
    },
  }
}

/**
 * Create a persist storage using `IndexedDB`.
 * Handy for persisting non-serializable data.
 * @param databaseName A name of the database.
 * @param storeName A name of the store within the database.
 *
 * @example
 * create(
 *   persist(initialState, {
 *     version: 0.1,
 *     name: 'row-key',
 *     storage: createIndexedDBStorage('database-name', 'store-name')
 *   })
 * )
 */
export function createIndexedDBStorage<S>(
  databaseName: string,
  storeName: string,
): PersistStorage<S, Promise<void>> {
  // Fall back to in-memory storage when IndexedDB is missing, so reads/writes
  // don't reject and break hydration.
  if (typeof indexedDB === 'undefined') {
    return createMemoryStorage<S>()
  }

  return {
    async getItem(name) {
      const value = await withStore(
        databaseName,
        storeName,
        'readonly',
        (store) =>
          promisifyRequest<StorageValue<S> | undefined>(store.get(name)),
      )
      return value ?? null
    },

    setItem(name, value) {
      return withStore(databaseName, storeName, 'readwrite', (store) =>
        commitTransaction(store.put(value, name)),
      )
    },

    removeItem(name) {
      return withStore(databaseName, storeName, 'readwrite', (store) =>
        commitTransaction(store.delete(name)),
      )
    },
  }
}
