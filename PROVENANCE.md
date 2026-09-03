# Provenance — what was borrowed, and what was written for this project

Recorded at the starting line, before any domain code existed, so the boundary
is permanent rather than reconstructed later. If a judge asks how much of this
was written for Track 3, this file is the answer, and it is written to
**neither undercount nor overcount** what came from elsewhere.

Everything borrowed came from **Quark**, a previous personal project: a
capability-aware task agent for a notes-and-kanban workspace. It shares exactly
one idea with this project — an agent that honestly classifies what it can and
cannot do, behind a server-side gate that decides what needs human approval
rather than letting the model decide. Everything in Quark that did not serve
that idea was left behind: the kanban board, the BlockNote editor, the notes and
pages UI, Supabase, authentication, and all five of its workspace tools.

Line counts below are approximate — they count meaningful code lines, and a
file's category reflects its substance, not its diff.

---

## Categories

- **Verbatim** — copied with no logic change. Comments may be re-worded.
- **Adapted** — Quark's structure and control flow kept; content substantially
  rewritten for this domain.
- **Extracted** — pulled out of a larger Quark file, leaving most of it behind.
- **New** — written for this project. No Quark code.

---

## File by file

| File | Category | From | Detail |
|---|---|---|---|
| `src/engine/provider.ts` | **Verbatim** | `server/src/agent/provider.ts` | Gemini REST client. Identical code; only the import path and header comment differ. ~55 lines borrowed. |
| `web/dev.mjs` | **Verbatim** | `web/dev.mjs` | Vite JS-API launcher + EPERM cache retry. Code identical, header rewritten. ~40 lines. |
| `web/build.mjs` | **Verbatim** | `web/build.mjs` | Same rationale for builds. ~9 lines. **Still unrun in this repo.** |
| `web/vite.config.mjs` | **Adapted** | `web/vite.config.mjs` | The Windows workarounds — `cacheDir`, `host: '127.0.0.1'`, `strictPort`, `dedupe` — are verbatim with their original comments. Supabase/env `define` block dropped. ~20 lines borrowed. |
| `src/engine/env.ts` | **Adapted** | `server/src/env.ts` | `required()` and the dotenv bootstrap verbatim. All Supabase variables dropped; the API key became a lazy getter so tests run without one. ~15 lines borrowed. |
| `src/engine/tool-types.ts` | **Adapted** | `server/src/agent/tools/types.ts` | The `Tool` interface — `requiresConfirmation` / `describeConsequence` / `execute` — is verbatim with its doc comments. `ToolContext` fully replaced: Supabase and task-board fields out, `{ caseId, port, clock, audit }` in. ~20 lines borrowed. |
| `src/engine/schema.ts` | **Adapted** | `server/src/agent/schema.ts` | `extractJson`, `parseAgentResponse`, `agentActionSchema` and the base response schema are verbatim apart from the bucket rename. `toolNameSchema`, `proposedActionSchema`, `diagnosisSchema`, `parseDiagnosis` and the confidence floor are new. ~35 of 139 lines borrowed. |
| `src/engine/gate.ts` | **Extracted** | `server/src/agent/runner.ts` (321 lines) | `needsConfirmation` and `describeActions` verbatim — the gate deciding in code rather than trusting the model's flag. `partitionActions` rewritten to carry real rejection reasons; `executeActions` rerouted through the idempotency guard. Quark's Supabase orchestration, `agent_runs` writes and research second-turn all left behind. ~35 of 178 lines borrowed. |
| `src/engine/prompt.ts` | **Adapted** | `server/src/agent/prompt.ts` | `buildSystemPrompt` and `replaceOrThrow` keep Quark's placeholder-filling logic and its throw-on-missing-placeholder behaviour. The tool descriptions, allowed-causes list and `buildUserMessage` are new — Quark's version imported notes/kanban tools that did not come across. ~55 of 179 lines borrowed. |
| `src/engine/classifier-prompt.md` | **Adapted** | `task-agent-prompt.md` | Structure kept: provider notes → role → tools → Understand / Classify / Act → Rules → strict JSON output contract. Buckets renamed, subject reframed from task to payment case, allowed-causes list added, most prose rewritten. |
| `web/package.json` | **Adapted** | `web/package.json` | Versions kept exactly (Vite 8.2.2, plugin-react 6.1.x, React 19.2.8, TS 7.0.2) because they are the verified-working set. Every BlockNote, Mantine, dnd-kit and Supabase dependency removed. Scripts repointed at `dev.mjs` / `build.mjs`. |
| `tsconfig.json` | **Adapted** | `server/tsconfig.json` | Same strict compiler settings; include paths changed. |
| `.env.example` | **Adapted** | `.env.example` | Supabase section removed. One key: `GEMINI_API_KEY`. |
| `src/engine/audit.ts` | **New** | *concept* from `runner.ts` | 198 lines, no Quark code. Reimplements the *idea* of `resolveRun`'s double-resolve guard — see below. |
| `src/engine/case.ts` | **New** | — | The `Case` type. |
| `src/ports/razorpay.ts` | **New** | — | `RazorpayPort` interface. |
| `src/cli.ts` | **New** | — | Batch runner entry point. |
| `tests/idempotency.test.ts` | **New** | — | 146 lines. |
| `web/index.html`, `web/src/main.tsx` | **New** | — | Minimal scaffolding. |
| `package.json` | **New** | — | Root workspace manifest. |
| `README.md`, `BLUEPRINT.md`, `WHAT_BROKE.md`, `MILESTONES.md`, this file | **New** | — | ~850 lines of documentation, all written for this project. |

