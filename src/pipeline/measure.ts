// M8 — MEASURE (BLUEPRINT §4.10). The substance finish line.
//
// The number that matters is not "₹X recovered". It is the difference between
// the arm the agent worked and the arm it never touched, because a good slice
// of any failed-payment batch recovers on its own — the customer tops up, the
// issuer comes back, the authorisation lands late. Counting those as agent
// recoveries is the single easiest way to produce an impressive and worthless
// number.
//
//   net lift = treated_recovered − (holdout_rate × treated_pool)
//
// Both arms are scored by the same simulator table, and the holdout is never
// touched by anything upstream — `tests/holdout.test.ts` enforces that.
import type { Case } from '../engine/case'
import type { Cause } from './rules'
import type { Outcome } from './decide'
import { simulate } from '../sim/simulator'
import type { SimAction } from '../sim/outcomes'

export type ArmResult = {
  cases: number
  pool_inr: number
  recovered_cases: number
  recovered_inr: number
  /** By value — the rate the net-lift arithmetic uses. */
  rate: number
  /**
   * By case count. Reported alongside `rate` because with a small arm the two
   * can diverge sharply: one ₹9,999 case landing either way moves the
   * value-weighted rate far more than it moves the count.
   */
  rate_by_count: number
}

export type CaseResult = {
  kase: Case
  arm: 'treated' | 'holdout'
  action: SimAction
  outcome: Outcome | 'HOLDOUT'
  cause: Cause
  recovered: boolean
  cost_inr: number
}

function summarise(results: CaseResult[]): ArmResult {
  const pool_inr = results.reduce((s, r) => s + r.kase.amount_inr, 0)
  const recovered = results.filter((r) => r.recovered)
  const recovered_inr = recovered.reduce((s, r) => s + r.kase.amount_inr, 0)
  return {
    cases: results.length,
    pool_inr,
    recovered_cases: recovered.length,
    recovered_inr,
    rate: pool_inr === 0 ? 0 : recovered_inr / pool_inr,
    rate_by_count: results.length === 0 ? 0 : recovered.length / results.length,
  }
}

export type Measurement = {
  treated: ArmResult
  holdout: ArmResult
  /** What the treated pool would have recovered on its own, per the holdout. */
  counterfactual_inr: number
  net_lift_inr: number
  action_cost_inr: number
  net_lift_after_cost_inr: number
  /** Second estimate from the simulator table. Cross-check, never the headline. */
  modelled?: { rate: number; counterfactual_inr: number; net_lift_inr: number }
  by_cause: { cause: Cause; treated: ArmResult; holdout: ArmResult; lift_inr: number }[]
  by_bucket: { bucket: Outcome | 'HOLDOUT'; cases: number; recovered_inr: number; cost_inr: number }[]
}

/** Score the holdout arm: nothing was done, so everything takes the `none` column. */
export function scoreHoldout(cases: Case[], causes: Map<string, Cause>, batchSeed = 0): CaseResult[] {
  return cases.map((kase) => ({
    kase,
    arm: 'holdout' as const,
    action: 'none' as SimAction,
    outcome: 'HOLDOUT' as const,
    cause: causes.get(kase.id) ?? 'unknown',
    recovered: simulate(kase, 'none', batchSeed).recovered,
    cost_inr: 0,
  }))
}

export function measure(
  treated: CaseResult[],
  holdout: CaseResult[],
  /** Table-implied do-nothing rate for the treated pool — a variance-free
   *  cross-check on the small holdout arm. See `expectedNoActionRate`. */
  expectedNoActionRate?: number,
): Measurement {
  const t = summarise(treated)
  const h = summarise(holdout)

  // The counterfactual: the treated pool, recovering at the rate the untouched
  // arm managed by itself.
  const counterfactual_inr = h.rate * t.pool_inr
  const net_lift_inr = t.recovered_inr - counterfactual_inr
  const action_cost_inr = treated.reduce((s, r) => s + r.cost_inr, 0)

  const causes = [...new Set([...treated, ...holdout].map((r) => r.cause))].sort()
  const by_cause = causes.map((cause) => {
    const ta = summarise(treated.filter((r) => r.cause === cause))
    const ha = summarise(holdout.filter((r) => r.cause === cause))
    return { cause, treated: ta, holdout: ha, lift_inr: ta.recovered_inr - ha.rate * ta.pool_inr }
  })

  const buckets = [...new Set(treated.map((r) => r.outcome))].sort()
  const by_bucket = buckets.map((bucket) => {
    const rows = treated.filter((r) => r.outcome === bucket)
    return {
      bucket,
      cases: rows.length,
      recovered_inr: rows.filter((r) => r.recovered).reduce((s, r) => s + r.kase.amount_inr, 0),
      cost_inr: rows.reduce((s, r) => s + r.cost_inr, 0),
    }
  })

  const modelled =
    expectedNoActionRate === undefined
      ? undefined
      : {
          rate: expectedNoActionRate,
          counterfactual_inr: expectedNoActionRate * t.pool_inr,
          net_lift_inr: t.recovered_inr - expectedNoActionRate * t.pool_inr,
        }

  return {
    treated: t,
    holdout: h,
    counterfactual_inr,
    net_lift_inr,
    action_cost_inr,
    net_lift_after_cost_inr: net_lift_inr - action_cost_inr,
    modelled,
    by_cause,
    by_bucket,
  }
}
