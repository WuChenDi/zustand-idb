import { describe, expect, it, vi } from 'vitest'
import { createIndexedDBStorage, storeKeys } from '../src'
import { ensureStore } from '../src/db'
import type { User } from './utils'
import { VERSION } from './utils'

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
