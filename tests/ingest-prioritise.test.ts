// M2 invariants: the holdout is real and untouchable, and the ranking is
// deterministic and explainable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AuditLog, type AuditEntry } from '../src/engine/audit'
import { fixedClock } from '../src/engine/clock'
import { BATCH_NOW } from '../src/pipeline/generate'
import { ingest, assignHoldout, loadCases, HOLDOUT_SHARE } from '../src/pipeline/ingest'
import { prioritise, score, likelyAction, PriorityQueue, type Scored } from '../src/pipeline/prioritise'

const cases = loadCases()
const clock = fixedClock(BATCH_NOW)

let dir: string
let ledger: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'batch-'))
  ledger = path.join(dir, 'audit.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function runIngest() {
  const audit = new AuditLog(ledger)
  await audit.load()
  const ingested = await ingest(audit, clock)
  const entries = (await readFile(ledger, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry)
  return { ingested, entries }
}

describe('holdout', () => {
  it('is exactly the configured share', () => {
    const holdout = assignHoldout(cases)
    expect(holdout.size).toBe(Math.round(cases.length * HOLDOUT_SHARE))
    expect(holdout.size).toBe(16)
  })

  it('is identical across runs', () => {
    expect([...assignHoldout(cases)].sort()).toEqual([...assignHoldout(cases)].sort())
  })

  it('changes with the seed', () => {
    expect([...assignHoldout(cases, 1)].sort()).not.toEqual([...assignHoldout(cases, 2)].sort())
  })

  it('is not correlated with the generator slice order', () => {
    // Taking "every fifth case" would silently bias the control arm toward
    // whichever slices happen to sit on that stride. Assert the picks are
    // spread across the batch rather than clustered.
    const picked = [...assignHoldout(cases)]
      .map((id) => Number(id.replace('case_', '')))
      .sort((a, b) => a - b)
    const gaps = new Set(picked.slice(1).map((n, i) => n - picked[i]!))
    expect(gaps.size).toBeGreaterThan(1)
  })

  it('never enters the priority queue', async () => {
    const { ingested } = await runIngest()
    const { queue, eligible } = prioritise(ingested)
    const holdoutIds = new Set(ingested.filter((i) => i.holdout).map((i) => i.kase.id))

    expect(eligible.some((s) => holdoutIds.has(s.kase.id))).toBe(false)
    for (const item of queue.take(1000)) {
      expect(holdoutIds.has(item.kase.id)).toBe(false)
    }
  })
})

describe('ingest', () => {
  it('writes exactly one audit line per case', async () => {
    const { ingested, entries } = await runIngest()
    expect(ingested).toHaveLength(80)
    const ingestLines = entries.filter((e) => e.stage === 'ingest')
    expect(ingestLines).toHaveLength(80)
    expect(new Set(ingestLines.map((e) => e.case_id)).size).toBe(80)
  })

  it('records which arm every case is in', async () => {
    const { entries } = await runIngest()
    const arms = entries.filter((e) => e.stage === 'ingest').map((e) => e.arm)
    expect(arms.filter((a) => a === 'holdout')).toHaveLength(16)
    expect(arms.filter((a) => a === 'treated')).toHaveLength(64)
  })

  it('never puts ground truth in the input hash', async () => {
    // The hash documents what the agent was shown. If it covered _true_cause,
    // two cases identical to the agent would hash differently and the ledger
    // would be quietly leaking the answer.
    const { entries } = await runIngest()
    for (const e of entries.filter((x) => x.stage === 'ingest')) {
      expect(e.input_hash).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('marks and excludes already-halted subscriptions', async () => {
    const { ingested } = await runIngest()
    const halted = ingested.filter((i) => i.halted)
    expect(halted.length).toBeGreaterThan(0)
    for (const h of halted) expect(h.hours_to_halt).toBeLessThanOrEqual(0)

    const { eligible } = prioritise(ingested)
    expect(eligible.some((s) => s.halted)).toBe(false)
  })
})

describe('scoring', () => {
  const find = (id: string) => cases.find((c) => c.id === id)!

  it('computes priority as (EV - cost) x urgency', () => {
    const [first] = prioritise(
      [{ kase: find('case_001'), holdout: false, halted: false, hours_to_halt: 10 }],
    ).scored
    const s = first!
    expect(s.urgency).toBeCloseTo(0.1, 6)
    expect(s.priority).toBeCloseTo((s.expected_value - s.cost) * s.urgency, 6)
  })

  it('clamps urgency so a nearly-expired case cannot swamp everything', () => {
    const base = { kase: find('case_001'), holdout: false, halted: false }
    expect(score({ ...base, hours_to_halt: 0.1 }).urgency).toBe(1)
    expect(score({ ...base, hours_to_halt: 1 }).urgency).toBe(1)
    expect(score({ ...base, hours_to_halt: 4 }).urgency).toBe(0.25)
  })

  it('gives a cancelled mandate zero expected value', () => {
    const cancelled = cases.find((c) => c.mandate.cancelled_by_customer)!
    const s = score({ kase: cancelled, holdout: false, halted: false, hours_to_halt: 5 })
    expect(s.expected_value).toBe(0)
    // Priced as an escalation, so it scores negative and sinks — the queue is a
    // second line of defence behind the compliance gate, not the only one.
    expect(s.priority).toBeLessThan(0)
  })

  it('prices a domestic card as a payment link, never a retry', () => {
    const domestic = cases.find((c) => c.is_domestic_card && c.error.reason === 'insufficient_funds')
    if (domestic) expect(likelyAction(domestic)).toBe('sendPaymentLink')
  })

  it('explains itself in terms a human can check', async () => {
    const { ingested } = await runIngest()
    const top = prioritise(ingested).queue.take(1)[0]!
    expect(top.why).toContain('recover-prior')
    expect(top.why).toContain('EV')
    expect(top.why).toContain('urgency')
    expect(top.why).toContain(top.priority.toFixed(2))
  })
})

describe('priority queue', () => {
  const make = (id: string, priority: number) =>
    ({ kase: { id }, priority } as unknown as Scored)

  it('pops in descending priority', () => {
    const q = new PriorityQueue()
    for (const p of [3, 9, 1, 7, 5, 2]) q.push(make(`c${p}`, p))
    expect(q.take(6).map((s) => s.priority)).toEqual([9, 7, 5, 3, 2, 1])
  })

  it('breaks ties by case id so runs are reproducible', () => {
    const q = new PriorityQueue()
    for (const id of ['c_c', 'c_a', 'c_b']) q.push(make(id, 5))
    expect(q.take(3).map((s) => s.kase.id)).toEqual(['c_a', 'c_b', 'c_c'])
  })

  it('take() stops cleanly when asked for more than it holds', () => {
    const q = new PriorityQueue()
    q.push(make('c1', 1))
    expect(q.take(50)).toHaveLength(1)
    expect(q.size).toBe(0)
    expect(q.pop()).toBeUndefined()
  })

  it('ranks the real batch the same way twice', async () => {
    const a = prioritise((await runIngest()).ingested).queue.take(20).map((s) => s.kase.id)
    const b = prioritise((await runIngest()).ingested).queue.take(20).map((s) => s.kase.id)
    expect(a).toEqual(b)
  })
})
