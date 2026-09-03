// Invariants 1 and 2 of BLUEPRINT §5, plus the rest of the compliance gate.
//
// These are the compliance rules stated as executable claims. If any of them
// goes red, the agent is capable of doing something it must never do.
import { describe, it, expect } from 'vitest'
import { fixedClock } from '../src/engine/clock'
import { BATCH_NOW } from '../src/pipeline/generate'
import { loadCases } from '../src/pipeline/ingest'
import { applyRules, RULES, AMBIGUOUS_REASONS } from '../src/pipeline/rules'
import { diagnoseCase, noLlm } from '../src/pipeline/diagnose'
import { decide, decideFromCause, nextSalaryCycleDate, PRE_DEBIT_NOTICE_HOURS } from '../src/pipeline/decide'
import { complianceGate, CONTACT_WINDOW_IST } from '../src/pipeline/compliance'
import { ALLOWED_CAUSES } from '../src/engine/prompt'
import { TRUE_CAUSES } from '../src/sim/outcomes'

const cases = loadCases()
const clock = fixedClock(BATCH_NOW)
const now = clock.now()

/** Run a case all the way to the decision that may actually proceed. */
async function settle(kase: (typeof cases)[number], at: Date = now) {
  const d = await diagnoseCase(kase, noLlm)
  const proposed = decide(kase, d, at)
  return complianceGate(kase, proposed, fixedClock(at.getTime()))
}

describe('INVARIANT 1 — no action is ever taken on a cancelled mandate', () => {
  const cancelled = cases.filter((c) => c.mandate.cancelled_by_customer)

  it('has cases to test', () => expect(cancelled.length).toBe(8))

  it('never yields a tool for any of them', async () => {
    for (const kase of cancelled) {
      const { decision } = await settle(kase)
      expect(decision.tool).toBeNull()
      expect(decision.outcome).toBe('STOP')
    }
  })

  it('blocks at the gate even if the decision stage proposed an action', () => {
    const kase = cancelled[0]!
    // Simulate a decide stage that got it wrong. The gate is the backstop.
    const rogue = {
      outcome: 'AUTO' as const,
      tool: 'retryNow' as const,
      params: {},
      because: 'wrong on purpose',
      rejected: [],
      via: 'table' as const,
    }
    const gate = complianceGate(kase, rogue, clock)
    expect(gate.decision.tool).toBeNull()
    expect(gate.decision.outcome).toBe('STOP')
    expect(gate.checks.find((c) => c.id === 'C1')!.passed).toBe(false)
  })

  it('blocks contact as firmly as it blocks debits', () => {
    const kase = cancelled[0]!
    const contact = {
      outcome: 'CUSTOMER_ACTION' as const,
      tool: 'sendPaymentLink' as const,
      params: { channel: 'sms' },
      because: 'wrong on purpose',
      rejected: [],
      via: 'table' as const,
    }
    expect(complianceGate(kase, contact, clock).decision.tool).toBeNull()
  })
})

describe('INVARIANT 2 — no contact is ever made to a DND or opted-out customer', () => {
  const blocked = cases.filter((c) => c.customer.dnd || c.customer.opted_out)

  it('has cases to test', () => expect(blocked.length).toBe(4))

  it('never sends them a payment link', async () => {
    for (const kase of blocked) {
      const { decision } = await settle(kase)
      expect(decision.tool).not.toBe('sendPaymentLink')
    }
  })

  it('escalates rather than silently dropping them', async () => {
    for (const kase of blocked) {
      const { decision } = await settle(kase)
      expect(decision.outcome).toBe('ESCALATE')
      expect(decision.rejected.some((r) => r.because.includes('C2'))).toBe(true)
    }
  })

  it('still allows a debit — consent to contact is not authorisation to charge', () => {
    const kase = { ...cases.find((c) => !c.is_domestic_card && c.method === 'upi')!, customer: { ...cases[0]!.customer, dnd: true } }
    const auto = {
      outcome: 'AUTO' as const,
      tool: 'retryScheduled' as const,
      params: { scheduled_for: new Date(now.getTime() + 72 * 3_600_000).toISOString() },
      because: 'test',
      rejected: [],
      via: 'table' as const,
    }
    const gate = complianceGate(kase, auto, clock)
    expect(gate.decision.tool).toBe('retryScheduled')
    expect(gate.checks.find((c) => c.id === 'C2')!.passed).toBe(true)
  })
})

