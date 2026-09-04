// M2 — INGEST (BLUEPRINT §4.1).
//
// Loads the seeded batch, splits off the holdout arm, and marks the cases that
// are already past saving. One audit line per case, so the ledger accounts for
// every case in the batch including the ones nothing will be done to.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Case } from '../engine/case'
import type { Clock } from '../engine/tool-types'
import { hoursUntil } from '../engine/clock'
import { AuditLog, hashInput } from '../engine/audit'
import { mulberry32, SEED } from './generate'

export const CASES_FILE = fileURLToPath(new URL('../../data/cases.seed.json', import.meta.url))

/** BLUEPRINT §4.10 — the agent never touches these. */
export const HOLDOUT_SHARE = 0.2

export type IngestedCase = {
  kase: Case
  /** Control arm. Nothing may act on these; INVARIANT 3 in
   * `tests/stopping-measure.test.ts` enforces it. */
  holdout: boolean
  /**
   * The subscription has already been halted — the deadline passed before the
   * batch ran. Nothing is recoverable, so it never enters the queue.
   * §4.6 lists `halted` as a terminal stop state; this is that check, applied
   * at the door rather than after work has been done on the case.
   */
  halted: boolean
  hours_to_halt: number
}

export function loadCases(file: string = CASES_FILE): Case[] {
  return JSON.parse(readFileSync(file, 'utf8')) as Case[]
}

/**
 * Assign the holdout, stratified by amount.
 *
 * A plain random 20% is the obvious thing and it was wrong here. Subscription
 * amounts are heavy-tailed — ₹149 to ₹9,999 in this batch — so with only 16
 * control cases a simple shuffle can hand the holdout most of the large ones.
 * It did exactly that: the control arm ended up holding ₹41,884 against the
 * treated arm's ₹57,792, which is 42% of the money in 20% of the cases. Every
 * per-rupee rate computed off that is noise, and the net lift built on it was
 * meaningless.
 *
 * So: sort by amount, cut into strata of 1/HOLDOUT_SHARE cases, and draw one
 * control at random from each stratum. Still randomised, still reproducible
 * under the seed, but both arms now get a proportional slice of every value
 * band — which is the whole point of a control group.
 */
export function assignHoldout(cases: Case[], seed: number = SEED): Set<string> {
  const rng = mulberry32(seed ^ 0x5eed)
  const stratumSize = Math.round(1 / HOLDOUT_SHARE)

  // Sort by amount, tie-broken on id so the strata are deterministic.
  const byAmount = [...cases].sort(
    (a, b) => b.amount_inr - a.amount_inr || a.id.localeCompare(b.id),
  )

  const holdout = new Set<string>()
  for (let i = 0; i < byAmount.length; i += stratumSize) {
    const stratum = byAmount.slice(i, i + stratumSize)
    const chosen = stratum[Math.floor(rng() * stratum.length)]
    if (chosen) holdout.add(chosen.id)
  }

  return holdout
}

export async function ingest(
  audit: AuditLog,
  clock: Clock,
  file: string = CASES_FILE,
  seed: number = SEED,
): Promise<IngestedCase[]> {
  const cases = loadCases(file)
  const holdoutIds = assignHoldout(cases, seed)
  const now = clock.now()
  const ingested: IngestedCase[] = []

  for (const kase of cases) {
    const hours_to_halt = hoursUntil(kase.halts_at, now)
    const entry: IngestedCase = {
      kase,
      holdout: holdoutIds.has(kase.id),
      halted: hours_to_halt <= 0,
      hours_to_halt,
    }
    ingested.push(entry)

    await audit.append({
      ts: now.toISOString(),
      case_id: kase.id,
      stage: 'ingest',
      // Hash of what the agent may see. Deliberately excludes the ground-truth
      // fields, so the hash also documents what was withheld.
      input_hash: hashInput({
        amount: kase.amount_inr,
        method: kase.method,
        error: kase.error,
        mandate: kase.mandate,
        attempts: kase.attempts,
      }),
      arm: entry.holdout ? 'holdout' : 'treated',
      stop_check: entry.halted
        ? { stopped: true, because: 'subscription already halted before the batch ran' }
        : { stopped: false },
    })
  }

  return ingested
}
