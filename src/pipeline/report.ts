// M10 — the batch report the dashboard renders.
//
// Written by the CLI at the end of a run so the browser never re-derives a
// number. The measurement lives in exactly one place (measure.ts); if the
// dashboard recomputed it, the page and the console could disagree and one of
// them would be wrong without anyone noticing.
//
// The per-case timeline the drawer shows comes from `audit.jsonl` directly —
// this file carries the summary, the ledger carries the evidence.
import { writeFileSafe } from '../engine/fs-safe'
import type { Measurement } from './measure'
import type { Outcome } from './decide'

export type ReportCase = {
  id: string
  amount_inr: number
  method: string
  reason: string
  cause: string
  arm: 'treated' | 'holdout'
  /** Null for anything stopped before it reached a rail. */
  decision: Outcome | 'HOLDOUT' | 'HALTED' | null
  tool: string | null
  priority: number | null
  why: string | null
  recovered: boolean
  cost_inr: number
  halted: boolean
  stopped_because: string | null
}

export type DiagnosisReport = {
  total: number
  by_rules: number
  by_llm: number
  escalated_uncertain: number
  provider: { name: string; model: string } | null
  calls: number
  usable: number
  failed: number
  quota_exhausted: boolean
  /** Model diagnoses scored against ground truth. Empty when no model ran. */
  accuracy: { case_id: string; claimed: string; actual: string; correct: boolean }[]
}

export type BatchReport = {
  generated_at: string
  clock: string
  seed: number
  counts: { total: number; treated: number; holdout: number; halted: number }
  diagnosis: DiagnosisReport
  systemic: { fired: boolean; cause?: string; share?: number; because?: string }
  measurement: Measurement
  cases: ReportCase[]
}

export function writeReport(file: string, report: BatchReport): void {
  writeFileSafe(file, `${JSON.stringify(report, null, 2)}\n`)
}
