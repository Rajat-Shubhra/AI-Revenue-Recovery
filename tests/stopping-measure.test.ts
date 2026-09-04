// M6–M8: stopping rules, the simulator, and the measurement — including
// invariant 3, that the holdout is never touched.
import { describe, it, expect } from 'vitest'
import { fixedClock } from '../src/engine/clock'
import { BATCH_NOW } from '../src/pipeline/generate'
import { loadCases, assignHoldout } from '../src/pipeline/ingest'
import { loadStoppingConfig, stopCheck, systemicCheck } from '../src/pipeline/stopping'
import { score } from '../src/pipeline/prioritise'
import { decideFromCause } from '../src/pipeline/decide'
import { simulate, expectedNoActionRate, checkDiagnoses } from '../src/sim/simulator'
import { MockRazorpayPort } from '../src/ports/mock'
import { measure, scoreHoldout, type CaseResult } from '../src/pipeline/measure'
import { OUTCOME_TABLE } from '../src/sim/outcomes'
import type { Cause } from '../src/pipeline/rules'

const cases = loadCases()
const config = loadStoppingConfig()
const now = fixedClock(BATCH_NOW).now()

const scoredOf = (id: string, over: Partial<{ halted: boolean; holdout: boolean }> = {}) =>
  score({
    kase: cases.find((c) => c.id === id)!,
    holdout: over.holdout ?? false,
    halted: over.halted ?? false,
    hours_to_halt: 100,
  })

describe('stopping config', () => {
  it('loads and validates', () => {
    expect(config.max_attempts_per_case).toBe(3)
    expect(config.systemic_alert_if_same_cause_share_exceeds).toBe(0.4)
    expect(config.stop_on).toContain('mandate_cancelled')
  })

  it('rejects a config with a missing threshold rather than defaulting it', () => {
    // A threshold that silently became undefined would disable a stopping rule.
    expect(() => loadStoppingConfig('config/nonexistent.json')).toThrow()
  })
})

describe('stopping rules', () => {
  const anyDecision = decideFromCause(cases[0]!, 'insufficient_funds', now)

  it('stops a cancelled mandate', () => {
    const s = scoredOf(cases.find((c) => c.mandate.cancelled_by_customer)!.id)
    const check = stopCheck(s, anyDecision, 'mandate_cancelled_by_customer', config, now)
    expect(check.stopped).toBe(true)
    expect(check.rule).toBe('stop_on:mandate_cancelled')
  })

  it('stops a case that has already used its attempts', () => {
    const s = scoredOf(cases[0]!.id)
    const maxed = { ...s, kase: { ...s.kase, attempts: 3 } }
    const check = stopCheck(maxed, anyDecision, 'insufficient_funds', config, now)
    expect(check.stopped).toBe(true)
    expect(check.rule).toBe('max_attempts_per_case')
  })

  it('holds a late-auth case inside the hold window', () => {
    const late = cases.find((c) => c.late_auth_pending)!
    const s = { ...scoredOf(late.id), kase: { ...late, failed_at: new Date(now.getTime() - 5 * 3_600_000).toISOString() } }
    const check = stopCheck(s, anyDecision, 'late_auth_pending', config, now)
    expect(check.stopped).toBe(true)
    expect(check.rule).toBe('hold_if_late_auth_pending_hours')
  })

  it('releases a late-auth case once the hold window has passed', () => {
    const late = cases.find((c) => c.late_auth_pending)!
    const s = { ...scoredOf(late.id), kase: { ...late, failed_at: new Date(now.getTime() - 100 * 3_600_000).toISOString() } }
    expect(stopCheck(s, anyDecision, 'late_auth_pending', config, now).stopped).toBe(false)
  })

  it('drops a case worth less than the floor', () => {
    const s = scoredOf(cases[0]!.id)
    // attempts pinned: the cap is checked before the value floor, and the
    // generator now hands out 0-3 prior attempts.
    const tiny = { ...s, kase: { ...s.kase, attempts: 0 }, expected_value: 5 }
    const check = stopCheck(tiny, anyDecision, 'insufficient_funds', config, now)
    expect(check.stopped).toBe(true)
    expect(check.rule).toBe('drop_if_expected_value_below_inr')
  })

  it('never drops an escalation on value — a small misconfiguration still needs fixing', () => {
    const base = scoredOf(cases[0]!.id)
    const s = { ...base, kase: { ...base.kase, attempts: 0 }, expected_value: 5 }
    const escalation = decideFromCause(cases[0]!, 'amount_exceeds_mandate_max', now)
    expect(stopCheck(s, escalation, 'amount_exceeds_mandate_max', config, now).stopped).toBe(false)
  })
})

