/**
 * Module-level connection cache: one connection per database, shared by every
 * object store inside it. Keeping it per-database (rather than per db+store)
 * means our own connections never block each other's upgrades, and transactions
 * issued on the shared connection commit in call order (avoids out-of-order
 * writes).
 */
type DatabaseEntry = {
  connection: Promise<IDBDatabase>
  /** The resolved connection, once available. Absent while still opening. */
  database?: IDBDatabase
}

const databases = new Map<string, DatabaseEntry>()

/**
 * Drop `entry` from the cache unless a newer one has already replaced it.
 *
 * Every eviction goes through here. Deleting by database name alone would let
 * a late cleanup — an `onclose` for a long-dead connection, say — take out a
 * healthy entry opened in the meantime, stranding its connection outside the
 * cache while a second one is opened alongside it.
 */
function evict(databaseName: string, entry: DatabaseEntry): void {
  if (databases.get(databaseName) === entry) databases.delete(databaseName)
}

/** An upgrade can lose a version race against another tab; bound the retries. */
const MAX_OPEN_ATTEMPTS = 5

/**
 * WebKit and Chromium both intermittently abort a Blob/File write; the
 * identical value stores fine on a later attempt. Bound the retries and back
 * off a little between them so a genuinely stuck write still surfaces.
 */
const MAX_BLOB_WRITE_RETRIES = 3
const BLOB_RETRY_DELAY_MS = 50

/**
 * A blocked open/upgrade is transient: another tab is holding an older
 * connection and is being asked to close it. Back off between retries so it has
 * a moment to let go before we give up.
 */
const BLOCKED_RETRY_DELAY_MS = 50

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
  if (current?.database?.objectStoreNames.contains(storeName)) {
    return current.connection
  }

  // Assigned below, before any of the closures can run.
  let entry: DatabaseEntry
  const evictSelf = () => evict(databaseName, entry)

  const track = (database: IDBDatabase) => {
    entry.database = database
    // Rebind on every adoption: an inherited connection still points at the
    // previous entry's (now stale) eviction closure.
    //
    // Step aside when another tab needs to upgrade/delete the database, and
    // invalidate the cache so the next call reconnects.
    database.onversionchange = () => {
      database.close()
      evictSelf()
    }
    // Drop the stale connection from the cache whenever it closes abnormally.
    database.onclose = evictSelf
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

  entry = { connection }
  databases.set(databaseName, entry)
  // Never leave a rejected connection cached, otherwise every later call is
  // dragged down by the same failure.
  connection.catch(evictSelf)
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
    try {
      // No explicit version: open the current version, or create the database
      // (version 1, firing `upgradeneeded`) when it does not exist yet.
      const database = await requestOpen(databaseName, undefined, storeName)
      if (database.objectStoreNames.contains(storeName)) return database

      // Database exists but the store is missing: reopen at the next version to
      // trigger `upgradeneeded` and create the store.
      const nextVersion = database.version + 1
      database.close()

      const upgraded = await requestOpen(databaseName, nextVersion, storeName)
      // Another tab may have claimed this version number first, in which case
      // our `upgradeneeded` never ran and the store is still missing. Retry.
      if (upgraded.objectStoreNames.contains(storeName)) return upgraded
      upgraded.close()
    } catch (error) {
      // A block is transient: another tab holds an older connection and its
      // `onversionchange` is being asked to close it. Back off and retry within
      // the attempt budget instead of failing the whole open (this also keeps a
      // momentary block during the first probe from demoting the session to
      // in-memory storage). A block that outlives the budget still surfaces.
      if (isBlocked(error) && attempt < MAX_OPEN_ATTEMPTS - 1) {
        await delay(BLOCKED_RETRY_DELAY_MS * (attempt + 1))
        continue
      }
      throw error
    }
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
    // Another tab holding an old connection blocks the upgrade. Reject with a
    // tagged error so `openWithStore` can retry a bounded number of times (the
    // other tab usually closes on `onversionchange`) rather than hang forever.
    request.onblocked = () => {
      settled = true
      reject(blockedError(`upgrade for "${databaseName}"`))
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
        // in case the connection died without firing either handler. Match on
        // the connection we actually tripped over, so an entry opened
        // concurrently is left in place rather than replaced by a second one.
        const entry = databases.get(databaseName)
        if (entry?.database === database) evict(databaseName, entry)
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

/**
 * Run `operation` and re-throw any failure tagged with where it came from.
 *
 * IndexedDB reports failures as bare `DOMException`s: no stack, and a message
 * ("Failed to write blobs (IOError)") naming neither the database, the store,
 * nor the row. A production report built from `error.message` alone is then
 * unactionable, so prefix the context and keep the original as `cause`.
 *
 * The original's `name` is carried over: callers branch on
 * `error.name === 'QuotaExceededError'`, and a wrapper left named "Error" would
 * fail that check silently — turning "disk is full" into an unrecognized error
 * rather than a loud one.
 */
export async function tagFailure<T>(
  description: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const tagged = new Error(
      `[zustand-idb] ${description} failed: ${detail(error)}`,
      { cause: error },
    )
    if (error instanceof Error && error.name !== 'Error') {
      tagged.name = error.name
    }
    throw tagged
  }
}

/**
 * The readable part of a thrown value. Keeps the `DOMException` name, which
 * carries the actual failure class (`QuotaExceededError`, `UnknownError`, …),
 * but drops the noise of a plain `Error` always being named "Error".
 */
function detail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.name && error.name !== 'Error'
    ? `${error.name}: ${error.message}`
    : error.message
}

/** Describe a store-scoped operation for {@link tagFailure}. */
export function describeStore(
  databaseName: string,
  storeName: string,
  operation: string,
  rowKey?: string,
): string {
  const target = rowKey === undefined ? '' : ` "${rowKey}"`
  return `${operation}${target} on "${databaseName}/${storeName}"`
}

/** A transaction on a connection that has already been closed. */
function isClosedConnection(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError'
}

/**
 * Build the tagged error used to signal (and later detect) an operation blocked
 * by a connection held elsewhere, typically another tab.
 */
function blockedError(what: string): Error {
  const error = new Error(`IndexedDB ${what} blocked by another connection`)
  error.name = 'BlockedError'
  return error
}

/** A `blockedError` raised while another tab held the database open. */
function isBlocked(error: unknown): boolean {
  return error instanceof Error && error.name === 'BlockedError'
}

/**
 * A transient Blob/File write failure. Matched by message because the
 * DOMException name (`UnknownError`) is far too broad to key off of, while the
 * messages are fixed English constants: WebKit reports "Blob/File data" and
 * Chromium reports "Failed to write blobs".
 */
function isTransientBlobError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.message.includes('Blob/File data') ||
      error.message.includes('Failed to write blobs'))
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

  return tagFailure(
    `deleteDatabase "${databaseName}"`,
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        // `tagFailure` already names the database; don't repeat it here.
        request.onblocked = () => reject(blockedError('delete'))
      }),
  )
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
  return tagFailure(describeStore(databaseName, storeName, 'clearStore'), () =>
    withStore(databaseName, storeName, 'readwrite', (store) =>
      commitTransaction(store.clear()),
    ),
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
  return tagFailure(describeStore(databaseName, storeName, 'storeKeys'), () =>
    withStore(databaseName, storeName, 'readonly', (store) =>
      // getAllKeys() is typed as IDBValidKey[]; narrow to the caller's KeyType.
      promisifyRequest(store.getAllKeys() as unknown as IDBRequest<KeyType[]>),
    ),
  )
}
