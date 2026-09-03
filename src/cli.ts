// Batch runner (BLUEPRINT §4). Stages land here as milestones complete.
//
// Built so far: ingest (§4.1) and prioritise (§4.2).
// Still to come: diagnose, decide, compliance, stopping, act, measure.
import { fileURLToPath } from 'node:url'
import { AuditLog } from './engine/audit'
import { fixedClock } from './engine/clock'
import { BATCH_NOW } from './pipeline/generate'
import { ingest } from './pipeline/ingest'
import { prioritise, BATCH_TICK_SIZE, type Scored } from './pipeline/prioritise'
import { diagnose } from './pipeline/diagnose'
import { decide, type Outcome } from './pipeline/decide'
import { complianceGate } from './pipeline/compliance'

const AUDIT_FILE = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url))

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const padL = (s: string | number, n: number) => String(s).padStart(n)

function printQueue(top: Scored[]): void {
  console.log(`\nTop ${top.length} by priority\n`)
  console.log(
    `  ${pad('#', 3)}${pad('case', 10)}${padL('amount', 8)}  ${pad('method', 9)}${pad('reason', 23)}${pad('likely action', 16)}${padL('h/halt', 7)}${padL('priority', 10)}`,
  )
  console.log(`  ${'─'.repeat(88)}`)
  top.forEach((s, i) => {
    console.log(
      `  ${pad(i + 1, 3)}${pad(s.kase.id, 10)}${padL(inr(s.kase.amount_inr), 8)}  ` +
        `${pad(s.kase.method, 9)}${pad(s.kase.error.reason, 23)}${pad(s.likely_action, 16)}` +
        `${padL(s.hours_to_halt.toFixed(0), 7)}${padL(s.priority.toFixed(2), 10)}`,
    )
  })
}

async function main(): Promise<void> {
  const clock = fixedClock(BATCH_NOW)
  const audit = new AuditLog(AUDIT_FILE)
  await audit.load()

  const stranded = audit.unreconciled()
  if (stranded.length > 0) {
    // Claimed but never confirmed — we do not know whether the customer was
    // charged, so these are never retried automatically.
    console.warn(`\n${stranded.length} action(s) NEED RECONCILIATION against Razorpay:`)
    for (const key of stranded) console.warn(`  ${key}`)
  }

  const ingested = await ingest(audit, clock)
  const { queue, scored, eligible } = prioritise(ingested)

  const holdout = scored.filter((s) => s.holdout)
  const halted = scored.filter((s) => s.halted && !s.holdout)
  const pool = (items: Scored[]) => items.reduce((sum, s) => sum + s.kase.amount_inr, 0)

  console.log(`\nBatch of ${scored.length} cases, clock fixed at ${clock.now().toISOString()}`)
  console.log(`  treated pool   ${padL(eligible.length, 3)} cases  ${padL(inr(pool(eligible)), 10)} at risk`)
  console.log(`  holdout arm    ${padL(holdout.length, 3)} cases  ${padL(inr(pool(holdout)), 10)} at risk  (never touched)`)
  console.log(`  already halted ${padL(halted.length, 3)} cases  ${padL(inr(pool(halted)), 10)} written off before the batch ran`)

  const top = queue.take(BATCH_TICK_SIZE)
  printQueue(top)

  console.log('\nWhy the top 3 ranked there\n')
  for (const s of top.slice(0, 3)) {
    console.log(`  ${s.kase.id}  ${s.why}`)
  }

  for (const s of top) {
    await audit.append({
      ts: clock.now().toISOString(),
      case_id: s.kase.id,
      stage: 'prioritise',
      arm: 'treated',
      priority: Number(s.priority.toFixed(4)),
      why: s.why,
      tool: s.likely_action,
    })
  }

  // Diagnose the whole batch, not just this tick — the rules-vs-model split is
  // a claim about the batch, and the holdout arm needs a cause for measurement
  // even though nothing will be done to it.
  const { results, tally } = await diagnose(
    scored.map((s) => s.kase),
    audit,
    clock,
  )

  console.log('\nDiagnosis\n')
  console.log(`  ${tally.total} cases · ${tally.by_rules} resolved by rules · ${tally.by_llm} via the model` +
    ` · ${tally.escalated_uncertain} uncertain → escalated`)
  console.log(
    `  ${((tally.by_rules / tally.total) * 100).toFixed(0)}% deterministic. ` +
      `The model is reserved for the ambiguous tail (M10 wires it live; the run above used none).`,
  )

  // Decide + compliance for the treated arm only. The holdout is diagnosed for
  // measurement but never decided on — nothing may reach it.
  const buckets = new Map<Outcome, number>()
  const gateFirings: string[] = []
  let overridden = 0
  const treated = scored.filter((s) => !s.holdout && !s.halted)

  for (const s of treated) {
    const d = results.get(s.kase.id)!
    const proposed = decide(s.kase, d, clock.now())
    const gate = complianceGate(s.kase, proposed, clock)
    const final = gate.decision

    buckets.set(final.outcome, (buckets.get(final.outcome) ?? 0) + 1)
    if (gate.overridden) overridden += 1
    for (const c of gate.checks) {
      if (!c.passed || c.action) gateFirings.push(`${c.id} ${c.action ?? 'blocked'} · ${s.kase.id} · ${c.detail ?? c.check}`)
    }

    await audit.append({
      ts: clock.now().toISOString(),
      case_id: s.kase.id,
      stage: 'decide',
      arm: 'treated',
      rules_fired: d.rules_fired,
      llm: { used: d.via !== 'rules', confidence: d.confidence },
      cause: d.cause,
      decision: final.outcome,
      tool: final.tool ?? undefined,
      because: final.because,
      rejected: final.rejected,
      compliance: { passed: gate.passed, checks: gate.checks.map((c) => `${c.id}:${c.passed ? 'ok' : c.action}`) },
      stop_check: { stopped: final.outcome === 'STOP' || final.outcome === 'HOLD' },
    })
  }

  console.log('\nDecisions across the treated arm\n')
  for (const outcome of ['AUTO', 'CUSTOMER_ACTION', 'ESCALATE', 'STOP', 'HOLD'] as Outcome[]) {
    const n = buckets.get(outcome) ?? 0
    if (n > 0) console.log(`  ${pad(outcome, 17)}${padL(n, 3)}`)
  }
  console.log(`\n  ${overridden} decision(s) changed by the compliance gate.`)

  if (gateFirings.length > 0) {
    console.log('\nCompliance checks that fired\n')
    for (const f of gateFirings.slice(0, 8)) console.log(`  ${f}`)
    if (gateFirings.length > 8) console.log(`  … and ${gateFirings.length - 8} more (all in the audit log)`)
  }

  console.log(`\n${queue.size} eligible cases remain queued for the next tick.`)
  console.log(`Audit ledger: ${audit.file}`)
}

await main()
