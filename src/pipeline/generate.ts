// M1 — the synthetic batch generator (BLUEPRINT §3).
//
// Reproducibility is the whole requirement: the same seed must produce a
// byte-identical file every time, because the batch is re-run on camera. That
// means NO `Date.now()`, no `Math.random()`, no iteration over an object whose
// key order isn't fixed. Every value below derives from the seeded PRNG or from
// BATCH_NOW.
//
// This file is one of only three places allowed to touch `_true_cause` and
// `_will_self_heal` — it writes them. Nothing downstream outside /src/sim/ may
// read them; `tests/ground-truth-isolation.test.ts` enforces that.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { writeFileSafe } from '../engine/fs-safe'
import type { Case } from '../engine/case'
import { OUTCOME_TABLE, type TrueCause } from '../sim/outcomes'

export const SEED = 20260905
/** Fixed reference time. Every timestamp is relative to this so reruns match. */
export const BATCH_NOW = Date.parse('2026-09-05T09:00:00.000Z')

/** mulberry32 — small, fast, and deterministic across Node versions. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number

const pick = <T,>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
const chance = (rng: Rng, p: number) => rng() < p
const hours = (h: number) => h * 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

/** Realistic Indian subscription price points, with a long tail so the
 *  prioritiser has something meaningful to rank by. */
const AMOUNTS = [149, 199, 249, 299, 399, 499, 599, 799, 999, 1499, 1999, 2999, 4999, 9999] as const

const METHODS = ['card', 'upi', 'emandate'] as const

function customer(rng: Rng, opts: { dnd?: boolean; opted_out?: boolean } = {}) {
  return {
    id: `cust_${int(rng, 100000, 999999)}`,
    phone_masked: `+91XXXXXX${int(rng, 1000, 9999)}`,
    dnd: opts.dnd ?? false,
    opted_out: opts.opted_out ?? false,
  }
}

/**
 * `_will_self_heal` is sampled from the simulator's own `none` column, so the
 * flag and the outcome table can never drift apart. For late_auth_pending that
 * is 0.70, matching LATE_AUTH_SELF_HEAL_RATE.
 */
function willSelfHeal(rng: Rng, cause: TrueCause): boolean {
  return chance(rng, OUTCOME_TABLE[cause].none)
}

type Draft = {
  amount?: number
  method?: Case['method']
  is_domestic_card?: boolean
  maxAmountMultiplier?: number
  cancelled?: boolean
  paused?: boolean
  dnd?: boolean
  opted_out?: boolean
  late_auth?: boolean
  attempts?: number
  source: Case['error']['source']
  step: string
  reason: string
  description: string
  cause: TrueCause
}

function build(rng: Rng, index: number, d: Draft): Case {
  const amount = d.amount ?? pick(rng, AMOUNTS)
  const method = d.method ?? pick(rng, METHODS)
  const failedAt = BATCH_NOW - hours(int(rng, 2, 72))
  // How long until Razorpay halts the subscription. Wide spread so urgency
  // actually differentiates cases in the priority queue.
  const haltsAt = failedAt + hours(int(rng, 18, 264))

  return {
    id: `case_${String(index + 1).padStart(3, '0')}`,
    subscription_id: `sub_${int(rng, 10000000, 99999999)}`,
    customer: customer(rng, { dnd: d.dnd, opted_out: d.opted_out }),
    amount_inr: amount,
    method,
    is_domestic_card: method === 'card' ? (d.is_domestic_card ?? chance(rng, 0.7)) : false,
    mandate: {
      max_amount_inr: Math.round(amount * (d.maxAmountMultiplier ?? pick(rng, [1.5, 2, 3, 5]))),
      cancelled_by_customer: d.cancelled ?? false,
      paused_by_customer: d.paused ?? false,
    },
    error: {
      source: d.source,
      step: d.step,
      reason: d.reason,
      description: d.description,
    },
    failed_at: iso(failedAt),
    attempts: d.attempts ?? int(rng, 0, 2),
    halts_at: iso(haltsAt),
    late_auth_pending: d.late_auth ?? false,
    _true_cause: d.cause,
    _will_self_heal: willSelfHeal(rng, d.cause),
  }
}

