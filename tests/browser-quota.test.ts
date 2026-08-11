/// <reference types="@vitest/browser-playwright" />
import { expect, it } from 'vitest'
import { cdp } from 'vitest/browser'
import { createIndexedDBStorage } from '../src'
import { VERSION } from './utils'

// Kept in its own file on purpose: Chromium settles an origin's quota the first
// time the page touches storage, so `overrideQuotaForOrigin` only takes effect
// while the page is still untouched. Sharing a page with the other browser
// tests would silently make the write succeed and the assertion vacuous.
it('rejects setItem with QuotaExceededError instead of resolving', async ({
  task,
}) => {
  const storage = createIndexedDBStorage<{ bytes: Uint8Array }>(
    task.id,
    'store',
  )

  const session = cdp()
  await session.send('Storage.overrideQuotaForOrigin', {
    origin: location.origin,
    quotaSize: 4096,
  })
  try {
    const error = await storage
      .setItem('user', {
        state: { bytes: new Uint8Array(8 * 1024 * 1024) },
        version: VERSION,
      })
      .catch((e) => e)

    // `request.onsuccess` fires happily on an over-quota write; only waiting
    // for the transaction to *commit* surfaces the failure. Resolving here
    // would mean silently losing the user's data.
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('QuotaExceededError')
    expect(error.message).toContain(`setItem "user" on "${task.id}/store"`)
  } finally {
    await session.send('Storage.overrideQuotaForOrigin', {
      origin: location.origin,
    })
  }
})
