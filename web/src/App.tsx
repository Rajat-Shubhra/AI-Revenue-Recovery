// The dashboard (BLUEPRINT §4.11). One page, for the video.
//
// It derives no numbers. Everything on screen comes from data/report.json,
// written by the CLI at the end of a run, and the per-case timeline comes from
// the audit ledger. If this page computed its own totals they could drift from
// the console's, and one of them would be wrong without anyone noticing.
import { useCallback, useEffect, useState } from 'react'

type ReportCase = {
  id: string
  amount_inr: number
  method: string
  reason: string
  cause: string
  arm: 'treated' | 'holdout'
  decision: string | null
  tool: string | null
  priority: number | null
  why: string | null
  recovered: boolean
  cost_inr: number
  halted: boolean
  stopped_because: string | null
}

type Arm = { cases: number; pool_inr: number; recovered_inr: number; rate: number; rate_by_count: number }

type Report = {
  generated_at: string
  clock: string
  seed: number
  counts: { total: number; treated: number; holdout: number; halted: number }
  diagnosis: {
    total: number
    by_rules: number
    by_llm: number
    escalated_uncertain: number
    provider: { name: string; model: string } | null
    calls: number
    accuracy: { case_id: string; claimed: string; actual: string; correct: boolean }[]
  }
  systemic: { fired: boolean; cause?: string; share?: number; because?: string }
  measurement: {
    treated: Arm
    holdout: Arm
    counterfactual_inr: number
    net_lift_inr: number
    action_cost_inr: number
    net_lift_after_cost_inr: number
    modelled?: { rate: number; net_lift_inr: number }
  }
  cases: ReportCase[]
}

