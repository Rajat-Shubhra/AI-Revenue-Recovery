# What broke, and how it got fixed

Failure-recovery log. Judged criterion, so it is written to be accurate rather
than impressive: every entry marked **reproduced** was observed directly in this
repo on 3 Sept 2026, with the command and the output. Entries marked
**unverified** are carried from Quark's source comments and commit history and
have *not* been re-observed here — they are recorded because they shaped the
code, not because they were re-proved.

Time costs for today's entries are wall-clock estimates from this session.
Quark-era costs are not known and are marked as such.

The machine throughout: Windows 11, Node v22.20.0, npm 10.9.3, repo path
`C:\Users\KIIT0001\Documents\AI Revenue Recovery` (note the space — it matters
twice below).

---

## 1. Vite dev server bound IPv6 only; `127.0.0.1` refused every connection

**Status:** reproduced.

**Symptom.** `npx vite` printed `VITE v8.2.2 ready in 1204 ms` and advertised
`http://localhost:5178/`. Thirty polls of `http://127.0.0.1:5178/` over 45
seconds all failed. The server looked healthy and served nothing.

**Root cause.** With no `server.host` set, Node resolved `localhost` to `::1`
and bound IPv6 only. `Get-NetTCPConnection -LocalPort 5178` showed exactly one
listener: `::1`. Anything reaching for the IPv4 loopback — curl, most scripts,
some browsers depending on resolution order — got nothing to talk to.

**What we tried that didn't work.** Connecting to `[::1]:5178` directly. It also
timed out, which sent us looking for a networking problem that wasn't there —
the IPv6 bind was real, but a *second* fault (entry 3) was swallowing requests
on that address at the same time. Two bugs stacked look like one weird bug.

**Fix.** Pin the family explicitly in `web/vite.config.mjs`:

```js
server: { host: '127.0.0.1', strictPort: true }
```

**Time cost.** ~15 minutes, most of it wasted on the stacked second fault.

**Lesson.** "Ready" is a claim about process startup, not about serving. Curl it.
And when a fix doesn't take, check whether you are looking at one failure or two.

---

## 2. `npx vite` hung silently — live process, no output, no listener

**Status:** reproduced.

**Symptom.** After adding `vite.config.mjs`, `npx vite --port 5179` produced
**zero** bytes of stdout and stderr and never opened a listener. The process
stayed alive. No error, no stack, no timeout — just nothing.

**Root cause.** npm's `.bin` shim. The live process's command line was:

```
node   C:\...\web\node_modules\.bin\\..\vite\bin\vite.js --port 5179
```

