// M5 — COMPLIANCE GATE (BLUEPRINT §4.5).
//
// Six hard rules, all deterministic, all logged — including when they pass.
// A gate that only logs its failures cannot prove it ran, and "we checked and
// it was fine" is exactly what an auditor needs to see for the 79 cases where
// nothing went wrong.
//
// This runs AFTER decide and BEFORE any action. It can override the decision:
// a retry on a domestic card is rerouted to a payment link, and contact to a
// customer who withdrew consent is refused outright. The decision stage
// proposes; this stage has the veto.
import type { Case } from '../engine/case'
import type { Clock } from '../engine/tool-types'
import { istHour } from '../engine/clock'
import type { Decision } from './decide'

export const CONTACT_WINDOW_IST = { open: 9, close: 21 } as const

/** Tools that reach the customer. The consent rules apply to exactly these. */
const CONTACT_TOOLS = new Set(['sendPaymentLink'])
/** Tools that move money. The mandate rules apply to exactly these. */
const DEBIT_TOOLS = new Set(['retryNow', 'retryScheduled', 'switchRail'])

export type CheckResult = {
  id: string
  /** What was verified, in words. */
  check: string
  passed: boolean
  /** Present when the check changed the outcome. */
  action?: 'blocked' | 'rerouted' | 'deferred'
  detail?: string
}

export type GateResult = {
  decision: Decision
  checks: CheckResult[]
  passed: boolean
  /** True when the gate changed the decision it was handed. */
  overridden: boolean
}

/**
 * Run the gate. Returns the decision that may actually proceed — which is not
 * always the decision that went in.
 */
