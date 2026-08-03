// Module-level connection cache: reuse a single connection per (db, store)
// so we don't reopen the database on every read/write, and so transactions on
// the same connection commit in call order (avoids out-of-order writes).
const connections = new Map<string, Promise<IDBDatabase>>()

const cacheKeyOf = (databaseName: string, storeName: string) =>
  `${databaseName}::${storeName}`

/**
 * Open (and cache) a connection to the target store. The connection closes
 * itself and drops out of the cache when another tab upgrades or deletes the
 * database, so it never blocks the other tab.
 */
export function getConnection(
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  const cacheKey = cacheKeyOf(databaseName, storeName)
  const cached = connections.get(cacheKey)
  if (cached) return cached

  const connection = openDatabase(databaseName, storeName).then((database) => {
    // Step aside when another tab needs to upgrade/delete the database, and
    // invalidate the cache so the next call reconnects.
    database.onversionchange = () => {
      database.close()
      connections.delete(cacheKey)
    }
    // Drop the stale connection from the cache whenever it closes.
    database.onclose = () => {
      connections.delete(cacheKey)
    }
    return database
  })
  // Never cache a rejected promise, otherwise every later call is dragged down
  // by the same failure.
  connection.catch(() => connections.delete(cacheKey))
  connections.set(cacheKey, connection)
  return connection
}

export function openDatabase(
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    // No explicit version: open the current version, or create the database
    // (version 1, firing `upgradeneeded`) when it does not exist yet.
    const openRequest = indexedDB.open(databaseName)

    openRequest.onerror = () => reject(openRequest.error)
    // Create the store here for a brand-new database.
    openRequest.onupgradeneeded = () =>
      createStoreIfMissing(openRequest, storeName)

    openRequest.onsuccess = () => {
      const database = openRequest.result
      if (database.objectStoreNames.contains(storeName)) {
        resolve(database)
        return
      }
      // Database exists but the store is missing: reopen at the next version to
      // trigger `upgradeneeded` and create the store.
      const nextVersion = database.version + 1
      database.close()

      const upgradeRequest = indexedDB.open(databaseName, nextVersion)
      upgradeRequest.onerror = () => reject(upgradeRequest.error)
      // Another tab holding an old connection blocks the upgrade; fail fast
      // instead of hanging forever.
      upgradeRequest.onblocked = () =>
        reject(new Error(`IndexedDB upgrade blocked: ${databaseName}`))
      upgradeRequest.onupgradeneeded = () =>
        createStoreIfMissing(upgradeRequest, storeName)
      upgradeRequest.onsuccess = () => resolve(upgradeRequest.result)
    }
  })
}

function createStoreIfMissing(request: IDBOpenDBRequest, storeName: string) {
  const database = request.result
  if (!database.objectStoreNames.contains(storeName)) {
    database.createObjectStore(storeName)
  }
}

/**
 * Run `callback` against the object store inside a transaction of the given
 * mode. Centralizes the connection → transaction → object store dance so
 * higher-level operations stay one-liners.
 */
export function withStore<T>(
  databaseName: string,
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => T | PromiseLike<T>,
): Promise<T> {
  return getConnection(databaseName, storeName).then((database) =>
    callback(database.transaction(storeName, mode).objectStore(storeName)),
  )
}

/** Read request: resolve as soon as the result is available (`onsuccess`). */
export function promisifyRequest<T = undefined>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Write request: resolve only after the owning transaction actually commits
 * (`oncomplete`). `request.onsuccess` merely means the request joined the
 * transaction; commit-time failures (e.g. `QuotaExceededError`) surface via
 * `transaction.onabort`, so this is the only way to report "storage full"
 * instead of silently swallowing it.
 */
export function commitTransaction(request: IDBRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = request.transaction
    request.onerror = () => reject(request.error)
    if (!transaction) {
      // A write request should always belong to a transaction; guard against
      // hanging forever just in case.
      request.onsuccess = () => resolve()
      return
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Delete an entire database (e.g. logout cleanup or schema migration). Closes
 * this module's cached connections first, otherwise the delete is blocked by
 * our own open connection.
 */
export function deleteDatabase(databaseName: string): Promise<void> {
  const prefix = `${databaseName}::`
  for (const [key, connection] of connections) {
    if (key.startsWith(prefix)) {
      connection.then((db) => db.close()).catch(() => {})
      connections.delete(key)
    }
  }
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error(`IndexedDB delete blocked: ${databaseName}`))
  })
}

/**
 * Clear every row in the store while keeping the database and its schema.
 * Lighter than `deleteDatabase` when you only need to drop the data.
 */
export function clearStore(
  databaseName: string,
  storeName: string,
): Promise<void> {
  return withStore(databaseName, storeName, 'readwrite', (store) =>
    commitTransaction(store.clear()),
  )
}

/**
 * List all row keys currently held in the store. Handy for inspecting or
 * managing several persisted stores that share the same database + store.
 */
export function storeKeys<KeyType extends IDBValidKey = IDBValidKey>(
  databaseName: string,
  storeName: string,
): Promise<KeyType[]> {
  return withStore(databaseName, storeName, 'readonly', (store) =>
    // getAllKeys() is typed as IDBValidKey[]; narrow to the caller's KeyType.
    promisifyRequest(store.getAllKeys() as unknown as IDBRequest<KeyType[]>),
  )
}
