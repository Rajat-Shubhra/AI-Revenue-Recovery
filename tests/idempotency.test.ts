// BLUEPRINT §7, the mandatory fourth invariant:
// "re-running the same batch must produce zero new actions".
//
// This is the test that stands between a crash-and-restart and a customer being
// charged twice. If it ever goes red, nothing else in this repo matters.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuditLog, idempotencyKey, type AuditEntry } from '../src/engine/audit'
import { executeActions } from '../src/engine/gate'
import { registerTools } from '../src/pipeline/tools'
import { MockRazorpayPort } from '../src/ports/mock'
import { fixedClock } from '../src/engine/clock'
import type { ToolContext } from '../src/engine/tool-types'
import { loadCases } from '../src/pipeline/ingest'

let dir: string
let ledger: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'audit-'))
  ledger = path.join(dir, 'audit.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function entries(): Promise<AuditEntry[]> {
  const text = await readFile(ledger, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditEntry)
}

/** A batch of three actions across two cases, one of them scheduled. */
const BATCH = [
  { caseId: 'case_001', tool: 'retryScheduled', scheduledFor: '2026-09-10T00:00:00.000Z' },
  { caseId: 'case_002', tool: 'sendPaymentLink', scheduledFor: null },
  { caseId: 'case_003', tool: 'escalate', scheduledFor: null },
]

/** Runs the batch against a freshly loaded log, as a restarted process would. */
async function runBatch(): Promise<number> {
  const audit = new AuditLog(ledger)
  await audit.load()

  let railCalls = 0
  for (const action of BATCH) {
    await audit.executeOnce(action, async () => {
      railCalls += 1
      return { ok: true, detail: `${action.tool} accepted` }
    })
  }
  return railCalls
}

describe('idempotency guard', () => {
  it('runs every action the first time', async () => {
    expect(await runBatch()).toBe(3)
  })

  it('produces zero new actions when the same batch is re-run', async () => {
    expect(await runBatch()).toBe(3)

    // Second run — a fresh AuditLog, exactly as a restarted CLI would build.
    expect(await runBatch()).toBe(0)

    // And a third, to prove it is not an off-by-one.
    expect(await runBatch()).toBe(0)

    const executed = (await entries()).filter((e) => e.act === 'executed')
    expect(executed).toHaveLength(3)

    const skipped = (await entries()).filter((e) => e.act === 'skipped_duplicate')
    expect(skipped).toHaveLength(6)
  })

  it('logs a skipped-duplicate entry rather than staying silent', async () => {
    await runBatch()
    await runBatch()

    const skipped = (await entries()).filter((e) => e.act === 'skipped_duplicate')
    expect(skipped.map((e) => e.case_id)).toEqual(['case_001', 'case_002', 'case_003'])
    for (const entry of skipped) {
      expect(entry.idempotency_key).toBeTruthy()
      expect(entry.detail).toContain('not sent to the rail')
    }
  })

  it('treats the same retry on a different date as a different action', async () => {
    const audit = new AuditLog(ledger)
    await audit.load()

    let calls = 0
    const run = async () => {
      calls += 1
      return { ok: true, detail: 'ok' }
    }

    await audit.executeOnce(
      { caseId: 'case_001', tool: 'retryScheduled', scheduledFor: '2026-09-10T00:00:00.000Z' },
      run,
    )
    await audit.executeOnce(
      { caseId: 'case_001', tool: 'retryScheduled', scheduledFor: '2026-09-25T00:00:00.000Z' },
      run,
    )
    // Same case, same tool, same date as the first — a replay.
    await audit.executeOnce(
      { caseId: 'case_001', tool: 'retryScheduled', scheduledFor: '2026-09-10T00:00:00.000Z' },
      run,
    )

    expect(calls).toBe(2)
  })

  it('never calls the rail twice even when the first result never landed', async () => {
    // Simulate a crash between claiming the key and recording the outcome: the
    // intent line is on disk, the executed line is not.
    const first = new AuditLog(ledger)
    await first.load()
    await expect(
      first.executeOnce({ caseId: 'case_009', tool: 'retryNow' }, async () => {
        throw new Error('process died mid-call')
      }),
    ).rejects.toThrow('process died mid-call')

    // Restart. We do not know whether the customer was charged.
    const second = new AuditLog(ledger)
    await second.load()

    let calls = 0
    const result = await second.executeOnce({ caseId: 'case_009', tool: 'retryNow' }, async () => {
      calls += 1
      return { ok: true, detail: 'charged' }
    })

    expect(calls).toBe(0)
    expect(result.status).toBe('skipped_duplicate')

    // And it is surfaced for a human rather than quietly dropped.
    expect(second.unreconciled()).toContain(idempotencyKey('case_009', 'retryNow', null))
  })

  it('refuses to answer before the ledger has been loaded', () => {
    const audit = new AuditLog(ledger)
    expect(() => audit.hasClaimed('anything')).toThrow(/load\(\) must be awaited/)
  })
})

/**
 * The confirmation gate, which for a long time was implemented and never
 * called.
 *
 * `retryNow` debits immediately with no pre-debit notice and cannot be undone,
 * so `tools.ts` declares it as always requiring a human. That declaration was
 * true and inert: `executeActions` went straight to the rail without ever
 * asking. Nothing reached it — the decide table never proposes `retryNow` — but
 * "unreachable" is not the same safety property as "gated", and only one of
 * them survives someone adding a new branch.
 */
describe('the confirmation gate is actually consulted', () => {
  beforeEach(() => {
    registerTools()
  })

  // A real case from the seed, so the port can score the ones that go through.
  const kase = loadCases()[0]!

  const ctxFor = (audit: AuditLog): ToolContext => ({
    caseId: kase.id,
    port: new MockRazorpayPort([kase]),
    clock: fixedClock('2026-09-05T09:00:00.000Z'),
    audit,
  })

  it('holds retryNow for a human instead of debiting', async () => {
    const audit = new AuditLog(ledger)
    await audit.load()

    const [result] = await executeActions(
      [{ tool: 'retryNow', input: {}, result: '' }],
      ctxFor(audit),
    )

    expect(result?.ok).toBe(false)
    expect(result?.result).toContain('Held for confirmation')
    // And it says what it would have done, in words a person can act on.
    expect(result?.result).toContain('cannot be undone')
  })

  it('claims no idempotency key for an action nobody approved', async () => {
    const audit = new AuditLog(ledger)
    await audit.load()

    await executeActions([{ tool: 'retryNow', input: {}, result: '' }], ctxFor(audit))

    // Claiming the key here would mean that when a human DOES approve the
    // action, the replay guard refuses the very thing they authorised.
    expect(audit.hasClaimed(idempotencyKey(kase.id, 'retryNow', null))).toBe(false)
    expect(audit.unreconciled()).toEqual([])
  })

  it('lets the four unconfirmed tools straight through', async () => {
    const audit = new AuditLog(ledger)
    await audit.load()

    const [result] = await executeActions(
      [{ tool: 'escalate', input: { reason: 'test' }, result: '' }],
      ctxFor(audit),
    )

    expect(result?.ok).toBe(true)
    expect(result?.result).not.toContain('Held for confirmation')
    expect(audit.hasClaimed(idempotencyKey(kase.id, 'escalate', null))).toBe(true)
  })
})
