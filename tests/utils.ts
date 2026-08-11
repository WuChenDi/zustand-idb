import { persist } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import { ensureStore, promisifyRequest } from '../src/db'
import { createIndexedDBStorage } from '../src/storage'

export interface User {
  name: string
}

export const VERSION = 0.1

/** Read a row straight out of IndexedDB, bypassing the storage adapter. */
export async function getRow<T>(
  databaseName: string,
  storeName: string,
  rowKey: string,
) {
  const database = await ensureStore(databaseName, storeName)
  const store = database
    .transaction(storeName, 'readonly')
    .objectStore(storeName)

  return await promisifyRequest<T>(store.get(rowKey))
}

/** Create a persisted store backed by the IndexedDB storage. */
export function createUserStore(
  databaseName: string,
  storeName: string,
  name: string,
  initialState: User = { name: 'John' },
) {
  return createStore(
    persist<User>(() => initialState, {
      name,
      version: VERSION,
      storage: createIndexedDBStorage(databaseName, storeName),
    }),
  )
}

/** Resolve once the store has finished its asynchronous hydration. */
export function untilHydrated(store: {
  persist: { onFinishHydration(callback: () => void): () => void }
}): Promise<void> {
  return new Promise((resolve) => {
    store.persist.onFinishHydration(() => resolve())
  })
}
