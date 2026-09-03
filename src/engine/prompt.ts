import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Case } from './case'

const promptPath = fileURLToPath(new URL('./classifier-prompt.md', import.meta.url))

const APP_NAME = 'the failed-subscription recovery agent'
const TASK_DOMAIN =
  'failed subscription payment recovery across cards, UPI Autopay and eMandate — ' +
  'diagnosing why a debit failed and choosing the one action most likely to recover it ' +
  'without breaking mandate rules or contact consent'

/**
 * BLUEPRINT §4.2 — the closed list of causes. The model may return nothing
 * else; `parseDiagnosis` rejects anything outside it and escalates. Keep this
 * in step with `rules.ts` when the pipeline lands.
 */
export const ALLOWED_CAUSES = [
  'insufficient_funds',
  'card_expired',
  'bank_blocked_card',
  'issuer_downtime',
  'gateway_downtime',
  'mandate_cancelled_by_customer',
  'upi_mandate_paused_by_customer',
  'amount_exceeds_mandate_max',
  'late_auth_pending',
  'unknown',
] as const

const CAUSE_DESCRIPTIONS = [
  '- insufficient_funds: the account had no money at the moment of the debit.',
  '- card_expired: the stored card is past its expiry date.',
  '- bank_blocked_card: the issuer refused the card itself, not the balance.',
  '- issuer_downtime: the customer’s bank was unavailable.',
  '- gateway_downtime: the payment gateway was unavailable.',
  '- mandate_cancelled_by_customer: the customer revoked the mandate. Terminal.',
  '- upi_mandate_paused_by_customer: paused by the customer; only they can resume it.',
  '- amount_exceeds_mandate_max: the debit was above the mandate’s max_amount.',
  '- late_auth_pending: authorisation may still land; the case may resolve itself.',
  '- unknown: the evidence does not support any of the above.',
].join('\n')

/**
 * Replaces the TOOL_DESCRIPTIONS import that came from Quark's tools/index —
 * those were notes and kanban tools and did not come across. These are the five
 * of BLUEPRINT §4.6. Keep this list in step with the RazorpayPort interface: the
 * model classifies against exactly this text, so a tool described here but not
 * implemented would make it overclaim.
 */
export const TOOL_DESCRIPTIONS = [
  '- retryNow(case_id): re-attempt the debit immediately.',
  '  NOT available for domestic cards — manual charge is unsupported on them, and',
  '  proposing it there will be rejected and rerouted. Check is_domestic_card first.',
  '',
  '- retryScheduled(case_id, scheduled_for): book the debit for a later ISO date.',
  '  The usual choice for insufficient_funds — aim at the next salary cycle rather',
  '  than retrying into the same empty account. RBI requires a pre-debit notice at',
  '  least 24h ahead, so never schedule less than 24h out.',
  '',
  '- switchRail(case_id, to): move the mandate to "upi" or "emandate".',
  '  Only sensible when the current rail itself is the problem.',
  '',
  '- sendPaymentLink(case_id, channel): send a payment link by "sms" or "email".',
  '  This is CONTACT. It is refused for customers on DND or opted out, and outside',
  '  09:00–21:00 IST, and absolutely for any customer who cancelled their mandate.',
  '',
  '- escalate(case_id, reason): hand the case to an operations human.',
  '  The right answer for merchant configuration problems and anything you cannot',
  '  confidently place. Escalating costs a human a few minutes; a wrong charge costs',
  '  a customer their money and the merchant their trust.',
  '',
  'You have no other tools. You cannot phone anyone, issue a refund, change the',
  'mandate amount, or edit the subscription. Cases needing those are ESCALATE.',
].join('\n')

/**
 * Builds the system prompt from classifier-prompt.md.
 *
 * The file is the source of truth for the agent's behaviour, so this fills in
 * its placeholders rather than restating them. If the file is edited such that
 * a placeholder disappears, we throw — silently shipping a prompt that still
 * says "[LIST YOUR REAL TOOLS HERE]" would make the model classify against
 * tools it doesn't have.
 */
