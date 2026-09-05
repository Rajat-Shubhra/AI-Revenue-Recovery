# AI Revenue Recovery

**A failed-subscription recovery agent.** Razorpay Buildathon, Track 3.

An agent that works a batch of failed subscription payments the way an
operations team would: rank them by what's actually recoverable, work out why
each one failed, decide who can fix it, refuse the ones nobody should touch, and
report how much money it recovered against a control group that it never
touched.

The bar set by the brief was not "identify the problem" but **show measured
money recovered across a batch, with compliant escalation, stopping rules, and
an audit trail** — so those four things are what this repo is organised around.

> **Status: complete.** Fourteen milestones done — the ten that were planned, plus
> four that came out of auditing a loop that was already finished and green.
> 127 tests passing. `npm run batch` runs the full loop over 80 cases in ~25 seconds and `npm run dev` serves the
> dashboard. A sample audit ledger and report are committed, so the trail can be
> read straight from the diff. See [MILESTONES.md](MILESTONES.md) for how it was
> built and what broke.

---

## The bar, clause by clause

Track 3's brief sets five requirements. Here is where each one is satisfied, and
which are not satisfied yet. These markers are kept honest as milestones land —
if something says pending, it is genuinely not built.

> *"Don't just identify the problem. Show measured money recovered across a
> batch, with compliant escalation, stopping rules, and an audit trail."*

| Clause | Where | State |
|---|---|---|
| **Measured money recovered** | 20% holdout the agent never touches, stratified by amount so both arms see the same value range. Latest run: **₹21,779 recovered treated (32.2% of a ₹67,544 pool) vs ₹499 holdout (2.1% of ₹23,734) · ₹20,359 net lift · ₹19,775 after ₹584 of action cost** | ✅ |
| **Across a batch** | 80 seeded cases, byte-identical between runs. A max-heap works the top 20 per tick and each case carries the arithmetic that ranked it into the audit trail | ✅ |
| **Compliant escalation** | Six deterministic checks before every action, logged whether they pass or fire. DND and opted-out customers escalate rather than being silently dropped — and a debit is still permitted, because consent to be contacted is not authorisation to charge | ✅ |
| **Stopping rules** | `config/stopping.json` — attempt caps, expected-value floor, terminal states, and a systemic rule raising one escalation instead of N when a single cause exceeds 40% of a batch | ✅ |
| **Audit trail** | Append-only `audit.jsonl`, one line per stage per case, including the `rejected` array of alternatives declined and why. A sample run is committed — readable in the diff without running anything | ✅ |

Plus the judged criterion that sits underneath all of them:

| Criterion | Where | State |
|---|---|---|
| **AI Judgment** — deterministic where AI is unnecessary | **56 of 80 resolved by rules; 24 reach the model.** 70% deterministic. Critically, the 30% is not "cases with vague errors" — it is the `(source, code)` pairs Razorpay's own docs publish with more than one meaning, derived from the catalogue rather than asserted. The model's diagnoses are scored against ground truth and the scoring is published, right or wrong — last run **21 of 24 correct, 3 wrong, and the confidence floor caught none of the three** | ✅ |
| **Failure Recovery** | [WHAT_BROKE.md](WHAT_BROKE.md) — sixteen entries with symptom, root cause, dead ends, fix, time cost and lesson. The last five are things that worked, passed their tests, and were wrong anyway — including a safety mechanism that fitted one run and broke on the next, and a confirmation gate that was implemented, declared in a comment, and never actually called | ✅ |

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
  data/cases.seed.json
          │
          ▼
     INGEST ──────────────► holdout arm — 20%, stratified by amount ──┐
          │                  nothing downstream can reach it          │
          ▼                                                           │
     PRIORITISE   max-heap, drained into ticks of 20                  │
          │                                                           │
          ▼                                                           │
     DIAGNOSE     rules first; the model only on the ambiguous tail   │
          │                                                           │
          ▼                                                           │
     SYSTEMIC     one cause over 40% of the batch? then one           │
       CHECK      escalation instead of N individual actions          │
          │                                                           │
          ▼       per case, highest priority first                    │
     DECIDE ─► COMPLIANCE ─► STOPPING ─► ACT ─► RazorpayPort          │
                                                                      │
     every stage appends to data/audit.jsonl as it goes —             │
     the decide line is written BEFORE the act line it authorised     │
          │                                                           │
          ▼                                                           ▼
     MEASURE   treated vs holdout ─► data/report.json ─► dashboard
