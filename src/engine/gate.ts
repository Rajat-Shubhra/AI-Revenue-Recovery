// Carried from Quark: server/src/agent/runner.ts.
//
// Only the confirmation-gate machinery came across. Left behind on purpose:
// startRun/resolveRun's Supabase orchestration, the agent_runs table writes,
// and the read-only research second turn — all Quark's workspace plumbing.
//
// resolveRun's double-resolve guard DID need to come across, and did: it lives
// in audit.ts as AuditLog.executeOnce, rewritten against the JSONL ledger.
// Nothing here calls the rail except through it.
import type { AgentAction, AgentResponse } from './schema'
import type { Tool, ToolContext } from './tool-types'
import type { RejectedAlternative } from './audit'

/**
 * The agent's entire capability. The classifier decides AUTO /
 * CUSTOMER_ACTION / ESCALATE relative to exactly this list, so adding an entry
 * here without implementing it would make it overclaim.
 *
 * Deliberately empty: the pipeline task fills it with the five §4.6 tools.
 */
export const TOOLS: Record<string, Tool> = {}

export type ExecutedAction = {
  tool: string
  input: unknown
  result: string
  ok: boolean
  /** True when the idempotency guard refused a replay. */
  skipped?: boolean
}

const KNOWN_TOOLS = ['retryNow', 'retryScheduled', 'switchRail', 'sendPaymentLink', 'escalate']

/**
 * A reason a specific action must not run, or null to let it through. The
 * compliance gate (§4.4) supplies these so the audit trail can say things like
 * "domestic card — manual charge unsupported" rather than a generic refusal.
 */
export type RejectionCheck = (action: AgentAction, ctx: ToolContext) => string | null

/**
 * Splits proposed actions into those that may run and those that may not,
 * with a real reason attached to every refusal.
 *
 * The `rejected` array is the most persuasive field in the audit trail (§4.9):
 * it proves the agent considered an alternative and declined it, and for that
 * to be worth anything the reason has to be the actual one. A fixed
 * placeholder string here would make the whole field decorative.
 */
export function partitionActions(
  actions: AgentAction[],
  ctx: ToolContext,
  checks: RejectionCheck[] = [],
) {
  const runnable: AgentAction[] = []
  const rejected: RejectedAlternative[] = []

  for (const action of actions) {
    if (!TOOLS[action.tool]) {
      // A hallucinated tool must never reach execution, and silently dropping
      // it would misreport what happened.
      rejected.push({
        tool: action.tool,
        because: KNOWN_TOOLS.includes(action.tool)
          ? `${action.tool} is a known tool but is not registered in this run — nothing was sent to the rail`
          : `no such tool: ${action.tool}. This agent has only ${KNOWN_TOOLS.join(', ')}`,
      })
      continue
    }

    const because = checks.reduce<string | null>(
      (found, check) => found ?? check(action, ctx),
      null,
    )
    if (because) rejected.push({ tool: action.tool, because })
    else runnable.push(action)
  }

  return { runnable, rejected }
}

/**
 * THE GATE. Confirmation is decided here, in code — never by trusting the
 * model's own flag. We gate if the model asked for confirmation OR if any tool
 * reports that this particular call has real consequences. A model that
 * returns confirmation_required: false cannot talk its way past a side effect.
 */
export async function needsConfirmation(
  response: AgentResponse,
  actions: AgentAction[],
  ctx: ToolContext,
): Promise<boolean> {
  if (response.confirmation_required) return true

  for (const action of actions) {
    const tool = TOOLS[action.tool]
    if (tool && (await tool.requiresConfirmation(action.input, ctx))) return true
  }
  return false
}

/** Plain-language summary of what's waiting behind the gate. */
export async function describeActions(actions: AgentAction[], ctx: ToolContext): Promise<string> {
  const descriptions: string[] = []
  for (const action of actions) {
    const tool = TOOLS[action.tool]
    if (!tool) continue
    try {
      descriptions.push(await tool.describeConsequence(action.input, ctx))
    } catch {
      descriptions.push(`Run ${action.tool} on case ${ctx.caseId}.`)
    }
  }
  return descriptions.join(' ') || 'The agent wants to take an action on this case.'
}

/** Pull the scheduled date out of an action's params, if it carries one. */
function scheduledFor(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const params = input as Record<string, unknown>
    for (const field of ['scheduled_for', 'atISO', 'at']) {
      if (typeof params[field] === 'string') return params[field] as string
    }
  }
  return null
}

/**
 * Runs actions through the confirmation gate and then the idempotency guard.
 * Every call to the rail in this codebase goes through here — there is no other
 * path.
 *
 * The confirmation check is not decorative and it is not the model's to make.
 * `tools.ts` says of `retryNow` that "if anything ever proposes it, it stops
 * here for a person" — that sentence was false until this check existed: the
 * tool's own `requiresConfirmation` was implemented, and nothing consulted it.
 * A safety claim nobody calls is worse than no claim, because it reads as
 * covered.
 *
 * Nothing in the pipeline currently proposes `retryNow` — the decide table
 * never returns it and compliance check C5 reroutes around it — so this changes
 * no measured number today. It is here for the day something does.
 */
export async function executeActions(
  actions: AgentAction[],
  ctx: ToolContext,
): Promise<ExecutedAction[]> {
  const executed: ExecutedAction[] = []

  for (const action of actions) {
    const tool = TOOLS[action.tool]
    if (!tool) {
      executed.push({ tool: action.tool, input: action.input, result: 'No such tool.', ok: false })
      continue
    }

    // Held for a human BEFORE the idempotency key is claimed. Claiming the key
    // for an action nobody has approved would mean that when a person does
    // approve it, the replay guard refuses the very action they authorised.
    if (await tool.requiresConfirmation(action.input, ctx)) {
      executed.push({
        tool: action.tool,
        input: action.input,
        result: `Held for confirmation: ${await describeActions([action], ctx)}`,
        ok: false,
      })
      continue
    }

    try {
      const result = await ctx.audit.executeOnce(
        { caseId: ctx.caseId, tool: action.tool, scheduledFor: scheduledFor(action.input) },
        async () => ({ ok: true, detail: await tool.execute(action.input, ctx) }),
      )

      if (result.status === 'skipped_duplicate') {
        executed.push({
          tool: action.tool,
          input: action.input,
          result: `Already done (${result.key}) — not repeated.`,
          ok: true,
          skipped: true,
        })
      } else {
        executed.push({
          tool: action.tool,
          input: action.input,
          result: result.outcome.detail,
          ok: result.outcome.ok,
        })
      }
    } catch (error) {
      executed.push({
        tool: action.tool,
        input: action.input,
        result: error instanceof Error ? error.message : String(error),
        ok: false,
      })
    }
  }

  return executed
}
