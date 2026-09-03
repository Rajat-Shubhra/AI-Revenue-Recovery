// Append-only audit log (BLUEPRINT §4.9) and the idempotency guard that
// replaces Quark's `resolveRun` double-resolve check.
//
// In Quark the guard was one line of Supabase: re-read the run, refuse it if
// `status !== 'awaiting_confirmation'`. The database made it atomic for free.
// Here there is no database, so the JSONL file is the ledger and the guard has
// to be written out longhand.
//
// Why this is not a nicety: a crash-and-restart mid-batch, or simply running
// the CLI twice, replays every action. In a payments agent a replay is a second
// charge against a real customer. That is the worst thing this system can do,
// so the guard is written to fail toward *not* charging.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { appendLineSafe } from './fs-safe'
import type { Classification, ToolName } from './schema'

/**
 * The identity of an action, per BLUEPRINT §7: case_id + tool + scheduled_for.
 *
 * `scheduled_for` is part of the key on purpose. Two retries of the same case
 * on two different dates are two legitimate actions; the same retry booked
 * twice for the same date is a replay. Immediate actions collapse to the
 * literal 'immediate' so that retryNow can never be issued twice for a case.
 */
export function idempotencyKey(
  caseId: string,
  tool: string,
  scheduledFor?: string | null,
): string {
  return `${caseId}|${tool}|${scheduledFor ?? 'immediate'}`
}

export function hashInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16)
}

export type RejectedAlternative = { tool: string; because: string }

export type AuditEntry = {
  ts: string
  case_id: string
  stage: 'ingest' | 'prioritise' | 'diagnose' | 'decide' | 'compliance' | 'stop' | 'act'
  input_hash?: string
  /** Which arm of the measurement this case is in (§4.10). */
  arm?: 'treated' | 'holdout'
  /** Prioritise stage: the score and the arithmetic behind it (§4.2). */
  priority?: number
  why?: string
  rules_fired?: string[]
  llm?: { used: boolean; model?: string; confidence?: number }
  /** Diagnose stage: the cause established, from rules or the model (§4.3). */
  cause?: string
  decision?: Classification | 'STOP' | 'HOLD'
  tool?: ToolName | string
  /** Why a case was stopped, held, or escalated. */
  because?: string
  rejected?: RejectedAlternative[]
  compliance?: { passed: boolean; checks: string[] }
  stop_check?: { stopped: boolean; because?: string }
  /** Act stage only. */
  idempotency_key?: string
  /**
   * Act stage only.
   * - `intent`     — written BEFORE the call. Claims the key.
   * - `executed`   — the call returned.
   * - `skipped_duplicate` — the key was already claimed; nothing was called.
   */
  act?: 'intent' | 'executed' | 'skipped_duplicate'
  ok?: boolean
  detail?: string
}

export class AuditLog {
  readonly file: string
  /**
   * Keys that have been *claimed* — an intent was written, whether or not the
   * result came back. Loaded from disk at construction so the guard survives a
   * restart, and updated in memory as we append so a batch doesn't re-read the
   * file 80 times.
   */
  private claimed = new Set<string>()
  private completed = new Set<string>()
  private loaded = false

  constructor(file: string) {
    this.file = file
  }

  /** Rebuild the guard's state from the ledger. Safe to call repeatedly. */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      // No ledger yet is the normal first-run case; anything else is real.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry: AuditEntry
      try {
        entry = JSON.parse(line) as AuditEntry
      } catch {
        // A torn last line means we crashed mid-write. Skip it rather than
        // refusing to start — but never treat it as a completed action.
        continue
      }
      if (entry.stage !== 'act' || !entry.idempotency_key) continue
      if (entry.act === 'intent') this.claimed.add(entry.idempotency_key)
      if (entry.act === 'executed') {
        this.claimed.add(entry.idempotency_key)
        this.completed.add(entry.idempotency_key)
      }
    }
    this.loaded = true
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('AuditLog.load() must be awaited before the guard is trusted')
    }
  }

  /**
   * Append one line. Goes through `appendLineSafe` because the antivirus on
   * this machine makes plain appends throw spuriously (WHAT_BROKE §11) — and a
   * dropped or duplicated audit line would misreport what the agent did with
   * someone's money, which is the one thing this file exists to prevent.
   */
  async append(entry: AuditEntry): Promise<void> {
    appendLineSafe(this.file, JSON.stringify(entry))
  }

  /** True once an action has been claimed — executed or merely attempted. */
  hasClaimed(key: string): boolean {
    this.assertLoaded()
    return this.claimed.has(key)
  }

  /**
   * Keys that were claimed but whose result never landed: we crashed between
   * calling the rail and recording what it said. These must NOT be retried
   * automatically — we do not know whether the customer was charged. They are
   * for a human to reconcile against Razorpay.
   */
  unreconciled(): string[] {
    this.assertLoaded()
    return [...this.claimed].filter((key) => !this.completed.has(key))
  }

  /**
   * THE GUARD. The only path that is allowed to call the rail.
   *
   * Order matters and is the whole point: the intent is written and the key
   * claimed *before* `run()` is called. If we crash between the two, the key
   * stays claimed and the replay is refused — we would rather leave money
   * uncollected and flag it for reconciliation than charge twice. Writing the
   * record after the call instead would invert that, and a crash in the gap
   * would double-charge.
   */
  async executeOnce<T extends { ok: boolean; detail: string }>(
    args: { caseId: string; tool: string; scheduledFor?: string | null },
    run: () => Promise<T>,
  ): Promise<{ status: 'executed'; outcome: T } | { status: 'skipped_duplicate'; key: string }> {
    this.assertLoaded()
    const key = idempotencyKey(args.caseId, args.tool, args.scheduledFor)

    if (this.claimed.has(key)) {
      await this.append({
        ts: new Date().toISOString(),
        case_id: args.caseId,
        stage: 'act',
        tool: args.tool,
        idempotency_key: key,
        act: 'skipped_duplicate',
        ok: true,
        detail: 'already in the audit log — not sent to the rail a second time',
      })
      return { status: 'skipped_duplicate', key }
    }

    this.claimed.add(key)
    await this.append({
      ts: new Date().toISOString(),
      case_id: args.caseId,
      stage: 'act',
      tool: args.tool,
      idempotency_key: key,
      act: 'intent',
    })

    const outcome = await run()

    this.completed.add(key)
    await this.append({
      ts: new Date().toISOString(),
      case_id: args.caseId,
      stage: 'act',
      tool: args.tool,
      idempotency_key: key,
      act: 'executed',
      ok: outcome.ok,
      detail: outcome.detail,
    })

    return { status: 'executed', outcome }
  }
}