describe('systemic alert', () => {
  it('does not fire on a healthy mixed batch', () => {
    const mixed: Cause[] = [
      ...Array(4).fill('insufficient_funds'),
      ...Array(3).fill('card_expired'),
      ...Array(3).fill('issuer_downtime'),
    ]
    expect(systemicCheck(mixed, config).fired).toBe(false)
  })

  it('fires when one cause exceeds the threshold', () => {
    const outage: Cause[] = [...Array(7).fill('issuer_downtime'), ...Array(3).fill('card_expired')]
    const alert = systemicCheck(outage, config)
    expect(alert.fired).toBe(true)
    expect(alert.cause).toBe('issuer_downtime')
    expect(alert.share).toBeCloseTo(0.7, 5)
    expect(alert.because).toContain('incident')
  })

  it('does not fire exactly at the threshold, only above it', () => {
    // 4/10 is the largest share and equals the 0.4 threshold exactly. The rest
    // is spread so no other cause is larger.
    const exactly: Cause[] = [
      ...Array(4).fill('issuer_downtime'),
      ...Array(3).fill('card_expired'),
      ...Array(3).fill('gateway_downtime'),
    ]
    const alert = systemicCheck(exactly, config)
    expect(alert.share).toBeCloseTo(0.4, 5)
    expect(alert.fired).toBe(false)
  })

  it('fires one step above the threshold', () => {
    const over: Cause[] = [
      ...Array(5).fill('issuer_downtime'),
      ...Array(3).fill('card_expired'),
      ...Array(2).fill('gateway_downtime'),
    ]
    expect(systemicCheck(over, config).fired).toBe(true)
  })

  it('is empty-safe', () => {
    expect(systemicCheck([], config).fired).toBe(false)
  })
})

describe('simulator', () => {
  const kase = cases[0]!

  it('is deterministic for the same case and action', () => {
    expect(simulate(kase, 'retryScheduled').recovered).toBe(simulate(kase, 'retryScheduled').recovered)
  })

  it('does not depend on how many cases were scored before it', () => {
    const alone = simulate(cases[40]!, 'sendPaymentLink').recovered
    cases.slice(0, 40).forEach((c) => simulate(c, 'retryNow'))
    expect(simulate(cases[40]!, 'sendPaymentLink').recovered).toBe(alone)
  })

  it('reads its probability straight from the table', () => {
    for (const c of cases.slice(0, 10)) {
      const cause = c._true_cause as keyof typeof OUTCOME_TABLE
      expect(simulate(c, 'retryScheduled').probability).toBe(OUTCOME_TABLE[cause].retryScheduled)
    }
  })

  it('gives a cancelled mandate zero chance under every action', () => {
    const cancelled = cases.find((c) => c.mandate.cancelled_by_customer)!
    for (const action of ['retryNow', 'retryScheduled', 'switchRail', 'sendPaymentLink', 'none'] as const) {
      expect(simulate(cancelled, action).probability).toBe(0)
      expect(simulate(cancelled, action).recovered).toBe(false)
    }
  })

  it('scores doing nothing identically whether held or in the holdout', () => {
    // Restraint and inaction must be measured on the same footing, or the
    // agent's decision to HOLD would score differently from the control arm's
    // doing nothing for no reason but the RNG.
    const port = new MockRazorpayPort(cases)
    for (const c of cases.slice(0, 20)) {
      expect(port.noAction(c.id)).toBe(simulate(c, 'none').recovered)
    }
  })
})

