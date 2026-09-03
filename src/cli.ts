// Batch runner (BLUEPRINT §4) — the full loop.
//
// ingest → prioritise → diagnose → decide → compliance → stop → act → measure,
// with every stage writing to the append-only audit ledger.
import { fileURLToPath } from 'node:url'
import { AuditLog } from './engine/audit'
import { fixedClock } from './engine/clock'
import { executeActions } from './engine/gate'
import type { AgentAction } from './engine/schema'
import { BATCH_NOW } from './pipeline/generate'
import { ingest } from './pipeline/ingest'
import { prioritise, BATCH_TICK_SIZE, type Scored } from './pipeline/prioritise'
import { diagnose, noLlm } from './pipeline/diagnose'
import { liveLlmDiagnoser, emptyLlmStats } from './pipeline/llm-diagnose'
import { defaultProvider } from './engine/provider'
import { decide, type Outcome } from './pipeline/decide'
import { complianceGate } from './pipeline/compliance'
import { loadStoppingConfig, stopCheck, systemicCheck } from './pipeline/stopping'
import { registerTools } from './pipeline/tools'
import { MockRazorpayPort } from './ports/mock'
import { ACTION_COST_INR, type ActionName } from './pipeline/recovery-priors'
import { measure, scoreHoldout, type CaseResult } from './pipeline/measure'
import { expectedNoActionRate, checkDiagnoses } from './sim/simulator'
import type { SimAction } from './sim/outcomes'

const AUDIT_FILE = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url))

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const padL = (s: string | number, n: number) => String(s).padStart(n)
const rule = (n = 78) => console.log('  ' + '─'.repeat(n))

function printQueue(top: Scored[]): void {
  console.log(`\nTop ${top.length} by priority\n`)
  console.log(
    `  ${pad('#', 3)}${pad('case', 10)}${padL('amount', 8)}  ${pad('method', 9)}${pad('reason', 23)}${padL('h/halt', 7)}${padL('priority', 10)}`,
  )
  rule(70)
  top.forEach((s, i) => {
    console.log(
      `  ${pad(i + 1, 3)}${pad(s.kase.id, 10)}${padL(inr(s.kase.amount_inr), 8)}  ` +
        `${pad(s.kase.method, 9)}${pad(s.kase.error.reason, 23)}` +
        `${padL(s.hours_to_halt.toFixed(0), 7)}${padL(s.priority.toFixed(2), 10)}`,
    )
  })
}

