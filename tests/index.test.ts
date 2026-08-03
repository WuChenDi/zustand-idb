import { describe, expect, it } from 'vitest'
import { persist } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import {
  clearStore,
  createIndexedDBStorage,
  deleteDatabase,
  storeKeys,
} from '../src'
import { getRow } from './utils'

interface User {
  name: string
}

const VERSION = 0.1

/** Create a persisted store backed by the IndexedDB storage. */
function createUserStore(
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
function untilHydrated(store: {
  persist: { onFinishHydration(callback: () => void): () => void }
}): Promise<void> {
  return new Promise((resolve) => {
    store.persist.onFinishHydration(() => resolve())
  })
}

describe('createIndexedDBStorage', () => {
  describe('hydration', () => {
    it('writes nothing until the first state change', async ({ task }) => {
      const store = createUserStore(task.id, 'store', 'user')

      await untilHydrated(store)

      await expect(getRow(task.id, 'store', 'user')).resolves.toBeUndefined()
    })

    it('keeps the initial state when nothing is persisted', async ({
      task,
    }) => {
      const store = createUserStore(task.id, 'store', 'user')

      await untilHydrated(store)

      expect(store.getState()).toEqual({ name: 'John' })
    })

    it('rehydrates persisted state into a fresh store instance', async ({
      task,
    }) => {
      const first = createUserStore(task.id, 'store', 'user')
      await untilHydrated(first)
      await first.setState(() => ({ name: 'Kaley' }))

      // A brand-new store on the same db/store/name must load the saved value.
      const second = createUserStore(task.id, 'store', 'user')
      await untilHydrated(second)

      expect(second.getState()).toEqual({ name: 'Kaley' })
    })
  })

  describe('persistence', () => {
    it('writes state changes to IndexedDB with the persist version', async ({
      task,
    }) => {
      const store = createUserStore(task.id, 'store', 'user')
      await untilHydrated(store)

      await store.setState(() => ({ name: 'Kaley' }))

      await expect(getRow(task.id, 'store', 'user')).resolves.toEqual({
        state: { name: 'Kaley' },
        version: VERSION,
      })
    })

    it('overwrites the row on subsequent updates', async ({ task }) => {
      const store = createUserStore(task.id, 'store', 'user')
      await untilHydrated(store)

      await store.setState(() => ({ name: 'Kaley' }))
      await store.setState(() => ({ name: 'Jason' }))

      await expect(getRow(task.id, 'store', 'user')).resolves.toEqual({
        state: { name: 'Jason' },
        version: VERSION,
      })
      expect(store.getState()).toEqual({ name: 'Jason' })
    })

    it('keeps distinct persist names as independent rows', async ({ task }) => {
      const a = createUserStore(task.id, 'store', 'user-a', { name: 'Ann' })
      const b = createUserStore(task.id, 'store', 'user-b', { name: 'Bob' })
      await untilHydrated(a)
      await untilHydrated(b)

      await a.setState(() => ({ name: 'Ann-2' }))
      await b.setState(() => ({ name: 'Bob-2' }))

      await expect(getRow(task.id, 'store', 'user-a')).resolves.toEqual({
        state: { name: 'Ann-2' },
        version: VERSION,
      })
      await expect(getRow(task.id, 'store', 'user-b')).resolves.toEqual({
        state: { name: 'Bob-2' },
        version: VERSION,
      })
    })
  })

  describe('removal', () => {
    it('clears the row via persist.clearStorage()', async ({ task }) => {
      const store = createUserStore(task.id, 'store', 'user')
      await untilHydrated(store)
      await store.setState(() => ({ name: 'Kaley' }))

      await store.persist.clearStorage()

      await expect(getRow(task.id, 'store', 'user')).resolves.toBeUndefined()
    })
  })

  describe('in-memory fallback', () => {
    it('keeps working when IndexedDB is unavailable', async ({ task }) => {
      const original = globalThis.indexedDB
      // Simulate an environment without IndexedDB (private mode, SSR, ...).
      globalThis.indexedDB = undefined as unknown as IDBFactory
      try {
        const store = createUserStore(task.id, 'store', 'user')
        await untilHydrated(store)

        await store.setState(() => ({ name: 'Kaley' }))

        // State stays usable in memory even though nothing is persisted.
        expect(store.getState()).toEqual({ name: 'Kaley' })
      } finally {
        globalThis.indexedDB = original
      }
    })
  })
})

describe('storeKeys', () => {
  it('returns an empty array for an untouched store', async ({ task }) => {
    await expect(storeKeys(task.id, 'store')).resolves.toEqual([])
  })

  it('lists the keys of persisted rows in ascending order', async ({
    task,
  }) => {
    const a = createUserStore(task.id, 'store', 'user-a')
    const b = createUserStore(task.id, 'store', 'user-b')
    await untilHydrated(a)
    await untilHydrated(b)
    await a.setState(() => ({ name: 'Ann' }))
    await b.setState(() => ({ name: 'Bob' }))

    await expect(storeKeys(task.id, 'store')).resolves.toEqual([
      'user-a',
      'user-b',
    ])
  })
})

describe('clearStore', () => {
  it('removes every row while keeping the database', async ({ task }) => {
    const a = createUserStore(task.id, 'store', 'user-a')
    const b = createUserStore(task.id, 'store', 'user-b')
    await untilHydrated(a)
    await untilHydrated(b)
    await a.setState(() => ({ name: 'Ann' }))
    await b.setState(() => ({ name: 'Bob' }))
    await expect(storeKeys(task.id, 'store')).resolves.toHaveLength(2)

    await clearStore(task.id, 'store')

    await expect(storeKeys(task.id, 'store')).resolves.toEqual([])
  })
})

describe('deleteDatabase', () => {
  it('deletes the whole database, and re-opening starts empty', async ({
    task,
  }) => {
    const store = createUserStore(task.id, 'store', 'user')
    await untilHydrated(store)
    await store.setState(() => ({ name: 'Kaley' }))
    await expect(storeKeys(task.id, 'store')).resolves.toEqual(['user'])

    await deleteDatabase(task.id)

    // Re-opening recreates an empty database + store.
    await expect(storeKeys(task.id, 'store')).resolves.toEqual([])
  })
})
