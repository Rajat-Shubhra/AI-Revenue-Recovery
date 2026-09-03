// TABLE B — the simulator's ground truth: P(success | action, true cause)
//
// This is the only place in the codebase allowed to read `_true_cause` and
// `_will_self_heal`. It scores what actually happens; the agent never sees it.
// Kept as one flat, readable table on purpose (BLUEPRINT §4.8) so a reviewer can
// check that it is not rigged in the agent's favour rather than take that on
// trust.
//
// Read the columns against each other, not down. The interesting claims are:
//   - retryNow on insufficient_funds is BAD (0.12) and retryScheduled is good
//     (0.52). That gap is what makes the sequencer decision worth anything.
//   - Both downtime rows recover well even with NO action (0.30 / 0.35). This
//     is the table being honest against itself: a big slice of "recovered"
//     money was never the agent's doing, and the holdout arm will take it back.
//   - mandate_cancelled is zero across every column including no-action. There
//     is no clever play; there is only not touching it.
//
// The numbers are hand-authored. Nobody measured them. Said plainly in the
// README and to be said out loud in the video.
import type { ActionName } from '../pipeline/recovery-priors'

/** `none` is the holdout arm and the HOLD decision: what happens if the agent
 *  does nothing at all. It is a column like any other so the two arms are
 *  scored by the same table. */
export type SimAction = ActionName | 'none'

export type OutcomeRow = Record<SimAction, number>

export const TRUE_CAUSES = [
  'insufficient_funds',
  'card_expired',
  'bank_blocked_card',
  'issuer_downtime',
  'gateway_downtime',
  'mandate_cancelled_by_customer',
  'upi_mandate_paused_by_customer',
  'amount_exceeds_mandate_max',
  'late_auth_pending',
  'unknown',
] as const

export type TrueCause = (typeof TRUE_CAUSES)[number]

export const OUTCOME_TABLE: Record<TrueCause, OutcomeRow> = {
  //                              retryNow  retrySched  switchRail  paymentLink  escalate  none
  insufficient_funds:            { retryNow: 0.12, retryScheduled: 0.52, switchRail: 0.10, sendPaymentLink: 0.30, escalate: 0.20, none: 0.08 },
  card_expired:                  { retryNow: 0.02, retryScheduled: 0.03, switchRail: 0.05, sendPaymentLink: 0.34, escalate: 0.25, none: 0.04 },
  bank_blocked_card:             { retryNow: 0.05, retryScheduled: 0.08, switchRail: 0.18, sendPaymentLink: 0.26, escalate: 0.25, none: 0.05 },
  issuer_downtime:               { retryNow: 0.35, retryScheduled: 0.82, switchRail: 0.62, sendPaymentLink: 0.30, escalate: 0.20, none: 0.30 },
  gateway_downtime:              { retryNow: 0.40, retryScheduled: 0.88, switchRail: 0.70, sendPaymentLink: 0.32, escalate: 0.20, none: 0.35 },
  mandate_cancelled_by_customer: { retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.00, sendPaymentLink: 0.00, escalate: 0.00, none: 0.00 },
  upi_mandate_paused_by_customer:{ retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.06, sendPaymentLink: 0.38, escalate: 0.22, none: 0.10 },
  amount_exceeds_mandate_max:    { retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.00, sendPaymentLink: 0.28, escalate: 0.55, none: 0.02 },
  // Special: recovery here is driven by `_will_self_heal`, not by acting. See
  // LATE_AUTH_SELF_HEAL_RATE and the double-charge note below.
  late_auth_pending:             { retryNow: 0.05, retryScheduled: 0.20, switchRail: 0.05, sendPaymentLink: 0.15, escalate: 0.18, none: 0.70 },
  unknown:                       { retryNow: 0.10, retryScheduled: 0.22, switchRail: 0.15, sendPaymentLink: 0.25, escalate: 0.30, none: 0.10 },
}

/**
 * The share of `late_auth_pending` cases whose authorisation lands on its own.
 * The generator samples `_will_self_heal` from this so the flag and the table
 * cannot drift apart.
 */
export const LATE_AUTH_SELF_HEAL_RATE = 0.70

/**
 * Causes where a debit-shaped action against a case that was going to settle
 * anyway produces a SECOND charge rather than a recovery.
 *
 * Not yet wired — the modelling decision is open (see MILESTONES.md M1 notes).
 */
export const DOUBLE_CHARGE_RISK: readonly TrueCause[] = ['late_auth_pending']

export function successProbability(cause: TrueCause, action: SimAction): number {
  return OUTCOME_TABLE[cause][action]
}
