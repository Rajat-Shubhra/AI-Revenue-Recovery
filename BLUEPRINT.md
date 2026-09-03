# Track 3 — Failed-Subscription Recovery Agent
## Two-day build blueprint

**Deadline:** verify on the application form. Third-party listings say 5 Sept 2026. Assume end of day Sat 5 Sept and aim to submit Sat afternoon.

**The bar (verbatim from Razorpay):** Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail.

**Judging criteria:** Problem Taste · Build Quality · AI Judgment (deterministic where AI is unnecessary) · Failure Recovery (what broke, how you fixed it).

Everything below is scoped to hit those five clauses and four criteria, and nothing else.

---

## 0. Scope lock — read before touching code

**In:**
- One direction only: **failed-subscription recovery** (cards + UPI Autopay + eMandate).
- Synthetic batch of 60–100 subscription-failure cases.
- Full loop: ingest → prioritise → diagnose → decide → act → measure → audit.
- Mock Razorpay adapter. Real test-mode adapter only if ahead of schedule (stretch).
- One-page dashboard for the video.

**Out (do not build, do not mention as "coming soon"):**
- Auth, multi-tenant, database (JSON files are fine), Hinglish voice, checkout drop-off, B2B receivables, promise-to-pay, real SMS/email sending, deployment.

**Why this direction:** states are documented (`active → pending → halted`), webhooks are named, and the domain has real constraints that force interesting agent behaviour — manual charge on domestic cards is not supported, UPI mandates paused by the customer can only be resumed by the customer, and a debit above the mandate `max_amount` fails. Those constraints give you compliant escalation and stopping rules that are *real*, not invented.

---

## 1. Architecture

