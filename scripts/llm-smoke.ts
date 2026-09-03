// One live call, to prove the wiring works before a batch spends the allowance.
// Not part of the pipeline; run it by hand.
import { loadCases } from '../src/pipeline/ingest'
import { applyRules } from '../src/pipeline/rules'
import { liveLlmDiagnoser, emptyLlmStats } from '../src/pipeline/llm-diagnose'
import { defaultProvider } from '../src/engine/provider'

const ambiguous = loadCases().filter((c) => applyRules(c) === null)
const kase = ambiguous[0]!
const provider = defaultProvider()

console.log(`provider: ${provider.name} (${provider.model})`)
console.log(`${ambiguous.length} cases would reach the model in a full batch.`)
console.log(`Calling once, for ${kase.id} (${kase.error.source}/${kase.error.reason}).`)
console.log(`description shown to the model: "${kase.error.description}"\n`)

const stats = emptyLlmStats()
const answer = await liveLlmDiagnoser(stats, provider)(kase)

console.log('answer:', JSON.stringify(answer, null, 2))
console.log('stats :', JSON.stringify(stats))
console.log(`\nground truth (never shown to the model): ${kase._true_cause}`)
console.log(answer ? (answer.cause === kase._true_cause ? '✓ correct' : '✗ wrong') : '— no answer')