async function main(): Promise<void> {
  const clock = fixedClock(BATCH_NOW)
  const now = clock.now()
  const audit = new AuditLog(AUDIT_FILE)
  await audit.load()
  registerTools()
  const config = loadStoppingConfig()

  const stranded = audit.unreconciled()
  if (stranded.length > 0) {
    console.warn(`\n${stranded.length} action(s) NEED RECONCILIATION against Razorpay:`)
    for (const key of stranded) console.warn(`  ${key}`)
  }

  // ─── INGEST + PRIORITISE ────────────────────────────────────────────────
  const ingested = await ingest(audit, clock)
  const { queue, scored } = prioritise(ingested)
  const port = new MockRazorpayPort(scored.map((s) => s.kase))

  const holdoutCases = scored.filter((s) => s.holdout)
  const halted = scored.filter((s) => s.halted && !s.holdout)
  const pool = (items: Scored[]) => items.reduce((sum, s) => sum + s.kase.amount_inr, 0)

  console.log(`\nBatch of ${scored.length} cases · clock fixed at ${now.toISOString()}`)
  console.log(`  treated pool   ${padL(scored.length - holdoutCases.length - halted.length, 3)} cases  ${padL(inr(pool(scored) - pool(holdoutCases) - pool(halted)), 10)} at risk`)
  console.log(`  holdout arm    ${padL(holdoutCases.length, 3)} cases  ${padL(inr(pool(holdoutCases)), 10)} at risk  (never touched)`)
  console.log(`  already halted ${padL(halted.length, 3)} cases  ${padL(inr(pool(halted)), 10)} written off before the batch ran`)

  printQueue(queue.take(BATCH_TICK_SIZE))

  // ─── DIAGNOSE ───────────────────────────────────────────────────────────
  // The model runs only on what the rules could not settle. `--no-llm` keeps a
  // run fully deterministic and free, which is the default for development.
  const useLlm = !process.argv.includes('--no-llm')
  const llmStats = emptyLlmStats()
  const provider = useLlm ? defaultProvider() : null
  const { results, tally } = await diagnose(
    scored.map((s) => s.kase),
    audit,
    clock,
    provider ? liveLlmDiagnoser(llmStats, provider) : noLlm,
  )

  console.log('\nDiagnosis\n')
  console.log(
    `  ${tally.total} cases · ${tally.by_rules} by rules · ${tally.by_llm} by the model · ${tally.escalated_uncertain} uncertain → escalated`,
  )
  console.log(`  ${pct(tally.by_rules / tally.total)} deterministic — the model is reserved for the ambiguous tail.`)
  if (provider) {
    console.log(`  provider: ${provider.name} (${provider.model})`)
    console.log(
      `  model: ${llmStats.calls} call(s) · ${llmStats.ok} usable · ${llmStats.rejected} rejected by the schema or floor` +
        ` · ${llmStats.failed} failed · ${llmStats.retries} transport retr${llmStats.retries === 1 ? 'y' : 'ies'}`,
    )
    if (llmStats.quotaExhausted) {
      console.log(`  ⚠ QUOTA EXHAUSTED mid-run — remaining cases escalated rather than guessed.`)
    }
    if (llmStats.lastError) console.log(`  last model issue: ${llmStats.lastError}`)

    // Was it right? "Resolved by the model" is not the same claim as "correct",
    // and reporting only the first would overstate what the model contributed.
    const modelClaims = new Map(
      [...results]
        .filter(([, d]) => d.via === 'llm' && !d.escalate)
        .map(([id, d]) => [id, d.cause as string]),
    )
    const checks = checkDiagnoses(scored.map((s) => s.kase), modelClaims)
    if (checks.length > 0) {
      const right = checks.filter((c) => c.correct)
      console.log(
        `  accuracy: ${right.length}/${checks.length} of the model's diagnoses matched the true cause`,
      )
      for (const wrong of checks.filter((c) => !c.correct)) {
        console.log(
          `    ✗ ${wrong.case_id} — model said ${wrong.claimed}, actually ${wrong.actual} (₹${wrong.amount_inr})`,
        )
      }
    }
  } else {
    console.log('  model: skipped (--no-llm)')
  }

  // ─── SYSTEMIC CHECK, before any per-case action ────────────────────────
  const treatedScored = scored.filter((s) => !s.holdout && !s.halted)
  const systemic = systemicCheck(treatedScored.map((s) => results.get(s.kase.id)!.cause), config)

  await audit.append({
    ts: now.toISOString(),
    case_id: '*batch*',
    stage: 'stop',
    stop_check: { stopped: systemic.fired, because: systemic.because },
  })

  if (systemic.fired) {
    console.log('\n⚠ SYSTEMIC ALERT\n')
    console.log(`  ${systemic.because}`)
  } else {
    console.log(
      `\n  No systemic alert — the largest single cause is ${systemic.cause} at ${pct(systemic.share ?? 0)}, ` +
        `under the ${pct(config.systemic_alert_if_same_cause_share_exceeds)} threshold.`,
    )
  }

  // ─── DECIDE → COMPLIANCE → STOP → ACT ──────────────────────────────────
  const buckets = new Map<Outcome, number>()
  const stops: string[] = []
  const treatedResults: CaseResult[] = []
  let gateOverrides = 0

  for (const s of treatedScored) {
    const d = results.get(s.kase.id)!
    const proposed = decide(s.kase, d, now)
    const gate = complianceGate(s.kase, proposed, clock)
    if (gate.overridden) gateOverrides += 1

    const stop = systemic.fired
      ? { stopped: true, rule: 'systemic_alert', because: 'held under the batch-wide systemic escalation' }
      : stopCheck(s, gate.decision, d.cause, config, now)

    const final = gate.decision
    const outcome: Outcome = stop.stopped && final.outcome !== 'STOP' && final.outcome !== 'HOLD' ? 'STOP' : final.outcome
    buckets.set(outcome, (buckets.get(outcome) ?? 0) + 1)
    if (stop.stopped) stops.push(`${s.kase.id} · ${stop.rule} · ${stop.because}`)

    // Only cases that survive compliance AND stopping reach a rail.
    const willAct = !stop.stopped && final.tool !== null
    let cost = 0
    let simAction: SimAction = 'none'

    if (willAct) {
      const action: AgentAction = { tool: final.tool!, input: final.params, result: '' }
      const [executed] = await executeActions([action], {
        caseId: s.kase.id,
        port,
        clock,
        audit,
      })
      cost = ACTION_COST_INR[final.tool as ActionName] ?? 0
      simAction = final.tool as SimAction
      if (executed && !executed.ok && executed.result.includes('confirmation')) simAction = 'none'
    }

    // Cases the agent chose not to act on are scored by the simulator's `none`
    // column — the same column the holdout takes — so restraint and inaction
    // are measured identically.
    if (simAction === 'none') port.noAction(s.kase.id)

    await audit.append({
      ts: now.toISOString(),
      case_id: s.kase.id,
      stage: 'decide',
      arm: 'treated',
      rules_fired: d.rules_fired,
      llm: { used: d.via !== 'rules', confidence: d.confidence },
      cause: d.cause,
      decision: outcome,
      tool: willAct ? (final.tool ?? undefined) : undefined,
      because: stop.stopped ? stop.because : final.because,
      rejected: final.rejected,
      compliance: { passed: gate.passed, checks: gate.checks.map((c) => `${c.id}:${c.passed ? 'ok' : c.action}`) },
      stop_check: { stopped: stop.stopped, because: stop.because },
    })

    treatedResults.push({
      kase: s.kase,
      arm: 'treated',
      action: simAction,
      outcome,
      cause: d.cause,
      recovered: port.recovered.get(s.kase.id) ?? false,
      cost_inr: cost,
    })
  }

  console.log('\nDecisions across the treated arm\n')
  for (const outcome of ['AUTO', 'CUSTOMER_ACTION', 'ESCALATE', 'STOP', 'HOLD'] as Outcome[]) {
    const n = buckets.get(outcome) ?? 0
    if (n > 0) console.log(`  ${pad(outcome, 17)}${padL(n, 3)}`)
  }
  console.log(`\n  ${gateOverrides} decision(s) changed by the compliance gate · ${stops.length} stopped by the stopping rules`)
  for (const s of stops.slice(0, 5)) console.log(`    ${s}`)
  if (stops.length > 5) console.log(`    … and ${stops.length - 5} more (all in the audit log)`)

  // ─── MEASURE ────────────────────────────────────────────────────────────
  const causeById = new Map([...results].map(([id, d]) => [id, d.cause]))
  const holdoutResults = scoreHoldout(holdoutCases.map((s) => s.kase), causeById)
  const m = measure(
    treatedResults,
    holdoutResults,
    expectedNoActionRate(treatedScored.map((s) => s.kase)),
  )

  console.log('\n' + '═'.repeat(80))
  console.log('  MEASUREMENT — treated vs holdout')
  console.log('═'.repeat(80) + '\n')
  console.log(`  ${pad('', 12)}${padL('cases', 7)}${padL('pool', 12)}${padL('recovered', 12)}${padL('by value', 10)}${padL('by count', 10)}`)
  rule(62)
  console.log(`  ${pad('treated', 12)}${padL(m.treated.cases, 7)}${padL(inr(m.treated.pool_inr), 12)}${padL(inr(m.treated.recovered_inr), 12)}${padL(pct(m.treated.rate), 10)}${padL(pct(m.treated.rate_by_count), 10)}`)
  console.log(`  ${pad('holdout', 12)}${padL(m.holdout.cases, 7)}${padL(inr(m.holdout.pool_inr), 12)}${padL(inr(m.holdout.recovered_inr), 12)}${padL(pct(m.holdout.rate), 10)}${padL(pct(m.holdout.rate_by_count), 10)}`)
  rule(62)
  console.log(`\n  The treated pool would have recovered ${inr(m.counterfactual_inr)} on its own,`)
  console.log(`  at the ${pct(m.holdout.rate)} rate the untouched arm managed by itself.\n`)
  console.log(`  NET LIFT            ${padL(inr(m.net_lift_inr), 12)}`)
  console.log(`  cost of actions     ${padL(inr(m.action_cost_inr), 12)}`)
  console.log(`  NET OF COST         ${padL(inr(m.net_lift_after_cost_inr), 12)}`)

  if (m.modelled) {
    console.log(`\n  Cross-check — the holdout is only ${m.holdout.cases} cases, so its rate is noisy.`)
    console.log(`  The simulator table implies a ${pct(m.modelled.rate)} do-nothing rate for this pool,`)
    console.log(`  which would put net lift at ${inr(m.modelled.net_lift_inr)} rather than ${inr(m.net_lift_inr)}.`)
    console.log(`  The holdout figure is the honest measurement; this is a check on it, and the`)
    console.log(`  gap between them is the uncertainty a 16-case control arm buys you.`)
  }

  console.log('\n  By decision bucket\n')
  console.log(`  ${pad('bucket', 17)}${padL('cases', 7)}${padL('recovered', 12)}${padL('cost', 9)}`)
  rule(45)
  for (const b of m.by_bucket) {
    console.log(`  ${pad(b.bucket, 17)}${padL(b.cases, 7)}${padL(inr(b.recovered_inr), 12)}${padL(inr(b.cost_inr), 9)}`)
  }

  console.log('\n  By cause — treated recovery, by value and by case count\n')
  console.log(
    `  ${pad('cause', 32)}${padL('n', 4)}${padL('by value', 10)}${padL('by count', 10)}${padL('holdout', 9)}${padL('lift', 11)}`,
  )
  rule(76)
  for (const c of m.by_cause) {
    if (c.treated.cases === 0) continue
    console.log(
      `  ${pad(c.cause, 32)}${padL(c.treated.cases, 4)}${padL(pct(c.treated.rate), 10)}` +
        `${padL(`${c.treated.recovered_cases}/${c.treated.cases}`, 10)}` +
        `${padL(c.holdout.cases > 0 ? pct(c.holdout.rate) : '—', 9)}${padL(inr(c.lift_inr), 11)}`,
    )
  }
  console.log(
    `\n  Where the two columns disagree, one large case is doing the work — with n this\n` +
      `  small the by-value rate is the noisier of the two. Per-cause lift is indicative,\n` +
      `  not a claim; the batch-level number is the one with a real control arm behind it.`,
  )

  console.log('\n  Outcomes are simulated from the single table in src/sim/outcomes.ts.')
  console.log('  The number that counts is the difference between arms, not raw recoveries.')
  console.log(`\n  Audit ledger: ${audit.file}`)
}

await main()
