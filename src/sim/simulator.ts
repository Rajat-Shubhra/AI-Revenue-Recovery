// M7 — OUTCOME SIMULATOR (BLUEPRINT §4.8).
//
// Given an action and the case's true cause, sample whether the money came
// back. This file and outcomes.ts are the only places allowed to read
// `_true_cause` and `_will_self_heal`.
//
// Two properties matter more than realism here:
//
// 1. **Auditable.** Every probability comes from the single flat table in
//    outcomes.ts. There is no fudge factor, no bonus for the agent, and no
//    branch that treats the treated arm differently from the holdout arm — both
//    are scored by the same function, and doing nothing is just another column.
//
// 2. **Deterministic.** The draw is seeded from the case id and the action, not
//    from a running counter, so a case's outcome does not depend on how many
//    other cases were processed before it. Re-running the batch, or processing
//    it in a different order, gives the same answer.
import type { Case } from '../engine/case'
import { OUTCOME_TABLE, type SimAction, type TrueCause } from './outcomes'

/** FNV-1a. Small, stable, and not dependent on any Node version detail. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** One draw in [0,1), fully determined by the seed. */
function draw(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * The value-weighted rate at which this set of cases would settle on its own,
 * straight from the table's `none` column.
 *
 * This is a sanity check on the holdout, not a replacement for it. The holdout
 * arm is the honest measurement — an actual untouched control — but at 16 cases
 * it is small, and a couple of large cases falling either way swings its rate a
 * long way. This gives a second, variance-free estimate of the same quantity to
 * compare it against.
 *
 * It reads ground truth, so it could never be computed in a real deployment.
 * It is reported as what it is: a check on the arithmetic, never the headline.
 */
export function expectedNoActionRate(cases: Case[]): number {
  const pool = cases.reduce((s, k) => s + k.amount_inr, 0)
  if (pool === 0) return 0
  const expected = cases.reduce(
    (s, k) => s + k.amount_inr * OUTCOME_TABLE[k._true_cause as TrueCause].none,
    0,
  )
  return expected / pool
}

export type DiagnosisCheck = {
  case_id: string
  claimed: string
  actual: string
  correct: boolean
  amount_inr: number
}

/**
 * Was the model right?
 *
 * "Resolved by the model" and "correct" are different claims, and reporting the
 * first as though it were the second is the easiest way to overstate what the
 * AI contributed. The confidence floor stops low-confidence guesses; it does
 * nothing about a confident wrong answer, so that has to be measured.
 *
 * Scoring only, and read-only: it lives here because it reads ground truth, it
 * runs after every decision has already been made, and nothing upstream can see
 * it. The agent cannot game a number it is never shown.
 *
 * Note that a wrong diagnosis is already punished implicitly — the agent acts on
 * its mistaken theory and the simulator scores that action against the TRUE
 * cause, so a payment link sent for what was really insufficient funds pays 0.30
 * instead of the 0.52 a scheduled retry would have earned. This just makes the
 * cost visible instead of leaving it buried in the total.
 */
export function checkDiagnoses(
  cases: Case[],
  claimed: Map<string, string>,
): DiagnosisCheck[] {
  const byId = new Map(cases.map((c) => [c.id, c]))
  const out: DiagnosisCheck[] = []

  for (const [case_id, claim] of claimed) {
    const kase = byId.get(case_id)
    if (!kase) continue
    out.push({
      case_id,
      claimed: claim,
      actual: kase._true_cause,
      correct: claim === kase._true_cause,
      amount_inr: kase.amount_inr,
    })
  }

  return out.sort((a, b) => a.case_id.localeCompare(b.case_id))
}

export type SimResult = {
  action: SimAction
  probability: number
  recovered: boolean
  amount_inr: number
  detail: string
}

/**
 * Score one case under one action.
 *
 * `none` — the holdout arm, and any case the agent decided to STOP or HOLD —
 * reads the pre-sampled `_will_self_heal` rather than drawing again. That flag
 * was itself sampled from this table's `none` column at generation time, so the
 * two cannot drift, and it guarantees a case's do-nothing outcome is identical
 * whether it landed in the holdout or was held by choice. Without that, the
 * agent's restraint would score differently from the control arm's inaction for
 * no reason but the RNG.
 */
export function simulate(kase: Case, action: SimAction, batchSeed = 0): SimResult {
  const cause = kase._true_cause as TrueCause
  const probability = OUTCOME_TABLE[cause][action]

  if (action === 'none') {
    return {
      action,
      probability,
      recovered: kase._will_self_heal,
      amount_inr: kase.amount_inr,
      detail: kase._will_self_heal
        ? 'settled without intervention'
        : 'no action taken; nothing recovered',
    }
  }

  const roll = draw(hashSeed(`${kase.id}|${action}|${batchSeed}`))
  const recovered = roll < probability

  return {
    action,
    probability,
    recovered,
    amount_inr: kase.amount_inr,
    detail: recovered
      ? `${action} succeeded (p=${probability.toFixed(2)})`
      : `${action} failed (p=${probability.toFixed(2)})`,
  }
}