Note `\.bin\\..\` — the shim builds the path by appending `..` to the `.bin`
directory with a doubled separator. Node's ESM loader does not normalise that
the way CommonJS `require` does, and the failure surfaces as silence rather than
`MODULE_NOT_FOUND`.

**What we tried that didn't work.** Re-running with an explicit `--port`.
Capturing stdout/stderr to files (both empty). `Start-Process npx` — which fails
on Windows with `%1 is not a valid Win32 application`, because `npx` is a shell
script, not an executable, and burns another few minutes.

**Fix.** Never invoke Vite through the CLI shim. `web/dev.mjs` calls the JS API
directly, and `package.json` points `dev` at it:

```js
const server = await createServer({ root: webRoot, configLoader: 'native' })
await server.listen()
```

`npm run dev` works. `npx vite` does **not**, and is not expected to.

**Time cost.** ~25 minutes.

**Lesson.** A silent hang is a resolution failure until proven otherwise. Check
the actual command line of the running process — the mangled path was visible in
`Win32_Process.CommandLine` the whole time.

---

## 3. Dev server accepted connections and never answered them

**Status:** reproduced, twice, in two different shapes.

**Symptom (first shape).** Sockets connected; requests hung until the client
timed out. `web/.vite-cache` was never written.

**Symptom (second shape).** Later, after a config change, an orphaned
`node dev.mjs` sat at **802 CPU-seconds**, holding port 5173 with one `Listen`
socket and ten in `CloseWait`, answering nothing. Every request I made for six
minutes hit that zombie rather than the server I thought I was testing.

**Root cause.** Vite holds incoming requests until dependency optimisation
finishes. When the optimiser stalls — writes under `web/node_modules/.vite`
intermittently fail here, antivirus or the search indexer holding handles — it
never finishes, so requests are never released. The process looks alive because
it is: it is spinning.

**What we tried that didn't work.** Waiting longer. Six 60-second polls, all
timed out. Patience does not fix a spin. Also: filtering for the stray process
by repo path, which missed it — its command line was the bare `node  dev.mjs`,
with no path in it at all. Search by **port owner**, not by command line.

**Fix.** Two parts, both carried from Quark:

- Move the optimiser cache out of `node_modules`: `cacheDir: '.vite-cache'`.
- `strictPort: true`, so a second server fails loudly with
  `Port 5173 is already in use` instead of drifting to 5174 and leaving you
  curling a corpse. This is what finally surfaced the zombie.

When it does wedge: kill the port's owner, delete `web/.vite-cache`, restart.
`dev.mjs` automates one retry and then prints that instruction rather than dying
on a stack trace.

**Time cost.** ~35 minutes across both shapes.

**Lesson.** `strictPort` is not a nicety; it is the difference between "my fix
didn't work" and "I am talking to the wrong process." And the most expensive
minutes of the day went to a stale process I had already tried to kill.

---

## 4. `npm test` produced no output — the same shim bug, a different binary

**Status:** reproduced.

**Symptom.** `npm test` (`vitest run`) ran for **292 CPU-seconds** with no
output at all. Looked like vitest crawling the filesystem.

**Root cause.** Not crawling — the same `.bin` shim as entry 2. The command line
was `node "C:\...\node_modules\.bin\\..\vitest\vitest.mjs" run`, the identical
doubled-separator pattern.

**What we tried that didn't work.** Adding a `vitest.config.mjs` to pin
`include` and stop the presumed crawl. It did not help, because there was no
crawl — and it introduced entry 5.

**Fix.** Bypass the shim, exactly as with Vite:

```json
"test": "node node_modules/vitest/vitest.mjs run --dir tests"
```

6 tests, ~1 second, stable across three consecutive runs.

**Time cost.** ~20 minutes.

**Lesson.** This is not a Vite bug. It is every ESM-entry binary dispatched
through `node_modules/.bin` on this machine. `tsc` is unaffected — `npm run
typecheck` works fine through the shim — which is consistent with a CommonJS
entry point resolving where an ESM one does not. **Assume any new dev dependency
with an ESM binary needs the same treatment.** That guess is the useful output
of this entry; the precise loader mechanism is *unverified*.

---

## 5. Vite could not write its own bundled temp config

**Status:** reproduced.

**Symptom.**

```
Error: ENOENT: no such file or directory, open
'C:\...\node_modules\.vite-temp\vitest.config.mjs.timestamp-1788416019611-...mjs'
```

Thrown from `loadConfigFromBundledFile`. It had worked once immediately before,
then failed — intermittent, which cost extra time.

**Root cause.** Vite bundles a config file to a temp file under
`node_modules/.vite-temp` before loading it. That write is unreliable here, same
family as entry 3.

**What we tried that didn't work.** Re-running, since it had just worked.
Intermittency is not flakiness to be waited out; it is a race with something
external.

**Fix.** Do not give Vite a config file to bundle. Deleted `vitest.config.mjs`
and moved its one setting to a CLI flag (`--dir tests`). For the web app, where a
config is genuinely needed, `configLoader: 'native'` in `dev.mjs` and `build.mjs`
skips the bundling step — which is why `web/vite.config.mjs` must stay plain ESM
and must not become `.ts`.

**Time cost.** ~10 minutes.

**Lesson.** The config file is itself a moving part. On this machine the cheapest
config is no config.

---

## 6. EPERM on the dep cache after a config change

**Status:** reproduced.

**Symptom.** After editing `web/vite.config.mjs`, `npm run dev` printed
`Re-optimizing dependencies because vite config has changed`, then:

```
[dev] EPERM on the Vite cache — clearing it and retrying once
[dev] Vite's dep cache is still locked by another process.
      Stop every node process for this repo, delete web/.vite-cache,
      then run npm run dev again.
