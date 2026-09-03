// M9 — the live model path for DIAGNOSE (BLUEPRINT §4.3).
//
// This is the only place in the pipeline that calls a model, and it is reached
// by roughly 10% of cases: the ones whose error reason carries no information.
// Everything else was settled by the rules table for free.
//
// Three rules govern it, and all three exist because this is a payments system:
//
//  1. **One call per case, never a silent retry.** A model that returned
//     malformed JSON gets escalated, not asked again. Retrying until the output
//     parses is how you talk yourself into an answer.
//  2. **A quota or network failure escalates the case and the batch carries
//     on.** An agent that halts because a model was unavailable is worse than
//     one that hands those cases to a human.
//  3. **The output is schema-validated and confidence-gated before it can
//     influence a money action** — `parseDiagnosis` in engine/schema.ts.
import type { Case } from '../engine/case'
import type { AgentProvider } from '../engine/provider'
import { geminiProvider } from '../engine/provider'
import { parseDiagnosis } from '../engine/schema'
import { ALLOWED_CAUSES, buildUserMessage } from '../engine/prompt'
import type { LlmDiagnoser } from './diagnose'

const CAUSE_LIST = ALLOWED_CAUSES.map((c) => `- ${c}`).join('\n')

export const DIAGNOSE_SYSTEM_PROMPT = `You are the diagnosis step of a failed-subscription recovery agent.

A recurring payment has failed and the deterministic rules could not establish why: the error reason is uninformative. Your job is to infer the most likely cause from the case, or to say honestly that you cannot.

You must return exactly one cause from this closed list. Never invent one:

${CAUSE_LIST}

Guidance:
- "unknown" is a legitimate and often correct answer. Preferring it to a weak guess is the behaviour we want, because a wrong cause here sends a real debit at a real customer.
- Weigh the mandate state, the method, the error source and step, and how many attempts have already been made.
- A domestic card cannot be manually charged; that constrains what can be done, but it is not itself a cause.
- confidence is your honest probability that the cause is right, from 0 to 1. Anything below 0.7 will be rejected and the case handed to a human, which is the correct outcome for a genuine guess. Do not inflate it.
- evidence is the specific facts from the case that led you there, quoted or paraphrased. Not reasoning about what you might do.

Respond with only a single valid JSON object. No markdown, no code fences, no text before or after it:

{"cause": "one of the causes above", "confidence": 0.0, "evidence": ["fact from the case", "another fact"]}`

export type LlmStats = {
  calls: number
  ok: number
  rejected: number
  failed: number
  /** Transport-level retries after a 429 or 503. Not re-asking for an answer. */
  retries: number
  /** Set once a call fails in a way that means further calls are pointless. */
  quotaExhausted: boolean
  lastError?: string
}

/** Looks like a rate limit or spent quota rather than a transient blip. */
function isQuotaError(message: string): boolean {
  return /\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(message)
}

/** Gemini overload, or a request that never came back. Worth one retry. */
function isTransient(message: string): boolean {
  return /\b(503|500|502|504)\b|UNAVAILABLE|overloaded|timeout|timed out|aborted|fetch failed|ECONN/i.test(
    message,
  )
}

/**
 * The free tier allows 5 requests per minute — a rate limit, not a daily cap,
 * which is a much better problem to have: it needs pacing, not a new key.
 * 13s leaves a little headroom over the 12s the limit implies.
 */
export const MIN_CALL_INTERVAL_MS = 13_000

/** Give up on the model for this run after this many hard failures. */
export const CONSECUTIVE_FAILURE_LIMIT = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Gemini reports "Please retry in 19.691398396s" — use its number, not a guess. */
function retryAfterMs(message: string): number {
  const match = message.match(/retry in ([\d.]+)s/i)
  return match ? Math.ceil(Number(match[1]) * 1000) + 500 : 20_000
}

/**
 * Build a diagnoser bound to a provider, plus the stats object the batch
 * reports from. Pass the stats in so the caller can read them after the run.
 */
export function liveLlmDiagnoser(
  stats: LlmStats,
  provider: AgentProvider = geminiProvider(),
  minIntervalMs: number = MIN_CALL_INTERVAL_MS,
): LlmDiagnoser {
  let lastCallAt = 0

  return async (kase: Case) => {
    // Once quota is genuinely gone, stop calling. Burning the rest of the
    // allowance on calls that will all fail helps nobody.
    if (stats.quotaExhausted) return null

    // Pace to stay inside the requests-per-minute limit.
    const since = Date.now() - lastCallAt
    if (lastCallAt > 0 && since < minIntervalMs) await sleep(minIntervalMs - since)

    /**
     * Ask once, and retry ONLY when the model never answered.
     *
     * This is not the "never retry the LLM silently" rule from §4.3 — that rule
     * forbids re-asking because you disliked the answer, which is how you talk
     * a model into agreeing with you. A 429 or a 503 means no answer was ever
     * produced. Retrying the same prompt after the wait the server asked for is
     * transport, not judgement, and it is counted separately.
     */
    let raw: string
    let attempt = 0
    for (;;) {
      try {
        stats.calls += 1
        lastCallAt = Date.now()
        raw = await provider.complete(DIAGNOSE_SYSTEM_PROMPT, buildUserMessage(kase, 'unknown'))
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stats.lastError = message

        const worthRetrying = isQuotaError(message) || isTransient(message)
        if (worthRetrying && attempt === 0) {
          attempt += 1
          stats.retries += 1
          await sleep(isQuotaError(message) ? retryAfterMs(message) : 2_000)
          continue
        }

        stats.failed += 1
        if (isQuotaError(message)) stats.quotaExhausted = true

        // Repeated non-quota failures mean the provider is unwell, not that
        // this particular case is hard. Stop calling rather than spending a
        // minute of wall clock per remaining case discovering the same thing.
        if (stats.failed >= CONSECUTIVE_FAILURE_LIMIT) stats.quotaExhausted = true

        // The case escalates. The batch continues.
        return null
      }
    }

    const outcome = parseDiagnosis(raw, ALLOWED_CAUSES)

    if (outcome.kind === 'escalate') {
      stats.rejected += 1
      stats.lastError = outcome.because
      // A malformed or unconfident answer is returned as-is when we have one,
      // so the confidence floor in diagnose.ts records the real number rather
      // than a zero. When there is nothing usable at all, escalate on null.
      if (outcome.diagnosis) {
        return {
          cause: outcome.diagnosis.cause,
          confidence: outcome.diagnosis.confidence,
          evidence: outcome.diagnosis.evidence,
        }
      }
      return null
    }

    stats.ok += 1
    return outcome.diagnosis
  }
}

export function emptyLlmStats(): LlmStats {
  return { calls: 0, ok: 0, rejected: 0, failed: 0, retries: 0, quotaExhausted: false }
}
