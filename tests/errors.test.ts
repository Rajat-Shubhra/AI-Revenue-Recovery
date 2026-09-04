// The error catalogue and the rules table that reads it.
//
// The claim this file defends: the rules resolve what a code CAN determine and
// refuse what it cannot. Getting that boundary wrong in either direction is the
// whole ballgame — resolve too much and the agent is confidently wrong; resolve
// too little and the model is doing work a lookup table should have done.
import { describe, it, expect } from 'vitest'
import {
  ERROR_CATALOGUE,
  ALL_CAUSES,
  ALL_CODES,
  AMBIGUOUS_KEYS,
  AMBIGUOUS_ENTRIES,
  DETERMINISTIC_ENTRIES,
  isAmbiguous,
  type Cause,
} from '../src/pipeline/razorpay-errors'
import { applyRules, whyUnresolved } from '../src/pipeline/rules'
import { OUTCOME_TABLE, bestAction } from '../src/sim/outcomes'
import { ALLOWED_CAUSES } from '../src/engine/prompt'
import { decideFromCause } from '../src/pipeline/decide'
import { generateCases } from '../src/pipeline/generate'

const cases = generateCases()
const now = new Date('2026-09-05T09:00:00.000Z')

describe('the catalogue', () => {
  it('is substantial enough to be worth calling a taxonomy', () => {
    expect(ERROR_CATALOGUE.length).toBeGreaterThanOrEqual(30)
    expect(ALL_CODES.length).toBeGreaterThanOrEqual(20)
  })

  it('uses only the four sources Razorpay emits', () => {
    const real = ['customer', 'business', 'gateway', 'razorpay']
    for (const e of ERROR_CATALOGUE) expect(real).toContain(e.source)
  })

  it('has genuinely colliding codes, derived not hand-flagged', () => {
    // If this is ever empty, the ambiguous slice is fiction and the model has
    // nothing defensible to do.
    expect(AMBIGUOUS_KEYS.size).toBeGreaterThan(0)
    expect(AMBIGUOUS_ENTRIES.length).toBeGreaterThan(0)
    expect(DETERMINISTIC_ENTRIES.length).toBeGreaterThan(AMBIGUOUS_ENTRIES.length)
  })

  it('documents credit_failed as both a customer problem and a downtime blip', () => {
    // The specific collision from Razorpay's UPI page that motivates the whole
    // design: same code, opposite remedies.
    const variants = ERROR_CATALOGUE.filter((e) => e.code === 'credit_failed')
    const causes = variants.map((e) => e.cause)
    expect(causes).toContain('wrong_account_selected')
    expect(causes).toContain('gateway_downtime')
    expect(isAmbiguous('gateway', 'credit_failed')).toBe(true)
  })

  it('gives every cause a row in the outcome table', () => {
    for (const cause of ALL_CAUSES) expect(OUTCOME_TABLE[cause]).toBeDefined()
  })

  it('keeps the prompt cause list in step with the catalogue', () => {
    // If these drift, the model can return a cause nothing downstream can score.
    expect([...ALLOWED_CAUSES].sort()).toEqual([...ALL_CAUSES].sort())
  })
})

describe('rules resolve what the code determines', () => {
  it('resolves every unambiguous catalogue entry to its documented cause', () => {
    for (const entry of DETERMINISTIC_ENTRIES) {
      const kase = cases.find(
        (c) => c.error.code === entry.code && c.error.source === entry.source,
      )
      if (!kase) continue
      // State rules legitimately override the code — a cancelled mandate is
      // cancelled whatever the gateway said — so only assert when no state
      // rule applies.
      const stateOverridden =
        kase.mandate.cancelled_by_customer ||
        kase.mandate.paused_by_customer ||
        kase.late_auth_pending ||
        kase.amount_inr > kase.mandate.max_amount_inr
      if (stateOverridden) continue
      expect(applyRules(kase)?.cause, `${entry.source}/${entry.code}`).toBe(entry.cause)
    }
  })

  it('resolves most of the batch', () => {
    const resolved = cases.filter((c) => applyRules(c) !== null).length
    expect(resolved / cases.length).toBeGreaterThan(0.5)
  })
})

describe('rules refuse what the code cannot determine', () => {
  it('returns null for every ambiguous pair', () => {
    const ambiguous = cases.filter((c) => isAmbiguous(c.error.source, c.error.code))
    expect(ambiguous.length).toBeGreaterThan(0)

    for (const kase of ambiguous) {
      // Unless a state rule settles it on facts rather than the code.
      const stateOverridden =
        kase.mandate.cancelled_by_customer ||
        kase.mandate.paused_by_customer ||
        kase.late_auth_pending ||
        kase.amount_inr > kase.mandate.max_amount_inr
      if (stateOverridden) continue
      expect(applyRules(kase), `${kase.id} ${kase.error.code}`).toBeNull()
    }
  })

  it('explains why it refused, in terms an auditor can check', () => {
    const kase = cases.find(
      (c) => isAmbiguous(c.error.source, c.error.code) && !c.mandate.cancelled_by_customer,
    )!
    expect(whyUnresolved(kase)).toContain('more than one meaning')
  })

  it('still lets state rules override an ambiguous code', () => {
    // A cancelled mandate must diagnose as cancelled even when the error code
    // is one the table would otherwise refuse.
    const base = cases.find((c) => isAmbiguous(c.error.source, c.error.code))!
    const cancelled = { ...base, mandate: { ...base.mandate, cancelled_by_customer: true } }
    expect(applyRules(cancelled)?.cause).toBe('mandate_cancelled_by_customer')
  })
})

describe('every cause leads somewhere sensible', () => {
  const sample = cases[0]!

  it('decide handles all of them without falling through', () => {
    for (const cause of ALL_CAUSES) {
      const d = decideFromCause({ ...sample, is_domestic_card: false }, cause as Cause, now)
      expect(['AUTO', 'CUSTOMER_ACTION', 'ESCALATE', 'STOP', 'HOLD']).toContain(d.outcome)
      expect(d.because.length).toBeGreaterThan(20)
      expect(d.rejected.length).toBeGreaterThan(0)
    }
  })

  it('picks the simulator-optimal action for the clear-cut causes', () => {
    // Not asserted for every cause — compliance and RBI timing legitimately
    // push the agent off the theoretical optimum. But where the domain is
    // unambiguous, the table should not be leaving money on the floor.
    const clearCut: Cause[] = ['insufficient_funds', 'card_expired', 'psp_downtime', 'merchant_config_error']
    for (const cause of clearCut) {
      const kase = { ...sample, is_domestic_card: false, method: 'upi' as const, attempts: 0 }
      const d = decideFromCause(kase, cause, now)
      expect(d.tool, `${cause}: chose ${d.tool}, best is ${bestAction(cause)}`).toBe(bestAction(cause))
    }
  })

  it('never proposes a tool for a terminal or held cause', () => {
    for (const cause of ['mandate_cancelled_by_customer', 'late_auth_pending'] as Cause[]) {
      expect(decideFromCause(sample, cause, now).tool).toBeNull()
    }
  })
})
