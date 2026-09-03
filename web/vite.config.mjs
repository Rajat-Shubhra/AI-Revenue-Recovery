// Carried from Quark's web/vite.config.mjs — the Supabase/env plumbing stripped,
// the Windows workarounds kept, because both failures it works around reproduced
// on this machine on the first `npx vite` run in this repo.
//
// Plain ESM (not .ts) so Vite can load it with the native config loader and skip
// the esbuild temp-file bundling step that fails on this setup.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Keep the dep-optimizer cache out of node_modules. Writes under
  // web/node_modules/.vite intermittently fail with EPERM/ENOENT here (AV or
  // the search indexer holding handles), which stalls the optimizer — and
  // because Vite holds requests until it finishes, the dev server accepts
  // connections but never responds. Observed exactly that before this line.
  cacheDir: '.vite-cache',
  resolve: {
    // The root package.json declares `workspaces: ["web"]`, and workspaces make
    // it easy to end up with two copies of React — one hoisted to the repo root,
    // one under web/. When that happens the app binds to a different React than
    // its libraries, hooks break, and the dev server stops responding. React is
    // NOT hoisted as of this install; this keeps it that way if deps shift.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // Pin to IPv4. Left to itself, Node resolved "localhost" to ::1 and bound
    // IPv6 only, so http://127.0.0.1:5178 never answered. Observed here.
    host: '127.0.0.1',
    // Fail loudly instead of silently drifting to the next port.
    strictPort: true,
  },
})
