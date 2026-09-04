// Generator invariants: the batch is reproducible, and it is drawn from
// Razorpay's real error taxonomy rather than an invented one.
import { describe, it, expect } from 'vitest'
import { generateCases, batchStats, SEED, BATCH_SIZE, AMBIGUOUS_SHARE } from '../src/pipeline/generate'
import {
  ALL_CAUSES,
  ALL_CODES,
  ERROR_CATALOGUE,
  isAmbiguous,
} from '../src/pipeline/razorpay-errors'
import { OUTCOME_TABLE } from '../src/sim/outcomes'

const cases = generateCases()
const stats = batchStats(cases)

describe('synthetic batch', () => {
  it('produces the configured batch size', () => {
    expect(cases).toHaveLength(BATCH_SIZE)
  })

  it('is byte-identical across runs with the same seed', () => {
    // The batch is re-run on camera. If this fails, the demo is not reproducible.
    expect(JSON.stringify(generateCases())).toBe(JSON.stringify(generateCases()))
  })

  it('produces a different batch for a different seed', () => {
    expect(JSON.stringify(generateCases(SEED + 1))).not.toBe(JSON.stringify(cases))
  })

  it('has unique ids in stable order', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(BATCH_SIZE)
    expect(cases[0]!.id).toBe('case_001')
    expect(cases[BATCH_SIZE - 1]!.id).toBe(`case_${String(BATCH_SIZE).padStart(3, '0')}`)
  })
})

describe('drawn from the real taxonomy', () => {
  it('uses only error codes that exist in the catalogue', () => {
    for (const c of cases) expect(ALL_CODES).toContain(c.error.code)
  })

  it('uses only the four sources Razorpay actually emits', () => {
    // An earlier version used `internal` and `issuer_bank`, which the API
    // never returns. Every case carried a value that does not exist.
    const real = ['customer', 'business', 'gateway', 'razorpay']
    for (const c of cases) expect(real).toContain(c.error.source)
  })

  it('gives every case a cause the simulator can score', () => {
    for (const c of cases) {
      expect(ALL_CAUSES).toContain(c._true_cause)
      expect(OUTCOME_TABLE[c._true_cause as keyof typeof OUTCOME_TABLE]).toBeDefined()
    }
  })

  it('pairs every case with a description the catalogue actually publishes', () => {
    for (const c of cases) {
      const match = ERROR_CATALOGUE.find(
        (e) => e.code === c.error.code && e.source === c.error.source && e.description === c.error.description,
      )
      expect(match, `${c.id} has an unlisted description`).toBeDefined()
      expect(match!.cause).toBe(c._true_cause)
    }
  })

  it('draws a wide spread of codes rather than a curated handful', () => {
    expect(stats.distinctCodes).toBeGreaterThanOrEqual(15)
  })
})

describe('the ambiguous share', () => {
  it('is about the configured proportion', () => {
    const expected = BATCH_SIZE * AMBIGUOUS_SHARE
    // Sampling is uniform over the catalogue, so allow a little slack.
    expect(stats.ambiguous).toBeGreaterThanOrEqual(expected * 0.8)
    expect(stats.ambiguous).toBeLessThanOrEqual(expected * 1.2)
  })

  it('is genuinely undecidable from the code, not merely vague', () => {
    // Each ambiguous case's (source, code) must appear in the catalogue with
    // more than one cause. That is a documented collision, not an invented one.
    for (const c of cases.filter((k) => isAmbiguous(k.error.source, k.error.code))) {
      const causes = new Set(
        ERROR_CATALOGUE.filter((e) => e.source === c.error.source && e.code === c.error.code).map((e) => e.cause),
      )
      expect(causes.size).toBeGreaterThan(1)
    }
  })

  it('never names a canonical cause inside the description', () => {
    // The descriptions carry real signal in prose — that is the point, it is
    // what a model can read and a lookup table cannot. But if one literally
    // contained "insufficient_funds", the whole exercise would collapse into
    // string matching and prove nothing.
    for (const c of cases) {
      const text = c.error.description.toLowerCase()
      for (const cause of ALL_CAUSES) {
        expect(text, `${c.id}: ${c.error.description}`).not.toContain(cause)
        expect(text).not.toContain(cause.replace(/_/g, ' '))
      }
    }
  })

  it('includes cases that are honestly undeterminable', () => {
    // These exercise the escalation path against real model output. If every
    // ambiguous case were solvable the confidence floor would never fire.
    expect(cases.filter((c) => c._true_cause === 'unknown').length).toBeGreaterThan(0)
  })

  it('is dealt through the batch rather than clustered at one end', () => {
    const positions = cases
      .map((c, i) => (isAmbiguous(c.error.source, c.error.code) ? i : -1))
      .filter((i) => i >= 0)
    const firstHalf = positions.filter((i) => i < BATCH_SIZE / 2).length
    // Not a strict split — just evidence they are not all bunched together,
    // which would make the model's work look artificially batched.
    expect(firstHalf).toBeGreaterThan(positions.length * 0.2)
    expect(firstHalf).toBeLessThan(positions.length * 0.8)
  })
})

describe('case shapes hold', () => {
  it('flags cancelled mandates and leaves them unrecoverable', () => {
    const cancelled = cases.filter((c) => c.mandate.cancelled_by_customer)
    expect(cancelled.length).toBeGreaterThan(0)
    for (const c of cancelled) {
      expect(c._true_cause).toBe('mandate_cancelled_by_customer')
      expect(c._will_self_heal).toBe(false)
    }
  })

  it('makes over-limit cases genuinely exceed their ceiling', () => {
    const over = cases.filter((c) => c._true_cause === 'amount_exceeds_mandate_max')
    for (const c of over) expect(c.amount_inr).toBeGreaterThan(c.mandate.max_amount_inr)
  })

  it('keeps every other case within its ceiling', () => {
    for (const c of cases.filter((k) => k._true_cause !== 'amount_exceeds_mandate_max')) {
      expect(c.amount_inr).toBeLessThanOrEqual(c.mandate.max_amount_inr)
    }
  })

  it('flags late-auth cases and gives them no prior attempts', () => {
    for (const c of cases.filter((k) => k._true_cause === 'late_auth_pending')) {
      expect(c.late_auth_pending).toBe(true)
      expect(c.attempts).toBe(0)
    }
  })

  it('never marks a non-card method as a domestic card', () => {
    for (const c of cases) {
      if (c.method !== 'card') expect(c.is_domestic_card).toBe(false)
    }
  })

  it('only puts a code on a rail the catalogue allows it on', () => {
    for (const c of cases) {
      const entry = ERROR_CATALOGUE.find(
        (e) => e.code === c.error.code && e.source === c.error.source && e.description === c.error.description,
      )!
      expect(entry.methods).toContain(c.method)
    }
  })

  it('always halts after it failed', () => {
    for (const c of cases) {
      expect(Date.parse(c.halts_at)).toBeGreaterThan(Date.parse(c.failed_at))
    }
  })

  it('has some customers who cannot be contacted', () => {
    expect(cases.filter((c) => c.customer.dnd || c.customer.opted_out).length).toBeGreaterThan(0)
  })
})
