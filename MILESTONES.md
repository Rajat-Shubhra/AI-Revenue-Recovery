# Milestones — working state

**Deadline: Saturday 5 September 2026 — verified on the application form.**
No longer an assumption.

**Repo location: `C:\dev\razorpay-recovery`.** It must stay outside
`Documents\` — endpoint protection blocks file writes from `npm`-spawned
processes there, which broke the build in four different disguises before it was
diagnosed. See WHAT_BROKE.md §11.


**This file is the state of the build.** It is written to be resumable: a fresh
session reads [BLUEPRINT.md](BLUEPRINT.md) then this file, finds the first
milestone not marked `done`, and continues from there without needing anything
re-explained.

Keep Status and Notes current **as you go**, not at the end. The Notes column is
where a decision gets recorded instead of interrupting to ask about it.

---

## How to work

1. **One milestone at a time, in order.** Finish it, verify it, commit it, update
   this file, then start the next one in the batch.
2. **Verify by running, not by building.** A milestone is done when its
   *Done when* column is demonstrably true — output pasted, test green, command
   run. "It compiles" is not verification.
3. **Commit per milestone**, message starting `M<n>: <what>`.
4. **Don't interrupt to show progress**, or to confirm a choice you can defend.
   Record the reasoning in Notes and keep going.
5. **Do interrupt on a STOP trigger.** Those are below and they are narrow.
6. **Stop at the end of the batch** and summarise. Don't run past it — context
   compacts, and later milestones built on a half-remembered spec are worse than
   later milestones built fresh.

### STOP triggers — interrupt on these, and only these

- **The spec is wrong.** A milestone's instruction conflicts with what's actually
  in the repo or in Quark. This has already happened four times; it will happen
  again. Flag it, don't quietly work around it.
- **A choice would move the headline number.** Anything affecting recovery
  probabilities, the holdout split, or how net lift is computed. A judge can ask
  "where did this number come from", so the answer can't be "the model picked it".
- **About to spend LLM quota.** Say so before the run, not after. Free tier is
  ~20 requests/day; a batch is ~12–17.
- **A milestone is running materially over its box**, or would need to be
  half-finished to fit. A working loop over 60 cases beats a broken one over 80.
- **Anything irreversible or outside this repo** — deleting data, touching Quark,
  publishing, installing something global.
- **A dev dependency with an ESM binary** needs adding. Its npm script path must
  be fixed at the same time (WHAT_BROKE.md §4), or it will hang silently.

---

## Batches

Run these as separate sessions, with a look at the running log in between.

| Batch | Milestones | Why it ends here |
|---|---|---|
| 1 | M0 – M2 | Provenance, README, generator, prioritiser. Plumbing, low risk. |
| 2 | M3 – M5 | Rules, diagnose, decide, compliance. The reasoning core — everything downstream inherits the rules table, so it's worth a look before continuing. |
| 3 | M6 – M8 | Stopping, ports, simulator, measurement. **Ends at the substance finish line.** |
| 4 | M9 – M10 | Hardening and the dashboard, if the clock allows. |
| 5 | M11 – M14 | **Unplanned.** Four defects found in a finished loop that was passing all its tests. See *After M10* below. |

**Resume prompt for any later session** — reusable verbatim:

> Read BLUEPRINT.md then MILESTONES.md. Resume from the first milestone not
> marked done, and work through M__. Same rules as before: don't stop to ask
> permission, only the STOP triggers interrupt you, update Status and Notes as
> you go.

---

## The milestones

Blueprint section references in brackets.

| # | Milestone | Done when | Status | Notes |
|---|---|---|---|---|
| **M0** | Starting line — engine, provenance, README | Engine typechecks and tests green; PROVENANCE.md records the Quark boundary; README answers the Track 3 bar clause by clause | **done** | Engine committed `00145a5`; blueprint + README `81e2f76`. Decisions taken: STOP/HOLD in code not in the enum; live LLM calls, no cache; Gemini SDK not added (provider is hand-rolled fetch); env key lazy so tests run without one; `web/package-lock.json` deleted — workspaces make the root lock authoritative. |
| **M1** | Synthetic generator [§3] | `npm run generate` writes 80 cases; slice counts match §3; same seed → byte-identical file; a test asserts nothing outside `/src/sim/` reads `_true_cause` or `_will_self_heal` | **done** | Probability tables approved before building (two tables, deliberately separate — prior vs ground truth). 23 tests green, seed file SHA256-identical across runs. Cost a long detour into WHAT_BROKE §11 before the repo was moved out of `Documents`. Double-charge modelling deferred by decision. |
| **M2** | Ingest + prioritiser [§4.1–4.2] | Batch loads cases, assigns the 20% holdout by seed, writes one audit line per case; top-20 printed with expected_value, urgency, cost, final priority, and the reason it ranked there | **done** | 41 tests green. Holdout is a seeded Fisher–Yates shuffle, not a stride, so the control arm isn't correlated with slice order. Urgency clamped at 1h. Queue ties break on case id so runs are reproducible. 3 cases arrive already halted and are excluded at the door. |
| **M3** | Rules table + diagnose [§4.3] | Rules resolve every reason except the ambiguous slice; unmatched cases fall through cleanly; rules-vs-LLM counts reported. LLM path stubbed here — no live calls yet | **done** | 12 rules, 90% of the batch deterministic (72/80). The 8 unresolved are exactly the ambiguous slice. State-of-the-world rules (R1–R4) run before error-code rules so a mislabelled error can't smuggle a terminal case into the recoverable pile. |
| **M4** | Decide [§4.4] | Every rule-resolved case gets a bucket and tool with no model call; STOP and HOLD decided before the classifier is reachable | **done** | AUTO 23 · CUSTOMER_ACTION 15 · ESCALATE 13 · STOP 7 · HOLD 3. Insufficient funds routes to the next salary-cycle date (1st/3rd/7th), never an immediate retry. Every decision carries a populated `rejected` array. |
| **M5** | Compliance gate [§4.5] | All six checks deterministic and logged **when they pass as well as when they fire** — a gate that only logs failures can't prove it ran. Invariant tests 1 and 2 green | **done** | C1–C6 recorded on every case either way. Invariants 1 and 2 green, including a rogue-decision test proving the gate blocks an action the decide stage wrongly proposed. |
| **M6** | Stopping rules [§4.6] | Read from `config/stopping.json`, not hardcoded; systemic alert fires on a rigged single-cause batch and raises exactly one escalation | **done** | Config is zod-validated on load — a threshold that silently became `undefined` would disable a stopping rule. Escalations are exempt from the value floor: a small misconfiguration still needs fixing. |
| **M7** | Ports + outcome simulator [§4.7–4.8] | `TOOLS` registry filled with the five tools; `MockRazorpayPort` runs against the simulator; deterministic under seed; probability table in one readable file | **done** | Draw is seeded from case id + action, so an outcome doesn't depend on processing order. `retryNow` is the one tool requiring confirmation — it debits with no notice period. `TestModeRazorpayPort` deliberately NOT stubbed: a stub returning success is indistinguishable from a real integration in the ledger. |
| **M8** | Measurement + holdout [§4.10] | `npm run batch` runs 80 cases end to end and prints treated vs holdout, net lift, action cost, and recovery rate by cause and bucket. Invariant test 3 green | **done** | **Substance finish line reached.** Treated 46.1% vs holdout 3.5% by value, net lift ₹47,337. Rates reported by value *and* by count after the holdout showed 3.5%/12.5% — a 16-case arm is noisy. Table-implied cross-check printed alongside. **No LLM calls yet.** |
| **M9** | End-to-end hardening | Re-running the whole batch produces zero new actions (idempotency test extended from the unit to the full pipeline); quota failure degrades affected cases to ESCALATE without crashing; one sample `audit.jsonl` committed | **done** | Idempotency verified at pipeline level (51 actions, then 0). Quota-failure path proved itself for real when Gemini ran dry mid-run. Sample `audit.jsonl` + `report.json` committed. |
| **M10** | Dashboard [§4.11] | One page reading the JSONL: top strip, priority table, per-case audit timeline drawer, Run batch button | **done** | Reads `report.json` + the ledger; derives no numbers of its own so the page and console cannot disagree. Drawer renders the full per-case timeline including the `rejected` array and every compliance check. Buttons run the same `npm run batch` a human would type. |

### After M10 — the milestones nobody planned

M0–M10 were the plan. These four were not: they came out of looking hard at a
loop that was already finished and passing its tests. Numbered so the running
log has something to point at.

| # | Milestone | Done when | Status | Notes |
|---|---|---|---|---|
| **M11** | The priority queue actually decides what gets worked | The order the queue produces is the order cases are processed, and a test proves the work loop consumes it | **done** | It was decorative. A real max-heap with four passing tests, popped once to print the top-20 table — and `take()` drains — after which the work loop iterated the *unsorted* array in generator order. Every test passed. Found only because Rajat asked directly whether the queue was being used. The queue now drains into ticks and the ticks drive the loop. Commit `5dfb3f3`. |
| **M12** | Error taxonomy rebuilt on Razorpay's published docs, and the holdout made comparable | `razorpay-errors.ts` carries the real catalogue; the ambiguous set is *derived* from it; both arms of the experiment hold a comparable share of the money | **done** | The redirect that changed the project. Rules solving 90% showcased a lookup table Razorpay already has — so the model's share had to be justified rather than invented. 41 catalogue entries, 32 codes, 18 causes, and **five `(source, code)` pairs that Razorpay's own docs publish with more than one meaning**. `AMBIGUOUS_KEYS` is computed by grouping the catalogue, not hand-flagged, so it cannot drift from the data. Split moved 90/10 → 70/30. Rebuilding the batch exposed a second bug: the random holdout had drawn **42% of the money into 16 cases**, and net lift read ₹2,227 against a modelled ₹11,886. Holdout assignment is now **stratified by amount** — sort, cut into strata of 5, draw one control from each. Commits `dfb8b75`, `d252fe2`. |
| **M13** | The production build works, and so does its API | `npm run build` produces a bundle that loads real data, not just a bundle | **done** | Deferred item from the M10 list, closed. The batch API was registered on `configureServer` only, so the built app asked `/api/report` and got `index.html` back. Also on `configurePreviewServer` now. A working dev server had been hiding a broken build — exactly the nasty surprise the deferred-items table predicted at recording time. Commit `5dcf0f4`. |
| **M14** | The confidence floor measured, and HOLD grounded in the docs | The floor's value is defended by evidence, and the HOLD reasoning cites Razorpay's documented behaviour rather than caution | **done** | The floor was raised 0.70 → 0.80 because all three wrong diagnoses on one run sat at 0.78. **The next run returned the same three wrong at 0.86, 0.86 and 0.92** and the floor caught none. It was over-fitted to a single sample. Kept at 0.80 because it costs nothing, but nothing leans on it, and the record was corrected in code, tests, README and WHAT_BROKE §15. Separately, HOLD now cites the real rule: Razorpay polls the bank for **3 days** after a timeout, so re-presenting inside that window risks a duplicate debit that gets refunded rather than a recovery. A test asserts the citation survives. Commits `fafb2e8`, `3a131d2`, `aa86418`. |


### Deferred — revisit only if the clock allows

| Item | Why it was deferred | Value if it lands |
|---|---|---|
| **Double-charge modelling** — ~~deferred~~ **dropped, on evidence** | Deferred at M1; revisited on 4 Sept against the docs and abandoned. Razorpay **auto-refunds** a duplicate created by late authorisation, and auto-refunds an uncaptured authorised payment within five days. A permanent double charge is not a documented outcome, so a scoreboard line counting them would have invented a harm the platform actively prevents. | The simulator would count a debit against a `late_auth_pending` case as a second charge rather than a weak recovery, The real cost of acting early is a refund and a support contact, not lost revenue — which is what the HOLD reasoning says now (M14). `DOUBLE_CHARGE_RISK` stays stubbed in `src/sim/outcomes.ts` and unused. |
| `TestModeRazorpayPort.sendPaymentLink` | Stretch goal from the start | Wire only `sendPaymentLink` to the real test-mode Payment Links API, and say so. Do not fake it. |
| ~~`web/build.mjs` verification~~ | Never run in this repo | **Closed in M13 — and it *was* broken.** |

**Raise these with Rajat near the end if there is time left.**

### Invariant tests
Not optional — the compliance and stopping rules stated as executable claims.
They land **with their milestone**, not in a batch at the end.

| # | Claim | Lands in |
|---|---|---|
| 1 | No action is ever taken on a cancelled mandate | **done** (M5) |
| 2 | No contact is ever made to a DND or opted-out customer | **done** (M5) |
| 3 | Holdout cases are never touched | **done** (M8) |
| 4 | Re-running the same batch produces zero new actions | **done** (M0), extended in M9 |

---

## Running log

Newest last. One or two lines per milestone — what landed, and anything
surprising. This is the part to read when picking up a cold session.

- **M0** — Engine carried from Quark and rewired: buckets renamed, `ToolContext`
  reshaped, diagnosis schema and confidence floor added, gate rejections given
  real reasons. Quark's `resolveRun` double-resolve guard was **not** in the
  original copy list and nearly got lost; reimplemented as `AuditLog.executeOnce`
  against the JSONL ledger, keyed on `case_id + tool + scheduled_for`, claiming
  the key *before* calling the rail so a crash leaves money uncollected rather
  than a customer charged twice. Six tests green.
- **M0** — Four plan-vs-reality mismatches found and corrected in the spec: Quark
  had no eval harness, no `WHAT_BROKE.md`, no Vite 7, and no `web/package-lock.json`.
  Eight failures reproduced and logged in WHAT_BROKE.md, including three that
  cost real time today (`::1`-only bind, silent `.bin` shim hang, dep-optimizer
  stall). The `.bin` shim bug affects **every ESM-entry binary** on this machine,
  not just Vite — vitest hit it identically.
- **M0** — Still unverified: `web/build.mjs` has never been run, and `provider.ts`
  has never talked to a live key. Neither blocks M1.
- **M1** — Generator built: 80 cases, seeded, byte-identical across runs
  (SHA256 verified). 23 tests green. Two probability tables kept deliberately
  separate — the prioritiser's prior is keyed on the *observed* error reason, the
  simulator's on `_true_cause`, and a test enforces that no pipeline file reads
  the ground-truth fields.
- **M1** — **Environment finding, and it is the big one — now fixed.** Writes
  from `cmd.exe`-spawned processes (which is how every `npm run` script starts
  on Windows) were blocked anywhere under `Documents\` by Trend Micro Apex One.
  Single root cause behind WHAT_BROKE §3, §5 and §6, previously logged as three
  separate Vite problems.
- **M9–M10** — Hardening and the dashboard. **All ten milestones done.**
  - `data/report.json` is written by the CLI and rendered by the page, which
    derives no numbers of its own. If the dashboard recomputed the measurement
    it could drift from the console and one of them would be wrong silently.
  - Two bugs the dashboard exposed that the console had hidden. **Halted cases
    sorted to the top of the priority table** — a passed deadline clamps the
    `1/hours` urgency term to 1, inflating their score — so priority is now null
    for cases that never entered the queue. And **`act` was being written to the
    ledger before `decide`**, which reads as a trail reconstructed after the
    fact; the decision is now recorded before it is acted on.
  - Running the batch twice is a *feature* of the demo: every action is refused
    as a duplicate. "Reset & run" exists for when you want a clean sheet, and
    the page says which is which.
  - A sample `audit.jsonl` and `report.json` are committed, so a reviewer can
    read the audit trail and the scoreboard in the GitHub diff without running
    anything.
- **M9 (LLM tail)** — Live model path working, on **Groq** rather than Gemini.
  Gemini's free tier turned out to be **20 requests/day** as well as 5/minute;
  it ran dry mid-build. Groq gives 14,400/day at 30/min, and the `AgentProvider`
  interface carried from Quark meant adding it touched one file. Both stay
  wired; `LLM_PROVIDER` picks.
  - `llama-3.3-70b-versatile` 404s — Groq's catalogue has moved. Now on
    `openai/gpt-oss-120b`. Query `GET /openai/v1/models` rather than trusting a
    model name from documentation.
  - Full batch: **8 calls, 8 usable, 0 failed, 25 seconds.** Typically 5–6 of
    the 8 resolved, the rest escalated. Accuracy against ground truth ranges
    4/5 to 6/6 across runs.
  - **The model is not deterministic even at temperature 0.** `case_078` flips
    between `issuer_downtime`, `gateway_downtime` and `unknown` across runs.
    Documented in the README as an honest limitation.
  - **The headline number does not move anyway** — ₹47,736 in both runs that
    disagreed. Adjacent causes collapse to the same action in the decide table,
    so the agent does the same thing and the simulator scores against the true
    cause regardless. Worth saying out loud in the video: the architecture
    absorbs model variance.
  - Gemini's quota running out mid-run was the first real test of the
    degradation path, and it held: 8 cases escalated with "the model was not
    available" and the batch completed. Better evidence than a test.
- **M6–M8** — The loop closes. `npm run batch` runs ingest → prioritise →
  diagnose → decide → compliance → stop → act → measure on 80 cases and prints
  the scoreboard. 92 tests green.
  - **The isolation test earned its keep.** The batch runner read
    `_will_self_heal` directly to score cases it decided not to act on, and the
    test failed the build. Fixed by adding `MockRazorpayPort.noAction()`, which
    scores restraint through the same `none` column the holdout takes — so
    choosing to HOLD and being in the control arm are measured identically
    rather than differing by an RNG draw.
  - **The first honest number was misleading and got fixed.** Holdout recovery
    read 3.5% by value but 12.5% by count: with 16 cases, one large case
    landing either way swings the value-weighted rate hard, and net lift
    inherits that noise. Both rates are now reported, plus a table-implied
    cross-check that puts lift at ₹43,003 against the holdout's ₹47,337. The
    holdout stays the headline; the gap is stated as the uncertainty it is.
  - Same distortion appears per-cause — `bank_blocked_card` reads 94.6% by
    value on 6 cases — so that table now shows recovered/total counts too, with
    a note that per-cause lift is indicative rather than a claim.
  - **Full-pipeline idempotency verified early**: run 1 executes 51 actions,
    run 2 executes 0 and logs 51 skipped duplicates. That is invariant 4 at
    pipeline level, which was M9's job.
  - `escalate` never counts as a recovery. A handoff is not money returned, and
    scoring it as one would inflate the headline with work nobody has done yet.
- **M3–M5** — The reasoning core. Landed as one commit because they are not
  separable: decide is meaningless without a cause, and the gate is meaningless
  without a decision to veto. 66 tests green.
  - Rules resolve **72/80 deterministically**; the 8 that fall through are
    exactly the ambiguous slice, so the model's share is by design, not
    by accident.
  - Rules are ordered **state-of-the-world before error-code**. A cancelled
    mandate diagnoses as cancelled even when the error string claims something
    recoverable — there's a test that mislabels one to prove it.
  - **Layering worked as intended**: C1 and C5 never fire in a normal run,
    because decide already stops cancelled mandates and already reroutes
    domestic cards. They are the backstop, and there is a rogue-decision test
    that feeds the gate a deliberately wrong `retryNow` to prove the backstop
    holds.
  - C2 fires 3 times on the DND/opted-out slice, escalating rather than
    silently dropping — and a debit is still permitted for those customers,
    because consent to be contacted is not authorisation to charge.
  - Every decision carries a populated `rejected` array. A test asserts every
    reason is a real sentence, not a placeholder.
- **M2** — Ingest and prioritiser done; `npm run batch` prints the ranked queue.
  61 treated / 16 holdout / 3 already halted before the batch ran. Three
  decisions worth knowing: the holdout is a **seeded Fisher–Yates shuffle**
  rather than every-Nth, because a stride would correlate the control arm with
  the generator's slice order and quietly bias the measurement; **urgency is
  clamped at one hour**, or a case with 20 minutes left would outrank everything
  regardless of value; and the **queue breaks ties on case id**, without which
  equal-priority cases reorder between runs and the demo stops being
  reproducible. Halted subscriptions are dropped at ingest rather than after
  work is done on them.
- **M1** — **The repo moved to `C:\dev\razorpay-recovery`.** The block was
  scoped to the protected `Documents` folder, not to `cmd`; a probe package in
  `C:\dev` wrote fine by every route. Copied with `robocopy` (the old directory
  was locked by the editor), dependencies reinstalled, git history intact.
  Everything now works normally: `npm run generate`, `npm test`,
  `npm run typecheck`, `npm run batch` all green at the new location. No more
  "run it directly" workaround needed. `src/engine/fs-safe.ts` is kept as belt
  and braces for the audit ledger.
- **M11** — **The priority queue was decorative.** A real max-heap, four passing
  tests, correct arithmetic — popped once to print the top-20 table, and `take()`
  drains it, after which the work loop iterated the unsorted array in generator
  order. Nothing failed. No test could have caught it, because every test tested
  the heap and the heap was fine. It surfaced because Rajat asked whether the
  queue was actually being used. The queue now drains into ticks and the ticks
  drive the loop, so ranking changes what gets worked and not just what gets
  printed.
- **M12** — **The redirect, and the best decision in the project.** Rajat's
  observation: rules solving 90% of the batch showcases a lookup table Razorpay
  almost certainly already runs, so the thing worth showing is what the model
  does on what the rules *can't* settle — which makes the diagnosis the centre of
  the project, not a stage in it.
  - Razorpay's published error pages were read properly and transcribed into
    `src/pipeline/razorpay-errors.ts`: **41 entries, 32 codes, 18 causes**, with
    `source` restricted to the four values Razorpay actually uses
    (`customer | business | gateway | razorpay`).
  - The finding that carries the whole argument: **the error code is not the
    cause.** `gateway/credit_failed` is documented as both *"customer selected a
    different bank account"* and *"partner bank downtime"* — opposite remedies,
    one code. Five `(source, code)` pairs collide this way.
  - `AMBIGUOUS_KEYS` is **derived** by grouping the catalogue, never
    hand-maintained. Ambiguity the model has to resolve is therefore a property
    of Razorpay's documentation, not of our storytelling — which is the
    difference between a defensible claim and a convenient one.
  - Rules/model split moved 90/10 → **70/30** without loosening a single rule.
  - **A second bug fell out of the rebuild.** With the new case mix the random
    holdout had captured **42% of the money in 16 of 80 cases**. Net lift read
    ₹2,227 while the table-implied cross-check said ₹11,886 — a 5× disagreement
    that would have been indefensible on camera. Holdout assignment is now
    **stratified by amount**: sort, cut into strata of five, draw one control from
    each. The two arms now see the same value range, and the two estimates agree
    to within the noise a 16-case arm carries.
- **M13** — `web/build.mjs` verified at last, and it was broken. The batch API
  existed only on `configureServer`, so the built app requested `/api/report` and
  received `index.html`. Registered on `configurePreviewServer` too. A working
  dev server had been concealing a broken production build for a week.
- **M14** — **Two safety mechanisms, examined honestly.**
  - The confidence floor was raised 0.70 → 0.80 because every wrong diagnosis on
    that run arrived at 0.78. **The next run returned the same three wrong
    diagnoses at 0.86, 0.86 and 0.92.** The floor was fitted to one sample and
    the sample moved. It stays at 0.80 because it is free, but the README no
    longer claims it protects anything, and WHAT_BROKE §15 records the sequence
    including the part where the fix looked like evidence.
  - HOLD stopped sounding like caution and started citing a rule. Razorpay polls
    the bank for **three days** after a timeout and fires `payment.authorized` if
    it lands, which is where the 72h hold window came from — a threshold picked
    without a source that turned out to match documented behaviour. Every
    threshold in `config/stopping.json` now carries a one-line `_doc` rationale,
    and a test asserts the citation stays in the reasoning.
  - **Double-charge modelling is dropped, not deferred.** Razorpay auto-refunds
    duplicates. Counting "double charges avoided" would have credited the agent
    with preventing something the platform prevents anyway. The rejected-action
    text says *"duplicate debit that has to be refunded"* instead — smaller, and
    true.
- **Where it finished.** 80 cases · **56 by rules, 24 to the model, 21 of 24
  correct** · treated ₹67,544 → **₹21,779 (32.2%)** · holdout ₹23,734 → **₹499
  (2.1%)** · **net lift ₹20,359**, ₹19,775 after ₹584 of action cost · modelled
  cross-check ₹14,210 · AUTO 16 · CUSTOMER_ACTION 15 · ESCALATE 11 · STOP 12 ·
  HOLD 2 · **121 tests green.**