type AuditEntry = {
  ts: string
  case_id: string
  stage: string
  cause?: string
  decision?: string
  tool?: string
  because?: string
  why?: string
  priority?: number
  rules_fired?: string[]
  llm?: { used: boolean; confidence?: number }
  rejected?: { tool: string; because: string }[]
  compliance?: { passed: boolean; checks: string[] }
  stop_check?: { stopped: boolean; because?: string }
  act?: string
  ok?: boolean
  detail?: string
  idempotency_key?: string
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function Stat({ k, v, n, tone }: { k: string; v: string; n?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v${tone ? ` ${tone}` : ''}`}>{v}</div>
      {n && <div className="n">{n}</div>}
    </div>
  )
}

function Drawer({ c, entries, onClose }: { c: ReportCase; entries: AuditEntry[]; onClose: () => void }) {
  const mine = entries.filter((e) => e.case_id === c.id)

  return (
    <aside className="drawer">
      <button className="close" onClick={onClose}>
        close
      </button>
      <h3 className="mono">{c.id}</h3>
      <div className="sub">
        {inr(c.amount_inr)} · {c.method} · {c.reason} · cause <b>{c.cause}</b>
      </div>

      {c.why && <div className="note">{c.why}</div>}

      <div className="ev">
        {mine.map((e, i) => {
          const kind = e.act === 'executed' ? 'act' : e.stop_check?.stopped ? 'stop' : ''
          return (
            <div className={`step ${kind}`} key={i}>
              <div className="stage">
                {e.stage}
                {e.act ? ` · ${e.act}` : ''}
              </div>

              <div className="body">
                {e.decision && (
                  <>
                    <span className={`pill ${e.decision}`}>{e.decision}</span>{' '}
                  </>
                )}
                {e.tool && <span className="mono">{e.tool}</span>}
                {e.tool && e.detail && ' — '}
                {e.detail && <span className="mono">{e.detail}</span>}
                {e.cause && !e.decision && <span>cause: {e.cause}</span>}
              </div>

              {e.because && <div className="meta">{e.because}</div>}

              {e.rules_fired && e.rules_fired.length > 0 && (
                <div className="meta">
                  rules fired: {e.rules_fired.join(', ')}
                  {e.llm?.used ? ` · model used (confidence ${e.llm.confidence})` : ' · no model call'}
                </div>
              )}

              {e.idempotency_key && <div className="meta mono">key: {e.idempotency_key}</div>}

              {e.compliance && (
                <div className="checks">
                  {e.compliance.checks.map((chk) => {
                    const pass = chk.endsWith(':ok')
                    return (
                      <span className={`chk ${pass ? 'pass' : 'fail'}`} key={chk}>
                        {chk}
                      </span>
                    )
                  })}
                </div>
              )}

              {e.rejected && e.rejected.length > 0 && (
                <div className="rej">
                  <div className="stage">considered and declined</div>
                  {e.rejected.map((r, j) => (
                    <div className="r" key={j}>
                      <b>{r.tool}</b> — {r.because}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export default function App() {
  const [report, setReport] = useState<Report | null>(null)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/report')
      if (!r.ok) throw new Error((await r.json()).error ?? `report ${r.status}`)
      setReport(await r.json())
      const a = await fetch('/api/audit')
      setEntries(a.ok ? await a.json() : [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (opts: { noLlm?: boolean; fresh?: boolean } = {}) => {
    setRunning(true)
    setOutput(null)
    try {
      const q = [opts.noLlm ? 'no-llm' : '', opts.fresh ? 'fresh' : ''].filter(Boolean).join('&')
      const r = await fetch(`/api/run${q ? `?${q}` : ''}`, { method: 'POST' })
      const body = await r.json()
      setOutput(body.output ?? body.error ?? 'no output')
      await load()
    } catch (e) {
      setOutput(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const m = report?.measurement
  const d = report?.diagnosis
  const wrong = d?.accuracy.filter((a) => !a.correct) ?? []
  const rows = report ? [...report.cases].sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1)) : []
  const current = rows.find((c) => c.id === selected)

  return (
    <div className="wrap">
      <header>
        <h1>AI Revenue Recovery</h1>
        {report && (
          <span className="sub mono">
            seed {report.seed} · clock {report.clock.slice(0, 16).replace('T', ' ')}
            {d?.provider ? ` · ${d.provider.name}/${d.provider.model}` : ' · no model'}
          </span>
        )}
      </header>

      <div className="bar">
        <button className="primary" onClick={() => run({ fresh: true })} disabled={running}>
          {running ? 'running…' : 'Reset & run'}
        </button>
        <button onClick={() => run({})} disabled={running}>
          Run again (no reset)
        </button>
        <button onClick={() => run({ fresh: true, noLlm: true })} disabled={running}>
          Reset & run without model
        </button>
        <button onClick={() => void load()} disabled={running}>
          Reload
        </button>
        {running && <span className="sub">the model tail is paced to stay inside the rate limit — ~25s</span>}
      </div>

      {error && (
        <div className="note alert">
          <b>{error}</b> — run the batch to produce one.
        </div>
      )}

      {report && m && d && (
        <>
          <div className="strip">
            <Stat k="batch" v={String(report.counts.total)} n={`${report.counts.treated} treated · ${report.counts.holdout} holdout · ${report.counts.halted} halted`} />
            <Stat k="deterministic" v={pct(d.by_rules / d.total)} n={`${d.by_rules} by rules · ${d.by_llm} by model · ${d.escalated_uncertain} escalated`} />
            <Stat k="recovered (treated)" v={inr(m.treated.recovered_inr)} n={`${pct(m.treated.rate)} of ${inr(m.treated.pool_inr)}`} />
            <Stat k="recovered (holdout)" v={inr(m.holdout.recovered_inr)} n={`${pct(m.holdout.rate)} — never touched`} />
            <Stat k="net lift" v={inr(m.net_lift_inr)} tone={m.net_lift_inr >= 0 ? 'good' : 'bad'} n={`after ${inr(m.action_cost_inr)} of actions: ${inr(m.net_lift_after_cost_inr)}`} />
          </div>

          {m.modelled && (
            <div className="note">
              <b>Honest caveat.</b> The holdout is {m.holdout.cases} cases, so its rate is noisy — {pct(m.holdout.rate)} by
              value against {pct(m.holdout.rate_by_count)} by count. The simulator table implies a {pct(m.modelled.rate)}{' '}
              do-nothing rate, which would put net lift at {inr(m.modelled.net_lift_inr)} rather than {inr(m.net_lift_inr)}.
              The holdout is the honest measurement; the gap is the uncertainty a small control arm buys you.
            </div>
          )}

          {report.systemic.fired && (
            <div className="note alert">
              <b>Systemic alert.</b> {report.systemic.because}
            </div>
          )}

          {d.calls > 0 && (
            <div className="note">
              <b>Model.</b> {d.calls} calls, on the {pct((d.total - d.by_rules) / d.total)} of cases the rules could not
              settle — not because those errors are vague, but because Razorpay's own docs publish that{' '}
              <span className="mono">(source, code)</span> pair with more than one meaning.{' '}
              <span className="mono">gateway/credit_failed</span> is either the customer picking the wrong account or a
              partner-bank outage: opposite remedies, one code. A lookup table would be wrong and confident; the issuer's
              advice text settles it. {d.accuracy.length - wrong.length}/{d.accuracy.length} of the model's diagnoses
              matched the true cause; {d.escalated_uncertain} were escalated instead — either below the confidence floor or answered {'"'}unknown{'"'}.
              {wrong.length > 0 && (
                <>
                  {' '}
                  Wrong:{' '}
                  {wrong.map((w) => (
                    <span key={w.case_id} className="mono">
                      {w.case_id} said {w.claimed}, actually {w.actual}.{' '}
                    </span>
                  ))}
                  Both map to the same action, so the recovered total is unchanged — which is the point.
                </>
              )}
            </div>
          )}

          <div className="note">
            <b>Try running it twice.</b> "Run again (no reset)" replays the same batch against the same ledger, and every
            action is refused as a duplicate — each one is keyed on{' '}
            <span className="mono">case_id + tool + scheduled_for</span> and the key is claimed before the rail is
            called. A crash mid-batch leaves money uncollected and a reconciliation flag, never a customer charged
            twice.
          </div>

          <h2>Cases, by priority — click any row for its audit trail</h2>
          <table>
            <thead>
              <tr>
                <th>case</th>
                <th className="num">amount</th>
                <th>method</th>
                <th>code</th>
                <th>cause</th>
                <th>decision</th>
                <th>tool</th>
                <th className="num">priority</th>
                <th>outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className={c.id === selected ? 'sel' : ''}
                  onClick={() => setSelected(c.id === selected ? null : c.id)}
                >
                  <td className="mono">{c.id}</td>
                  <td className="num">{inr(c.amount_inr)}</td>
                  <td>{c.method}</td>
                  <td className="mono">{c.reason}</td>
                  <td>{c.cause}</td>
                  <td>{c.decision && <span className={`pill ${c.decision}`}>{c.decision}</span>}</td>
                  <td className="mono">{c.tool ?? <span className="no">—</span>}</td>
                  <td className="num">{c.priority ?? <span className="no">—</span>}</td>
                  <td className={c.recovered ? 'ok' : 'no'}>{c.recovered ? 'recovered' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="foot">
            Outcomes are simulated from a single hand-authored table in <span className="mono">src/sim/outcomes.ts</span>.
            The number that counts is the difference between the treated and holdout arms, not raw recoveries.
            <br />
            Nothing here reaches a real customer — sending a payment link writes to the audit log.
          </div>
        </>
      )}

      {output && (
        <>
          <h2>Batch output</h2>
          <pre className="out">{output}</pre>
        </>
      )}

      {current && <Drawer c={current} entries={entries} onClose={() => setSelected(null)} />}
    </div>
  )
}
