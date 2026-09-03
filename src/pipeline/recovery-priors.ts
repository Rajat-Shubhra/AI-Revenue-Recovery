// TABLE A — the agent's prior: P(recover | observed error reason, method)
//
// Used by the prioritiser only (BLUEPRINT §4.2):
//   expected_value = amount_inr × P(recover | error.reason, method)
//
// This is what the agent BELIEVES before it acts, keyed on the error reason it
// can actually see on the case. It is deliberately NOT the same table the
// simulator scores outcomes with (src/sim/outcomes.ts, keyed on _true_cause).
// If the two matched, the agent would be ranking cases using ground truth it has
// no way of knowing, and every measured number would be worthless. The gap
// between this table and reality is the thing the holdout arm exists to expose.
//
// These numbers are hand-authored, not learned. They are shaped by how Indian
// subscription rails behave — a scheduled retry aimed at a salary cycle beats an
// immediate one; an expired card cannot be retried into working; downtime is
// transient and mostly resolves — but the specific values are judgement, not
// measurement. Stated plainly here and in the README.
import type { Case } from '../engine/case'

type Method = Case['method']

/** Probability the case is recovered IF the agent works it with the best
 *  action available for that reason. Not a base rate — a worked-case rate. */
export type RecoveryPrior = Record<Method, number>

/**
 * Every reason the generator can emit, including the vague ones in the
 * ambiguous slice that `rules.ts` is not meant to resolve.
 *
 * All three methods are listed explicitly even where the value is identical,
 * so the table can be read and argued with rather than reverse-engineered from
 * a base rate and a multiplier.
 */
export const RECOVERY_PRIORS: Record<string, RecoveryPrior> = {
  // Money wasn't there. Timing is everything, and UPI Autopay debits retry
  // slightly better because they can be aimed at a credit event same-day.
  insufficient_funds: { card: 0.42, upi: 0.48, emandate: 0.40 },

  // The instrument is dead. No retry fixes this; only the customer can.
  card_expired: { card: 0.28, upi: 0.28, emandate: 0.26 },
  bank_blocked_card: { card: 0.22, upi: 0.22, emandate: 0.20 },

  // Transient. Most of these recover on their own or on the next attempt,
  // which is exactly why acting on them looks impressive and proves little —
  // the holdout arm will claw most of this back.
  issuer_unavailable: { card: 0.75, upi: 0.78, emandate: 0.72 },
  gateway_error: { card: 0.82, upi: 0.85, emandate: 0.80 },

  // Terminal. The customer revoked consent. Nothing is recoverable and any
  // contact is a compliance violation, so this must be exactly zero — it also
  // guarantees these cases sink to the bottom of the priority queue.
  mandate_revoked: { card: 0.0, upi: 0.0, emandate: 0.0 },

  // Only the customer can resume a paused mandate, but they can still pay a
  // one-off link, so this is not zero.
  mandate_paused: { card: 0.30, upi: 0.32, emandate: 0.30 },

  // A merchant configuration problem. Low, and what recovery exists comes from
  // a human fixing the mandate, not from anything the agent can do.
  amount_limit_exceeded: { card: 0.15, upi: 0.15, emandate: 0.15 },

  // Authorisation may still land. High prior — but see the simulator: the
  // recovery here mostly happens by NOT acting.
  authorization_pending: { card: 0.70, upi: 0.68, emandate: 0.65 },

  // The ambiguous slice. Vague reasons the rules table is not meant to resolve;
  // these are the ~10% that reach the model.
  payment_failed: { card: 0.22, upi: 0.24, emandate: 0.20 },
  transaction_declined: { card: 0.20, upi: 0.22, emandate: 0.18 },
  processing_error: { card: 0.24, upi: 0.26, emandate: 0.22 },
}

/** Used when a reason is not in the table at all. Deliberately pessimistic:
 *  an unrecognised failure should not outrank a known-recoverable one. */
export const UNKNOWN_REASON_PRIOR = 0.15

export function recoveryPrior(reason: string, method: Method): number {
  return RECOVERY_PRIORS[reason]?.[method] ?? UNKNOWN_REASON_PRIOR
}

/**
 * TABLE C — what each action costs to take, in rupees (BLUEPRINT §4.2).
 *
 * Retries are effectively free except that RBI requires a pre-debit
 * notification at least 24h ahead, which is one real SMS. Escalation is priced
 * as human minutes — it is by far the most expensive thing the agent can do,
 * which is what stops it escalating everything to look safe.
 */
export const ACTION_COST_INR = {
  retryNow: 0,
  retryScheduled: 0.25, // the mandatory pre-debit notice SMS
  switchRail: 0,
  sendPaymentLink: 2.0, // payment link + SMS delivery
  escalate: 50.0, // ~10 minutes of an ops human
} as const

export type ActionName = keyof typeof ACTION_COST_INR
