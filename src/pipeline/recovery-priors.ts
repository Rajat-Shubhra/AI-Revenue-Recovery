// TABLE A — the agent's prior: P(recover | error code, method).
//
// Used by the prioritiser only (BLUEPRINT §4.2):
//   expected_value = amount_inr × P(recover | error, method)
//
// This is what the agent BELIEVES before it acts, and it runs BEFORE diagnosis
// — so it is keyed on the error code, which is all that is known at that point.
// It is deliberately NOT the table the simulator scores with
// (src/sim/outcomes.ts, keyed on `_true_cause`). If the two matched, the agent
// would be ranking cases using ground truth it has no way of knowing and every
// measured number would be worthless.
//
// Note what happens for an ambiguous code: the prior is the MEAN over every
// cause that code can carry. That is the honest thing to do — at ranking time
// the agent genuinely does not know whether `credit_failed` is a downtime blip
// (usually recoverable) or the customer picking the wrong account (usually
// not), so it prices in both.
//
// The per-cause numbers are hand-authored, not learned. They sit a little below
// the simulator's best-action probabilities, because an estimate made before
// diagnosis should be less confident than the outcome it is estimating.
import type { Case } from '../engine/case'
import { ERROR_CATALOGUE, type Cause } from './razorpay-errors'

type Method = Case['method']

/** Probability the case is recovered IF worked with the best available action. */
const CAUSE_PRIOR: Record<Cause, number> = {
  insufficient_funds: 0.45,
  limit_exceeded: 0.35,
  card_expired: 0.3,
  instrument_blocked: 0.25,
  instrument_inactive: 0.28,
  issuer_downtime: 0.75,
  gateway_downtime: 0.8,
  psp_downtime: 0.68,
  // Terminal. Exactly zero, which also sinks these to the bottom of the queue —
  // so the priority ranking is a second line of defence behind the compliance
  // gate rather than the only one.
  mandate_cancelled_by_customer: 0.0,
  mandate_paused_by_customer: 0.32,
  mandate_not_authorised: 0.35,
  amount_exceeds_mandate_max: 0.5,
  wrong_account_selected: 0.4,
  customer_abandoned: 0.45,
  merchant_config_error: 0.55,
  risk_declined: 0.45,
  late_auth_pending: 0.65,
  unknown: 0.25,
}

/** Rails differ a little: UPI retries land same-day, eMandate presentments don't. */
const METHOD_FACTOR: Record<Method, number> = { card: 1.0, upi: 1.06, emandate: 0.95 }

/** `source|code` → mean prior across every cause that pair can carry. */
const CODE_PRIOR = new Map<string, number>()
for (const entry of ERROR_CATALOGUE) {
  const k = `${entry.source}|${entry.code}`
  const matching = ERROR_CATALOGUE.filter((e) => `${e.source}|${e.code}` === k)
  const mean = matching.reduce((s, e) => s + CAUSE_PRIOR[e.cause], 0) / matching.length
  CODE_PRIOR.set(k, mean)
}

/** Used when a code is not in the catalogue at all. Deliberately pessimistic:
 *  an unrecognised failure should not outrank a known-recoverable one. */
export const UNKNOWN_CODE_PRIOR = 0.15

export function recoveryPrior(source: string, code: string, method: Method): number {
  const base = CODE_PRIOR.get(`${source}|${code}`) ?? UNKNOWN_CODE_PRIOR
  return Math.min(1, base * METHOD_FACTOR[method])
}

/** Exposed so the audit line can say what the agent believed and why. */
export function priorDetail(source: string, code: string): { mean: number; causes: Cause[] } {
  const k = `${source}|${code}`
  const causes = ERROR_CATALOGUE.filter((e) => `${e.source}|${e.code}` === k).map((e) => e.cause)
  return { mean: CODE_PRIOR.get(k) ?? UNKNOWN_CODE_PRIOR, causes }
}

/**
 * TABLE C — what each action costs to take, in rupees (BLUEPRINT §4.2).
 *
 * Retries are effectively free except that RBI requires a pre-debit
 * notification at least 24h ahead, which is one real SMS. Escalation is priced
 * as human minutes — by far the most expensive thing the agent can do, which is
 * what stops it escalating everything to look safe.
 */
export const ACTION_COST_INR = {
  retryNow: 0,
  retryScheduled: 0.25, // the mandatory pre-debit notice SMS
  switchRail: 0,
  sendPaymentLink: 2.0, // payment link + SMS delivery
  escalate: 50.0, // ~10 minutes of an ops human
} as const

export type ActionName = keyof typeof ACTION_COST_INR
