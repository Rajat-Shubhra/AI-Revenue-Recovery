// M4 — DECIDE (BLUEPRINT §4.4).
//
// Once the cause is known the outcome is mostly forced by the domain, so this
// is a table rather than a model call. An expired card can only be
// CUSTOMER_ACTION; a cancelled mandate can only be STOP; a debit above the
// mandate ceiling can only be ESCALATE.
//
// STOP and HOLD are decided HERE, in code, and the classifier is never given
// the chance to return them. Both are pure fact-checks on the case —
// `mandate.cancelled_by_customer` and `late_auth_pending` are booleans, not
// judgements — and a model that could return STOP could also fail to return it.
// Hard guards must not be model-overridable.
//
// Every decision carries a `rejected` list naming the alternatives considered
// and why they were declined. That array is the most persuasive thing in the
// audit trail (§4.9): it is the difference between an agent that chose and one
// that only ever had one idea.
import type { Case } from '../engine/case'
import type { RejectedAlternative } from '../engine/audit'
import type { ToolName } from '../engine/schema'
import type { Cause } from './rules'
import type { Diagnosed } from './diagnose'

/**
 * Pipeline-level outcomes. Wider than the classifier's three buckets on
 * purpose: STOP and HOLD never come from the model.
 */
export type Outcome = 'AUTO' | 'CUSTOMER_ACTION' | 'ESCALATE' | 'STOP' | 'HOLD'

export type Decision = {
  outcome: Outcome
  tool: ToolName | null
  params: Record<string, unknown>
  because: string
  rejected: RejectedAlternative[]
  via: 'table' | 'classifier'
}

/** RBI requires a pre-debit notification at least 24h before a retry (§4.5). */
export const PRE_DEBIT_NOTICE_HOURS = 24

/**
 * The next plausible salary-cycle date at least 24h out.
 *
 * Indian salaries overwhelmingly land between the 1st and the 7th, so retrying
 * an insufficient-funds case on the 3rd of next month is worth far more than
 * retrying it tomorrow into the same empty account — the simulator puts that
 * gap at 0.12 versus 0.52, and it is the single most valuable judgement the
 * agent makes.
 *
 * Returns null when no compliant date fits before the subscription halts.
 */
export function nextSalaryCycleDate(now: Date, haltsAt: string): Date | null {
  const earliest = now.getTime() + PRE_DEBIT_NOTICE_HOURS * 3_600_000
  const halt = Date.parse(haltsAt)

  const candidates: number[] = []
  for (let monthOffset = 0; monthOffset <= 2; monthOffset += 1) {
    for (const day of [1, 3, 7]) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, day, 6, 0, 0),
      )
      candidates.push(d.getTime())
    }
  }

  const fit = candidates
    .filter((t) => t >= earliest && t < halt)
    .sort((a, b) => a - b)[0]

  return fit === undefined ? null : new Date(fit)
}

/** The earliest date a retry may legally be attempted. */
export function earliestCompliantRetry(now: Date, haltsAt: string): Date | null {
  const t = now.getTime() + PRE_DEBIT_NOTICE_HOURS * 3_600_000
  return t < Date.parse(haltsAt) ? new Date(t) : null
}

const NO_WINDOW = 'no retry window before the subscription halts that still leaves 24h for the RBI pre-debit notice'

/**
 * The decision table. `cause` in, outcome and tool out.
 *
 * Reads top to bottom: terminal states first, then the cases only the customer
 * can fix, then the ones the agent can act on alone.
 */
