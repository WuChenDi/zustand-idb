import { describe, expect, it } from 'vitest'
import { createIndexedDBStorage } from '../src'
import { VERSION } from './utils'

// Chromium-only, because Playwright's Linux WebKit build cannot run either
// case — measured, not assumed:
//
// - Blob writes abort 10 out of 10 times with "Error preparing Blob/File data
//   to be stored in object store", straight from raw IndexedDB with none of
//   this package involved. Chromium stores the same Blob 10 out of 10 times.
//   That is the build lacking blob storage outright, not the intermittent
//   WebKit abort `isTransientBlobError` retries around.
// - `navigator.storage.getDirectory` is undefined, so there is no OPFS handle
//   to persist. Real Safari has shipped both since 15.2.
describe('non-serializable values (Chromium-only capabilities)', () => {
  it('round-trips a Blob', async ({ task }) => {
    const storage = createIndexedDBStorage<{ file: Blob }>(task.id, 'store')

    await storage.setItem('user', {
      state: { file: new Blob(['hello'], { type: 'text/plain' }) },
      version: VERSION,
    })

    const loaded = await storage.getItem('user')
    expect(loaded?.state.file).toBeInstanceOf(Blob)
    expect(loaded?.state.file.type).toBe('text/plain')
    await expect(loaded?.state.file.text()).resolves.toBe('hello')
  })

  it('round-trips a FileSystemFileHandle', async ({ task }) => {
    // The headline use case: a handle the user picked stays usable after a
    // reload. It only exists in a browser, and only IndexedDB can store it.
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('picked.txt', { create: true })
    const writable = await handle.createWritable()
    await writable.write('picked by the user')
    await writable.close()

    const storage = createIndexedDBStorage<{ handle: FileSystemFileHandle }>(
      task.id,
      'store',
    )
    await storage.setItem('files', { state: { handle }, version: VERSION })

    const restored = (await storage.getItem('files'))?.state.handle
    expect(restored).toBeInstanceOf(FileSystemFileHandle)
    const file = await restored?.getFile()
    await expect(file?.text()).resolves.toBe('picked by the user')
  })
})
