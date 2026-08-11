import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/node.test.ts'],
          // `fake-indexeddb/auto` installs the IndexedDB globals so this project
          // runs in Node without a browser. It overwrites `globalThis.indexedDB`
          // unconditionally, which is exactly why it must never load in the
          // browser project below — it would silently shadow the real
          // implementation and leave those tests green while testing nothing.
          setupFiles: ['fake-indexeddb/auto'],
        },
      },
      {
        // Pre-bundle the peer dependency up front; discovering it mid-run makes
        // Vite reload the page and re-run the file.
        optimizeDeps: { include: ['zustand/middleware', 'zustand/vanilla'] },
        test: {
          name: 'browser',
          include: ['tests/browser*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [
              { browser: 'chromium' },
              {
                browser: 'webkit',
                // Two files need capabilities this build does not have: CDP
                // (to override the origin quota) and blob storage / OPFS.
                // Both files say which, and how it was measured.
                exclude: [
                  'tests/browser-quota.test.ts',
                  'tests/browser-chromium.test.ts',
                ],
              },
            ],
            // Failures are read from the terminal here; don't litter the repo
            // with screenshot artifacts.
            screenshotFailures: false,
          },
        },
      },
    ],
  },
})
