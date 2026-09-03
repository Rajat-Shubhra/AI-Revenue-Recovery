// M3 — DIAGNOSE (BLUEPRINT §4.3).
//
// Rules first, model only on what the rules cannot settle. The split is
// counted and reported, because "68 by rules, 12 by model, 3 escalated for low
// confidence" is the AI Judgment criterion made countable.
//
// The model path is defined here but not wired to a live provider until M10.
// `diagnose` takes the LLM step as an argument so the batch can run fully
// deterministically — no key, no quota, no network — and M10 only has to pass
// a different function in.
import type { Case } from '../engine/case'
import type { Clock } from '../engine/tool-types'
import type { AuditLog } from '../engine/audit'
import { hashInput } from '../engine/audit'
import { applyRules, type Cause } from './rules'
import { DIAGNOSIS_CONFIDENCE_FLOOR } from '../engine/schema'

export type DiagnosisSource = 'rules' | 'llm' | 'llm_unavailable'

export type Diagnosed = {
  cause: Cause
  confidence: number
  via: DiagnosisSource
  rules_fired: string[]
  evidence: string[]
  /**
   * True when the diagnosis is not trustworthy enough to act on, so DECIDE must
   * route the case to ESCALATE rather than to a money action (§4.3).
   */
  escalate: boolean
  because?: string
}

/**
 * What the LLM step must satisfy. Returns null when it cannot answer at all —
 * no key configured, quota exhausted, network down. A null is not a failure of
 * the batch: the case escalates, and the run continues. A payments agent that
 * halts because a model was unavailable is worse than one that hands those
 * cases to a human.
 */
export type LlmDiagnoser = (
  kase: Case,
) => Promise<{ cause: string; confidence: number; evidence: string[] } | null>

/** The deterministic default: no model, everything unresolved escalates. */
export const noLlm: LlmDiagnoser = async () => null

export async function diagnoseCase(kase: Case, llm: LlmDiagnoser): Promise<Diagnosed> {
  const hit = applyRules(kase)

  if (hit) {
    return {
      cause: hit.cause,
      confidence: 1,
      via: 'rules',
      rules_fired: [hit.rule.id],
      evidence: [hit.rule.describes],
      escalate: false,
    }
  }

  const answer = await llm(kase)

  if (!answer) {
    return {
      cause: 'unknown',
      confidence: 0,
      via: 'llm_unavailable',
      rules_fired: [],
      evidence: [],
      escalate: true,
      because: 'no rule matched and the model was not available',
    }
  }

  // A confident "unknown" is still not a diagnosis.
  //
  // The model can legitimately return `unknown` with high confidence — it is
  // sure the evidence supports nothing more specific, and that is the honest
  // answer we asked for. But counting it as "resolved by the model" would
  // inflate the AI-judgment number with cases the model explicitly declined to
  // call. It escalates, and it is counted as an escalation.
  if (answer.cause === 'unknown') {
    return {
      cause: 'unknown',
      confidence: answer.confidence,
      via: 'llm',
      rules_fired: [],
      evidence: answer.evidence,
      escalate: true,
      because: `model examined the case and could not narrow the cause (confidence ${answer.confidence.toFixed(2)} in "unknown")`,
    }
  }

  // Validation lives in schema.parseDiagnosis; by the time it reaches here the
  // shape is already known good. What is checked here is whether we trust it.
  if (answer.confidence < DIAGNOSIS_CONFIDENCE_FLOOR) {
    return {
      cause: 'unknown',
      confidence: answer.confidence,
      via: 'llm',
      rules_fired: [],
      evidence: answer.evidence,
      escalate: true,
      because: `model confidence ${answer.confidence.toFixed(2)} below the ${DIAGNOSIS_CONFIDENCE_FLOOR} floor`,
    }
  }

  return {
    cause: answer.cause as Cause,
    confidence: answer.confidence,
    via: 'llm',
    rules_fired: [],
    evidence: answer.evidence,
    escalate: false,
  }
}

export type DiagnoseTally = {
  total: number
  by_rules: number
  by_llm: number
  escalated_uncertain: number
}

export async function diagnose(
  cases: Case[],
  audit: AuditLog,
  clock: Clock,
  llm: LlmDiagnoser = noLlm,
): Promise<{ results: Map<string, Diagnosed>; tally: DiagnoseTally }> {
  const results = new Map<string, Diagnosed>()
  const tally: DiagnoseTally = { total: 0, by_rules: 0, by_llm: 0, escalated_uncertain: 0 }

  for (const kase of cases) {
    const d = await diagnoseCase(kase, llm)
    results.set(kase.id, d)

    tally.total += 1
    if (d.via === 'rules') tally.by_rules += 1
    else if (d.via === 'llm' && !d.escalate) tally.by_llm += 1
    if (d.escalate) tally.escalated_uncertain += 1

    await audit.append({
      ts: clock.now().toISOString(),
      case_id: kase.id,
      stage: 'diagnose',
      input_hash: hashInput({ error: kase.error, method: kase.method, attempts: kase.attempts }),
      rules_fired: d.rules_fired,
      llm: { used: d.via !== 'rules', confidence: d.confidence },
      cause: d.cause,
      stop_check: { stopped: false },
      ...(d.escalate ? { decision: 'ESCALATE' as const, because: d.because } : {}),
    })
  }

  return { results, tally }
}
