// The synthetic batch generator (BLUEPRINT §3), built from the real Razorpay
// error catalogue rather than a hand-invented one.
//
// Reproducibility is the requirement: the same seed must produce a
// byte-identical file every time, because the batch is re-run on camera. That
// means NO `Date.now()`, no `Math.random()`, no iteration over an object whose
// key order isn't fixed. Every value derives from the seeded PRNG or BATCH_NOW.
//
// This file is one of only three places allowed to touch `_true_cause` and
// `_will_self_heal` — it writes them. `tests/ground-truth-isolation.test.ts`
// enforces that nothing else outside /src/sim/ reads them.
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { writeFileSafe } from '../engine/fs-safe'
import type { Case } from '../engine/case'
import { OUTCOME_TABLE } from '../sim/outcomes'
import {
  ERROR_CATALOGUE,
  AMBIGUOUS_ENTRIES,
  DETERMINISTIC_ENTRIES,
  isAmbiguous,
  type Cause,
  type ErrorDef,
} from './razorpay-errors'

export const SEED = 20260905
/** Fixed reference time. Every timestamp is relative to this so reruns match. */
export const BATCH_NOW = Date.parse('2026-09-05T09:00:00.000Z')

export const BATCH_SIZE = 80
/**
 * Roughly a third of the batch carries an error code a lookup table cannot
 * resolve. That is the share the model works, and unlike the previous version
 * it is justified by Razorpay's own documentation: these are codes their docs
 * publish against more than one meaning.
 */
export const AMBIGUOUS_SHARE = 0.3

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

/**
 * `_will_self_heal` is sampled from the simulator's own `none` column, so the
 * flag and the outcome table can never drift apart.
 */
function willSelfHeal(rng: Rng, cause: Cause): boolean {
  return chance(rng, OUTCOME_TABLE[cause].none)
}

function build(rng: Rng, index: number, def: ErrorDef): Case {
  const method = pick(rng, def.methods)
  const amount = pick(rng, AMOUNTS)
  const failedAt = BATCH_NOW - hours(int(rng, 2, 72))
  // Wide spread so urgency actually differentiates cases in the queue. A few
  // land in the past — those subscriptions already halted.
  const haltsAt = failedAt + hours(int(rng, 18, 264))

  const cancelled = def.cause === 'mandate_cancelled_by_customer'
  const paused = def.cause === 'mandate_paused_by_customer'
  const overLimit = def.cause === 'amount_exceeds_mandate_max'

  // Contact consent is independent of the failure, so it is sampled rather than
  // tied to a cause — which is what makes the compliance gate bite on cases
  // that would otherwise be straightforward customer contact.
  const dnd = chance(rng, 0.06)
  const optedOut = !dnd && chance(rng, 0.05)

  return {
    id: `case_${String(index + 1).padStart(3, '0')}`,
    subscription_id: `sub_${int(rng, 10000000, 99999999)}`,
    customer: {
      id: `cust_${int(rng, 100000, 999999)}`,
      phone_masked: `+91XXXXXX${int(rng, 1000, 9999)}`,
      dnd,
      opted_out: optedOut,
    },
    amount_inr: amount,
    method,
    is_domestic_card: method === 'card' ? chance(rng, 0.7) : false,
    mandate: {
      // For the over-limit slice the ceiling sits below the debit; that is the
      // whole point of the case.
      max_amount_inr: overLimit
        ? Math.round(amount * 0.6)
        : Math.round(amount * pick(rng, [1.5, 2, 3, 5])),
      cancelled_by_customer: cancelled,
      paused_by_customer: paused,
    },
    error: {
      source: def.source,
      step: def.step,
      code: def.code,
      description: def.description,
    },
    failed_at: iso(failedAt),
    attempts: def.cause === 'late_auth_pending' ? 0 : int(rng, 0, 3),
    halts_at: iso(haltsAt),
    late_auth_pending: def.cause === 'late_auth_pending',
    _true_cause: def.cause,
    _will_self_heal: willSelfHeal(rng, def.cause),
  }
}

/**
 * Roughly how often each cause shows up in a real book of failed subscription
 * payments. Hand-authored — nobody measured it — but shaped by what actually
 * dominates recurring-payment failure: not enough money in the account, then
 * dead cards, then upstream outages.
 *
 * Weighting by CAUSE rather than by code matters. A uniform draw over the
 * catalogue gave 15 downtime cases against 3 insufficient-funds, purely because
 * downtime happens to have four documented codes and insufficient funds has
 * one. That is an artefact of how Razorpay names things, not of how payments
 * fail, and it would have quietly wrecked the measurement: downtime self-heals
 * far more than a dead card, so the holdout arm would have recovered most of
 * the batch on its own.
 */