describe('INVARIANT 3 — the holdout is never touched', () => {
  it('no action is ever run against a holdout case', async () => {
    const holdoutIds = assignHoldout(cases)
    const port = new MockRazorpayPort(cases)

    // Act on the treated arm only, as the batch does.
    for (const c of cases.filter((k) => !holdoutIds.has(k.id))) {
      await port.sendPaymentLink(c.id, 'sms')
    }

    for (const id of holdoutIds) {
      expect(port.recovered.has(id)).toBe(false)
    }
  })

  it('holdout outcomes come only from the do-nothing column', () => {
    const holdoutIds = assignHoldout(cases)
    const holdout = cases.filter((c) => holdoutIds.has(c.id))
    const results = scoreHoldout(holdout, new Map())
    for (const r of results) {
      expect(r.action).toBe('none')
      expect(r.outcome).toBe('HOLDOUT')
      expect(r.cost_inr).toBe(0)
      expect(r.recovered).toBe(simulate(r.kase, 'none').recovered)
    }
  })
})

describe('measurement', () => {
  const build = (kase: (typeof cases)[number], recovered: boolean, cost = 0): CaseResult => ({
    kase,
    arm: 'treated',
    action: 'retryScheduled',
    outcome: 'AUTO',
    cause: 'insufficient_funds',
    recovered,
    cost_inr: cost,
  })

  it('nets the counterfactual out of the raw recovery', () => {
    const treated = [build(cases[0]!, true), build(cases[1]!, true), build(cases[2]!, false)]
    const holdout: CaseResult[] = [{ ...build(cases[3]!, true), arm: 'holdout', action: 'none', outcome: 'HOLDOUT' }]

    const m = measure(treated, holdout)
    // The holdout recovered everything, so the counterfactual eats the whole
    // treated pool and lift must go negative rather than reporting raw wins.
    expect(m.holdout.rate).toBe(1)
    expect(m.counterfactual_inr).toBe(m.treated.pool_inr)
    expect(m.net_lift_inr).toBe(m.treated.recovered_inr - m.treated.pool_inr)
    expect(m.net_lift_inr).toBeLessThan(m.treated.recovered_inr)
  })

  it('reports rates by value and by count separately', () => {
    const big = cases.find((c) => c.amount_inr === 9999)!
    const small = cases.find((c) => c.amount_inr < 500)!
    const m = measure([build(big, true), build(small, false)], [])
    expect(m.treated.rate).toBeGreaterThan(0.9) // by value, the big one dominates
    expect(m.treated.rate_by_count).toBe(0.5) // by count, one of two
  })

  it('subtracts the cost of acting', () => {
    const m = measure([build(cases[0]!, true, 50)], [])
    expect(m.action_cost_inr).toBe(50)
    expect(m.net_lift_after_cost_inr).toBe(m.net_lift_inr - 50)
  })

  it('offers a table-implied cross-check when asked', () => {
    const m = measure([build(cases[0]!, true)], [], 0.1)
    expect(m.modelled!.rate).toBe(0.1)
    expect(m.modelled!.counterfactual_inr).toBeCloseTo(0.1 * m.treated.pool_inr, 6)
  })

  it('is empty-safe', () => {
    const m = measure([], [])
    expect(m.net_lift_inr).toBe(0)
    expect(m.holdout.rate).toBe(0)
  })

  it('checkDiagnoses scores a claim against the true cause', () => {
    const kase = cases.find((c) => c._true_cause === 'insufficient_funds')!
    const right = checkDiagnoses(cases, new Map([[kase.id, 'insufficient_funds']]))
    expect(right[0]!.correct).toBe(true)

    const wrong = checkDiagnoses(cases, new Map([[kase.id, 'card_expired']]))
    expect(wrong[0]!.correct).toBe(false)
    expect(wrong[0]!.actual).toBe('insufficient_funds')
  })

  it('checkDiagnoses ignores cases it was given no claim for', () => {
    expect(checkDiagnoses(cases, new Map())).toEqual([])
  })

  it('expectedNoActionRate agrees with the table', () => {
    const one = cases.find((c) => c._true_cause === 'late_auth_pending')!
    expect(expectedNoActionRate([one])).toBeCloseTo(OUTCOME_TABLE.late_auth_pending.none, 6)
  })
})
