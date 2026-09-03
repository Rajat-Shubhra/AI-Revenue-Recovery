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
  /** Control arm. Nothing may act on these; `tests/holdout.test.ts` enforces it. */
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
 * Assign the holdout by seed.
 *
 * Uses its own PRNG stream seeded off the batch seed, so the split is
 * reproducible but independent of the order the generator happened to emit
 * cases in — assigning "every fifth case" would have correlated the control arm
 * with the slice layout and quietly biased the measurement.
 */
export function assignHoldout(cases: Case[], seed: number = SEED): Set<string> {
  const rng = mulberry32(seed ^ 0x5eed)
  const shuffled = cases.map((c) => c.id)

  // Fisher–Yates, so every case has an equal chance of being a control.
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }

  return new Set(shuffled.slice(0, Math.round(cases.length * HOLDOUT_SHARE)))
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