/** One entry per §3 slice. Order is fixed, so case ids are stable. */
const SLICES: { name: string; count: number; draft: (rng: Rng, n: number) => Draft }[] = [
  {
    // 30% — the sequencer slice. Retrying into the same empty account fails;
    // aiming at the next salary cycle works.
    name: 'insufficient_funds',
    count: 24,
    draft: () => ({
      source: 'customer',
      step: 'payment_authorization',
      reason: 'insufficient_funds',
      description: 'Payment failed because the account had insufficient balance.',
      cause: 'insufficient_funds',
    }),
  },
  {
    // 20% — broken instrument. Only the customer can fix it.
    name: 'card_expired / bank_blocked_card',
    count: 16,
    draft: (_rng, n) =>
      n % 2 === 0
        ? {
            method: 'card',
            source: 'customer',
            step: 'payment_authentication',
            reason: 'card_expired',
            description: 'The card used for this mandate has expired.',
            cause: 'card_expired',
          }
        : {
            method: 'card',
            source: 'issuer_bank',
            step: 'payment_authorization',
            reason: 'bank_blocked_card',
            description: 'The issuing bank has blocked this card for online debits.',
            cause: 'bank_blocked_card',
          },
  },
  {
    // 15% — transient. Recovers well even untouched, which the holdout exposes.
    name: 'issuer / gateway downtime',
    count: 12,
    draft: (_rng, n) =>
      n % 2 === 0
        ? {
            source: 'issuer_bank',
            step: 'payment_authorization',
            reason: 'issuer_unavailable',
            description: 'The issuing bank was unavailable when the debit was attempted.',
            cause: 'issuer_downtime',
          }
        : {
            source: 'gateway',
            step: 'payment_initiation',
            reason: 'gateway_error',
            description: 'The payment gateway returned a transient processing error.',
            cause: 'gateway_downtime',
          },
  },
  {
    // 10% — terminal. Any contact is a compliance violation.
    name: 'mandate cancelled by customer',
    count: 8,
    draft: () => ({
      cancelled: true,
      source: 'customer',
      step: 'mandate_debit',
      reason: 'mandate_revoked',
      description: 'The customer cancelled this mandate with their bank.',
      cause: 'mandate_cancelled_by_customer',
    }),
  },
  {
    // 5% — acting here risks a second charge. Doing nothing is the right move.
    name: 'late auth pending',
    count: 4,
    draft: () => ({
      late_auth: true,
      source: 'internal',
      step: 'payment_authorization',
      reason: 'authorization_pending',
      description: 'Authorisation has not yet been confirmed by the bank.',
      cause: 'late_auth_pending',
    }),
  },
  {
    // 5% — merchant config problem, not the customer's fault. A retry can
    // never succeed, so this must escalate.
    name: 'amount exceeds mandate max',
    count: 4,
    draft: (rng) => ({
      amount: pick(rng, [1999, 2999, 4999, 9999]),
      maxAmountMultiplier: 0.6, // max_amount below the debit — the whole point
      source: 'business',
      step: 'mandate_debit',
      reason: 'amount_limit_exceeded',
      description: 'Debit amount exceeds the maximum authorised by the mandate.',
      cause: 'amount_exceeds_mandate_max',
    }),
  },
  {
    // 5% — the underlying fix needs contact, and contact is blocked. Retry is
    // still allowed where the bucket is AUTO, which is the distinction the
    // compliance gate has to get right.
    name: 'dnd / opted out',
    count: 4,
    draft: (_rng, n) => ({
      method: 'card',
      dnd: n < 2,
      opted_out: n >= 2,
      source: 'customer',
      step: 'payment_authentication',
      reason: 'card_expired',
      description: 'The card used for this mandate has expired.',
      cause: 'card_expired',
    }),
  },
  {
    // 10% — the LLM tail. The observed reason is genuinely uninformative; the
    // true cause is knowable for six of these and honestly not for two, so the
    // confidence floor gets exercised rather than just asserted.
    name: 'unknown / ambiguous',
    count: 8,
    draft: (_rng, n) => {
      const hidden: TrueCause[] = [
        'insufficient_funds',
        'insufficient_funds',
        'insufficient_funds',
        'bank_blocked_card',
        'bank_blocked_card',
        'issuer_downtime',
        'unknown',
        'unknown',
      ]
      const vague = [
        {
          reason: 'payment_failed',
          description: 'The payment could not be completed.',
          source: 'internal' as const,
        },
        {
          reason: 'transaction_declined',
          description: 'The transaction was declined. No further detail was provided.',
          source: 'issuer_bank' as const,
        },
        {
          reason: 'processing_error',
          description: 'An error occurred while processing the debit.',
          source: 'gateway' as const,
        },
      ]
      const v = vague[n % vague.length]!
      return {
        source: v.source,
        step: 'payment_authorization',
        reason: v.reason,
        description: v.description,
        cause: hidden[n]!,
      }
    },
  },
]

export function generateCases(seed: number = SEED): Case[] {
  const rng = mulberry32(seed)
  const cases: Case[] = []
  for (const slice of SLICES) {
    for (let n = 0; n < slice.count; n += 1) {
      cases.push(build(rng, cases.length, slice.draft(rng, n)))
    }
  }
  return cases
}

export const SLICE_COUNTS = Object.fromEntries(SLICES.map((s) => [s.name, s.count]))

const OUT = fileURLToPath(new URL('../../data/cases.seed.json', import.meta.url))

export function writeCases(seed: number = SEED): { file: string; count: number } {
  const cases = generateCases(seed)
  writeFileSafe(OUT, `${JSON.stringify(cases, null, 2)}\n`)
  return { file: OUT, count: cases.length }
}

// Only run when invoked directly, so importing this for a test writes nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { file, count } = writeCases()
  console.log(`Wrote ${count} cases (seed ${SEED}) → ${file}`)
  for (const [name, n] of Object.entries(SLICE_COUNTS)) {
    console.log(`  ${String(n).padStart(3)}  ${name}`)
  }
}