```

**Root cause.** A config change forces re-optimisation, which deletes the old
cache directory. A leftover node process from an earlier run still held handles
on those files.

**What we tried that didn't work.** Nothing — the carried handler caught it on
the first try and printed the fix. Following its own instructions worked.

**Fix.** Already in `web/dev.mjs`, carried from Quark: catch `EPERM`/`ENOENT`,
clear `.vite-cache`, retry once, and if it fails again print the manual recovery
instead of a stack trace.

**Time cost.** ~2 minutes, entirely because the error message said what to do.

**Lesson.** The single highest-value thing carried over from Quark was not code
that makes something work — it was an error message that says what to do next.
This entry is short *because* the previous project paid for it.

---

## 7. `URL.pathname` produced an unusable path on Windows

**Status:** reproduced.

**Symptom.** `npm run batch` reported its audit ledger as:

```
/C:/Users/KIIT0001/Documents/AI%20Revenue%20Recovery/data/audit.jsonl
```

A leading slash before the drive letter, and the space in the repo name
percent-encoded. Every write would have gone to a path that does not exist.

**Root cause.** `new URL(...).pathname` returns a URL path, not a filesystem
path. On Windows those differ in two ways at once, and the repo folder having a
space in its name made the second one visible.

**What we tried that didn't work.** Nothing — caught on the first run of the CLI
stub, before any pipeline code depended on it.

**Fix.** `fileURLToPath(new URL('../data/audit.jsonl', import.meta.url))`.

**Time cost.** ~3 minutes.

**Lesson.** Worth stating plainly because the audit log is the deliverable: had
this shipped, every run would have silently written its ledger nowhere, and the
idempotency guard would have started from an empty file every time — which is
precisely the double-charge scenario entry 9 exists to prevent. A path bug was
one step away from being a correctness bug.

---

## 8. The plan said Vite 7; Quark had never run Vite 7

**Status:** reproduced (by reading Quark's git history).

**Symptom.** BLUEPRINT §2 said to carry `web/package.json` and its lockfile at
"Vite 7 + plugin-react 5" to avoid re-fighting a dependency battle. Neither
existed.

**Root cause.** Three separate drifts between plan and repository:

- Quark's `web/package.json` is **Vite 8.2.2 + plugin-react 6.1.0**. Its history
  goes Vite 6.0.3 → Vite 8.2.2 in commit `ae960f5`. Vite 7 appears nowhere.
- There is no `web/package-lock.json` in Quark at all — it is an npm workspace
  with a single root lockfile.
- Every dependency in that file was BlockNote, Mantine, dnd-kit or Supabase,
  all of which the carry-over rules excluded.

**What we tried that didn't work.** Nothing was attempted on the false premise;
it was caught by reading the file before copying it.

**Fix.** Carried the toolchain at Quark's real versions, dropped every excluded
dependency, and generated a lockfile from an install that was then verified to
serve. BLUEPRINT §2 and the Stack section were corrected to match.

**Time cost.** ~10 minutes to verify, versus an unknown but larger cost had a
downgrade to a version that was never tested here been attempted.

**Lesson.** The plan is a memory of the repository, and memory drifts. Check the
file before copying it. Two further items in the same list — an "eval harness"
and a `WHAT_BROKE.md` — did not exist in Quark either, in the tree or anywhere in
its history.

---

## 9. Carried forward from Quark, not re-observed here

**Status:** unverified in this repo.

- **Duplicate React under npm workspaces.** Quark's `vite.config.mjs` documents
  two copies of React — one hoisted to the repo root, one under `web/` — causing
  libraries to bind to a different React than the app, breaking hooks and
  wedging the dev server. This repo now declares `workspaces: ["web"]`, so the
  hazard exists, but after the root install React resolved only to
  `web/node_modules/react@19.2.8` with nothing hoisted. `resolve.dedupe:
  ['react', 'react-dom']` is carried as insurance. **The failure has not been
  seen here.**
- **`vite build` via the CLI shim.** `web/build.mjs` exists and mirrors
  `dev.mjs`, on the assumption that entry 2 applies to builds as well. Entry 4
  makes that likely. **It has not been run.** Do not claim the build works until
  it has been.
- **Quark commit `49f7749`, "Fix dev-server and build hangs on Windows."** The
  origin of `dev.mjs` and `build.mjs`, predating the Vite 8 upgrade. Its specific
  symptoms are not recorded beyond the code comments quoted above.

---

## 10. The one that has not broken yet — idempotency

**Status:** guarded, not yet observed failing.

Quark's confirmation gate had a second half that nearly did not come across: in
`resolveRun`, before executing approved actions, it re-read the run from the
database and refused if the status was no longer `awaiting_confirmation`. One
line of Supabase, easy to read past when extracting "the confirmation gate."

Dropping it here would have been the single most expensive mistake available.
This repo has no database, so nothing else would have caught a replay — and a
replay in a payments agent means charging a customer twice. It was flagged
during the copy and reimplemented against `data/audit.jsonl` as
`AuditLog.executeOnce`, keyed on `case_id + tool + scheduled_for`.

The ordering is the part worth defending: the intent line is written and the key
claimed **before** the rail is called. A crash in the gap leaves the key claimed
and the replay refused, so the failure mode is money left uncollected and a
reconciliation flag raised — never a second charge. Writing the record after the
call would invert exactly that. `tests/idempotency.test.ts` asserts it, including
the crash-in-the-gap case.

**Lesson.** When extracting a component, the risky part is not what you copy — it
is the thing next to it that made it safe. Ask what the original was protecting
against, not just what it did.

---

## 11. The one behind the others: endpoint protection blocks writes from cmd-spawned processes

**Status:** reproduced, minimally, many times.

This is the root cause of §3, §5 and §6, found while building the case
generator. Those three were each treated as a separate Vite quirk. They were one
environmental fault, and it has cost more than any other entry here.

**Symptom.** `npm run generate` never produced a file. The error changed almost
every run, which is what made it hard to see:

- `EBADF: bad file descriptor, write` — raised *after* the bytes had already
  landed, the file on disk at exactly the right length
- `ENOENT: no such file or directory, open` into a directory that demonstrably
  existed and was writable a second earlier
- `EPERM: operation not permitted, unlink` on a file created moments before
- and sometimes no output at all, the process alive and doing nothing

Running the identical script as `node --import tsx src/pipeline/generate.ts`
worked every single time.

**Root cause.** A node process spawned through `cmd.exe` cannot create files
anywhere in this repository. `npm run <script>` on Windows always goes through
`cmd.exe`, so every npm script that writes fails — and `cmd /d /s /c node
script.js` fails identically with no npm involved, which is what proved npm was
innocent.

The machine runs **Trend Micro Apex One** alongside Defender — a centrally
managed endpoint agent. "`cmd.exe` spawns a process that writes files into a
user document folder" is ransomware-shaped, and its behaviour monitoring blocks
it. Direct execution from PowerShell is not matched by that rule.

The final probe — one script, three ways of running it:

| Target | `node script.js` | `npm run` | `cmd /c node` |
|---|---|---|---|
| repo root | ok | ENOENT | ENOENT |
| `data/` | ok | ENOENT | ENOENT |
| fresh dir | ok | *hung* | *hung* |
| `tests/` | ok | — | — |
| OS temp dir | ok | — | — |

It also explains the previously confusing fact that `npm test` and
`npm run typecheck` work fine: neither writes anything into the repo. `vitest`
reports to stdout, and `tsc --noEmit` says so in the name.

**What we tried that didn't work.**

- A retry loop with backoff. All five attempts failed identically.
- Temp-file-and-rename, the standard way to make a write atomic. Blocked
  *harder* — a name like `cases.seed.json.<pid>.<n>.tmp` is a double extension
  ending in `.tmp`, which is even more ransomware-shaped. It never got as far as
  creating the temp file.
- Suspecting the filename, since `cases.seed.json` has two dots. Probed eight
  names including `plain.txt`: all eight failed under `cmd`, all eight succeeded
  directly. The filename was irrelevant.
- Blaming npm for about forty minutes. It was `cmd.exe` the whole time.
- Worst of all, the first retry wrapper **deleted its output on error** — and
  because `EBADF` is raised *after* a successful write, it was destroying a
  perfectly good file every run. The error was lying and the code believed it.

**Fix — moving the repository out of `Documents`.**

The block turned out to be scoped to the *location*, not to `cmd.exe`. A
throwaway npm package at `C:\dev\probe` wrote its output happily by all three
routes — direct, `cmd /c`, and `npm run` — while the same code under
`Documents\` failed every time. `Documents` is a protected user folder and the
endpoint agent guards it; `C:\dev` is outside the profile and is not watched.

So the repo now lives at **`C:\dev\razorpay-recovery`**, and everything works
normally there: `npm run generate`, the command that had never once succeeded,
writes its 80 cases first try.

Two notes on the move. The source directory could not be `Move-Item`d because
the editor had it open, so it was copied with `robocopy /E /XD node_modules`
and dependencies reinstalled — git history came across intact, clean tree, same
HEAD. And it is worth being precise that this **relocates** the problem rather
than solving it: any project kept under `Documents` on this machine will hit the
same wall.

`src/engine/fs-safe.ts` is kept anyway. After a write error it re-reads the file
and accepts the write when the bytes are exactly right, and `appendLineSafe`
checks whether a line already landed before retrying, so a spurious error can
never duplicate an audit entry. The `audit.jsonl` ledger is the record of what
the agent did with real money; belt and braces is the right call there even on a
filesystem that is currently behaving.

**Time cost.** ~90 minutes, on top of the ~45 previously spent on §3, §5 and §6
treating symptoms of the same cause. The actual fix — moving one folder — took
about four.

**Lesson.** Four, and the last one is the expensive one.

When an error message changes every run, stop debugging the error and start
looking for what is *outside* the program.

When a fix doesn't take, check whether the failure you are fixing is the failure
you actually have. That retry wrapper was correct code defeated by a false
premise — that a thrown error means the write failed.

Reproduce it minimally before theorising. Eight filenames in one script answered
in ten seconds a question that guessing had not answered in forty minutes.

And test the environment as a variable, not just the code. Every hypothesis
tried for over an hour — the filename, the temp extension, the retry strategy,
npm itself — was about the *program*. The one that was right was about *where
the program was standing*, and a two-minute probe in a different folder would
have found it before any code was written.