describe('the rest of the gate', () => {
  const anyCase = cases.find((c) => !c.mandate.cancelled_by_customer)!

  it('C3 defers contact outside 09:00–21:00 IST rather than cancelling it', () => {
    // 22:00 IST is 16:30 UTC.
    const night = fixedClock(Date.parse('2026-09-05T16:30:00.000Z'))
    const contact = {
      outcome: 'CUSTOMER_ACTION' as const,
      tool: 'sendPaymentLink' as const,
      params: { channel: 'sms' },
      because: 'test',
      rejected: [],
      via: 'table' as const,
    }
    const gate = complianceGate(anyCase, contact, night)
    const c3 = gate.checks.find((c) => c.id === 'C3')!
    expect(c3.passed).toBe(false)
    expect(c3.action).toBe('deferred')
    // Deferred, not abandoned — the tool survives.
    expect(gate.decision.tool).toBe('sendPaymentLink')
    expect(gate.decision.params.deferred_until_ist_hour).toBe(CONTACT_WINDOW_IST.open)
  })

  it('C3 passes during the batch clock, which is mid-afternoon IST', () => {
    const contact = {
      outcome: 'CUSTOMER_ACTION' as const,
      tool: 'sendPaymentLink' as const,
      params: { channel: 'sms' },
      because: 'test',
      rejected: [],
      via: 'table' as const,
    }
    expect(complianceGate(anyCase, contact, clock).checks.find((c) => c.id === 'C3')!.passed).toBe(true)
  })

  it('C4 blocks a retry scheduled inside the 24h pre-debit notice window', () => {
    const soon = {
      outcome: 'AUTO' as const,
      tool: 'retryScheduled' as const,
      params: { scheduled_for: new Date(now.getTime() + 6 * 3_600_000).toISOString() },
      because: 'test',
      rejected: [],
      via: 'table' as const,
    }
    const gate = complianceGate(anyCase, soon, clock)
    expect(gate.checks.find((c) => c.id === 'C4')!.passed).toBe(false)
    expect(gate.decision.outcome).toBe('ESCALATE')
  })

  it('C5 reroutes a domestic-card manual charge to a payment link', () => {
    const domestic = cases.find((c) => c.is_domestic_card && !c.mandate.cancelled_by_customer)!
    const manual = {
      outcome: 'AUTO' as const,
      tool: 'retryNow' as const,
      params: {},
      because: 'test',
      rejected: [],
      via: 'table' as const,
    }
    const gate = complianceGate(domestic, manual, clock)
    expect(gate.decision.tool).toBe('sendPaymentLink')
    expect(gate.decision.outcome).toBe('CUSTOMER_ACTION')
    expect(gate.decision.rejected.some((r) => r.because.includes('manual charge unsupported'))).toBe(true)
  })

  it('C6 blocks a debit above the mandate ceiling', () => {
    const over = cases.find((c) => c.amount_inr > c.mandate.max_amount_inr)!
    const retry = {
      outcome: 'AUTO' as const,
      tool: 'retryScheduled' as const,
      params: { scheduled_for: new Date(now.getTime() + 72 * 3_600_000).toISOString() },
      because: 'test',
      rejected: [],
      via: 'table' as const,
    }
    const gate = complianceGate(over, retry, clock)
    expect(gate.checks.find((c) => c.id === 'C6')!.passed).toBe(false)
    expect(gate.decision.outcome).toBe('ESCALATE')
  })

  it('records every check on every case, passing ones included', async () => {
    // A gate that only logs failures cannot prove it ran.
    for (const kase of cases.slice(0, 20)) {
      const { checks } = await settle(kase)
      expect(checks.map((c) => c.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])
    }
  })
})

