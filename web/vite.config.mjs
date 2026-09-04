// Carried from Quark's web/vite.config.mjs — the Supabase/env plumbing stripped,
// the Windows workarounds kept, because both failures it works around reproduced
// on this machine on the first `npx vite` run in this repo.
//
// Plain ESM (not .ts) so Vite can load it with the native config loader and skip
// the esbuild temp-file bundling step that fails on this setup.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const dataFile = (name) => path.join(repoRoot, 'data', name)

const json = (res, status, body) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * The dashboard is a read-only view over what the CLI produced. It gets the
 * summary from data/report.json and the per-case evidence from the audit
 * ledger, and it derives no numbers of its own — the measurement lives in
 * measure.ts alone, so the page and the console can never disagree.
 *
 * /api/run shells out to the same `npm run batch` a human would type. Nothing
 * about the pipeline is special-cased for the UI.
 */
function batchApi() {
  /**
   * The same handler is mounted on both the dev server and `vite preview`.
   *
   * It was dev-only at first, which meant the production build served its own
   * index.html for `/api/report` — a 200 with HTML in it, so the page did not
   * error, it just tried to JSON.parse a web page. A built dashboard that
   * silently shows no data is worse than one that fails loudly, and worse still
   * to discover while recording.
   */
  const middleware = () => async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()

        try {
          if (req.url.startsWith('/api/report')) {
            return json(res, 200, JSON.parse(await readFile(dataFile('report.json'), 'utf8')))
          }

          if (req.url.startsWith('/api/audit')) {
            const text = await readFile(dataFile('audit.jsonl'), 'utf8')
            const entries = text
              .split('\n')
              .filter((line) => line.trim())
              .map((line) => {
                try {
                  return JSON.parse(line)
                } catch {
                  // A torn last line means the writer was interrupted. Skip it
                  // rather than failing the whole view.
                  return null
                }
              })
              .filter(Boolean)
            return json(res, 200, entries)
          }

          if (req.url.startsWith('/api/run') && req.method === 'POST') {
            // Clearing the ledger is a deliberate, separate action.
            //
            // Running the batch twice against the same ledger legitimately does
            // nothing — every action is already recorded and the idempotency
            // guard refuses to repeat it. That is the correct behaviour and
            // worth demonstrating, so the default "Run batch" appends. "Reset
            // and run" is what you want when you need a clean sheet.
            if (req.url.includes('fresh')) {
              await rm(dataFile('audit.jsonl'), { force: true })
              await rm(dataFile('report.json'), { force: true })
            }

            const args = ['run', 'batch']
            // Same flag the CLI takes, so a demo can be run without spending
            // model quota.
            if (req.url.includes('no-llm')) args.push('--', '--no-llm')

            const child = spawn('npm', args, { cwd: repoRoot, shell: true })
            let out = ''
            child.stdout.on('data', (d) => (out += d))
            child.stderr.on('data', (d) => (out += d))

            return child.on('close', (code) =>
              json(res, code === 0 ? 200 : 500, { ok: code === 0, code, output: out.slice(-8000) }),
            )
          }
        } catch (error) {
          // A missing report just means the batch has not been run yet — say so
          // rather than throwing a 500 the page cannot explain.
          const missing = error?.code === 'ENOENT'
          return json(res, missing ? 404 : 500, {
            error: missing ? 'no batch has been run yet' : String(error?.message ?? error),
          })
        }

    return next()
  }

  return {
    name: 'batch-api',
    configureServer(server) {
      server.middlewares.use(middleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware())
    },
  }
}

export default defineConfig({
  plugins: [react(), batchApi()],
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
