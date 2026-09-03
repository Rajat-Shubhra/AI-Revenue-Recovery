// Carried from Quark's web/build.mjs — same rationale as dev.mjs: the `vite`
// CLI via npm's .bin shim fails silently on this machine, so we call the JS API
// with the native config loader. Configuration lives in vite.config.mjs.
//
// NOT YET VERIFIED in this repo — only the dev server was tested.
import { build } from 'vite'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))

await build({ root: webRoot, configLoader: 'native' })