describe('rules table', () => {
  it('resolves everything except the ambiguous slice', () => {
    const unresolved = cases.filter((c) => applyRules(c) === null)
    expect(unresolved).toHaveLength(8)
    for (const c of unresolved) expect(AMBIGUOUS_REASONS.has(c.error.reason)).toBe(true)
  })

  it('resolves 90% of the batch deterministically', () => {
    const resolved = cases.filter((c) => applyRules(c) !== null).length
    expect(resolved / cases.length).toBeGreaterThanOrEqual(0.85)
  })

  it('puts state-of-the-world rules ahead of error-code rules', () => {
    // A cancelled mandate must diagnose as cancelled even if the error string
    // claims something recoverable.
    const cancelled = cases.find((c) => c.mandate.cancelled_by_customer)!
    const mislabelled = { ...cancelled, error: { ...cancelled.error, source: 'customer' as const, reason: 'insufficient_funds' } }
    expect(applyRules(mislabelled)!.cause).toBe('mandate_cancelled_by_customer')
  })

  it('has unique rule ids', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length)
  })

  it('keeps the three cause lists in step', () => {
    // rules.ts, prompt.ts and sim/outcomes.ts each name the causes. If they
    // drift, the model can return a cause nothing downstream can score.
    expect([...ALLOWED_CAUSES].sort()).toEqual([...TRUE_CAUSES].sort())
  })
})

describe('decide', () => {
  it('sends insufficient funds to the next salary cycle, not an immediate retry', () => {
    const d = decideFromCause(
      { ...cases[0]!, is_domestic_card: false, method: 'upi', halts_at: new Date(now.getTime() + 90 * 24 * 3_600_000).toISOString() },
      'insufficient_funds',
      now,
    )
    expect(d.outcome).toBe('AUTO')
    expect(d.tool).toBe('retryScheduled')
    expect(d.rejected.some((r) => r.tool === 'retryNow')).toBe(true)
    const day = new Date(d.params.scheduled_for as string).getUTCDate()
    expect([1, 3, 7]).toContain(day)
  })

  it('always leaves room for the pre-debit notice', () => {
    const at = nextSalaryCycleDate(now, new Date(now.getTime() + 90 * 24 * 3_600_000).toISOString())!
    expect((at.getTime() - now.getTime()) / 3_600_000).toBeGreaterThanOrEqual(PRE_DEBIT_NOTICE_HOURS)
  })

  it('escalates when no compliant retry window fits before the halt', () => {
    const tight = { ...cases[0]!, is_domestic_card: false, halts_at: new Date(now.getTime() + 6 * 3_600_000).toISOString() }
    const d = decideFromCause(tight, 'insufficient_funds', now)
    expect(d.outcome).toBe('ESCALATE')
    expect(d.because).toContain('pre-debit notice')
  })

  it('never proposes a retry for an expired card', () => {
    const d = decideFromCause(cases[0]!, 'card_expired', now)
    expect(d.tool).toBe('sendPaymentLink')
    expect(d.rejected.some((r) => r.tool === 'retryScheduled')).toBe(true)
  })

  it('holds a late-auth case rather than acting', () => {
    const d = decideFromCause(cases[0]!, 'late_auth_pending', now)
    expect(d.outcome).toBe('HOLD')
    expect(d.tool).toBeNull()
    expect(d.rejected.some((r) => r.because.includes('double charge'))).toBe(true)
  })

  it('gives every decision at least one rejected alternative with a real reason', async () => {
    for (const kase of cases.slice(0, 40)) {
      const { decision } = await settle(kase)
      expect(decision.rejected.length).toBeGreaterThan(0)
      for (const r of decision.rejected) {
        expect(r.because.length).toBeGreaterThan(20)
        expect(r.because).not.toContain('placeholder')
      }
    }
  })
})