```
 synthetic-events.json
        │
        ▼
 ┌─────────────┐    ┌──────────────┐    ┌─────────────┐
 │  INGEST     │───▶│  PRIORITISE  │───▶│  DIAGNOSE   │
 │ events→Case │    │ EV × urgency │    │ rules first │
 └─────────────┘    │ priority     │    │ LLM on tail │
                    │ queue, top N │    └──────┬──────┘
                    └──────────────┘           │
                                               ▼
                    ┌──────────────┐    ┌─────────────┐
                    │  COMPLIANCE  │◀───│   DECIDE    │  ◀── Quark classifier
                    │  gate        │    │ CAN_DO /    │      (carried over)
                    └──────┬───────┘    │ PARTIAL /   │
                           │            │ HUMAN_ONLY  │
                           ▼            └─────────────┘
                    ┌──────────────┐
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

Every stage writes to the audit log. Nothing reaches ACT without passing COMPLIANCE and STOPPING.

### Stack
- **Runtime:** Node + TypeScript. Single package, no monorepo.
- **LLM:** whichever provider you already have working (Gemini, Groq, whatever). Must support structured JSON output; every response is schema-validated before it can drive a money action.
- **Storage:** JSON files in `/data` plus append-only `audit.jsonl`. **No database.** A committed JSONL file is readable in the GitHub diff without running anything — that is worth more to a reviewer than a hosted DB, and costs zero setup.
- **UI:** React + **Vite 8.2.2 + plugin-react 6.1.x**, Quark's real versions, verified serving in this repo. `npx vite` is broken on this machine (npm `.bin` shim); the dev server runs via the Vite JS API in `web/dev.mjs`. `npm run dev` works, `npx vite` does not — do not "fix" this by downgrading.
- **Tests:** Vitest. **No eval harness exists in Quark** — the batch runner is written fresh (§4 pipeline + §7 `/tests/`).

---

## 2. What to carry from Quark (and only this)

| Take | Why |
|---|---|
| Classifier prompt + `CAN_DO / PARTIAL / HUMAN_ONLY` schema | It is the decide step, unchanged in shape |
| JSON contract validation (zod or whatever you used) | Every LLM output must be validated before it drives money |
| Confirmation gate logic for irreversible actions | Becomes the ESCALATE path — extracted from `runner.ts` into `gate.ts` |
| `resolveRun`'s double-resolve guard | **Idempotency.** Was Supabase-coupled; must be reimplemented against `audit.jsonl`. Without it a replay double-charges. |
| `provider.ts` (Gemini client) | LLM plumbing you already debugged |
| `web/` toolchain at Quark's real versions (Vite 8.2.2, plugin-react 6.1.x) plus `dev.mjs`, `build.mjs`, `vite.config.mjs` | The workarounds are the value; without them the dev server does not serve |

There is **no eval harness** in Quark and never was — the batch runner is new code.

Leave behind: notes, kanban, BlockNote, workspace UI, everything else.

**Rename the buckets for this domain** so the video reads naturally:
- `CAN_DO` → `AUTO` (agent acts silently)
- `PARTIAL` → `CUSTOMER_ACTION` (agent contacts customer; only they can fix it)
- `HUMAN_ONLY` → `ESCALATE` (ops human decides)

---

## 3. Data model

### Case
```ts
type Case = {
  id: string;
  subscription_id: string;
  customer: { id: string; phone_masked: string; dnd: boolean; opted_out: boolean };
  amount_inr: number;
  method: "card" | "upi" | "emandate";
  is_domestic_card: boolean;          // matters: manual charge unsupported
  mandate: { max_amount_inr: number; cancelled_by_customer: boolean; paused_by_customer: boolean };
  error: { source: "customer"|"business"|"internal"|"gateway"|"issuer_bank"; step: string; reason: string; description: string };
  failed_at: string;                  // ISO
  attempts: number;                   // prior retries already made
  halts_at: string;                   // deadline: when Razorpay moves it to halted
  late_auth_pending: boolean;         // true = might self-heal, do NOT act yet
  // ground truth for simulator only — hidden from agent
  _true_cause: string;
  _will_self_heal: boolean;
};
```

### Synthetic distribution (aim ~80 cases)
| Slice | Share | Purpose |
|---|---|---|
| insufficient_funds, salary-cycle timing | 30% | AUTO → retry_scheduled; shows sequencer logic |
| card_expired / bank_blocked_card | 20% | CUSTOMER_ACTION → send_payment_link |
| issuer_bank / gateway downtime | 15% | AUTO → switch_rail or retry_now after downtime resolves |
| mandate cancelled_by_customer | 10% | **STOP** — any contact is a violation |
| late_auth_pending (self-heals) | 5% | **HOLD** — acting here double-charges; shows discipline |
| charge > mandate.max_amount | 5% | ESCALATE — merchant config problem, not customer's |
| customer dnd / opted_out | 5% | compliance gate blocks contact |
| unknown / ambiguous reason | 10% | the LLM tail — where AI Judgment gets demonstrated |

Write the generator with a seed so the batch is reproducible in the video.

---

## 4. Stage specs

### 4.1 Prioritise
```
expected_value = amount_inr × P(recover | error.reason, method)   // small lookup table
urgency        = 1 / max(hours_until(halts_at), 1)
cost           = action_cost[likely_action]                          // link+SMS ≈ ₹2, retry ≈ ₹0, escalate ≈ ₹50 (human minutes)
priority       = (expected_value − cost) × urgency
```
Max-heap. Pop top N (N=20) per batch tick. **Log the priority and the reason it ranked there** — judges will ask "why this one first".

### 4.2 Diagnose — deterministic first
`rules.ts`: a table from `(source, reason)` → `cause`. Cover every reason in the synthetic set except the "unknown/ambiguous" slice.

Only cases with no rule hit go to the LLM. LLM prompt gets: the error object, method, attempts, mandate state, and **the list of allowed causes**. Output schema: `{ cause, confidence: 0..1, evidence: string[] }`. Reject and escalate if confidence < 0.7.

**Dashboard stat to surface:** "80 cases · 68 resolved by rules · 12 via LLM · 3 LLM-uncertain → escalated." This one line is your AI Judgment score.

### 4.3 Decide — lookup first, classifier only on the uncertain tail
Once `cause` is known, the bucket is mostly forced by the domain, so this is a table, not a model call:

| cause | bucket | tool |
|---|---|---|
| insufficient_funds | AUTO | retryScheduled (next salary-cycle date) |
| issuer_downtime / gateway_downtime | AUTO | retryScheduled after downtime resolves, or switchRail |
| card_expired / bank_blocked_card | CUSTOMER_ACTION | sendPaymentLink |
| domestic card, any retry-shaped fix | CUSTOMER_ACTION | sendPaymentLink (manual charge unsupported) |
| mandate_cancelled_by_customer | STOP | none — never contacted |
| upi_mandate_paused_by_customer | CUSTOMER_ACTION | sendPaymentLink (merchant cannot resume) |
| amount > mandate.max_amount | ESCALATE | escalate (merchant config, not the customer's problem) |
| late_auth_pending | HOLD | none until the hold window expires |

The **Quark classifier runs only** on cases the diagnose stage could not resolve confidently — the ~10% ambiguous slice. Input: `cause` (or "unknown") + case. Output: bucket + proposed tool + params, JSON-schema validated. Validation failure → ESCALATE, never retry the LLM silently.

**LLM call budget for an 80-case batch: roughly 12 diagnose calls plus 3–5 decide calls. Everything else is deterministic.** That ratio is the AI Judgment criterion, made countable — put the number on the dashboard and say it in the video.

### 4.4 Compliance gate — runs before every action
Hard rules, all deterministic, all logged when they fire:
- `mandate.cancelled_by_customer` → no retry, no contact. Full stop.
- `customer.opted_out` or `customer.dnd` → no contact (retry still allowed if AUTO).
- Contact only between 09:00–21:00 IST (simulate a clock; log the deferral).
- Retry requires a pre-debit notification ≥ 24h before the retry date (RBI). Schedule it; log it.
- `is_domestic_card && tool == retry_now` → not supported. Reroute to CUSTOMER_ACTION.
- `amount > mandate.max_amount` → never retry; ESCALATE as merchant config.

### 4.5 Stopping rules — explicit config file, not buried in code
```json
{
  "max_attempts_per_case": 3,
  "hold_if_late_auth_pending_hours": 72,
  "drop_if_expected_value_below_inr": 20,
  "systemic_alert_if_same_cause_share_exceeds": 0.4,
  "stop_on": ["mandate_cancelled", "customer_opted_out", "recovered", "halted"]
}
```
Systemic rule: if >40% of a batch shares one cause (e.g. one issuer down), stop per-case action and raise ONE escalation. This is the "knows when something bigger is wrong" moment — put it in the video.

### 4.6 Act — five tools, one port
```ts
interface RazorpayPort {
  retryNow(caseId): Promise<Outcome>;
  retryScheduled(caseId, atISO): Promise<Outcome>;
  switchRail(caseId, to: "upi"|"emandate"): Promise<Outcome>;
  sendPaymentLink(caseId, channel: "sms"|"email"): Promise<Outcome>;
  escalate(caseId, reason: string): Promise<Outcome>;
}
```
`MockRazorpayPort` implements this against the simulator. `TestModeRazorpayPort` is the stretch goal — if built, wire only `sendPaymentLink` to the real test-mode Payment Links API and say so in the video. Do not fake it.

### 4.7 Outcome simulator
Given `(action, _true_cause, _will_self_heal)` → success probability → sampled outcome. Keep it in a single table so it is auditable and obviously not cheating. **Say in the video that outcomes are simulated and how.** Honesty here scores; pretending scores negative.

### 4.8 Measure — the holdout
- Randomly assign 20% of cases to `holdout`. The agent never touches them.
- Run the simulator on both arms.
- Report:
  - Recovered ₹ (treated) vs recovered ₹ (holdout, i.e. self-healed / customer self-retried)
  - **Net lift** = treated − holdout-rate × treated-pool-size
  - Cost of actions taken
  - Recovery rate by cause and by decision bucket

Without the holdout you are counting the 5% that would have paid anyway. With it, your number is defensible.

### 4.9 Audit trail — append-only JSONL, one line per event
```json
{"ts":"...","case_id":"...","stage":"decide","input_hash":"...","rules_fired":["R7"],
 "llm":{"used":false},"decision":"CUSTOMER_ACTION","tool":"sendPaymentLink",
 "rejected":[{"tool":"retryNow","because":"domestic card — manual charge unsupported"}],
 "compliance":{"passed":true,"checks":["not_dnd","contact_hours_ok"]},
 "stop_check":{"stopped":false}}
