// Carried from Quark: server/src/agent/tools/types.ts. The Supabase client is
// gone — this repo has no database — and the task-board fields are replaced by
// the four things a money action actually needs.
import type { RazorpayPort } from '../ports/razorpay'
import type { AuditLog } from './audit'

/** Injected so the 09:00–21:00 IST contact window (§4.4) is testable. */
export type Clock = {
  now(): Date
}

export type ToolContext = {
  caseId: string
  /** The five tools of §4.6. Every real-world effect goes through this. */
  port: RazorpayPort
  clock: Clock
  /** Append-only ledger, and the idempotency guard. */
  audit: AuditLog
}

export type Tool = {
  name: string
  /**
   * Whether running this action needs a human's approval first. Decided by the
   * gate, not the model — see gate.ts.
   */
  requiresConfirmation(input: unknown, ctx: ToolContext): Promise<boolean>
  /**
   * Plain-language description of what running this would do, used when the
   * gate stops a run the model didn't expect to be stopped (and so left
   * confirmation_prompt empty). Nobody must ever be asked to approve something
   * unexplained.
   */
  describeConsequence(input: unknown, ctx: ToolContext): Promise<string>
  execute(input: unknown, ctx: ToolContext): Promise<string>
}
