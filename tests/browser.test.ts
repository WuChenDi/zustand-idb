import { describe, expect, it, vi } from 'vitest'
import { createIndexedDBStorage, deleteDatabase, storeKeys } from '../src'
import { ensureStore, withStore } from '../src/db'
import type { User } from './utils'
import { VERSION } from './utils'

/** Open a connection this module does not manage, standing in for another tab. */
function openOutsider(
  databaseName: string,
  version?: number,
  onUpgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(databaseName)
        : indexedDB.open(databaseName, version)
    request.onupgradeneeded = () => onUpgrade?.(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    // An outsider that gets blocked means our own connection failed to step
    // aside, which is the bug these tests exist to catch.
    request.onblocked = () =>
      reject(new Error('blocked by a connection this package holds'))
  })
}

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

  it('retries a blocked upgrade until it clears', async ({ task }) => {
    // Seed the database so creating `store-a` needs a version bump (the call
    // that can be blocked by another tab's still-open connection).
    await ensureStore(task.id, 'seed')

    const realOpen = indexedDB.open.bind(indexedDB)
    let blockedOnce = false
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(((
      name: string,
      version?: number,
    ) => {
      // Block the first upgrade attempt the way another tab would, then let the
      // retry through.
      if (version !== undefined && !blockedOnce) {
        blockedOnce = true
        const request = {
          onblocked: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          result: null,
          error: null,
        } as unknown as IDBOpenDBRequest
        queueMicrotask(() => request.onblocked?.(new Event('blocked') as never))
        return request
      }
      return realOpen(name, version)
    }) as typeof indexedDB.open)

    try {
      const database = await ensureStore(task.id, 'store-a')

      expect(blockedOnce).toBe(true)
      expect(database.objectStoreNames.contains('store-a')).toBe(true)
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

describe('non-serializable values', () => {
  it('round-trips values JSON would mangle', async ({ task }) => {
    interface State {
      map: Map<string, number>
      set: Set<string>
      date: Date
      bytes: Uint8Array
    }
    const storage = createIndexedDBStorage<State>(task.id, 'store')

    await storage.setItem('user', {
      state: {
        map: new Map([['a', 1]]),
        set: new Set(['x']),
        date: new Date('2020-01-02T03:04:05.000Z'),
        bytes: new Uint8Array([1, 2, 3]),
      },
      version: VERSION,
    })

    // `JSON.stringify` turns every one of these into `{}` or a string.
    const loaded = await storage.getItem('user')
    expect(loaded?.state.map).toBeInstanceOf(Map)
    expect(loaded?.state.map.get('a')).toBe(1)
    expect(loaded?.state.set).toBeInstanceOf(Set)
    expect(loaded?.state.set.has('x')).toBe(true)
    expect(loaded?.state.date).toBeInstanceOf(Date)
    expect(loaded?.state.date.toISOString()).toBe('2020-01-02T03:04:05.000Z')
    expect(loaded?.state.bytes).toBeInstanceOf(Uint8Array)
    expect([...(loaded?.state.bytes ?? [])]).toEqual([1, 2, 3])
  })
})

describe('cross-connection cooperation', () => {
  it('steps aside so another connection can upgrade', async ({ task }) => {
    const storage = createIndexedDBStorage<User>(task.id, 'store')
    await storage.setItem('user', {
      state: { name: 'Ann' },
      version: VERSION,
    })
    const cached = await ensureStore(task.id, 'store')

    // Another tab bumps the version. `openOutsider` rejects if it is blocked,
    // so this only resolves when our `onversionchange` really closed the
    // cached connection.
    const outsider = await openOutsider(task.id, cached.version + 1, (db) =>
      db.createObjectStore('other-tab'),
    )

    try {
      // The cache must have been invalidated, and reads keep working by
      // transparently reconnecting.
      await expect(storage.getItem('user')).resolves.toEqual({
        state: { name: 'Ann' },
        version: VERSION,
      })
      await expect(ensureStore(task.id, 'store')).resolves.not.toBe(cached)
    } finally {
      outsider.close()
    }
  })

  it('rejects deleteDatabase while an outside connection holds it', async ({
    task,
  }) => {
    await ensureStore(task.id, 'store')
    // A connection with no `versionchange` handler — exactly the tab that does
    // not cooperate. No mocking: this really blocks the delete.
    const outsider = await openOutsider(task.id)

    try {
      const error = await deleteDatabase(task.id).catch((e) => e)

      expect(error.name).toBe('BlockedError')
      expect(error.message).toContain(`deleteDatabase "${task.id}"`)
    } finally {
      outsider.close()
    }
  })
})

describe('connection cache invalidation', () => {
  it('keeps one connection per database when a dead one is evicted', async ({
    task,
  }) => {
    const dead = await ensureStore(task.id, 'store')
    // Kill the cached connection the way a force-close does: `close()` fires
    // neither `close` nor `versionchange`, so the cache goes on handing it out.
    dead.close()

    // Trip over the dead connection, and in the same tick let another store
    // install a fresh cache entry. `withStore` suspends on its first `await`,
    // so the entry below is in place by the time the reconnect runs — and the
    // reconnect must evict only the dead entry, never that newer one.
    const reading = withStore(
      task.id,
      'store',
      'readonly',
      (store) => store.name,
    )
    const other = ensureStore(task.id, 'other')

    await reading

    // The documented invariant: one connection per database, shared by every
    // store in it. Dropping a live entry here would strand its connection
    // outside the cache and open a second one alongside it.
    expect(await other).toBe(await ensureStore(task.id, 'other'))
  })
})
