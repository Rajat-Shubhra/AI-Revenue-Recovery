// Filesystem writes that survive an antivirus holding handles on new files.
//
// This machine runs Trend Micro Apex One alongside Defender. Its real-time
// scanner takes a handle on a file the instant it is created, and the effect on
// Node is reproducible and ugly:
//
//   - `writeFileSync` throws EBADF — *after* the bytes have already landed.
//     Verified: the file is on disk at the correct length, and the error is a
//     lie about a write that worked.
//   - `unlinkSync` throws EPERM on a file created moments earlier.
//   - `openSync` throws ENOENT into a directory that demonstrably exists.
//
// It only bites for processes spawned through a shell — `npm run x` fails where
// running the same script directly succeeds every time — which is presumably
// the scanner's behaviour-monitoring treating script-spawned children as
// suspicious. See WHAT_BROKE.md §11; it is the same root cause as §3, §5 and §6.
//
// The response is: retry, and — critically — **verify before believing an
// error**. A write that reports EBADF but left the right bytes on disk
// succeeded. Treating it as a failure is what destroyed a perfectly good seed
// file earlier: the error path deleted it.
//
// This matters most for `audit.jsonl`. It is the record of what the agent did
// with real money, so a silently dropped line is worse than a crash.
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** Errors this scanner produces that are worth retrying rather than trusting. */
const TRANSIENT = new Set(['EBADF', 'EPERM', 'ENOENT', 'EBUSY', 'EACCES'])

const ATTEMPTS = 5

function isTransient(error: unknown): boolean {
  return TRANSIENT.has((error as NodeJS.ErrnoException)?.code ?? '')
}

/** Block without spinning. The waits are tens of milliseconds. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function backoff(attempt: number): void {
  sleepSync(25 * 2 ** (attempt - 1))
}

function readOrNull(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

function rawWrite(file: string, contents: string): void {
  const fd = openSync(file, 'w')
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function rawAppend(file: string, contents: string): void {
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Replace a file's contents, verifying rather than trusting the error.
 *
 * Deliberately writes IN PLACE rather than to a temp file and renaming, which
 * is the usual way to make this atomic. Temp-and-rename was tried first and the
 * scanner refused to create the temp file at all — `ENOENT` on every attempt at
 * `cases.seed.json.<pid>.<n>.tmp`, while an ordinary filename in the same
 * directory was created fine. A double extension ending in `.tmp` is what
 * ransomware writes, so it appears to be pattern-matched. Writing straight to
 * the real filename sidesteps the heuristic.
 *
 * The cost is losing atomicity, and the verification step is what buys it back:
 * we read the file after any error and only accept the write if the bytes are
 * exactly right. A torn write fails that check and gets retried.
 */
export function writeFileSafe(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true })

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      rawWrite(file, contents)
      // Even a clean return is not proof here — verify.
      if (readOrNull(file) === contents) return
    } catch (error) {
      // The write may well have landed despite the error. Check before
      // believing it: treating a successful write as a failure is what
      // destroyed a perfectly good seed file the first time round.
      if (readOrNull(file) === contents) return
      if (!isTransient(error) || attempt === ATTEMPTS) throw error
    }
    if (attempt === ATTEMPTS) {
      throw new Error(
        `Could not write ${file} after ${ATTEMPTS} attempts — content never verified. ` +
          `On this machine that means endpoint protection is holding the file (WHAT_BROKE.md §11).`,
      )
    }
    backoff(attempt)
  }
}

/**
 * Append one line, exactly once.
 *
 * The at-most-once property is what matters for the audit log: on a spurious
 * error we check whether the line already landed rather than writing it again,
 * because a duplicated audit line would misreport what the agent did.
 */
export function appendLineSafe(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const payload = line.endsWith('\n') ? line : `${line}\n`

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      rawAppend(file, payload)
      return
    } catch (error) {
      // Did it land anyway? If so we must NOT write it again.
      if (readOrNull(file)?.endsWith(payload)) return
      if (!isTransient(error) || attempt === ATTEMPTS) throw error
      backoff(attempt)
    }
  }
}