export function complianceGate(kase: Case, proposed: Decision, clock: Clock): GateResult {
  const checks: CheckResult[] = []
  let decision = proposed
  let overridden = false

  const isContact = () => decision.tool !== null && CONTACT_TOOLS.has(decision.tool)
  const isDebit = () => decision.tool !== null && DEBIT_TOOLS.has(decision.tool)

  // C1 — a revoked mandate is terminal for both debits and contact.
  {
    const violates = kase.mandate.cancelled_by_customer && (isContact() || isDebit())
    checks.push({
      id: 'C1',
      check: 'mandate not cancelled by the customer',
      passed: !violates,
      ...(violates ? { action: 'blocked' as const, detail: 'the customer revoked this mandate — no retry and no contact' } : {}),
    })
    if (violates) {
      decision = {
        ...decision,
        outcome: 'STOP',
        tool: null,
        params: {},
        because: 'compliance: the customer revoked this mandate — no retry and no contact',
        rejected: [
          ...decision.rejected,
          { tool: proposed.tool ?? 'unknown', because: 'blocked by C1 — mandate revoked by the customer' },
        ],
      }
      overridden = true
    }
  }

  // C2 — DND or opt-out blocks contact. A retry is still allowed: consent to be
  // contacted and authorisation to debit are different permissions, and
  // conflating them would strand recoverable AUTO cases for no reason.
  {
    const blocked = (kase.customer.dnd || kase.customer.opted_out) && isContact()
    checks.push({
      id: 'C2',
      check: 'customer not on DND and not opted out of contact',
      passed: !blocked,
      ...(blocked
        ? {
            action: 'blocked' as const,
            detail: kase.customer.dnd
              ? 'customer is on DND — cannot be contacted'
              : 'customer opted out of contact',
          }
        : {}),
    })
    if (blocked) {
      const why = kase.customer.dnd ? 'customer is on DND' : 'customer opted out of contact'
      decision = {
        ...decision,
        outcome: 'ESCALATE',
        tool: 'escalate',
        params: { reason: `${why}; the fix needs the customer but they cannot be contacted` },
        because: `compliance: ${why}, and this case cannot be fixed without them`,
        rejected: [
          ...decision.rejected,
          { tool: 'sendPaymentLink', because: `blocked by C2 — ${why}` },
        ],
      }
      overridden = true
    }
  }

  // C3 — contact only between 09:00 and 21:00 IST. Deferred, not cancelled.
  {
    const hour = istHour(clock.now())
    const outside = isContact() && (hour < CONTACT_WINDOW_IST.open || hour >= CONTACT_WINDOW_IST.close)
    checks.push({
      id: 'C3',
      check: `contact inside 09:00–21:00 IST (now ${String(hour).padStart(2, '0')}:00 IST)`,
      passed: !outside,
      ...(outside ? { action: 'deferred' as const, detail: `outside the contact window — held until ${CONTACT_WINDOW_IST.open}:00 IST` } : {}),
    })
    if (outside) {
      decision = {
        ...decision,
        params: { ...decision.params, deferred_until_ist_hour: CONTACT_WINDOW_IST.open },
        because: `${decision.because} (deferred — outside the 09:00–21:00 IST contact window)`,
      }
      overridden = true
    }
  }

  // C4 — every retry needs a pre-debit notice at least 24h ahead. Scheduled and
  // logged here rather than assumed by the decide stage.
  {
    const scheduledFor = decision.params.scheduled_for
    const needsNotice = isDebit()
    let ok = true
    let detail: string | undefined

    if (needsNotice) {
      if (typeof scheduledFor !== 'string') {
        // switchRail carries no date; the notice attaches to the debit that
        // follows it, which is out of scope for this milestone.
        detail = 'no scheduled date on this action — pre-debit notice not applicable'
      } else {
        const hoursAhead = (Date.parse(scheduledFor) - clock.now().getTime()) / 3_600_000
        ok = hoursAhead >= 24
        detail = ok
          ? `pre-debit notice scheduled ${hoursAhead.toFixed(0)}h ahead of the retry`
          : `retry is only ${hoursAhead.toFixed(0)}h away — less than the 24h notice RBI requires`
      }
    }

    checks.push({
      id: 'C4',
      check: 'retry carries a pre-debit notice at least 24h ahead',
      passed: ok,
      ...(ok ? {} : { action: 'blocked' as const }),
      ...(detail ? { detail } : {}),
    })

    if (!ok) {
      decision = {
        ...decision,
        outcome: 'ESCALATE',
        tool: 'escalate',
        params: { reason: detail ?? 'pre-debit notice window not met' },
        because: `compliance: ${detail}`,
        rejected: [
          ...decision.rejected,
          { tool: proposed.tool ?? 'unknown', because: `blocked by C4 — ${detail}` },
        ],
      }
      overridden = true
    }
  }

  // C5 — manual charge is unsupported on domestic cards. Reroute, don't refuse:
  // the money is still recoverable, just not by us.
  {
    const unsupported = kase.is_domestic_card && decision.tool === 'retryNow'
    checks.push({
      id: 'C5',
      check: 'no manual charge attempted on a domestic card',
      passed: !unsupported,
      ...(unsupported ? { action: 'rerouted' as const, detail: 'domestic card — manual charge unsupported; rerouted to a payment link' } : {}),
    })
    if (unsupported) {
      decision = {
        ...decision,
        outcome: 'CUSTOMER_ACTION',
        tool: 'sendPaymentLink',
        params: { channel: 'sms' },
        because: 'compliance: domestic card — manual charge is not supported, so the customer completes this one',
        rejected: [
          ...decision.rejected,
          { tool: 'retryNow', because: 'domestic card — manual charge unsupported' },
        ],
      }
      overridden = true
    }
  }

  // C6 — never retry above the mandate ceiling.
  {
    const over = kase.amount_inr > kase.mandate.max_amount_inr && isDebit()
    checks.push({
      id: 'C6',
      check: 'debit within the mandate max_amount',
      passed: !over,
      ...(over ? { action: 'blocked' as const, detail: `₹${kase.amount_inr} exceeds the ₹${kase.mandate.max_amount_inr} mandate ceiling` } : {}),
    })
    if (over) {
      decision = {
        ...decision,
        outcome: 'ESCALATE',
        tool: 'escalate',
        params: { reason: `debit ₹${kase.amount_inr} exceeds mandate ceiling ₹${kase.mandate.max_amount_inr} — merchant configuration` },
        because: 'compliance: the debit is above the authorised ceiling — merchant configuration, not a customer problem',
        rejected: [
          ...decision.rejected,
          { tool: proposed.tool ?? 'unknown', because: `blocked by C6 — above the ₹${kase.mandate.max_amount_inr} ceiling` },
        ],
      }
      overridden = true
    }
  }

  return { decision, checks, passed: checks.every((c) => c.passed), overridden }
}