---

## The headline number

Of roughly **1,350 lines of code and configuration** at the starting line:

- **~230 lines are verbatim Quark** — the Gemini client, the Vite launchers and
  Windows workarounds, the `Tool` interface, the JSON-extraction and validation
  core, and the two gate functions.
- **~200 lines are adapted** — Quark's structure with this domain's content.
- **The remaining ~900 lines are new**, along with all ~850 lines of docs.

So roughly **a third of the starting-line code is traceable to Quark**, and it
is concentrated in exactly the two places where reuse is legitimate: LLM
plumbing already debugged against a live key, and Windows build workarounds that
cost real hours to find the first time.

**No domain code existed at the starting line.** Every pipeline stage — the case
generator, rules table, prioritiser, compliance gate, stopping rules, ports,
simulator and measurement — is written for this project from milestone M1
onward.

---

## What Quark did *not* provide

Worth stating because the original plan assumed otherwise:

- **No eval harness.** The plan said to carry one over. It does not exist in
  Quark's working tree and never appears in its git history. The batch runner
  here is new code.
- **No `WHAT_BROKE.md`.** Also assumed by the plan; also never existed.
- **No Vite 7.** The plan said to carry "Vite 7 + plugin-react 5". Quark went
  Vite 6.0.3 → Vite 8.2.2 directly; Vite 7 appears nowhere in its history, and
  there was no `web/package-lock.json` to carry at all.

All three are logged in [WHAT_BROKE.md](WHAT_BROKE.md) §8.

---

## The borrowed line that mattered most

Quark's confirmation gate had a second half that was easy to miss while
extracting it. Before executing approved actions, `resolveRun` re-read the run
from the database and refused if it had already been resolved. One line of
Supabase, doing work the database made invisible.

In Quark, dropping it would have meant a note written twice. Here it would mean
**charging a customer twice** — and with no database in this design, nothing else
would have caught it. It was flagged during the copy and reimplemented from
scratch as `AuditLog.executeOnce`, keyed on `case_id + tool + scheduled_for`,
against the append-only JSONL ledger.

It shares no code with Quark, which is why `audit.ts` is listed as New. But the
idea is borrowed, and the borrowing is the point: **the risky part of extracting
a component is not what you copy, it is the thing next to it that made it safe.**