function buildSystemPrompt(): string {
  const file = readFileSync(promptPath, 'utf8')

  // Everything above this line is provider setup notes addressed to the
  // developer ("read once, then delete"), not instructions for the model.
  const startIndex = file.indexOf('You are the recovery agent inside')
  if (startIndex === -1) {
    throw new Error('classifier-prompt.md: could not find the start of the system prompt')
  }
  let prompt = file.slice(startIndex)

  prompt = replaceOrThrow(prompt, '[APP_NAME]', APP_NAME)

  // The domain placeholder carries an inline example, so match the whole thing.
  const domainMatch = prompt.match(/\*\*\[TASK_DOMAIN[^\]]*\]\*\*/)
  if (!domainMatch) {
    throw new Error('classifier-prompt.md: missing the [TASK_DOMAIN ...] placeholder')
  }
  prompt = prompt.replace(domainMatch[0], `**${TASK_DOMAIN}**`)

  const causesMatch = prompt.match(/\[LIST ALLOWED CAUSES HERE\]\n/)
  if (!causesMatch) {
    throw new Error('classifier-prompt.md: missing the [LIST ALLOWED CAUSES HERE] placeholder')
  }
  prompt = prompt.replace(causesMatch[0], `${CAUSE_DESCRIPTIONS}\n`)

  // The tool list placeholder spans several lines inside one bracket pair.
  const toolsMatch = prompt.match(/\[LIST YOUR REAL TOOLS HERE[\s\S]*?\]\n/)
  if (!toolsMatch) {
    throw new Error('classifier-prompt.md: missing the [LIST YOUR REAL TOOLS HERE ...] placeholder')
  }
  prompt = prompt.replace(toolsMatch[0], `${TOOL_DESCRIPTIONS}\n`)

  return prompt.trim()
}

function replaceOrThrow(text: string, needle: string, value: string): string {
  if (!text.includes(needle)) {
    throw new Error(`classifier-prompt.md: missing the ${needle} placeholder`)
  }
  return text.replaceAll(needle, value)
}

// Read once at startup so a broken prompt fails on boot, not mid-batch.
export const SYSTEM_PROMPT = buildSystemPrompt()

function hoursUntil(iso: string, from: Date): number {
  return Math.round((new Date(iso).getTime() - from.getTime()) / 36e5)
}

/**
 * The per-case user message: what the agent is being asked to decide.
 *
 * `_true_cause` and `_will_self_heal` are deliberately NOT included. They are
 * the simulator's ground truth (§3); showing them to the agent would make every
 * measured number meaningless.
 */
export function buildUserMessage(
  kase: Case,
  cause: string = 'unknown',
  now: Date = new Date(),
): string {
  const lines = [
    `case_id: ${kase.id}`,
    `subscription_id: ${kase.subscription_id}`,
    `Established cause: ${cause}`,
    '',
    `Amount: INR ${kase.amount_inr}`,
    `Method: ${kase.method}${kase.is_domestic_card ? ' (DOMESTIC CARD — manual charge unsupported)' : ''}`,
    `Mandate max_amount: INR ${kase.mandate.max_amount_inr}`,
    `Mandate cancelled by customer: ${kase.mandate.cancelled_by_customer}`,
    `Mandate paused by customer: ${kase.mandate.paused_by_customer}`,
    '',
    `Error source: ${kase.error.source}`,
    `Error step: ${kase.error.step}`,
    `Error reason: ${kase.error.reason}`,
    `Error description: ${kase.error.description}`,
    '',
    `Failed at: ${kase.failed_at}`,
    `Prior attempts: ${kase.attempts}`,
    `Halts at: ${kase.halts_at} (${hoursUntil(kase.halts_at, now)}h from now)`,
    `Late authorisation still pending: ${kase.late_auth_pending}`,
    '',
    `Customer on DND: ${kase.customer.dnd}`,
    `Customer opted out of contact: ${kase.customer.opted_out}`,
    `Customer phone: ${kase.customer.phone_masked}`,
  ]

  if (kase.amount_inr > kase.mandate.max_amount_inr) {
    lines.push('', 'NOTE: this debit is above the mandate max_amount. A retry cannot succeed.')
  }

  return lines.join('\n')
}
