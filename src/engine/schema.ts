import { z } from 'zod'

/**
 * The agent's contract. Everything downstream comes from here — nothing ever
 * parses prose. Anything that doesn't validate is treated as a failed run
 * rather than passed along half-understood.
 *
 * Carried from Quark, with the three buckets renamed for this domain
 * (BLUEPRINT §2): CAN_DO → AUTO, PARTIAL → CUSTOMER_ACTION, HUMAN_ONLY → ESCALATE.
 */
export const classificationSchema = z.enum(['AUTO', 'CUSTOMER_ACTION', 'ESCALATE'])
export type Classification = z.infer<typeof classificationSchema>

/** The five tools of BLUEPRINT §4.6. The model may name no others. */
export const toolNameSchema = z.enum([
  'retryNow',
  'retryScheduled',
  'switchRail',
  'sendPaymentLink',
  'escalate',
])
export type ToolName = z.infer<typeof toolNameSchema>

/**
 * What the classifier *wants* to do, before the compliance gate and the
 * stopping rules have had their say. Kept separate from `actions_taken` because
 * in this domain the model never executes anything itself — proposing and
 * having-done are different claims, and conflating them in one field is how an
 * audit log ends up asserting a charge that never happened.
 */
export const proposedActionSchema = z.object({
  tool: toolNameSchema,
  params: z.record(z.string(), z.unknown()).default({}),
})
export type ProposedAction = z.infer<typeof proposedActionSchema>

export const agentActionSchema = z.object({
  tool: z.string(),
  input: z.union([z.string(), z.record(z.string(), z.unknown())]).default(''),
  result: z.string().default(''),
})
export type AgentAction = z.infer<typeof agentActionSchema>

// Arrays and strings get defaults: the prompt says never omit a field, but a
// missing `plan` shouldn't sink an otherwise usable answer. `classification`
// and `confirmation_required` have no defaults on purpose — those two decide
// what happens and whether we gate, so a malformed one must fail loudly.
// `proposed_action` is nullable rather than defaulted for the same reason: a
// missing proposal must read as "proposed nothing", never as a silent default.
export const agentResponseSchema = z.object({
  understanding: z.string().default(''),
  classification: classificationSchema,
  reasoning: z.string().default(''),
  plan: z.array(z.string()).default([]),
  proposed_action: proposedActionSchema.nullable(),
  actions_taken: z.array(agentActionSchema).default([]),
  confirmation_required: z.boolean(),
  confirmation_prompt: z.string().default(''),
  human_steps: z.array(z.string()).default([]),
  result_summary: z.string().default(''),
})
export type AgentResponse = z.infer<typeof agentResponseSchema>

/**
 * BLUEPRINT §4.2 — the diagnose stage's contract. Only cases with no
 * deterministic rule hit reach the model, and this is all it may return.
 */
export const diagnosisSchema = z.object({
  cause: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
})
export type Diagnosis = z.infer<typeof diagnosisSchema>

/** BLUEPRINT §4.2: "Reject and escalate if confidence < 0.7." */
export const DIAGNOSIS_CONFIDENCE_FLOOR = 0.7

/**
 * Models wrap JSON in code fences or add a sentence of preamble often enough
 * that trusting them not to is a bug waiting to happen. Take everything
 * between the first { and the last }.
 */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in model output: ${raw.slice(0, 200)}`)
  }
  return JSON.parse(raw.slice(start, end + 1))
}

export function parseAgentResponse(raw: string): AgentResponse {
  return agentResponseSchema.parse(extractJson(raw))
}

export type DiagnosisOutcome =
  | { kind: 'diagnosed'; diagnosis: Diagnosis }
  | { kind: 'escalate'; because: string; diagnosis: Diagnosis | null }

/**
 * The only way a model-produced cause is allowed into the pipeline.
 *
 * Three ways to fail, all of them ending in ESCALATE and none of them ending
 * in a silent retry (BLUEPRINT §4.3: "Validation failure → ESCALATE, never
 * retry the LLM silently"): the output isn't the shape we asked for, the cause
 * isn't one we offered, or the model isn't confident enough. The third is the
 * one that matters most — a 0.4-confidence guess about why a payment failed is
 * worse than no guess, because it looks like an answer.
 */
export function parseDiagnosis(raw: string, allowedCauses: readonly string[]): DiagnosisOutcome {
  let diagnosis: Diagnosis
  try {
    diagnosis = diagnosisSchema.parse(extractJson(raw))
  } catch (error) {
    return {
      kind: 'escalate',
      because: `diagnosis failed validation: ${error instanceof Error ? error.message : String(error)}`,
      diagnosis: null,
    }
  }

  if (!allowedCauses.includes(diagnosis.cause)) {
    return {
      kind: 'escalate',
      because: `model returned a cause outside the allowed list: ${diagnosis.cause}`,
      diagnosis,
    }
  }

  if (diagnosis.confidence < DIAGNOSIS_CONFIDENCE_FLOOR) {
    return {
      kind: 'escalate',
      because: `confidence ${diagnosis.confidence} is below the ${DIAGNOSIS_CONFIDENCE_FLOOR} floor`,
      diagnosis,
    }
  }

  return { kind: 'diagnosed', diagnosis }
}
