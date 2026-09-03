// BLUEPRINT §4.6 — the interface only. MockRazorpayPort and the outcome
// simulator are pipeline work; this file exists so the engine's ToolContext
// has a `port` to be typed against.
export type Outcome = {
  ok: boolean
  /** What the rail reported back, for the audit line. */
  detail: string
  /** Set when the action was scheduled rather than executed now. */
  scheduled_for?: string
}

export interface RazorpayPort {
  retryNow(caseId: string): Promise<Outcome>
  retryScheduled(caseId: string, atISO: string): Promise<Outcome>
  switchRail(caseId: string, to: 'upi' | 'emandate'): Promise<Outcome>
  sendPaymentLink(caseId: string, channel: 'sms' | 'email'): Promise<Outcome>
  escalate(caseId: string, reason: string): Promise<Outcome>
}
