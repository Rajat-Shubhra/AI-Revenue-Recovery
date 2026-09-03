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
| **M9** | End-to-end hardening | Re-running the whole batch produces zero new actions (idempotency test extended from the unit to the full pipeline); quota failure degrades affected cases to ESCALATE without crashing; one sample `audit.jsonl` committed | partly done | Full-pipeline idempotency **verified**: run 1 executes 51 actions, run 2 executes 0 and logs 51 skipped duplicates. Still to do: live LLM wiring, its quota-failure path, and committing a sample ledger. |
| **M10** | Dashboard [§4.11] | One page reading the JSONL: top strip, priority table, per-case audit timeline drawer, Run batch button | not started | Cut this before cutting anything in M1–M9. |

### Deferred — revisit only if the clock allows

| Item | Why it was deferred | Value if it lands |
|---|---|---|
| **Double-charge modelling** | Extra code and extra room for a bug, on the eve of a deadline. Deferred at M1 by explicit decision. | The simulator would count a debit against a `late_auth_pending` case as a second charge rather than a weak recovery, letting the scoreboard say *"N double-charges avoided by holding"* — a concrete demonstration of restraint for the video. Wiring point already stubbed: `DOUBLE_CHARGE_RISK` in `src/sim/outcomes.ts`. |
| `TestModeRazorpayPort.sendPaymentLink` | Stretch goal from the start | Wire only `sendPaymentLink` to the real test-mode Payment Links API, and say so. Do not fake it. |
| `web/build.mjs` verification | Never run in this repo | A broken build with a working dev server is a nasty surprise at recording time. |

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