const CAUSE_WEIGHT: Record<Cause, number> = {
  insufficient_funds: 26,
  card_expired: 12,
  instrument_blocked: 8,
  limit_exceeded: 5,
  issuer_downtime: 8,
  gateway_downtime: 5,
  psp_downtime: 4,
  mandate_cancelled_by_customer: 8,
  mandate_paused_by_customer: 3,
  mandate_not_authorised: 4,
  amount_exceeds_mandate_max: 3,
  wrong_account_selected: 3,
  customer_abandoned: 4,
  instrument_inactive: 3,
  merchant_config_error: 2,
  risk_declined: 2,
  late_auth_pending: 5,
  unknown: 6,
}

/**
 * Weighted draw. An entry's weight is its cause's weight divided across every
 * catalogue entry carrying that cause, so a cause with four codes is no more
 * likely than one with a single code — the codes share the cause's share.
 */
function weightedPick(rng: Rng, entries: ErrorDef[]): ErrorDef {
  const shareOf = (e: ErrorDef) =>
    CAUSE_WEIGHT[e.cause] / entries.filter((x) => x.cause === e.cause).length
  const total = entries.reduce((s, e) => s + shareOf(e), 0)
  let roll = rng() * total
  for (const e of entries) {
    roll -= shareOf(e)
    if (roll <= 0) return e
  }
  return entries[entries.length - 1]!
}

/**
 * Build the batch.
 *
 * The mix is drawn from the catalogue rather than a hand-written distribution
 * table: roughly 30% from entries whose `(source, code)` is genuinely
 * ambiguous, the rest from entries a rules table can resolve. Within each group
 * the draw is weighted by how often the underlying cause really occurs, so the
 * batch looks like a book of failed payments rather than a tour of the error
 * documentation.
 */
export function generateCases(seed: number = SEED, size: number = BATCH_SIZE): Case[] {
  const rng = mulberry32(seed)
  const ambiguousCount = Math.round(size * AMBIGUOUS_SHARE)

  const defs: ErrorDef[] = []
  for (let i = 0; i < ambiguousCount; i += 1) defs.push(weightedPick(rng, AMBIGUOUS_ENTRIES))
  for (let i = ambiguousCount; i < size; i += 1) defs.push(weightedPick(rng, DETERMINISTIC_ENTRIES))

  // Deal the two groups together so the ambiguous cases are not all at the end
  // — otherwise they would cluster at one end of the priority queue and the
  // model's work would look artificially batched.
  for (let i = defs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[defs[i], defs[j]] = [defs[j]!, defs[i]!]
  }

  return defs.map((def, i) => build(rng, i, def))
}

export function batchStats(cases: Case[]) {
  const ambiguous = cases.filter((c) => isAmbiguous(c.error.source, c.error.code))
  const byCause = new Map<string, number>()
  for (const c of cases) byCause.set(c._true_cause, (byCause.get(c._true_cause) ?? 0) + 1)
  return {
    total: cases.length,
    ambiguous: ambiguous.length,
    deterministic: cases.length - ambiguous.length,
    distinctCodes: new Set(cases.map((c) => c.error.code)).size,
    byCause: [...byCause].sort((a, b) => b[1] - a[1]),
  }
}

const OUT = fileURLToPath(new URL('../../data/cases.seed.json', import.meta.url))

export function writeCases(seed: number = SEED): { file: string; count: number } {
  const cases = generateCases(seed)
  writeFileSafe(OUT, `${JSON.stringify(cases, null, 2)}\n`)
  return { file: OUT, count: cases.length }
}

// Only run when invoked directly, so importing this for a test writes nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cases = generateCases()
  const { file, count } = writeCases()
  const stats = batchStats(cases)

  console.log(`Wrote ${count} cases (seed ${SEED}) → ${file}\n`)
  console.log(`  ${stats.distinctCodes} distinct error codes drawn from ${ERROR_CATALOGUE.length} catalogue entries`)
  console.log(`  ${stats.deterministic} resolvable by (source, code) · ${stats.ambiguous} genuinely ambiguous\n`)
  for (const [cause, n] of stats.byCause) {
    console.log(`  ${String(n).padStart(3)}  ${cause}`)
  }
}
