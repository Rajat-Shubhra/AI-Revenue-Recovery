// TABLE B — the simulator's ground truth: P(success | action, true cause).
//
// This file and simulator.ts are the only places allowed to read `_true_cause`
// and `_will_self_heal`. It scores what actually happens; the agent never sees
// it. Kept as one flat, readable table on purpose (BLUEPRINT §4.8) so a
// reviewer can check it is not rigged rather than take that on trust.
//
// Read the columns against each other, not down. The claims doing the work:
//
//   - retryNow on insufficient_funds is BAD (0.12) and retryScheduled is good
//     (0.52). That gap is what makes the sequencing decision worth anything.
//   - psp_downtime is the one cause where switchRail (0.75) beats a scheduled
//     retry (0.70) — moving off a broken PSP is better than waiting for it.
//   - Both downtime rows recover well with NO action (0.28–0.35). The table
//     being honest against itself: a large slice of "recovered" money was never
//     the agent's doing, and the holdout arm takes it back.
//   - mandate_cancelled is zero in every column including no-action. There is
//     no clever play; there is only not touching it.
//   - late_auth_pending is highest in the `none` column. Doing nothing beats
//     every action, which is what makes HOLD a real decision.
//
// The numbers are hand-authored. Nobody measured them. Said plainly in the
// README and to be said out loud in the video.
import type { ActionName } from '../pipeline/recovery-priors'
import type { Cause } from '../pipeline/razorpay-errors'
import { ALL_CAUSES } from '../pipeline/razorpay-errors'

/** `none` is the holdout arm and the HOLD decision: what happens if the agent
 *  does nothing at all. A column like any other, so both arms are scored by the
 *  same table. */
export type SimAction = ActionName | 'none'

export type OutcomeRow = Record<SimAction, number>

export const TRUE_CAUSES = ALL_CAUSES
export type TrueCause = Cause

export const OUTCOME_TABLE: Record<Cause, OutcomeRow> = {
  //                            retryNow  retrySched  switchRail  paymentLink  escalate  none
  insufficient_funds:            { retryNow: 0.12, retryScheduled: 0.52, switchRail: 0.10, sendPaymentLink: 0.30, escalate: 0.20, none: 0.08 },
  limit_exceeded:                { retryNow: 0.05, retryScheduled: 0.35, switchRail: 0.15, sendPaymentLink: 0.40, escalate: 0.20, none: 0.12 },

  card_expired:                  { retryNow: 0.02, retryScheduled: 0.03, switchRail: 0.05, sendPaymentLink: 0.34, escalate: 0.25, none: 0.04 },
  instrument_blocked:            { retryNow: 0.05, retryScheduled: 0.08, switchRail: 0.18, sendPaymentLink: 0.26, escalate: 0.25, none: 0.05 },
  instrument_inactive:           { retryNow: 0.03, retryScheduled: 0.05, switchRail: 0.20, sendPaymentLink: 0.30, escalate: 0.25, none: 0.04 },

  issuer_downtime:               { retryNow: 0.35, retryScheduled: 0.82, switchRail: 0.62, sendPaymentLink: 0.30, escalate: 0.20, none: 0.30 },
  gateway_downtime:              { retryNow: 0.40, retryScheduled: 0.88, switchRail: 0.70, sendPaymentLink: 0.32, escalate: 0.20, none: 0.35 },
  // The one cause where leaving the rail beats waiting on it.
  psp_downtime:                  { retryNow: 0.30, retryScheduled: 0.70, switchRail: 0.75, sendPaymentLink: 0.35, escalate: 0.20, none: 0.28 },

  mandate_cancelled_by_customer: { retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.00, sendPaymentLink: 0.00, escalate: 0.00, none: 0.00 },
  mandate_paused_by_customer:    { retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.06, sendPaymentLink: 0.38, escalate: 0.22, none: 0.10 },
  mandate_not_authorised:        { retryNow: 0.02, retryScheduled: 0.10, switchRail: 0.15, sendPaymentLink: 0.40, escalate: 0.35, none: 0.06 },
  amount_exceeds_mandate_max:    { retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.00, sendPaymentLink: 0.28, escalate: 0.55, none: 0.02 },

  wrong_account_selected:        { retryNow: 0.00, retryScheduled: 0.05, switchRail: 0.10, sendPaymentLink: 0.45, escalate: 0.25, none: 0.08 },
  customer_abandoned:            { retryNow: 0.15, retryScheduled: 0.40, switchRail: 0.10, sendPaymentLink: 0.50, escalate: 0.15, none: 0.20 },

  merchant_config_error:         { retryNow: 0.00, retryScheduled: 0.00, switchRail: 0.00, sendPaymentLink: 0.10, escalate: 0.65, none: 0.02 },
  risk_declined:                 { retryNow: 0.02, retryScheduled: 0.05, switchRail: 0.08, sendPaymentLink: 0.15, escalate: 0.55, none: 0.05 },

  late_auth_pending:             { retryNow: 0.05, retryScheduled: 0.20, switchRail: 0.05, sendPaymentLink: 0.15, escalate: 0.18, none: 0.70 },
  unknown:                       { retryNow: 0.10, retryScheduled: 0.22, switchRail: 0.15, sendPaymentLink: 0.25, escalate: 0.30, none: 0.10 },
}

/**
 * The share of `late_auth_pending` cases whose authorisation lands on its own.
 * The generator samples `_will_self_heal` from the `none` column, so the flag
 * and the table cannot drift apart.
 */
export const LATE_AUTH_SELF_HEAL_RATE = OUTCOME_TABLE.late_auth_pending.none

/**
 * Causes where a debit-shaped action against a case that was going to settle
 * anyway produces a SECOND charge rather than a recovery.
 *
 * Not yet wired — the modelling decision is open (see MILESTONES.md, deferred).
 */
export const DOUBLE_CHARGE_RISK: readonly Cause[] = ['late_auth_pending']

export function successProbability(cause: Cause, action: SimAction): number {
  return OUTCOME_TABLE[cause][action]
}

/** The action with the highest chance for a cause. Used by tests to assert the
 *  decide table is not leaving obvious money on the table. */
export function bestAction(cause: Cause): SimAction {
  const row = OUTCOME_TABLE[cause]
  return (Object.keys(row) as SimAction[]).reduce((a, b) => (row[b] > row[a] ? b : a))
}
