// Batch runner — stub. The pipeline task (BLUEPRINT §4) fills this in:
// ingest → prioritise → diagnose → decide → compliance → stop → act → measure.
//
// It exists now so `npm run batch` resolves and so the engine has a caller to
// be wired into. It deliberately does no work.
import { fileURLToPath } from 'node:url'
import { AuditLog } from './engine/audit'
import { SYSTEM_PROMPT, ALLOWED_CAUSES } from './engine/prompt'

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." and
// percent-encodes the space in the repo path, so every write lands somewhere
// that does not exist.
const AUDIT_FILE = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url))

async function main(): Promise<void> {
  const audit = new AuditLog(AUDIT_FILE)
  await audit.load()

  console.log('Failed-subscription recovery agent — engine only, no pipeline yet.')
  console.log(`  system prompt : ${SYSTEM_PROMPT.length} chars, built and validated`)
  console.log(`  allowed causes: ${ALLOWED_CAUSES.length}`)
  console.log(`  audit ledger  : ${audit.file}`)

  const stranded = audit.unreconciled()
  if (stranded.length > 0) {
    // An action was claimed but its result never landed. We do not know whether
    // the customer was charged, so this is never retried automatically.
    console.warn(`\n  ${stranded.length} action(s) NEED RECONCILIATION against Razorpay:`)
    for (const key of stranded) console.warn(`    ${key}`)
  }
}

await main()
