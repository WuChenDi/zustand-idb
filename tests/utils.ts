import { ensureStore, promisifyRequest } from '../src/db'

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
