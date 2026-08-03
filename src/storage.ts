import type { PersistStorage, StorageValue } from 'zustand/middleware/persist'
import {
  commitTransaction,
  ensureStore,
  promisifyRequest,
  withStore,
} from './db'

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
  const indexedDBStorage: PersistStorage<S, Promise<void>> = {
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

  type Storage = PersistStorage<S, Promise<void>>
  let chosen: Storage | undefined
  let probe: Promise<Storage> | undefined

  /**
   * Pick the backend, probing once and then answering synchronously. Deciding
   * availability by actually connecting — rather than by sniffing the global —
   * matters because IndexedDB can be missing (SSR) *or* present but refuse to
   * open (Firefox private mode, Safari ITP). Sniffing only catches the first,
   * leaving the second to reject every read and hang hydration forever.
   *
   * Only connection failures degrade. Errors raised once a transaction is
   * running (`QuotaExceededError`, …) are real and must reach the caller
   * instead of being masked by a silent switch to memory.
   */
  function backend(): Storage | Promise<Storage> {
    if (chosen) return chosen
    probe ??= ensureStore(databaseName, storeName).then(
      () => (chosen = indexedDBStorage),
      (error) => {
        console.warn(
          `[zustand-idb] IndexedDB is unavailable for "${databaseName}/${storeName}"; falling back to in-memory storage. State will not be persisted.`,
          error,
        )
        return (chosen = createMemoryStorage<S>())
      },
    )
    return probe
  }

  return {
    getItem(name) {
      const storage = backend()
      return storage instanceof Promise
        ? storage.then((resolved) => resolved.getItem(name))
        : storage.getItem(name)
    },

    setItem(name, value) {
      const storage = backend()
      return storage instanceof Promise
        ? storage.then((resolved) => resolved.setItem(name, value))
        : storage.setItem(name, value)
    },

    removeItem(name) {
      const storage = backend()
      return storage instanceof Promise
        ? storage.then((resolved) => resolved.removeItem(name))
        : storage.removeItem(name)
    },
  }
}
