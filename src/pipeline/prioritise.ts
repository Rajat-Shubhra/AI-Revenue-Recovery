// M2 — PRIORITISE (BLUEPRINT §4.2).
//
//   expected_value = amount_inr × P(recover | error.reason, method)
//   urgency        = 1 / max(hours_until(halts_at), 1)
//   cost           = action_cost[likely_action]
//   priority       = (expected_value − cost) × urgency
//
// The queue is a max-heap and the batch pops the top N per tick. Every case
// carries the arithmetic that put it where it is, because "why this one first"
// is the first question anyone will ask of the ranking.
import type { Case } from '../engine/case'
import type { IngestedCase } from './ingest'
import { recoveryPrior, ACTION_COST_INR, type ActionName } from './recovery-priors'

export const BATCH_TICK_SIZE = 20

/**
 * A guess at what this case will probably need, used ONLY to price the action
 * into the priority score. The real decision happens later, after diagnosis
 * (§4.4), and may differ — this is a cost estimate, not a plan.
 *
 * It exists because escalation costs ₹50 against a retry's ₹0.25, and a queue
 * that ignored that would happily rank a ₹149 case needing a human above a
 * ₹999 case needing a free retry.
 */
export function likelyAction(kase: Case): ActionName {
  const reason = kase.error.reason

  if (reason === 'mandate_revoked') return 'escalate'
  if (reason === 'amount_limit_exceeded') return 'escalate'
  if (reason === 'card_expired' || reason === 'bank_blocked_card') return 'sendPaymentLink'
  if (reason === 'mandate_paused') return 'sendPaymentLink'
  // A domestic card cannot be manually charged, so any retry-shaped fix on one
  // becomes a payment link (§4.5). Pricing it as a retry would understate it.
  if (kase.is_domestic_card) return 'sendPaymentLink'
  return 'retryScheduled'
}

export type Scored = IngestedCase & {
  expected_value: number
  urgency: number
  cost: number
  priority: number
  likely_action: ActionName
  /** Human-readable arithmetic, written into the audit trail. */
  why: string
}

const inr = (n: number) => `₹${n.toFixed(2)}`

export function score(entry: IngestedCase): Scored {
  const { kase } = entry
  const prior = recoveryPrior(kase.error.reason, kase.method)
  const expected_value = kase.amount_inr * prior

  // Clamped at one hour: below that the reciprocal explodes and urgency would
  // swamp every other term. A case with 20 minutes left is not 3× more
  // important than one with an hour.
  const urgency = 1 / Math.max(entry.hours_to_halt, 1)

  const likely_action = likelyAction(kase)
  const cost = ACTION_COST_INR[likely_action]
  const priority = (expected_value - cost) * urgency

  const why =
    `₹${kase.amount_inr} × ${prior.toFixed(2)} recover-prior (${kase.error.reason}/${kase.method})` +
    ` = ${inr(expected_value)} EV,` +
    ` less ${inr(cost)} for ${likely_action},` +
    ` × ${urgency.toFixed(4)} urgency (${entry.hours_to_halt.toFixed(1)}h to halt)` +
    ` = ${priority.toFixed(2)}`

  return { ...entry, expected_value, urgency, cost, priority, likely_action, why }
}

/**
 * Max-heap on priority. Ties break on case id so a run is reproducible — with
 * a plain comparison, equal priorities would surface in whatever order the heap
 * happened to sift them into, and the demo would reorder between runs.
 */
export class PriorityQueue {
  private heap: Scored[] = []

  get size(): number {
    return this.heap.length
  }

  private static before(a: Scored, b: Scored): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority
    return a.kase.id < b.kase.id
  }

  push(item: Scored): void {
    this.heap.push(item)
    let i = this.heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!PriorityQueue.before(this.heap[i]!, this.heap[parent]!)) break
      ;[this.heap[i], this.heap[parent]] = [this.heap[parent]!, this.heap[i]!]
      i = parent
    }
  }

  pop(): Scored | undefined {
    if (this.heap.length === 0) return undefined
    const top = this.heap[0]!
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      this.heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let best = i
        if (l < this.heap.length && PriorityQueue.before(this.heap[l]!, this.heap[best]!)) best = l
        if (r < this.heap.length && PriorityQueue.before(this.heap[r]!, this.heap[best]!)) best = r
        if (best === i) break
        ;[this.heap[i], this.heap[best]] = [this.heap[best]!, this.heap[i]!]
        i = best
      }
    }
    return top
  }

  /** Pop up to `n`, highest priority first. */
  take(n: number): Scored[] {
    const out: Scored[] = []
    for (let i = 0; i < n; i += 1) {
      const next = this.pop()
      if (!next) break
      out.push(next)
    }
    return out
  }
}

/**
 * Score the treated arm and rank it.
 *
 * Holdout cases are scored too — the report needs their expected value to
 * compare arms — but they never enter the queue, so nothing downstream can
 * reach them.
 */
export function prioritise(ingested: IngestedCase[]): {
  queue: PriorityQueue
  scored: Scored[]
  eligible: Scored[]
} {
  const scored = ingested.map(score)
  const queue = new PriorityQueue()
  const eligible: Scored[] = []

  for (const item of scored) {
    if (item.holdout || item.halted) continue
    eligible.push(item)
    queue.push(item)
  }

  return { queue, scored, eligible }
}
