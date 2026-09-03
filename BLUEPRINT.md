# Failed-Subscription Recovery Agent — build spec

Working document. Build material only: what to build, how each stage behaves,
and the order to build it in. Submission material (video script, form details)
lives elsewhere when it matters.

**The bar, verbatim from Razorpay:** don't just identify the problem — show
measured money recovered across a batch, with compliant escalation, stopping
rules, and an audit trail.

**Judged on:** Problem Taste · Build Quality · AI Judgment (deterministic where
AI is unnecessary) · Failure Recovery (what broke, how it was fixed).

---

## 1. Scope

**In:** failed subscription recovery only (cards + UPI Autopay + eMandate). A
seeded synthetic batch of ~80 cases. The full loop: ingest → prioritise →
diagnose → decide → compliance → stop → act → measure → audit. A mock Razorpay
adapter. One dashboard page.

**Out, and not promised as "coming soon":** auth, multi-tenant, any database,
voice, checkout drop-off, B2B receivables, real SMS/email sending, deployment.

**Why this domain:** the constraints are real and documented, not invented.
Manual charge is unsupported on domestic cards. A UPI mandate paused by the
customer can only be resumed by the customer. A debit above the mandate's
`max_amount` fails. RBI requires a pre-debit notice 24h ahead. Those give the
agent genuine compliant-escalation and stopping behaviour to demonstrate.

---

## 2. Architecture

```
 cases.seed.json
        │
        ▼
 ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
 │  INGEST     │───▶│  PRIORITISE  │───▶│  DIAGNOSE   │
 │ events→Case │    │ EV × urgency │    │ rules first │
 └─────────────┘    │ queue, top N │    │ LLM on tail │
                    └──────────────┘    └──────┬──────┘
                                               ▼
                    ┌──────────────┐    ┌─────────────┐
                    │  COMPLIANCE  │◀───│   DECIDE    │  ◀── Quark classifier
                    │  gate        │    │ AUTO /      │      (carried over)
                    └──────┬───────┘    │ CUSTOMER_   │
                           │            │ ACTION /    │
                           ▼            │ ESCALATE    │
                    ┌──────────────┐    └─────────────┘
                    │  STOPPING    │
                    │  rules       │
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐    ┌─────────────┐
                    │  ACT         │───▶│  OUTCOME    │
                    │ 5 tools via  │    │  simulator  │
                    │ RazorpayPort │    └──────┬──────┘
                    └──────────────┘           │
                                               ▼
                    ┌──────────────┐    ┌─────────────┐
                    │  AUDIT LOG   │◀───│  MEASURE    │
                    │ append-only  │    │ treated vs  │
                    │ JSONL        │    │ holdout     │
                    └──────────────┘    └─────────────┘
```

Every stage writes to the audit log. Nothing reaches ACT without passing
COMPLIANCE and STOPPING, and nothing calls the rail except through the
idempotency guard.

### Stack
- **Runtime:** Node + TypeScript, strict. Single package, `web` as a workspace.
- **LLM:** Gemini, via the client carried from Quark. Structured JSON output,
  schema-validated before it can drive any money action.
- **Storage:** JSON files in `/data` plus append-only `audit.jsonl`. No database.
  A committed JSONL file is readable in the GitHub diff without running anything.
- **UI:** React + Vite 8.2.2 + plugin-react 6.1.x. `npm run dev` works;
  `npx vite` is broken on this machine and is not expected to work. See
  WHAT_BROKE.md. Do not "fix" this by downgrading.
- **Tests:** Vitest, run via `node node_modules/vitest/vitest.mjs` — the npm
  `.bin` shim is broken here for ESM binaries.

### LLM budget and quota
Roughly **12 diagnose calls plus 3–5 decide calls per 80-case batch**. Everything
else is deterministic. That ratio is the AI Judgment criterion made countable —
it goes on the dashboard and in the video.

Calls are **live every run**; there is no response cache. The Gemini free tier is
~20 requests/day, so a batch is roughly one run per day per key. Rotate the key
when it runs out. **Every run that spends quota must be reported before it is
run, and a quota failure must degrade to ESCALATE, never crash the batch.**

---

## 3. Data model

```ts
type Case = {
  id: string
  subscription_id: string
  customer: { id: string; phone_masked: string; dnd: boolean; opted_out: boolean }
  amount_inr: number
  method: 'card' | 'upi' | 'emandate'
  is_domestic_card: boolean          // manual charge unsupported
  mandate: { max_amount_inr: number; cancelled_by_customer: boolean; paused_by_customer: boolean }
  error: {
    source: 'customer' | 'business' | 'internal' | 'gateway' | 'issuer_bank'
    step: string; reason: string; description: string
  }
  failed_at: string                  // ISO
  attempts: number                   // prior retries already made
  halts_at: string                   // when Razorpay moves it to halted
  late_auth_pending: boolean         // may self-heal — do NOT act yet

  _true_cause: string                // simulator ground truth, hidden from the agent
  _will_self_heal: boolean
}
```

