# `@cdlab/zustand-idb`

[![npm version](https://img.shields.io/npm/v/@cdlab/zustand-idb)](https://www.npmjs.com/package/@cdlab/zustand-idb)
[![license](https://img.shields.io/npm/l/@cdlab/zustand-idb)](./LICENSE)

Persist [Zustand](https://github.com/pmndrs/zustand) stores in IndexedDB — including the **non-serializable** values `localStorage` can't hold (a `FileSystemFileHandle`, a `Blob`, a `Map`, …).

```ts
import { createStore } from 'zustand'
import { persist } from 'zustand/middleware'
import { createIndexedDBStorage } from '@cdlab/zustand-idb'

const useFileStore = createStore(
  persist(() => ({ handle: null as FileSystemFileHandle | null }), {
    name: 'files',
    storage: createIndexedDBStorage('my-app', 'stores'),
  }),
)
```

## Why

- **Persists non-serializable state** — IndexedDB uses the structured clone algorithm, so file handles, blobs, `Map`/`Set`, typed arrays, and `Date`s survive a reload. `JSON.stringify` would mangle them.
- **A drop-in `persist` storage** — implements Zustand's `PersistStorage`, so `version`, `migrate`, `partialize`, and `onRehydrateStorage` keep working unchanged.
- **One database, many stores** — every `persist({ name })` maps to its own row, so unrelated stores can share a single database + object store instead of needing one database each.
- **Robust connection handling** — a single cached connection per database (writes stay ordered), automatic object-store creation that survives losing a version race against another tab, cooperative `versionchange` handling so other tabs are never blocked, and writes that resolve only after the transaction commits (so `QuotaExceededError` surfaces instead of being swallowed).
- **Graceful fallback** — when IndexedDB is unavailable it transparently falls back to in-memory storage so hydration never crashes. Availability is decided by actually connecting, which covers both a missing global (SSR) and a global that refuses to open (Firefox private mode, Safari ITP).
- **Tiny and typed** — ESM + CJS, full TypeScript types, `zustand` as the only peer dependency.

## Install

```bash
npm install zustand @cdlab/zustand-idb
# or
pnpm add zustand @cdlab/zustand-idb
```

## Quick start

```ts
import { createStore } from 'zustand'
import { persist } from 'zustand/middleware'
import { createIndexedDBStorage } from '@cdlab/zustand-idb'

const useUserStore = createStore(
  persist(() => ({ name: 'John' }), {
    name: 'user',
    version: 0.1,
    storage: createIndexedDBStorage('my-app', 'stores'),
  }),
)
```

Because IndexedDB is asynchronous, `persist` hydrates the store **after** creation. Await writes, and wait for hydration when you need the persisted value to be present:

```ts
// Wait until the persisted state has been loaded.
await new Promise((resolve) =>
  useUserStore.persist.onFinishHydration(resolve),
)

// setState resolves once the change has been committed to IndexedDB.
await useUserStore.setState({ name: 'Kaley' })
```

> `getState()` stays synchronous — the store hydrates asynchronously once, then keeps its state in memory and returns the latest value immediately.

## API

### `createIndexedDBStorage(databaseName, storeName)`

- `databaseName` (`string`) — the IndexedDB database to open (created on first use).
- `storeName` (`string`) — the object store within it. This is **not** a Zustand store; it's the IndexedDB compartment your rows live in.

Returns a Zustand `PersistStorage` that reads, writes, and deletes state in that object store. The `name` option of your `persist()` middleware is used as the **row key**, so multiple stores can share one `databaseName` + `storeName` while each keeps its own rehydration and migration logic.

When IndexedDB turns out to be unavailable, the storage degrades to an in-memory implementation on first use and warns once: hydration and state stay usable for the session, but nothing is persisted. Only failures to *connect* degrade — an error raised by a running transaction (`QuotaExceededError`, a value that can't be structured-cloned, …) rejects normally so you can handle it. See [Error handling](#error-handling) for the shape of those rejections.

### `deleteDatabase(databaseName)`

Closes any connection this package holds to `databaseName` — waiting for the close to land — and deletes the entire database. Useful for logout cleanup or schema resets. Rejects with a `BlockedError` if the deletion is blocked by a connection held elsewhere (e.g. another tab), and resolves as a no-op when IndexedDB is unavailable.

```ts
import { deleteDatabase } from '@cdlab/zustand-idb'

await deleteDatabase('my-app')
```

### `clearStore(databaseName, storeName)`

Removes every row from one object store while keeping the database and its schema. Lighter than `deleteDatabase` when you only need to drop the data. Resolves as a no-op when IndexedDB is unavailable.

```ts
import { clearStore } from '@cdlab/zustand-idb'

await clearStore('my-app', 'stores')
```

### `storeKeys(databaseName, storeName)`

Resolves with every row key in the object store, in ascending order. Since each `persist({ name })` maps to a row, this lists all persisted stores sharing the compartment — handy for inspection or bulk management. Resolves with `[]` when IndexedDB is unavailable.

Note that this creates the database and object store if they don't exist yet, rather than reporting them as absent — probing without creating would need `indexedDB.databases()`, which Firefox does not implement.

```ts
import { storeKeys } from '@cdlab/zustand-idb'

await storeKeys('my-app', 'stores') // => ['files', 'user']
```

## Error handling

IndexedDB reports failures as bare `DOMException`s with no stack and a message that names neither the database, the store, nor the row — `Failed to write blobs (IOError)` on its own is unactionable in a production report. Every rejection from this package is therefore wrapped in an `Error` that adds that context:

```
[zustand-idb] setItem "user" on "my-app/stores" failed: UnknownError: Failed to write blobs (IOError)
```

Two things are preserved so you can still branch on the failure:

- **`error.name`** is carried over from the original, so the usual checks keep working.
- **`error.cause`** holds the original `DOMException` untouched.

```ts
try {
  await useStore.persist.rehydrate()
} catch (error) {
  if (error.name === 'QuotaExceededError') {
    // Out of disk: prompt the user to free space, or drop cached data.
  }
  // The untouched DOMException, if you need `instanceof` or extra fields.
  console.error(error.cause)
}
```

Note that `error instanceof DOMException` is `false` on the wrapper — use `error.name`, or reach through `error.cause`.

Some failures are retried internally before they ever reach you: transient Blob/File write aborts (WebKit and Chromium), a connection closed by another tab's upgrade, and an upgrade momentarily blocked by another tab. What surfaces has already outlived a bounded retry budget, so treat it as a real failure rather than jitter — `InvalidBlob` usually means the source Blob/File is no longer readable, and `IOError` points at the disk itself.

One case never reaches your `catch` at all: a block that outlives the budget while the storage is still opening its *first* connection counts as a connection failure, so it degrades to in-memory storage and warns instead of rejecting. Past that first connection — and on `clearStore` / `storeKeys` / `deleteDatabase`, which never degrade — a spent block rejects with a `BlockedError`.

## How it works

- **Connection cache** — one `IDBDatabase` connection is opened per `databaseName` and shared by every object store inside it. Keeping it per-database rather than per store means this package's own connections never block each other's upgrades. Transactions on a shared connection commit in call order, so rapid successive writes never land out of order.
- **Automatic store creation** — opening a database without a fixed version number lets a brand-new database create the object store on first use; if the database already exists but the store is missing, it is created via a one-step version bump. Work on a database is serialized, and an upgrade that loses its version race against another tab is retried, so the resolved connection always exposes the store you asked for.
- **Commit-accurate writes** — a write resolves on the transaction's `complete` event, not merely when the request is queued, so commit-time errors such as `QuotaExceededError` reject the promise instead of being lost. Rejections carry the failing operation, row, and store; see [Error handling](#error-handling).
- **Cross-tab safety** — the cached connection listens for `versionchange` and closes itself so another tab can upgrade or delete the database without being blocked.

## FAQ

### Why not `idb-keyval`?

[`idb-keyval`](https://github.com/jakearchibald/idb-keyval) is excellent, but its `createStore` won't create multiple stores within one database, nor create a store inside an existing database — so you'd need a separate database per Zustand store. This package keeps them in one compartment, keyed by the `persist` `name`.

### How do I combine it with `createJSONStorage`?

You don't. The point of IndexedDB here is to persist **non-serializable** data. If your state is JSON-serializable, a regular web storage (`localStorage`, `sessionStorage`) with `createJSONStorage` is simpler.

### Why does Next.js log `IndexedDB is unavailable` on startup?

```
[zustand-idb] IndexedDB is unavailable for "my-app/stores"; falling back to
in-memory storage. State will not be persisted. Error: IndexedDB is not
available in this environment
```

`persist` hydrates the store as soon as it is created. In an SSR framework such as Next.js the module is also evaluated on the server, where IndexedDB does not exist — so that first hydration probes IndexedDB, fails, and warns. Nothing is broken (the server transparently falls back to in-memory), but the warning is noisy because persisting on the server makes no sense anyway.

Skip the automatic hydration and trigger it once on the client instead:

```ts
const useStore = create(
  persist(() => ({ /* ... */ }), {
    name: 'stores',
    storage: createIndexedDBStorage('my-app', 'stores'),
    // IndexedDB is browser-only: don't hydrate during SSR.
    skipHydration: true,
  }),
)

// Runs only in the browser, so the server never touches IndexedDB.
if (typeof window !== 'undefined') {
  void useStore.persist.rehydrate()
}
```

`skipHydration` defers the initial load; `hasHydrated()` / `onFinishHydration()` still fire once the client-side `rehydrate()` completes, so gate any UI that needs the persisted value on those.

### Does it work in private / incognito mode?

Yes, but persistence guarantees differ by browser and are outside this package's control:

- **Firefox private mode** refuses to open IndexedDB at all. The connection probe fails and this package transparently falls back to in-memory storage — state stays usable for the session but is never persisted.
- **Chrome / Edge incognito** allow IndexedDB, so everything works normally, but the entire database is discarded when the last incognito window closes. Persistence is real within the session only.

Nothing here throws; just don't rely on data outliving the private session.

### My data disappears in Safari after a while

Safari's [Intelligent Tracking Prevention](https://webkit.org/tracking-prevention/) evicts script-writable storage — including IndexedDB — after **7 days** without user interaction with the site. This is a browser policy, not a bug in this package: reads simply start returning `null` (no error is raised), so treat persisted values as a cache that can vanish and always keep a sensible default in your initial state.

### What happens when several tabs are open?

Handled cooperatively. Each database uses one shared, cached connection that listens for `versionchange` and steps aside so another tab can upgrade or delete without being blocked. A store creation that loses a version race, or an upgrade momentarily blocked by another tab's connection, is retried a bounded number of times, so the connection you get always exposes the store you asked for. Writes on the shared connection commit in call order, keeping rapid successive writes from landing out of order.

## Development

```bash
pnpm install
pnpm run browsers    # one-off: Chromium for the browser test project
pnpm run build       # ESM + CJS via tsdown
pnpm run test        # both test projects
pnpm run test:node   # vitest against fake-indexeddb in Node
pnpm run test:browser # vitest against a real Chromium IndexedDB
pnpm run typecheck
pnpm run lint
```

## License

[MIT](./LICENSE) License © 2026-PRESENT [wudi](https://github.com/WuChenDi)