export function decideFromCause(kase: Case, cause: Cause, now: Date): Decision {
  const rejected: RejectedAlternative[] = []

  switch (cause) {
    case 'mandate_cancelled_by_customer':
      return {
        outcome: 'STOP',
        tool: null,
        params: {},
        because: 'the customer revoked this mandate — nothing is recoverable and any contact would be a compliance violation',
        rejected: [
          { tool: 'retryNow', because: 'the mandate is revoked; a debit has no authorisation' },
          { tool: 'retryScheduled', because: 'the mandate is revoked; no future date changes that' },
          { tool: 'sendPaymentLink', because: 'the customer withdrew consent — contacting them would be a violation, not a nudge' },
        ],
        via: 'table',
      }

    case 'late_auth_pending':
      return {
        outcome: 'HOLD',
        tool: null,
        params: {},
        because: 'authorisation has not landed yet and may still settle on its own — acting now risks charging the customer twice',
        rejected: [
          { tool: 'retryNow', because: 'the original debit may still authorise; a retry here is a double charge, not a recovery' },
          { tool: 'sendPaymentLink', because: 'asking for payment on a debit that may already be settling would collect it twice' },
        ],
        via: 'table',
      }

    case 'amount_exceeds_mandate_max':
      return {
        outcome: 'ESCALATE',
        tool: 'escalate',
        params: {
          reason: `debit of ₹${kase.amount_inr} exceeds the mandate ceiling of ₹${kase.mandate.max_amount_inr} — merchant configuration, not a customer problem`,
        },
        because: 'the debit is above what the customer authorised; only the merchant can fix the mandate',
        rejected: [
          { tool: 'retryScheduled', because: `every retry above the ₹${kase.mandate.max_amount_inr} ceiling fails by definition` },
          { tool: 'sendPaymentLink', because: 'the customer did nothing wrong here; billing them for a merchant misconfiguration is the wrong ask' },
        ],
        via: 'table',
      }

    case 'card_expired':
    case 'bank_blocked_card':
    case 'upi_mandate_paused_by_customer': {
      const why =
        cause === 'card_expired'
          ? 'the stored card has expired — only the customer can supply a new one'
          : cause === 'bank_blocked_card'
            ? 'the issuing bank has blocked this card — only the customer can resolve it with them'
            : 'the customer paused this mandate, and only they can resume it'
      rejected.push({
        tool: 'retryScheduled',
        because:
          cause === 'upi_mandate_paused_by_customer'
            ? 'a paused mandate rejects debits until the customer resumes it; the merchant cannot'
            : 'the instrument itself is broken — no retry date fixes an expired or blocked card',
      })
      return {
        outcome: 'CUSTOMER_ACTION',
        tool: 'sendPaymentLink',
        params: { channel: 'sms' },
        because: why,
        rejected,
        via: 'table',
      }
    }

    case 'issuer_downtime':
    case 'gateway_downtime': {
      // A rail that has already failed this case twice is worth leaving.
      // Otherwise a scheduled retry is simply better: the simulator puts
      // retryScheduled at 0.82–0.88 against switchRail at 0.62–0.70.
      if (kase.attempts >= 2 && kase.method !== 'upi') {
        return {
          outcome: 'AUTO',
          tool: 'switchRail',
          params: { to: 'upi' },
          because: `${cause.replace('_', ' ')} has failed this case ${kase.attempts} times already — moving it to a different rail rather than waiting again`,
          rejected: [
            { tool: 'retryScheduled', because: `the same rail has already failed ${kase.attempts} times; a third wait is unlikely to differ` },
          ],
          via: 'table',
        }
      }

      const at = earliestCompliantRetry(now, kase.halts_at)
      if (!at) {
        return {
          outcome: 'ESCALATE',
          tool: 'escalate',
          params: { reason: NO_WINDOW },
          because: NO_WINDOW,
          rejected: [{ tool: 'retryScheduled', because: NO_WINDOW }],
          via: 'table',
        }
      }
      return {
        outcome: 'AUTO',
        tool: 'retryScheduled',
        params: { scheduled_for: at.toISOString() },
        because: 'transient downtime — retrying once the outage has cleared, at the earliest date the pre-debit notice allows',
        rejected: [
          { tool: 'retryNow', because: 'RBI requires a pre-debit notification at least 24h ahead; an immediate retry skips it' },
        ],
        via: 'table',
      }
    }

    case 'insufficient_funds': {
      // A domestic card cannot be charged manually at all, so the only route
      // left is asking the customer. This is the case that produces the
      // rejected-alternative line worth showing on camera.
      if (kase.is_domestic_card) {
        return {
          outcome: 'CUSTOMER_ACTION',
          tool: 'sendPaymentLink',
          params: { channel: 'sms' },
          because: 'the account was short of funds, but manual charge is not supported on domestic cards — so the customer has to complete this one',
          rejected: [
            { tool: 'retryNow', because: 'domestic card — manual charge is not supported' },
            { tool: 'retryScheduled', because: 'domestic card — manual charge is not supported on any date' },
          ],
          via: 'table',
        }
      }

      const at = nextSalaryCycleDate(now, kase.halts_at)
      if (!at) {
        const fallback = earliestCompliantRetry(now, kase.halts_at)
        if (!fallback) {
          return {
            outcome: 'ESCALATE',
            tool: 'escalate',
            params: { reason: NO_WINDOW },
            because: NO_WINDOW,
            rejected: [{ tool: 'retryScheduled', because: NO_WINDOW }],
            via: 'table',
          }
        }
        return {
          outcome: 'AUTO',
          tool: 'retryScheduled',
          params: { scheduled_for: fallback.toISOString() },
          because: 'insufficient funds, and the subscription halts before the next salary cycle — retrying at the earliest compliant date instead',
          rejected: [
            { tool: 'retryNow', because: 'the pre-debit notice needs 24h; an immediate retry skips it' },
          ],
          via: 'table',
        }
      }

      return {
        outcome: 'AUTO',
        tool: 'retryScheduled',
        params: { scheduled_for: at.toISOString() },
        because: `insufficient funds — retrying on ${at.toISOString().slice(0, 10)}, the next salary-cycle date, rather than into the same empty account`,
        rejected: [
          { tool: 'retryNow', because: 'retrying immediately hits the same empty balance; waiting for the salary cycle is worth roughly four times as much' },
        ],
        via: 'table',
      }
    }

    case 'unknown':
    default:
      return {
        outcome: 'ESCALATE',
        tool: 'escalate',
        params: { reason: 'cause could not be established with confidence' },
        because: 'no rule matched and the diagnosis was not confident enough to act on',
        rejected: [
          { tool: 'retryScheduled', because: 'acting on an unestablished cause risks a debit that was never going to succeed' },
        ],
        via: 'table',
      }
  }
}

export function decide(kase: Case, diagnosed: Diagnosed, now: Date): Decision {
  // A diagnosis the confidence floor rejected never reaches the table — it
  // escalates, and it does so without a silent retry of the model (§4.3).
  if (diagnosed.escalate) {
    return {
      outcome: 'ESCALATE',
      tool: 'escalate',
      params: { reason: diagnosed.because ?? 'diagnosis not trustworthy' },
      because: diagnosed.because ?? 'diagnosis not trustworthy',
      rejected: [
        { tool: 'retryScheduled', because: 'the cause is not established; a debit here would be a guess with someone else’s money' },
      ],
      via: 'table',
    }
  }
  return decideFromCause(kase, diagnosed.cause, now)
}
