# Failed-Subscription Recovery Agent

An agent that works a batch of failed subscription payments the way an
operations team would: rank them by what's actually recoverable, work out why
each one failed, decide who can fix it, refuse the ones nobody should touch, and
report how much money it recovered against a control group that it never
touched.

Built for Razorpay Buildathon Track 3. The bar set by the brief was not "identify
the problem" but **show measured money recovered across a batch, with compliant
escalation, stopping rules, and an audit trail** — so those four things are what
this repo is organised around.

> **Status: in progress.** The engine and the idempotency guard are built and
> tested. The pipeline is being built milestone by milestone — see
> [BLUEPRINT.md](BLUEPRINT.md) §6 for where it is.

---

## The idea in one paragraph

When a recurring payment fails, something has to decide what happens next. Retry
now? Retry after payday? Send the customer a link? Do nothing at all? Most of
those decisions are not judgement calls — they are forced by facts about the
case, and a lookup table gets them right more reliably and more cheaply than a
model does. So this agent is **deliberately mostly not AI**: rules resolve the
large majority of a batch, and the model is spent only on the ambiguous tail
where there is genuinely something to weigh. The interesting engineering is not
the model call. It is everything standing between the model and a customer's
bank account.

---

## How it works

```
cases.seed.json → INGEST → PRIORITISE → DIAGNOSE → DECIDE
                                                     ↓
                            AUDIT ← ACT ← STOPPING ← COMPLIANCE
                              ↓
                           MEASURE (treated vs holdout)
```

**Prioritise.** `(expected_value − action_cost) × urgency`, where urgency rises
as the subscription approaches being halted. The queue logs *why* each case
ranked where it did.

**Diagnose.** A deterministic `(source, reason) → cause` table first. Only cases
no rule matches reach the model, and its answer is rejected below 0.7 confidence.

**Decide.** Once the cause is known the outcome is mostly forced by the domain,
so it is a table, not a model call. Two outcomes — **STOP** (the customer
cancelled the mandate) and **HOLD** (authorisation may still land) — are decided
in code before the model is ever invoked, because both are pure fact-checks and
the model should never get the chance to talk itself out of either.

**Compliance.** Six hard rules run before every action: no contact to a cancelled
mandate, none to a DND or opted-out customer, contact only 09:00–21:00 IST, a
pre-debit notice at least 24h before any retry, no manual charge on domestic
cards, nothing above the mandate's `max_amount`.

**Stopping.** Attempt caps, an expected-value floor, and a systemic rule: if more
than 40% of a batch shares one cause — one issuer having a bad afternoon — the
agent stops working cases individually and raises a single escalation instead.

**Measure.** 20% of cases are assigned to a holdout the agent never touches. The
headline number is the *difference between the two arms*, not raw recoveries,
because some of those payments would have succeeded on their own.

---

## What came from Quark, and what didn't

[Quark](https://github.com/) was a previous project — a capability-aware task
agent for a notes and kanban workspace. It shares one idea with this project:
an agent that honestly classifies what it can and cannot do, and a server-side
gate that decides what needs human approval rather than trusting the model to
decide.

**Only the parts that carried that idea were taken.** Everything else — the
kanban board, the BlockNote editor, the notes and pages UI, Supabase, auth, the
five workspace tools — was deliberately left behind.

| Taken | Why | State here |
|---|---|---|
| Classifier prompt | The decide step, unchanged in shape | Buckets renamed `AUTO / CUSTOMER_ACTION / ESCALATE`, subject reframed from task to case, allowed-causes list added |
| `schema.ts` — JSON contract validation | Every model output must be validated before it drives money | Renamed enum; `proposed_action` split from `actions_taken`; diagnosis schema with the confidence floor added |
| Confirmation gate (from `runner.ts`) | Becomes the ESCALATE path | Extracted into `gate.ts`; rejections now carry real reasons |
| **`resolveRun`'s double-resolve guard** | **Idempotency** | Rewritten against `audit.jsonl` — see below |
| `provider.ts` — Gemini client | LLM plumbing already debugged against a live key | Supabase config dropped; otherwise unchanged |
| `web/` toolchain + `dev.mjs`, `build.mjs`, `vite.config.mjs` | The Windows workarounds are the value | Dependencies stripped to React + Vite only |

**Not taken, and worth saying so:** Quark had no eval harness and no
`WHAT_BROKE.md`, despite the original plan assuming both. The batch runner here
is new code. That mismatch, and two others like it, are logged in
[WHAT_BROKE.md](WHAT_BROKE.md) §8.

### The one that nearly got left behind

Quark's confirmation gate had a second half that was easy to read past while
extracting it: before executing approved actions, it re-read the run from the
database and refused if it had already been resolved. One line of Supabase.

Dropping it here would have been the worst available mistake. This repo has no
database, so nothing else would have caught a replay — and a replay in a
payments agent means charging a customer a second time. It was reimplemented as
`AuditLog.executeOnce`, keyed on `case_id + tool + scheduled_for`.

The ordering is the part that matters: **the intent line is written and the key
claimed before the rail is called.** A crash in that gap leaves the key claimed,
so the replay is refused and the action is flagged for human reconciliation. The
failure mode is money left uncollected — never a second charge. Writing the
record *after* the call would invert exactly that.

---

## Running it

Requires Node 22+.

```bash
npm install
npm run typecheck     # tsc --noEmit, strict
npm test              # invariants, including the idempotency guard
npm run batch         # run a batch, print the report
npm run dev           # dashboard at http://127.0.0.1:5173
```

For the LLM tail, copy `.env.example` to `.env` and add a Gemini API key. The
deterministic path runs without one.

**Note on `npm run dev`:** `npx vite` does not work on the development machine —
npm's `.bin` shim fails silently for ESM binaries there. `npm run dev` starts
Vite through its JS API instead and works fine. This is documented in
[WHAT_BROKE.md](WHAT_BROKE.md) §2 and is not a bug to be fixed by downgrading.

---

## Honest limitations

- **Outcomes are simulated.** A hand-authored probability table maps
  `(action, true cause)` to a success chance. It is one readable file, on
  purpose, so it can be checked rather than trusted. The real Razorpay test-mode
  port is stubbed.
- **Recovery probabilities are authored, not learned.** There is no training
  data behind them.
- **One direction only.** The pipeline shape would generalise to other recovery
  problems; nothing else has been built.
- **No real contact channels.** "Sending" a payment link writes to the audit log.
  Nothing reaches a real customer.
- **The batch is synthetic**, generated from a seed so it is reproducible.

These are written down rather than hidden because a single cherry-picked result
proves nothing, and the failure-recovery criterion rewards saying what didn't
work.

---

## Repo map

| Path | What's in it |
|---|---|
| `src/engine/` | Carried from Quark: prompt building, schema validation, the gate, the Gemini client, and the audit log with the idempotency guard |
| `src/pipeline/` | The stages: ingest, prioritise, rules, diagnose, decide, compliance, stop, act, measure |
| `src/ports/` | `RazorpayPort` and its mock |
| `src/sim/` | Outcome simulator |
| `tests/` | The compliance and stopping rules as executable claims |
| `web/` | Dashboard |
| `data/` | Seeded cases and the append-only audit log |
| [BLUEPRINT.md](BLUEPRINT.md) | Full build spec and milestones |
| [WHAT_BROKE.md](WHAT_BROKE.md) | What broke and how it was fixed |