```

The earlier version of this diagram had `AUDIT` sitting after `ACT`, as though
the ledger were the last stage. It is not a stage at all — every stage writes to
it while it runs, and the ordering *within* the act stage is load-bearing: the
intent line is written before the rail is called, not after.

**Prioritise.** `(expected_value − action_cost) × urgency`, where urgency rises
as the subscription approaches being halted. The queue logs *why* each case
ranked where it did.

**Diagnose.** A deterministic `(source, code) → cause` table over Razorpay's
published error taxonomy — 41 catalogue entries, 32 codes, 18 causes. Only what
the code cannot settle reaches the model, and its answer is rejected below 0.80
confidence.

That boundary is the interesting part, and it is not "vague errors go to the
AI". **The error code is not the cause.** Razorpay's own docs publish
`credit_failed` as both *"the customer selected a different bank account"* and
*"partner bank downtime"* — opposite remedies behind one code — and publish
several codes under two sources with different meanings. Five `(source, code)`
pairs in the catalogue carry more than one cause. A lookup table on the code
would be wrong on those and confident about it; reading the issuer's advice text
resolves them. That set is derived from the catalogue, not hand-maintained, so
it cannot drift.

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

Quark was a previous personal project — a capability-aware task agent for a
notes and kanban workspace. It shares one idea with this project: an agent that
honestly classifies what it can and cannot do, and a server-side gate that
decides what needs human approval rather than trusting the model to decide.

**Only the parts that carried that idea were taken.** Everything else — the
kanban board, the BlockNote editor, the notes and pages UI, Supabase, auth, the
five workspace tools — was deliberately left behind.

Roughly **a third of the starting-line code is traceable to Quark**, concentrated
in the two places where reuse is legitimate: LLM plumbing already debugged
against a live key, and Windows build workarounds that cost real hours to find
the first time. No domain code was borrowed, because none existed.
[PROVENANCE.md](PROVENANCE.md) has the file-by-file accounting, marked verbatim /
adapted / extracted / new.

| Taken | Why | State here |
|---|---|---|
| Classifier prompt | Was to have driven the decide step | **Superseded, and left in the repo saying so.** Decide became a lookup table at M4, so the carried prompt drives nothing; `classifier-prompt.md` and `SYSTEM_PROMPT` are dead. What the model actually gets is `DIAGNOSE_SYSTEM_PROMPT` in `llm-diagnose.ts` — new, and pointed at the cause rather than the action |
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
npm run build         # production bundle of the dashboard
```

For the LLM tail, copy `.env.example` to `.env` and add a key. `LLM_PROVIDER`
picks between `groq` (default — 14,400 requests/day) and `gemini` (20/day, kept
wired as a cross-check). The deterministic path runs without either.

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
- **The error taxonomy is a reconstruction from public documentation.** Codes,
  sources and descriptions come from Razorpay's published error pages. A
  Razorpay engineer would have the live error stream, the internal code-to-cause
  mapping we inferred, and the ability to act inside the payment session rather
  than after it. What is portable here is the pipeline shape and the discipline
  around it, not the taxonomy — that is our best outside-in approximation.
- **The `(source, code)` collisions are real, but the case mix is ours.** The
  ambiguity the model resolves is documented; the decision that 30% of a batch
  should carry it is a choice we made, weighted by how often each cause plausibly
  occurs. A real book of failed payments would have its own shape.
- **One direction only.** The pipeline shape would generalise to other recovery
  problems; nothing else has been built.
- **No real contact channels.** "Sending" a payment link writes to the audit log.
  Nothing reaches a real customer.
- **The batch is synthetic**, generated from a seed so it is reproducible.
- **The model is not deterministic, even at temperature 0.** Across repeated
  runs it changes its mind about genuinely borderline cases. Temperature is set
  to 0 to minimise it, but no hosted provider is bit-reproducible, and the model
  is the one component of this pipeline that will not reproduce exactly.

  **A confidence floor does not fix this.** The obvious guard — reject anything
  the model is unsure about — was tried and measured. On one run every wrong
  answer arrived at 0.78 and a floor at 0.80 caught all three; on the next the
  same three came back at 0.86–0.92 and it caught none. Self-reported confidence
  is another token the model generates, with the same variance as the diagnosis.
  The floor is kept because it is free, but nothing leans on it. See
  [WHAT_BROKE.md](WHAT_BROKE.md) §15.

  **What insulates the headline number is structural, and there is direct
  evidence for it.**
  Two runs of the same batch scored **14/24 and 21/24** on diagnosis accuracy —
  a swing of seven cases — and both reported an **identical net lift** (₹19,361, on
  the build those two runs shared; the headline has since moved to ₹20,359 for
  reasons that have nothing to do with the model).
  Adjacent causes collapse to the same branch of the decide table, so the agent
  takes the same action either way, and the simulator scores that action against
  the *true* cause rather than the diagnosed one. The 70% of the batch the rules
  settle is untouched by any of it.

  That is the architecture absorbing model variance rather than luck, and it is
  a stronger claim than "the model is accurate": **the number does not depend on
  the model behaving.**

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
