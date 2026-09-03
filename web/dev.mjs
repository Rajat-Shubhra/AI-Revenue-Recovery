// Carried from Quark's web/dev.mjs.
//
// We start Vite through its JS API instead of the `vite` CLI because npm's
// .bin shim fails silently for Vite on this machine — `npx vite` leaves a live
// node process that prints nothing and never opens a listener. Verified again
// in this repo before this file existed. The native config loader keeps Vite
// from writing a bundled temp config, which fails here too.
// Configuration lives in vite.config.mjs; `root` is pinned so any cwd works.
import { createServer } from 'vite'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const cacheDir = path.join(webRoot, '.vite-cache')

async function start() {
  const server = await createServer({ root: webRoot, configLoader: 'native' })
  await server.listen()
  server.printUrls()
}

try {
  await start()
} catch (error) {
  // After a dependency change Vite re-optimizes, which means deleting the old
  // dep cache — and that intermittently fails with EPERM here when something
  // still holds a handle on those files. Clearing and retrying fixes it when
  // the holder is gone; when it isn't, say so plainly instead of dying on a
  // stack trace, because the fix is to stop the process still holding it.
  if (error?.code !== 'EPERM' && error?.code !== 'ENOENT') throw error

  console.warn(`[dev] ${error.code} on the Vite cache — clearing it and retrying once`)
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {})

  try {
    await start()
  } catch (retryError) {
    if (retryError?.code !== 'EPERM' && retryError?.code !== 'ENOENT') throw retryError
    console.error(
      `\n[dev] Vite's dep cache is still locked by another process.\n` +
        `      Stop every node process for this repo, delete web/.vite-cache,\n` +
        `      then run npm run dev again.\n`,
    )
    process.exit(1)
  }
}