### Synthetic distribution (~80 cases, seeded and reproducible)

| Slice | Share | Purpose |
|---|---|---|
| insufficient_funds, salary-cycle timing | 30% | AUTO → retryScheduled; shows sequencer logic |
| card_expired / bank_blocked_card | 20% | CUSTOMER_ACTION → sendPaymentLink |
| issuer / gateway downtime | 15% | AUTO → switchRail or retry after downtime |
| mandate cancelled_by_customer | 10% | **STOP** — any contact is a violation |
| late_auth_pending (self-heals) | 5% | **HOLD** — acting here double-charges |
| charge > mandate.max_amount | 5% | ESCALATE — merchant config, not the customer's fault |
| customer dnd / opted_out | 5% | compliance gate blocks contact |
| unknown / ambiguous reason | 10% | the LLM tail — where AI Judgment is demonstrated |

---

## 4. Stage specs

### 4.1 Ingest
Read `data/cases.seed.json`. Assign 20% to `holdout` using the same seed. Write
one audit line per case. `_true_cause` and `_will_self_heal` are never passed to
the agent or into any prompt.

### 4.2 Prioritise
```
expected_value = amount_inr × P(recover | error.reason, method)   // lookup table
urgency        = 1 / max(hours_until(halts_at), 1)
cost           = action_cost[likely_action]   // link+SMS ≈ ₹2, retry ≈ ₹0, escalate ≈ ₹50
priority       = (expected_value − cost) × urgency
```
Max-heap, pop top N (N=20) per tick. **Log the priority and why it ranked there** —
judges will ask "why this one first".

### 4.3 Diagnose — deterministic first
`rules.ts`: a table from `(source, reason)` → `cause`, covering every reason in
the synthetic set except the ambiguous slice.

Only cases with no rule hit go to the LLM. The prompt gets the error object,
method, attempts, mandate state, and the closed list of allowed causes. Output:
`{ cause, confidence: 0..1, evidence: string[] }`. **Confidence below 0.7 is
rejected and escalated.** Already implemented in `schema.ts`.

Dashboard line: *"80 cases · 68 by rules · 12 via LLM · 3 LLM-uncertain →
escalated."*

### 4.4 Decide — lookup first, classifier only on the tail

Once the cause is known the bucket is forced by the domain, so this is a table:

| cause | outcome | tool |
|---|---|---|
| insufficient_funds | AUTO | retryScheduled (next salary-cycle date) |
| issuer_downtime / gateway_downtime | AUTO | retryScheduled after downtime, or switchRail |
| card_expired / bank_blocked_card | CUSTOMER_ACTION | sendPaymentLink |
| domestic card, any retry-shaped fix | CUSTOMER_ACTION | sendPaymentLink |
| upi_mandate_paused_by_customer | CUSTOMER_ACTION | sendPaymentLink |
| amount_exceeds_mandate_max | ESCALATE | escalate (merchant config) |
| mandate_cancelled_by_customer | **STOP** | none — never contacted |
| late_auth_pending | **HOLD** | none until the hold window expires |

**STOP and HOLD are decided in code, before the model is ever called.** They are
pure fact-checks on the case, not judgement, and the model must never get the
chance to talk itself out of either. The classifier enum stays three values:
`AUTO | CUSTOMER_ACTION | ESCALATE`.

The **classifier runs only** on cases diagnose could not resolve confidently —
the ~10% ambiguous slice. Output: bucket + proposed tool + params, schema
validated. Validation failure → ESCALATE, never a silent retry.

### 4.5 Compliance gate — runs before every action
All deterministic, all logged when they fire:
- `mandate.cancelled_by_customer` → no retry, no contact. Full stop.
- `customer.opted_out` or `customer.dnd` → no contact (retry still allowed if AUTO).
- Contact only 09:00–21:00 IST (simulated clock; log the deferral).
- Retry requires a pre-debit notification ≥ 24h before the retry date. Schedule and log it.
- `is_domestic_card && tool == retryNow` → unsupported. Reroute to CUSTOMER_ACTION.
- `amount > mandate.max_amount` → never retry. ESCALATE as merchant config.

### 4.6 Stopping rules — `config/stopping.json`, not buried in code
```json
{
  "max_attempts_per_case": 3,
  "hold_if_late_auth_pending_hours": 72,
  "drop_if_expected_value_below_inr": 20,
  "systemic_alert_if_same_cause_share_exceeds": 0.4,
  "stop_on": ["mandate_cancelled", "customer_opted_out", "recovered", "halted"]
}
```
**Systemic rule:** if >40% of a batch shares one cause (one issuer down), stop
per-case action and raise ONE escalation. This is the "knows when something
bigger is wrong" moment.

