// M1 invariants: the batch is reproducible, and it matches BLUEPRINT §3.
import { describe, it, expect } from 'vitest'
import { generateCases, SLICE_COUNTS, SEED } from '../src/pipeline/generate'
import { TRUE_CAUSES } from '../src/sim/outcomes'

const cases = generateCases()

describe('synthetic batch', () => {
  it('produces 80 cases', () => {
    expect(cases).toHaveLength(80)
    expect(Object.values(SLICE_COUNTS).reduce((a, b) => a + b, 0)).toBe(80)
  })

  it('is byte-identical across runs with the same seed', () => {
    // The batch is re-run on camera. If this fails, the demo is not reproducible.
    expect(JSON.stringify(generateCases())).toBe(JSON.stringify(generateCases()))
  })

  it('produces a different batch for a different seed', () => {
    expect(JSON.stringify(generateCases(SEED + 1))).not.toBe(JSON.stringify(cases))
  })

  it('matches the §3 slice distribution', () => {
    const byCause = (c: string) => cases.filter((k) => k._true_cause === c).length

    expect(byCause('insufficient_funds')).toBe(24 + 3) // slice + 3 hidden in the ambiguous tail
    expect(byCause('card_expired')).toBe(8 + 4) // slice half + the dnd/opted-out slice
    expect(byCause('bank_blocked_card')).toBe(8 + 2)
    expect(byCause('issuer_downtime')).toBe(6 + 1)
    expect(byCause('gateway_downtime')).toBe(6)
    expect(byCause('mandate_cancelled_by_customer')).toBe(8)
    expect(byCause('late_auth_pending')).toBe(4)
    expect(byCause('amount_exceeds_mandate_max')).toBe(4)
    expect(byCause('unknown')).toBe(2)
  })

  it('gives every case a cause the simulator can score', () => {
    for (const k of cases) {
      expect(TRUE_CAUSES).toContain(k._true_cause)
    }
  })

  it('has unique ids in stable order', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(80)
    expect(cases[0]!.id).toBe('case_001')
    expect(cases[79]!.id).toBe('case_080')
  })
})

describe('slice shapes hold', () => {
  it('cancelled mandates are flagged and unrecoverable', () => {
    const cancelled = cases.filter((c) => c.mandate.cancelled_by_customer)
    expect(cancelled).toHaveLength(8)
    for (const c of cancelled) {
      expect(c.error.reason).toBe('mandate_revoked')
      // Nothing recovers these, so nothing should ever be attempted on them.
      expect(c._will_self_heal).toBe(false)
    }
  })

  it('over-limit cases really do exceed their mandate max', () => {
    const over = cases.filter((c) => c._true_cause === 'amount_exceeds_mandate_max')
    expect(over).toHaveLength(4)
    for (const c of over) {
      expect(c.amount_inr).toBeGreaterThan(c.mandate.max_amount_inr)
    }
  })

  it('every other case is within its mandate max', () => {
    const rest = cases.filter((c) => c._true_cause !== 'amount_exceeds_mandate_max')
    for (const c of rest) {
      expect(c.amount_inr).toBeLessThanOrEqual(c.mandate.max_amount_inr)
    }
  })

  it('late-auth cases are flagged, and most self-heal', () => {
    const late = cases.filter((c) => c.late_auth_pending)
    expect(late).toHaveLength(4)
    // Sampled at 0.70 from the simulator's own `none` column.
    expect(late.filter((c) => c._will_self_heal).length).toBeGreaterThanOrEqual(2)
  })

  it('has exactly four contact-blocked customers', () => {
    expect(cases.filter((c) => c.customer.dnd || c.customer.opted_out)).toHaveLength(4)
  })

  it('the ambiguous tail has a reason code that gives nothing away', () => {
    const vague = ['payment_failed', 'transaction_declined', 'processing_error']
    const tail = cases.filter((c) => vague.includes(c.error.reason))
    expect(tail).toHaveLength(8)
    // Its true causes must NOT be readable from the reason string, or the
    // rules table would resolve them and the LLM tail would be empty.
    for (const c of tail) {
      expect(c.error.reason).not.toContain(c._true_cause)
    }
  })

  it('no ambiguous description names a canonical cause', () => {
    // The descriptions carry real signal in prose — that is the point, it is
    // what a model can read and a lookup table cannot. But if one literally
    // contained "insufficient_funds", the whole exercise would collapse into
    // string matching and the model would be proving nothing.
    const vague = ['payment_failed', 'transaction_declined', 'processing_error']
    const tail = cases.filter((c) => vague.includes(c.error.reason))
    for (const c of tail) {
      const text = c.error.description.toLowerCase()
      for (const cause of TRUE_CAUSES) {
        expect(text).not.toContain(cause)
        // Also catch the spaced-out form, e.g. "insufficient funds".
        expect(text).not.toContain(cause.replace(/_/g, ' '))
      }
    }
  })

  it('keeps two of the tail genuinely undeterminable', () => {
    // These exercise the escalation path against real model output. If every
    // ambiguous case were solvable, the confidence floor would never fire and
    // would be an untested claim.
    const undeterminable = cases.filter(
      (c) => c._true_cause === 'unknown' && c.error.description.length > 0,
    )
    expect(undeterminable).toHaveLength(2)
  })

  it('never marks a non-card method as a domestic card', () => {
    for (const c of cases) {
      if (c.method !== 'card') expect(c.is_domestic_card).toBe(false)
    }
  })

  it('always halts after it failed', () => {
    for (const c of cases) {
      expect(Date.parse(c.halts_at)).toBeGreaterThan(Date.parse(c.failed_at))
    }
  })
})
