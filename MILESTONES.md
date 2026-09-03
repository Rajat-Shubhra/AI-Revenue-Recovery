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
| **M2** | Ingest + prioritiser [§4.1–4.2] | Batch loads cases, assigns the 20% holdout by seed, writes one audit line per case; top-20 printed with expected_value, urgency, cost, final priority, and the reason it ranked there | not started | |
| **M3** | Rules table + diagnose [§4.3] | Rules resolve every reason except the ambiguous slice; unmatched cases fall through cleanly; rules-vs-LLM counts reported. LLM path stubbed here — no live calls yet | not started | |
| **M4** | Decide [§4.4] | Every rule-resolved case gets a bucket and tool with no model call; STOP and HOLD decided before the classifier is reachable | not started | Enum stays three values. See §4.4. |
| **M5** | Compliance gate [§4.5] | All six checks deterministic and logged **when they pass as well as when they fire** — a gate that only logs failures can't prove it ran. Invariant tests 1 and 2 green | not started | |
| **M6** | Stopping rules [§4.6] | Read from `config/stopping.json`, not hardcoded; systemic alert fires on a rigged single-cause batch and raises exactly one escalation | not started | |
| **M7** | Ports + outcome simulator [§4.7–4.8] | `TOOLS` registry filled with the five tools; `MockRazorpayPort` runs against the simulator; deterministic under seed; probability table in one readable file | not started | |
| **M8** | Measurement + holdout [§4.10] | `npm run batch` runs 80 cases end to end and prints treated vs holdout, net lift, action cost, and recovery rate by cause and bucket. Invariant test 3 green | not started | **Substance finish line.** First live LLM run happens at or before this point — announce quota spend first. |
| **M9** | End-to-end hardening | Re-running the whole batch produces zero new actions (idempotency test extended from the unit to the full pipeline); quota failure degrades affected cases to ESCALATE without crashing; one sample `audit.jsonl` committed | not started | |
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
| 1 | No action is ever taken on a cancelled mandate | M5 |
| 2 | No contact is ever made to a DND or opted-out customer | M5 |
| 3 | Holdout cases are never touched | M8 |
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
- **M1** — **The repo moved to `C:\dev\razorpay-recovery`.** The block was
  scoped to the protected `Documents` folder, not to `cmd`; a probe package in
  `C:\dev` wrote fine by every route. Copied with `robocopy` (the old directory
  was locked by the editor), dependencies reinstalled, git history intact.
  Everything now works normally: `npm run generate`, `npm test`,
  `npm run typecheck`, `npm run batch` all green at the new location. No more
  "run it directly" workaround needed. `src/engine/fs-safe.ts` is kept as belt
  and braces for the audit ledger.
