// The agent must never see the simulator's ground truth.
//
// `_true_cause` and `_will_self_heal` are the answers. If any pipeline stage
// reads them, the agent is grading its own homework and every number the demo
// produces is worthless — and it would be an easy mistake to make quietly,
// since the fields sit right there on the Case object. So it is enforced
// mechanically rather than by discipline.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/**
 * The only files permitted to mention the ground-truth fields.
 * - `src/sim/**`        — scores outcomes; this is its job.
 * - `engine/case.ts`    — declares the fields.
 * - `pipeline/generate.ts` — writes them.
 * Anything else is a leak.
 */
const ALLOWED = [
  path.join('src', 'sim'),
  path.join('src', 'engine', 'case.ts'),
  path.join('src', 'pipeline', 'generate.ts'),
]

const GROUND_TRUTH = ['_true_cause', '_will_self_heal']

/**
 * Strip comments before scanning.
 *
 * Several files legitimately *discuss* the ground-truth fields in prose —
 * `prompt.ts` documents that it deliberately withholds them, and
 * `recovery-priors.ts` explains that it is keyed on the observed reason rather
 * than the true cause. Those comments are the reasoning we want to keep, not
 * leaks. Only code counts.
 *
 * The `//` rule ignores matches preceded by `:` so `https://` in a URL isn't
 * mistaken for a comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

describe('ground-truth isolation', () => {
  const files = walk(SRC)

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('no file outside the allowlist mentions the ground-truth fields', () => {
    const leaks: string[] = []

    for (const file of files) {
      const rel = path.relative(path.join(SRC, '..'), file)
      if (ALLOWED.some((a) => rel.startsWith(a))) continue

      const code = stripComments(readFileSync(file, 'utf8'))
      for (const field of GROUND_TRUTH) {
        if (code.includes(field)) leaks.push(`${rel} reads ${field}`)
      }
    }

    expect(leaks).toEqual([])
  })

  it('the allowlist points at files that exist', () => {
    for (const entry of ALLOWED) {
      expect(() => statSync(path.join(SRC, '..', entry))).not.toThrow()
    }
  })
})
