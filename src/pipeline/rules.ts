// Deterministic diagnosis (BLUEPRINT §4.3).
//
// The rules table resolves `(source, code)` → cause using Razorpay's own
// published error taxonomy. This is the stage that makes the AI-judgment claim
// true: most payment error codes are structured data with a documented meaning,
// so reasoning over them with a language model is the wrong tool.
//
// What it must NOT do is pretend to resolve the codes that carry more than one
// meaning. Razorpay's docs publish `credit_failed` as both "the customer chose
// a different bank account" and "partner bank downtime" — opposite remedies
// behind one code. A table that picked one would be wrong half the time and
// confident about it. Those pairs are refused here and handed to the model,
// which can read the issuer's advice text.
//
// The refusal list is derived from the catalogue, not hand-maintained, so it
// cannot drift out of step with the data.
import type { Case } from '../engine/case'
import {
  ERROR_CATALOGUE,
  isAmbiguous,
  type Cause,
} from './razorpay-errors'

export type { Cause } from './razorpay-errors'

export type RuleHit = {
  cause: Cause
  /** Rule id for the audit line — `R:<source>/<code>` or a state rule. */
  id: string
  describes: string
}

/**
 * State-of-the-world rules, checked BEFORE the error code.
 *
 * A cancelled mandate is a cancelled mandate whatever the gateway said, and a
 * debit above the ceiling cannot succeed however it was described. Reading
 * these off the case rather than the error string means a mislabelled or vague
 * error cannot smuggle a terminal case into the recoverable pile.
 */
const STATE_RULES: { id: string; describes: string; matches(k: Case): boolean; cause: Cause }[] = [
  {
    id: 'S1',
    describes: 'mandate cancelled by the customer — terminal regardless of error code',
    matches: (k) => k.mandate.cancelled_by_customer,
    cause: 'mandate_cancelled_by_customer',
  },
  {
    id: 'S2',
    describes: 'debit exceeds the mandate max_amount — cannot succeed however retried',
    matches: (k) => k.amount_inr > k.mandate.max_amount_inr,
    cause: 'amount_exceeds_mandate_max',
  },
  {
    id: 'S3',
    describes: 'authorisation still pending — the case may settle itself',
    matches: (k) => k.late_auth_pending,
    cause: 'late_auth_pending',
  },
  {
    id: 'S4',
    describes: 'mandate paused by the customer — only they can resume it',
    matches: (k) => k.mandate.paused_by_customer,
    cause: 'mandate_paused_by_customer',
  },
]

/** `(source, code)` → cause, for every catalogue entry the pair determines. */
const CODE_RULES = new Map<string, { cause: Cause; describes: string }>()
for (const entry of ERROR_CATALOGUE) {
  if (isAmbiguous(entry.source, entry.code)) continue
  CODE_RULES.set(`${entry.source}|${entry.code}`, {
    cause: entry.cause,
    describes: `${entry.source}/${entry.code}`,
  })
}

/**
 * First state rule wins, then the code table. Null means the model has to look
 * at it — either the pair is ambiguous, or the code is not in the catalogue at
 * all.
 */
export function applyRules(kase: Case): RuleHit | null {
  for (const rule of STATE_RULES) {
    if (rule.matches(kase)) {
      return { cause: rule.cause, id: rule.id, describes: rule.describes }
    }
  }

  const hit = CODE_RULES.get(`${kase.error.source}|${kase.error.code}`)
  if (hit) {
    return { cause: hit.cause, id: `R:${hit.describes}`, describes: hit.describes }
  }

  return null
}

/** Why a case was not resolved deterministically — for the audit line. */
export function whyUnresolved(kase: Case): string {
  return isAmbiguous(kase.error.source, kase.error.code)
    ? `${kase.error.source}/${kase.error.code} is published with more than one meaning — the code alone cannot decide`
    : `${kase.error.source}/${kase.error.code} is not in the catalogue`
}

export const RULE_COUNT = STATE_RULES.length + CODE_RULES.size