```
The `rejected` array is the most persuasive field you will ship. It proves the agent considered and declined alternatives.

### 4.10 Dashboard (one page, for the video only)
Top strip: batch size · rules vs LLM split · ₹ recovered treated vs holdout · net lift · actions cost.
Table: cases sorted by priority, columns: amount, method, cause, decision, tool, status.
Drawer: click a case → its full audit trail rendered as a timeline.
A "Run batch" button. That's it.

---

## 5. Schedule

Times are targets, not law. If a stage runs long, cut from Day 2's polish, never from the loop.

### Tonight (Thu 3 Sept)
- [ ] Verify deadline and submission format on the form.
- [ ] New repo. Copy Quark's `web/package.json` + lockfile. Confirm `vite` serves.
- [ ] Copy classifier prompt, schema validator, gate, eval runner from Quark into `src/engine/`.
- [ ] Write `Case` type and the synthetic generator with seed. Generate 80 cases. Commit.
- [ ] Run the Quark-chat extraction prompt (see chat) → `WHAT_BROKE.md` committed to the new repo.

### Day 1 (Fri 4 Sept)
- [ ] Morning: `rules.ts`, prioritiser, priority queue, batch runner. Print top-20 with reasons.
- [ ] Midday: compliance gate + stopping config + the port interface + `MockRazorpayPort` + outcome simulator.
- [ ] Afternoon: LLM diagnose on the tail. Decide via renamed classifier. Full loop runs end-to-end on 80 cases from CLI. Audit JSONL is being written.
- [ ] Evening: holdout + measurement report printed to console. **This is the finish line for substance.** Commit.
- [ ] Night: dashboard skeleton reading the JSONL.

### Day 2 (Sat 5 Sept)
- [ ] Morning: dashboard done. README with architecture (paste section 1 + 4 of this file, edited).
- [ ] Midday: record 5-min video (script below). Re-run batch on camera with the seed.
- [ ] Early afternoon: `WHAT_BROKE.md` updated with this project's breakages. Final commit. Submit.
- [ ] Only if everything above is done: `TestModeRazorpayPort.sendPaymentLink`.

---

## 6. Video script skeleton (5 min)
1. **0:00–0:30** The problem in one sentence + the bar quoted on screen.
2. **0:30–1:30** Architecture diagram. Say out loud: "Rules handle 85%, the model handles the ambiguous tail, and every money action passes a compliance gate and stopping rules first."
3. **1:30–3:00** Run the batch live. Show priority ordering with reasons. Open two audit trails: one AUTO retry_scheduled with pre-debit notice, one domestic-card case where retryNow was *rejected* and rerouted to a payment link.
4. **3:00–3:45** The scoreboard: treated vs holdout, net lift. Say: "Outcomes are simulated from this table; the number is the difference between arms, not raw recoveries."
5. **3:45–4:30** Stopping: show the mandate-cancelled case that was never touched, and the systemic alert firing when one issuer is down.
6. **4:30–5:00** What broke and how you recovered. Vite 8 / lockfile story in 20 seconds. What you'd do next with Razorpay test-mode.

---

## 7. Repo layout
```
/README.md            architecture + how to run + honest limitations
/WHAT_BROKE.md        failure-recovery log (judged criterion)
/BLUEPRINT.md         this file
/config/stopping.json
/data/cases.seed.json
/data/audit.jsonl     (generated, gitignore or commit one sample run)
/src/engine/          carried from Quark: classify, schema, gate, eval
/src/pipeline/        ingest, prioritise, rules, diagnose, decide, compliance, stop, act, measure
/src/ports/           RazorpayPort, MockRazorpayPort, TestModeRazorpayPort (stub)
/src/sim/             outcome simulator
/src/cli.ts           run batch → prints report
/web/                 dashboard
/tests/               invariants: no action on cancelled mandate; no contact when dnd; holdout untouched
```

The tests listed under `/tests/` are not optional. They are the compliance and stopping rules stated as executable claims. A fourth is mandatory: **re-running the same batch must produce zero new actions** — every action carries an idempotency key (`case_id + tool + scheduled_for`), and the audit log is checked before execution. Without this a crash-and-restart double-charges a customer, which is the single worst thing this agent could do.

---

## 8. Honest limitations to write in the README
- Outcomes are simulated; the port to real Razorpay test mode is stubbed/partial.
- Recovery probabilities are a hand-authored table, not learned.
- One direction (subscriptions) only; the pipeline shape generalises but nothing else is built.
- No real contact channels; "send" writes to the audit log.

Writing these down is worth more than hiding them. Track 4's bar says it directly: one cherry-picked match proves nothing.
