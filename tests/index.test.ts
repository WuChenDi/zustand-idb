import { describe, expect, it, vi } from 'vitest'
import { persist } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import {
  clearStore,
  createIndexedDBStorage,
  deleteDatabase,
  storeKeys,
} from '../src'
import { ensureStore } from '../src/db'
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

      // Zustand's `clearStorage(): void` drops the promise our `removeItem`
      // returns, so there is nothing to await here — poll for the row to go
      // away rather than depend on how many ticks the delete happens to take.
      store.persist.clearStorage()

      await expect.poll(() => getRow(task.id, 'store', 'user')).toBeUndefined()
    })
  })

  describe('in-memory fallback', () => {
    it('keeps working when IndexedDB is unavailable', async ({ task }) => {
      const original = globalThis.indexedDB
      // Simulate an environment without IndexedDB (private mode, SSR, ...).
      globalThis.indexedDB = undefined as unknown as IDBFactory
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const store = createUserStore(task.id, 'store', 'user')
        await untilHydrated(store)

        await store.setState(() => ({ name: 'Kaley' }))

        // State stays usable in memory even though nothing is persisted.
        expect(store.getState()).toEqual({ name: 'Kaley' })
      } finally {
        warn.mockRestore()
        globalThis.indexedDB = original
      }
    })

    it('falls back when IndexedDB exists but refuses to open', async ({
      task,
    }) => {
      const original = globalThis.indexedDB
      // Firefox private mode / Safari ITP: the global is present, but opening
      // throws. Sniffing `typeof indexedDB` would miss this and hydration would
      // hang forever.
      globalThis.indexedDB = {
        open() {
          throw new DOMException('denied', 'InvalidStateError')
        },
      } as unknown as IDBFactory
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const store = createUserStore(task.id, 'store', 'user')
        await untilHydrated(store)

        expect(store.persist.hasHydrated()).toBe(true)
        await store.setState(() => ({ name: 'Kaley' }))
        expect(store.getState()).toEqual({ name: 'Kaley' })
        // The degradation must be visible, not silent.
        expect(warn).toHaveBeenCalledOnce()
      } finally {
        warn.mockRestore()
        globalThis.indexedDB = original
      }
    })

    it('surfaces write errors instead of degrading to memory', async ({
      task,
    }) => {
      const storage = createIndexedDBStorage<{ value: unknown }>(
        task.id,
        'store',
      )
      // A failure raised *inside* a transaction is a real error, not a signal
      // that IndexedDB is unusable; masking it would silently stop persisting.
      await expect(
        storage.setItem('user', { state: { value: () => {} }, version: 0 }),
      ).rejects.toThrow(/could not be cloned/)

      // IndexedDB must still be the backend afterwards.
      await storage.setItem('user', { state: { value: 1 }, version: 0 })
      await expect(storeKeys(task.id, 'store')).resolves.toEqual(['user'])
    })
  })
})

describe('multiple object stores in one database', () => {
  it('shares a single connection across stores', async ({ task }) => {
    // Creating the second store swaps the connection for an upgraded one, so
    // only settle the schema first.
    await ensureStore(task.id, 'store-a')
    await ensureStore(task.id, 'store-b')

    const [a, b] = await Promise.all([
      ensureStore(task.id, 'store-a'),
      ensureStore(task.id, 'store-b'),
    ])

    // One connection per database, not per (database, store): our own
    // connections must never sit in the way of each other's upgrades.
    expect(a).toBe(b)
    expect(a.objectStoreNames.contains('store-a')).toBe(true)
    expect(a.objectStoreNames.contains('store-b')).toBe(true)
  })

  it('creates two stores requested concurrently', async ({ task }) => {
    // Seed the database so both stores have to take the version-upgrade path,
    // which is where a shared database can race itself.
    await ensureStore(task.id, 'seed')

    const a = createIndexedDBStorage<User>(task.id, 'store-a')
    const b = createIndexedDBStorage<User>(task.id, 'store-b')

    await Promise.all([
      a.setItem('user', { state: { name: 'Ann' }, version: VERSION }),
      b.setItem('user', { state: { name: 'Bob' }, version: VERSION }),
    ])

    await expect(a.getItem('user')).resolves.toEqual({
      state: { name: 'Ann' },
      version: VERSION,
    })
    await expect(b.getItem('user')).resolves.toEqual({
      state: { name: 'Bob' },
      version: VERSION,
    })
  })

  it('retries when another tab claims the version number first', async ({
    task,
  }) => {
    // Seed the database so creating `store-a` needs a version bump.
    await ensureStore(task.id, 'seed')

    const realOpen = indexedDB.open.bind(indexedDB)
    let hijacked = false
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(((
      name: string,
      version?: number,
    ) => {
      // Let "another tab" grab the first version number we reach for. Its
      // request is queued ahead of ours, so our `upgradeneeded` never runs
      // and the connection we get back is missing the store we asked for.
      if (version !== undefined && !hijacked) {
        hijacked = true
        const competitor = realOpen(name, version)
        competitor.onupgradeneeded = () =>
          competitor.result.createObjectStore('other-tab')
        competitor.onsuccess = () => competitor.result.close()
      }
      return realOpen(name, version)
    }) as typeof indexedDB.open)

    try {
      const database = await ensureStore(task.id, 'store-a')

      expect(hijacked).toBe(true)
      // The contract of `ensureStore`: a resolved connection always exposes the
      // requested store. Losing the version race must be retried away here, not
      // left for the caller's transaction to trip over.
      expect(database.objectStoreNames.contains('store-a')).toBe(true)

      const a = createIndexedDBStorage<User>(task.id, 'store-a')
      await a.setItem('user', { state: { name: 'Ann' }, version: VERSION })
      await expect(a.getItem('user')).resolves.toEqual({
        state: { name: 'Ann' },
        version: VERSION,
      })
    } finally {
      open.mockRestore()
    }
  })

  it('adds a store to a database that is already open', async ({ task }) => {
    const a = createIndexedDBStorage<User>(task.id, 'store-a')
    await a.setItem('user', { state: { name: 'Ann' }, version: VERSION })

    // `store-a` is connected and cached; adding `store-b` needs an upgrade that
    // must not be blocked by our own connection.
    const b = createIndexedDBStorage<User>(task.id, 'store-b')
    await b.setItem('user', { state: { name: 'Bob' }, version: VERSION })

    // The pre-existing store keeps working across the upgrade.
    await expect(a.getItem('user')).resolves.toEqual({
      state: { name: 'Ann' },
      version: VERSION,
    })
    await expect(storeKeys(task.id, 'store-b')).resolves.toEqual(['user'])
  })
})

describe('without IndexedDB', () => {
  it('keeps the helpers usable instead of throwing', async ({ task }) => {
    const original = globalThis.indexedDB
    globalThis.indexedDB = undefined as unknown as IDBFactory
    try {
      await expect(storeKeys(task.id, 'store')).resolves.toEqual([])
      await expect(clearStore(task.id, 'store')).resolves.toBeUndefined()
      await expect(deleteDatabase(task.id)).resolves.toBeUndefined()
    } finally {
      globalThis.indexedDB = original
    }
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
