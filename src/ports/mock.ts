// M7 — MockRazorpayPort (BLUEPRINT §4.6).
//
// Implements the five-tool port against the outcome simulator. This is the only
// implementation that exists; `TestModeRazorpayPort` is a stretch goal and is
// deliberately NOT stubbed out here, because a stub that returns success would
// be indistinguishable from a real integration in the audit log, and that is
// exactly the kind of thing that should not be easy to do by accident.
import type { Case } from '../engine/case'
import type { Outcome, RazorpayPort } from './razorpay'
import { simulate } from '../sim/simulator'
import type { SimAction } from '../sim/outcomes'

export type MockOptions = {
  /** Distinguishes reruns; keeps the draw deterministic within a batch. */
  batchSeed?: number
}

/**
 * Every call records what the rail "did" and whether the money came back.
 * `recovered` rides along on the Outcome so the measurement stage does not have
 * to re-derive it — and so the audit log carries the same number the scoreboard
 * reports.
 */
export class MockRazorpayPort implements RazorpayPort {
  private readonly cases: Map<string, Case>
  private readonly batchSeed: number
  /** Case id → whether that case ended up recovered. Read by MEASURE. */
  readonly recovered = new Map<string, boolean>()

  constructor(cases: Case[], options: MockOptions = {}) {
    this.cases = new Map(cases.map((c) => [c.id, c]))
    this.batchSeed = options.batchSeed ?? 0
  }

  private run(caseId: string, action: SimAction, note: string): Outcome {
    const kase = this.cases.get(caseId)
    if (!kase) throw new Error(`No such case: ${caseId}`)

    const result = simulate(kase, action, this.batchSeed)
    this.recovered.set(caseId, result.recovered)

    return {
      ok: result.recovered,
      detail: `${note} — ${result.detail}`,
    }
  }

  async retryNow(caseId: string): Promise<Outcome> {
    return this.run(caseId, 'retryNow', 'debit re-attempted immediately')
  }

  async retryScheduled(caseId: string, atISO: string): Promise<Outcome> {
    const outcome = this.run(caseId, 'retryScheduled', `debit booked for ${atISO.slice(0, 10)}`)
    return { ...outcome, scheduled_for: atISO }
  }

  async switchRail(caseId: string, to: 'upi' | 'emandate'): Promise<Outcome> {
    return this.run(caseId, 'switchRail', `mandate moved to ${to}`)
  }

  async sendPaymentLink(caseId: string, channel: 'sms' | 'email'): Promise<Outcome> {
    // "Sending" writes to the audit log and nothing else. Stated in the README
    // as an honest limitation — no message reaches a real person.
    return this.run(caseId, 'sendPaymentLink', `payment link sent by ${channel} (simulated)`)
  }

  /**
   * Score a case WITHOUT calling the rail.
   *
   * Two callers, both of which need an outcome for a case the rail never saw:
   *
   *  - `noAction` below, for a case the agent chose not to act on.
   *  - A replay, where the idempotency guard refused the action because it was
   *    already executed in an earlier batch. The rail must not be called again,
   *    but the case is still in whatever state that first action left it, and
   *    reporting "nothing recovered" would be false.
   *
   * The draw is seeded on case id and action, so this reproduces the ORIGINAL
   * outcome rather than sampling a fresh one. That is what makes a replay
   * report the same scoreboard as the run it is replaying, which is the only
   * answer that can be right: re-reading a ledger does not change what happened.
   */
  score(caseId: string, action: SimAction): boolean {
    const kase = this.cases.get(caseId)
    if (!kase) throw new Error(`No such case: ${caseId}`)

    // An escalation is a handoff, not an attempt at the money — the same rule
    // `escalate()` below applies. The outcome table has a non-zero escalate
    // column because a human often does recover the case eventually, but this
    // batch does not get to count work nobody has done yet. Reading it here
    // would credit a replay with recoveries the original run never counted,
    // which is how the first version of this method reported MORE money on the
    // second run than the first.
    if (action === 'escalate') {
      this.recovered.set(caseId, false)
      return false
    }

    const result = simulate(kase, action, this.batchSeed)
    this.recovered.set(caseId, result.recovered)
    return result.recovered
  }

  /**
   * Score a case the agent decided NOT to act on — STOP, HOLD, or stopped by a
   * stopping rule. It takes the simulator's `none` column, the same one the
   * holdout arm takes, so restraint is measured on exactly the same footing as
   * inaction.
   *
   * This exists so the batch runner never has to touch `_will_self_heal`
   * itself. `tests/ground-truth-isolation.test.ts` caught that leak when the
   * runner read the flag directly, which is what the test is for.
   */
  noAction(caseId: string): boolean {
    return this.score(caseId, 'none')
  }

  async escalate(caseId: string, reason: string): Promise<Outcome> {
    const kase = this.cases.get(caseId)
    if (!kase) throw new Error(`No such case: ${caseId}`)

    // An escalation is a handoff, not an attempt at the money. It never
    // "recovers" anything by itself — a human might, later, and that is outside
    // what this batch measures. Recording it as a recovery would inflate the
    // headline number with work nobody has done yet.
    this.recovered.set(caseId, false)
    return { ok: true, detail: `escalated to operations — ${reason}` }
  }
}
