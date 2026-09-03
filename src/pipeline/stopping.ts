// M6 — STOPPING RULES (BLUEPRINT §4.6).
//
// The thresholds live in config/stopping.json, not in this file. That is the
// point: a stopping rule buried in code is a rule nobody can audit or change
// without a deploy, and "when does this thing give up?" is a question an
// operations team has to be able to answer by reading one small file.
//
// The config is schema-validated on load. A typo in a threshold that silently
// became `undefined` would disable a stopping rule, which is exactly the class
// of bug that ends with an agent retrying a customer forever.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Case } from '../engine/case'
import type { Cause } from './rules'
import type { Scored } from './prioritise'
import type { Decision } from './decide'

const configSchema = z.object({
  max_attempts_per_case: z.number().int().positive(),
  hold_if_late_auth_pending_hours: z.number().positive(),
  drop_if_expected_value_below_inr: z.number().nonnegative(),
  systemic_alert_if_same_cause_share_exceeds: z.number().min(0).max(1),
  stop_on: z.array(z.string()).nonempty(),
})

export type StoppingConfig = z.infer<typeof configSchema>

const CONFIG_FILE = fileURLToPath(new URL('../../config/stopping.json', import.meta.url))

export function loadStoppingConfig(file: string = CONFIG_FILE): StoppingConfig {
  return configSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

export type StopCheck = {
  stopped: boolean
  rule?: string
  because?: string
}

/**
 * Per-case stopping rules, applied after the compliance gate and before any
 * action reaches a rail.
 */
export function stopCheck(
  scored: Scored,
  decision: Decision,
  cause: Cause,
  config: StoppingConfig,
  now: Date,
): StopCheck {
  const kase: Case = scored.kase

  // Terminal states from `stop_on`. These are facts, not judgements.
  if (config.stop_on.includes('mandate_cancelled') && kase.mandate.cancelled_by_customer) {
    return { stopped: true, rule: 'stop_on:mandate_cancelled', because: 'the customer revoked this mandate' }
  }
  if (config.stop_on.includes('customer_opted_out') && kase.customer.opted_out && decision.tool === 'sendPaymentLink') {
    return { stopped: true, rule: 'stop_on:customer_opted_out', because: 'the customer opted out of contact' }
  }
  if (config.stop_on.includes('halted') && scored.halted) {
    return { stopped: true, rule: 'stop_on:halted', because: 'the subscription had already halted when the batch ran' }
  }

  // Attempt cap. Counted against attempts already made before the batch — the
  // agent inherits a history it did not create, and must respect it.
  if (kase.attempts >= config.max_attempts_per_case) {
    return {
      stopped: true,
      rule: 'max_attempts_per_case',
      because: `${kase.attempts} attempts already made, cap is ${config.max_attempts_per_case}`,
    }
  }

  // Hold window for authorisation that may still land.
  if (cause === 'late_auth_pending') {
    const elapsed = (now.getTime() - Date.parse(kase.failed_at)) / 3_600_000
    if (elapsed < config.hold_if_late_auth_pending_hours) {
      return {
        stopped: true,
        rule: 'hold_if_late_auth_pending_hours',
        because: `authorisation may still land — ${elapsed.toFixed(0)}h of the ${config.hold_if_late_auth_pending_hours}h hold window elapsed`,
      }
    }
  }

  // Not worth the attempt. Escalations are exempt: a ₹149 merchant
  // misconfiguration still needs fixing, and dropping it would hide a problem
  // rather than decline a cost.
  if (
    decision.outcome !== 'ESCALATE' &&
    scored.expected_value < config.drop_if_expected_value_below_inr
  ) {
    return {
      stopped: true,
      rule: 'drop_if_expected_value_below_inr',
      because: `expected value ₹${scored.expected_value.toFixed(2)} is below the ₹${config.drop_if_expected_value_below_inr} floor`,
    }
  }

  return { stopped: false }
}

export type SystemicAlert = {
  fired: boolean
  cause?: Cause
  share?: number
  count?: number
  because?: string
}

/**
 * The batch-level rule (§4.6).
 *
 * If one cause dominates the batch, the problem is not eighty customers — it is
 * one issuer, or one misconfiguration. Working the cases individually would
 * send eighty notifications about a single incident and recover nothing, so the
 * agent stops and raises ONE escalation instead.
 *
 * This is the "knows when something bigger is wrong" behaviour, and it is the
 * difference between an agent and a loop.
 */
export function systemicCheck(
  causes: Cause[],
  config: StoppingConfig,
): SystemicAlert {
  if (causes.length === 0) return { fired: false }

  const counts = new Map<Cause, number>()
  for (const c of causes) counts.set(c, (counts.get(c) ?? 0) + 1)

  let worst: Cause | undefined
  let worstCount = 0
  // Sorted for determinism: two causes tied at the threshold must always pick
  // the same one, or the batch reports differently between runs.
  for (const [cause, count] of [...counts].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))) {
    if (count > worstCount) {
      worst = cause
      worstCount = count
    }
    break
  }

  const share = worstCount / causes.length
  if (worst && share > config.systemic_alert_if_same_cause_share_exceeds) {
    return {
      fired: true,
      cause: worst,
      share,
      count: worstCount,
      because:
        `${worstCount} of ${causes.length} cases (${(share * 100).toFixed(0)}%) share one cause: ${worst}. ` +
        `That is an incident, not ${worstCount} customer problems — raising a single escalation instead of working them individually.`,
    }
  }

  return { fired: false, cause: worst, share, count: worstCount }
}
