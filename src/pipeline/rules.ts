// M3 — deterministic diagnosis (BLUEPRINT §4.3).
//
// A table from (error.source, error.reason) → cause. This is the stage that
// makes the AI Judgment claim true: payment error codes are structured data
// with documented meanings, so reasoning over them with a language model is the
// wrong tool. Everything the rules can settle, they settle — for free, in
// microseconds, and identically every run.
//
// Only what the rules cannot resolve reaches the model, which by design is the
// ambiguous slice: reasons like `payment_failed` that carry no information.
//
// Each rule has an id so the audit trail can name what fired (§4.9).
import type { Case } from '../engine/case'

/** The closed set of causes. Kept in step with ALLOWED_CAUSES in prompt.ts and
 *  TRUE_CAUSES in sim/outcomes.ts; a test asserts all three match. */
export type Cause =
  | 'insufficient_funds'
  | 'card_expired'
  | 'bank_blocked_card'
  | 'issuer_downtime'
  | 'gateway_downtime'
  | 'mandate_cancelled_by_customer'
  | 'upi_mandate_paused_by_customer'
  | 'amount_exceeds_mandate_max'
  | 'late_auth_pending'
  | 'unknown'

export type Rule = {
  id: string
  /** What this rule matches, in words, for the audit line. */
  describes: string
  matches(kase: Case): boolean
  cause: Cause
}

/**
 * Order matters: the first match wins, and the state-of-the-world rules come
 * before the error-code rules.
 *
 * A cancelled mandate is a cancelled mandate whatever the gateway said the
 * reason was, and a debit above `max_amount` cannot succeed however it was
 * described. Reading those off the case rather than off the error string means
 * a mislabelled or vague error cannot smuggle a terminal case into the
 * recoverable pile.
 */
export const RULES: Rule[] = [
  {
    id: 'R1',
    describes: 'mandate cancelled by the customer — terminal regardless of error code',
    matches: (k) => k.mandate.cancelled_by_customer,
    cause: 'mandate_cancelled_by_customer',
  },
  {
    id: 'R2',
    describes: 'debit exceeds the mandate max_amount — cannot succeed however retried',
    matches: (k) => k.amount_inr > k.mandate.max_amount_inr,
    cause: 'amount_exceeds_mandate_max',
  },
  {
    id: 'R3',
    describes: 'authorisation still pending — the case may settle itself',
    matches: (k) => k.late_auth_pending,
    cause: 'late_auth_pending',
  },
  {
    id: 'R4',
    describes: 'UPI mandate paused by the customer — only they can resume it',
    matches: (k) => k.mandate.paused_by_customer,
    cause: 'upi_mandate_paused_by_customer',
  },

  // Error-code rules. Matched on (source, reason) together: the same reason
  // string from a different source can mean a different thing.
  {
    id: 'R5',
    describes: 'customer/insufficient_funds',
    matches: (k) => k.error.source === 'customer' && k.error.reason === 'insufficient_funds',
    cause: 'insufficient_funds',
  },
  {
    id: 'R6',
    describes: 'customer/card_expired',
    matches: (k) => k.error.source === 'customer' && k.error.reason === 'card_expired',
    cause: 'card_expired',
  },
  {
    id: 'R7',
    describes: 'issuer_bank/bank_blocked_card',
    matches: (k) => k.error.source === 'issuer_bank' && k.error.reason === 'bank_blocked_card',
    cause: 'bank_blocked_card',
  },
  {
    id: 'R8',
    describes: 'issuer_bank/issuer_unavailable',
    matches: (k) => k.error.source === 'issuer_bank' && k.error.reason === 'issuer_unavailable',
    cause: 'issuer_downtime',
  },
  {
    id: 'R9',
    describes: 'gateway/gateway_error',
    matches: (k) => k.error.source === 'gateway' && k.error.reason === 'gateway_error',
    cause: 'gateway_downtime',
  },
  {
    id: 'R10',
    describes: 'customer/mandate_revoked',
    matches: (k) => k.error.source === 'customer' && k.error.reason === 'mandate_revoked',
    cause: 'mandate_cancelled_by_customer',
  },
  {
    id: 'R11',
    describes: 'internal/authorization_pending',
    matches: (k) => k.error.source === 'internal' && k.error.reason === 'authorization_pending',
    cause: 'late_auth_pending',
  },
  {
    id: 'R12',
    describes: 'business/amount_limit_exceeded',
    matches: (k) => k.error.source === 'business' && k.error.reason === 'amount_limit_exceeded',
    cause: 'amount_exceeds_mandate_max',
  },
]

export type RuleHit = { cause: Cause; rule: Rule } | null

/** First matching rule wins. Null means the model has to look at it. */
export function applyRules(kase: Case): RuleHit {
  for (const rule of RULES) {
    if (rule.matches(kase)) return { cause: rule.cause, rule }
  }
  return null
}

/**
 * Reasons the rules deliberately do not cover. Kept explicit so that a genuinely
 * unhandled reason shows up as a gap in the table rather than being mistaken for
 * an intentional hand-off to the model.
 */
export const AMBIGUOUS_REASONS = new Set([
  'payment_failed',
  'transaction_declined',
  'processing_error',
])
