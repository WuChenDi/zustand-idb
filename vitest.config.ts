import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `fake-indexeddb/auto` installs the IndexedDB globals so the suite runs
    // in Node without a real browser.
    setupFiles: ['fake-indexeddb/auto'],
  },
})
