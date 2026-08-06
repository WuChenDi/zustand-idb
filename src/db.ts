/**
 * Module-level connection cache: one connection per database, shared by every
 * object store inside it. Keeping it per-database (rather than per db+store)
 * means our own connections never block each other's upgrades, and transactions
 * issued on the shared connection commit in call order (avoids out-of-order
 * writes).
 */
type DatabaseEntry = {
  connection: Promise<IDBDatabase>
  /** Object stores the cached connection is known to expose. */
  stores: Set<string>
}

const databases = new Map<string, DatabaseEntry>()

/** An upgrade can lose a version race against another tab; bound the retries. */
const MAX_OPEN_ATTEMPTS = 5

/**
 * WebKit intermittently aborts a Blob/File write while "preparing" the data;
 * the identical value stores fine on a later attempt. Bound the retries and
 * back off a little between them so a genuinely stuck write still surfaces.
 */
const MAX_BLOB_WRITE_RETRIES = 3
const BLOB_RETRY_DELAY_MS = 50

/**
 * IndexedDB is missing entirely in SSR and some sandboxed contexts. Note that
 * "present" does not imply "usable": `open()` still throws in Firefox private
 * mode, which is why callers must also handle a rejected connection.
 */
function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

/**
 * Resolve a cached connection guaranteed to expose `storeName`, opening or
 * upgrading the database as needed. Work on a database is chained onto whatever
 * is already in flight for it, so two stores can never race each other into a
 * version conflict.
 */
export function ensureStore(
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  const current = databases.get(databaseName)
  if (current?.stores.has(storeName)) return current.connection

  // The `stores` set doubles as this entry's identity token, so asynchronous
  // cleanup only ever evicts itself and never a newer connection.
  const stores = new Set<string>()
  const evict = () => {
    if (databases.get(databaseName)?.stores === stores) {
      databases.delete(databaseName)
    }
  }

  const track = (database: IDBDatabase) => {
    for (const name of database.objectStoreNames) stores.add(name)
    // Rebind on every adoption: an inherited connection still points at the
    // previous entry's (now stale) eviction closure.
    //
    // Step aside when another tab needs to upgrade/delete the database, and
    // invalidate the cache so the next call reconnects.
    database.onversionchange = () => {
      database.close()
      evict()
    }
    // Drop the stale connection from the cache whenever it closes abnormally.
    database.onclose = evict
    return database
  }

  const adopt = async (existing?: IDBDatabase) => {
    // The chained connection may already carry the store we need.
    if (existing?.objectStoreNames.contains(storeName)) return track(existing)
    existing?.close()
    return track(await openWithStore(databaseName, storeName))
  }

  const previous = current?.connection
  const connection = previous
    ? previous.then(adopt, () => adopt(undefined))
    : adopt(undefined)

  databases.set(databaseName, { connection, stores })
  // Never leave a rejected connection cached, otherwise every later call is
  // dragged down by the same failure.
  connection.catch(evict)
  return connection
}

/**
 * Open `databaseName` and guarantee `storeName` exists on the returned
 * connection.
 */
async function openWithStore(
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  if (!isIndexedDBAvailable()) {
    throw new Error('IndexedDB is not available in this environment')
  }

  for (let attempt = 0; attempt < MAX_OPEN_ATTEMPTS; attempt++) {
    // No explicit version: open the current version, or create the database
    // (version 1, firing `upgradeneeded`) when it does not exist yet.
    const database = await requestOpen(databaseName, undefined, storeName)
    if (database.objectStoreNames.contains(storeName)) return database

    // Database exists but the store is missing: reopen at the next version to
    // trigger `upgradeneeded` and create the store.
    const nextVersion = database.version + 1
    database.close()

    const upgraded = await requestOpen(databaseName, nextVersion, storeName)
    // Another tab may have claimed this version number first, in which case our
    // `upgradeneeded` never ran and the store is still missing. Start over.
    if (upgraded.objectStoreNames.contains(storeName)) return upgraded
    upgraded.close()
  }

  throw new Error(
    `IndexedDB could not create object store: ${databaseName}/${storeName}`,
  )
}

/**
 * Promisified `indexedDB.open`, creating `storeName` whenever an upgrade
 * transaction is available.
 */
