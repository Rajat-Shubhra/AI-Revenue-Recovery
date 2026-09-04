// BLUEPRINT §3, corrected against Razorpay's real error API.
//
// `error.source` and `error.step` now carry the values Razorpay actually emits.
// An earlier version used `internal` and `issuer_bank` as sources, which the
// API never returns — see src/pipeline/razorpay-errors.ts.
import type { ErrorSource, ErrorStep } from '../pipeline/razorpay-errors'

export type Case = {
  id: string
  subscription_id: string
  customer: { id: string; phone_masked: string; dnd: boolean; opted_out: boolean }
  amount_inr: number
  method: 'card' | 'upi' | 'emandate'
  /** Matters: manual charge on a domestic card is not supported. */
  is_domestic_card: boolean
  mandate: {
    max_amount_inr: number
    cancelled_by_customer: boolean
    paused_by_customer: boolean
  }
  error: {
    source: ErrorSource
    step: ErrorStep
    /**
     * Razorpay's machine-readable error code — `insufficient_funds`,
     * `payment_declined`, and so on. Note this is the CODE, not the cause: the
     * same code legitimately carries different meanings, which is the whole
     * reason the diagnose stage is not just a lookup.
     */
    code: string
    /** The issuer or gateway's advice text. Often carries what the code does not. */
    description: string
  }
  failed_at: string
  /** Prior retries already made, including Razorpay's own automatic ones. */
  attempts: number
  /** Deadline: when Razorpay moves the subscription to halted. */
  halts_at: string
  /** True = might self-heal, do NOT act yet. */
  late_auth_pending: boolean

  // Ground truth for the simulator only — never shown to the agent.
  // buildUserMessage() must not read these.
  _true_cause: string
  _will_self_heal: boolean
}
