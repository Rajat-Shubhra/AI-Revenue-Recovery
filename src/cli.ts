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

  console.log(`\n${queue.size} eligible cases remain queued for the next tick.`)
  console.log(`Audit ledger: ${audit.file}`)
}

await main()
