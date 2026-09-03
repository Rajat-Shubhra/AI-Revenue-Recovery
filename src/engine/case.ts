// BLUEPRINT §3. Lives in engine/ because prompt.ts builds the model's user
// message from it; the pipeline task may want to move it to src/pipeline/.
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
    source: 'customer' | 'business' | 'internal' | 'gateway' | 'issuer_bank'
    step: string
    reason: string
    description: string
  }
  failed_at: string
  /** Prior retries already made. */
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