### 4.7 Act — five tools, one port
```ts
interface RazorpayPort {
  retryNow(caseId): Promise<Outcome>
  retryScheduled(caseId, atISO): Promise<Outcome>
  switchRail(caseId, to: 'upi' | 'emandate'): Promise<Outcome>
  sendPaymentLink(caseId, channel: 'sms' | 'email'): Promise<Outcome>
  escalate(caseId, reason: string): Promise<Outcome>
}
```
`MockRazorpayPort` runs against the simulator. `TestModeRazorpayPort` is a
stretch goal — if built, wire only `sendPaymentLink` to the real test-mode
Payment Links API and say so. Do not fake it.

Every call goes through `AuditLog.executeOnce` (§4.9). There is no other path.

### 4.8 Outcome simulator
`(action, _true_cause, _will_self_heal)` → success probability → sampled
outcome, from a single table so it is auditable and obviously not cheating.
**State in the video that outcomes are simulated and how.**

### 4.9 Audit trail + idempotency — append-only JSONL, one line per event
```json
{"ts":"...","case_id":"...","stage":"decide","input_hash":"...","rules_fired":["R7"],
 "llm":{"used":false},"decision":"CUSTOMER_ACTION","tool":"sendPaymentLink",
 "rejected":[{"tool":"retryNow","because":"domestic card — manual charge unsupported"}],
 "compliance":{"passed":true,"checks":["not_dnd","contact_hours_ok"]},
 "stop_check":{"stopped":false}}
```
The `rejected` array is the most persuasive field shipped — it proves the agent
considered alternatives and declined them, with the real reason.

**Idempotency (implemented, `src/engine/audit.ts`).** Every action is keyed on
`case_id + tool + scheduled_for`. The intent line is written and the key claimed
**before** the rail is called, so a crash in the gap refuses the replay and
raises a reconciliation flag rather than charging twice.

### 4.10 Measure — the holdout
20% of cases are never touched. Run the simulator on both arms and report:
recovered ₹ treated vs holdout · **net lift** = treated − holdout-rate ×
treated-pool-size · cost of actions taken · recovery rate by cause and bucket.

Without the holdout you are counting the payments that would have self-healed.

### 4.11 Dashboard — one page
Top strip: batch size · rules vs LLM split · ₹ recovered treated vs holdout ·
net lift · action cost. Table: cases by priority — amount, method, cause,
decision, tool, status. Drawer: click a case → its audit trail as a timeline.
A "Run batch" button. That's it.

---

## 5. Repo layout

```
/README.md            what it is, how to run, what came from Quark, limitations
/WHAT_BROKE.md        failure-recovery log (judged criterion)
/BLUEPRINT.md         this file
/config/stopping.json
/data/cases.seed.json
/data/audit.jsonl     one sample run committed
/src/engine/          carried from Quark: prompt, schema, gate, provider, audit
/src/pipeline/        ingest, prioritise, rules, diagnose, decide, compliance, stop, act, measure
/src/ports/           RazorpayPort, MockRazorpayPort, TestModeRazorpayPort (stub)
/src/sim/             outcome simulator
/src/cli.ts           run batch → prints report
/web/                 dashboard
/tests/               the invariants below
```

### Tests — not optional
These are the compliance and stopping rules stated as executable claims:
1. No action is ever taken on a cancelled mandate.
2. No contact is ever made to a DND or opted-out customer.
3. Holdout cases are never touched.
4. **Re-running the same batch produces zero new actions.** (Implemented.)

---

## 6. Milestones

**[MILESTONES.md](MILESTONES.md) is the working state file** — it holds Status,
Notes, the running log, the STOP triggers and the batch seams, and it is what a
fresh session reads to resume. This table is the summary; that file is the truth.

| # | Milestone | Blueprint |
|---|---|---|
| **M0** | Starting line — engine, provenance, README | ✅ done |
| M1 | Synthetic generator | §3 |
| M2 | Ingest + prioritiser | §4.1–4.2 |
| M3 | Rules table + diagnose | §4.3 |
| M4 | Decide | §4.4 |
| M5 | Compliance gate | §4.5 |
| M6 | Stopping rules | §4.6 |
| M7 | Ports + outcome simulator | §4.7–4.8 |
| M8 | Measurement + holdout — **substance finish line** | §4.10 |
| M9 | End-to-end hardening | §4.9 |
| M10 | Dashboard | §4.11 |

Batches: **M0–M2**, **M3–M5**, **M6–M8**, **M9–M10** — separate sessions, with a
look at the running log between each.

---

## 7. Honest limitations — to state plainly in the README and the video

- Outcomes are simulated; the real Razorpay test-mode port is stubbed or partial.
- Recovery probabilities are a hand-authored table, not learned.
- One direction only. The pipeline shape generalises; nothing else is built.
- No real contact channels — "send" writes to the audit log.

Writing these down is worth more than hiding them. One cherry-picked match
proves nothing.