function requestOpen(
  databaseName: string,
  version: number | undefined,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(databaseName)
        : indexedDB.open(databaseName, version)
    let settled = false

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName)
      }
    }
    request.onerror = () => {
      settled = true
      reject(request.error)
    }
    // Another tab holding an old connection blocks the upgrade; fail fast
    // instead of hanging forever.
    request.onblocked = () => {
      settled = true
      reject(new Error(`IndexedDB upgrade blocked: ${databaseName}`))
    }
    request.onsuccess = () => {
      // A blocked upgrade still succeeds once the other tab lets go. Nobody is
      // waiting on it any more, so close it rather than leak a connection that
      // would go on to block every later upgrade.
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
  })
}

/**
 * Run `callback` against the object store inside a transaction of the given
 * mode. Centralizes the connection → transaction → object store dance so
 * higher-level operations stay one-liners.
 */
export async function withStore<T>(
  databaseName: string,
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => T | PromiseLike<T>,
): Promise<T> {
  let reconnected = false
  let blobRetries = 0
  for (;;) {
    const database = await ensureStore(databaseName, storeName)
    try {
      return await callback(
        database.transaction(storeName, mode).objectStore(storeName),
      )
    } catch (error) {
      // Another tab's upgrade can close the connection between resolving it and
      // using it. Reconnect once — every operation routed through here is
      // idempotent, so a retry is safe.
      if (!reconnected && isClosedConnection(error)) {
        reconnected = true
        // `onversionchange` normally evicts the entry already; drop it here too
        // in case the connection died without firing either handler.
        databases.delete(databaseName)
        continue
      }
      // WebKit intermittently aborts a Blob/File write while "preparing" the
      // data; the same value stores fine moments later. Retry a bounded number
      // of times with a short backoff, keeping the connection as-is (only the
      // transaction aborted). Once the budget is spent the error surfaces, so a
      // genuinely failing write is never silently dropped.
      if (isTransientBlobError(error) && blobRetries < MAX_BLOB_WRITE_RETRIES) {
        blobRetries++
        await delay(BLOB_RETRY_DELAY_MS * blobRetries)
        continue
      }
      throw error
    }
  }
}

/** A transaction on a connection that has already been closed. */
function isClosedConnection(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError'
}

/**
 * WebKit's transient Blob/File write failure. Matched by message because the
 * DOMException name (`UnknownError`) is far too broad to key off of, while the
 * message is a fixed English constant across WebKit versions.
 */
function isTransientBlobError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.message.includes('Blob/File data')
  )
}

/** Resolve after `ms` milliseconds; used to back off between write retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
 * this module's cached connection first, otherwise the delete is blocked by our
 * own open connection. No-op when IndexedDB is unavailable.
 */
export async function deleteDatabase(databaseName: string): Promise<void> {
  if (!isIndexedDBAvailable()) return

  const entry = databases.get(databaseName)
  databases.delete(databaseName)
  // Await the close: scheduling it is not enough, since a connection still in
  // its opening phase would otherwise block the delete request below.
  if (entry) {
    await entry.connection.then(
      (database) => database.close(),
      () => {},
    )
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
 * Lighter than `deleteDatabase` when you only need to drop the data. No-op when
 * IndexedDB is unavailable.
 */
export async function clearStore(
  databaseName: string,
  storeName: string,
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  return withStore(databaseName, storeName, 'readwrite', (store) =>
    commitTransaction(store.clear()),
  )
}

/**
 * List all row keys currently held in the store. Handy for inspecting or
 * managing several persisted stores that share the same database + store.
 * Resolves with an empty array when IndexedDB is unavailable.
 */
export async function storeKeys<KeyType extends IDBValidKey = IDBValidKey>(
  databaseName: string,
  storeName: string,
): Promise<KeyType[]> {
  if (!isIndexedDBAvailable()) return []
  return withStore(databaseName, storeName, 'readonly', (store) =>
    // getAllKeys() is typed as IDBValidKey[]; narrow to the caller's KeyType.
    promisifyRequest(store.getAllKeys() as unknown as IDBRequest<KeyType[]>),
  )
}
