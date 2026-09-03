// M7 — the five tools (BLUEPRINT §4.6), registered into the gate.
//
// The gate carried from Quark decides confirmation in code and refuses any tool
// not in this registry, so this list is the agent's entire capability. Adding
// an entry here that isn't implemented would let the classifier overclaim.
import type { Tool, ToolContext } from '../engine/tool-types'
import { TOOLS } from '../engine/gate'

type Params = Record<string, unknown>

const asParams = (input: unknown): Params =>
  input && typeof input === 'object' ? (input as Params) : {}

const str = (input: unknown, key: string, fallback: string): string => {
  const value = asParams(input)[key]
  return typeof value === 'string' ? value : fallback
}

const retryNow: Tool = {
  name: 'retryNow',
  /**
   * The only tool that always needs a human.
   *
   * Every other action either waits out the RBI pre-debit notice or asks the
   * customer. This one debits an account immediately with no notice period and
   * cannot be undone, so it is exactly the irreversible side effect the carried
   * confirmation gate exists to catch. The pipeline never proposes it — the
   * decide table and compliance check C5 both route around it — and if anything
   * ever does, it stops here for a person.
   */
  async requiresConfirmation() {
    return true
  },
  async describeConsequence(_input, ctx) {
    return `Immediately debit case ${ctx.caseId} with no pre-debit notice. This cannot be undone.`
  },
  async execute(_input, ctx) {
    return (await ctx.port.retryNow(ctx.caseId)).detail
  },
}

const retryScheduled: Tool = {
  name: 'retryScheduled',
  async requiresConfirmation() {
    return false
  },
  async describeConsequence(input, ctx) {
    return `Book a debit for case ${ctx.caseId} on ${str(input, 'scheduled_for', 'a future date').slice(0, 10)}, with a pre-debit notice 24h ahead.`
  },
  async execute(input, ctx) {
    const at = str(input, 'scheduled_for', new Date(ctx.clock.now().getTime() + 86_400_000).toISOString())
    return (await ctx.port.retryScheduled(ctx.caseId, at)).detail
  },
}

const switchRail: Tool = {
  name: 'switchRail',
  async requiresConfirmation() {
    return false
  },
  async describeConsequence(input, ctx) {
    return `Move case ${ctx.caseId} onto the ${str(input, 'to', 'upi')} rail.`
  },
  async execute(input, ctx) {
    const to = str(input, 'to', 'upi') === 'emandate' ? 'emandate' : 'upi'
    return (await ctx.port.switchRail(ctx.caseId, to)).detail
  },
}

const sendPaymentLink: Tool = {
  name: 'sendPaymentLink',
  async requiresConfirmation() {
    return false
  },
  async describeConsequence(input, ctx) {
    return `Send case ${ctx.caseId} a payment link by ${str(input, 'channel', 'sms')}.`
  },
  async execute(input, ctx) {
    const channel = str(input, 'channel', 'sms') === 'email' ? 'email' : 'sms'
    return (await ctx.port.sendPaymentLink(ctx.caseId, channel)).detail
  },
}

const escalate: Tool = {
  name: 'escalate',
  async requiresConfirmation() {
    return false
  },
  async describeConsequence(input, ctx) {
    return `Hand case ${ctx.caseId} to operations: ${str(input, 'reason', 'no reason given')}`
  },
  async execute(input, ctx) {
    return (await ctx.port.escalate(ctx.caseId, str(input, 'reason', 'no reason given'))).detail
  },
}

export const ALL_TOOLS: Tool[] = [retryNow, retryScheduled, switchRail, sendPaymentLink, escalate]

/** Fill the gate's registry. Called once at batch start. */
export function registerTools(): void {
  for (const tool of ALL_TOOLS) TOOLS[tool.name] = tool
}

export type { ToolContext }
