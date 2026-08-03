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
- **Graceful fallback** — when IndexedDB is unavailable (private mode, SSR, disabled), it transparently falls back to in-memory storage so hydration never crashes.
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

When IndexedDB is unavailable, the returned storage is an in-memory implementation instead: hydration and state stay usable for the session, but nothing is persisted.

### `deleteDatabase(databaseName)`

Closes any connection this package holds to `databaseName` — waiting for the close to land — and deletes the entire database. Useful for logout cleanup or schema resets. Rejects if the deletion is blocked by a connection held elsewhere (e.g. another tab), and resolves as a no-op when IndexedDB is unavailable.

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

## How it works

- **Connection cache** — one `IDBDatabase` connection is opened per `databaseName` and shared by every object store inside it. Keeping it per-database rather than per store means this package's own connections never block each other's upgrades. Transactions on a shared connection commit in call order, so rapid successive writes never land out of order.
- **Automatic store creation** — opening a database without a fixed version number lets a brand-new database create the object store on first use; if the database already exists but the store is missing, it is created via a one-step version bump. Work on a database is serialized, and an upgrade that loses its version race against another tab is retried, so the resolved connection always exposes the store you asked for.
- **Commit-accurate writes** — a write resolves on the transaction's `complete` event, not merely when the request is queued, so commit-time errors such as `QuotaExceededError` reject the promise instead of being lost.
- **Cross-tab safety** — the cached connection listens for `versionchange` and closes itself so another tab can upgrade or delete the database without being blocked.

## FAQ

### Why not `idb-keyval`?

[`idb-keyval`](https://github.com/jakearchibald/idb-keyval) is excellent, but its `createStore` won't create multiple stores within one database, nor create a store inside an existing database — so you'd need a separate database per Zustand store. This package keeps them in one compartment, keyed by the `persist` `name`.

### How do I combine it with `createJSONStorage`?

You don't. The point of IndexedDB here is to persist **non-serializable** data. If your state is JSON-serializable, a regular web storage (`localStorage`, `sessionStorage`) with `createJSONStorage` is simpler.

## Development

```bash
pnpm install
pnpm run build       # ESM + CJS via tsdown
pnpm run test        # vitest, running against fake-indexeddb in Node
pnpm run typecheck
pnpm run lint
```

## License

[MIT](./LICENSE) License © 2026-PRESENT [wudi](https://github.com/WuChenDi)
