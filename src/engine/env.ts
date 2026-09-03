// Carried from Quark's server/src/env.ts, with the Supabase variables dropped —
// this repo has no database (BLUEPRINT §0: JSON files only).
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
config({ path: path.join(repoRoot, '.env') })

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    // Name only — never log secret values.
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`)
  }
  return value
}

/** Which provider the diagnose step talks to. See provider.ts. */
export type ProviderName = 'gemini' | 'groq'

export const env = {
  /**
   * Both providers are kept wired. Gemini's free tier is 20 requests/day, which
   * ran out mid-build; Groq's is 14,400. Switching is one line here rather than
   * a code change, and keeping both means a batch can be re-run against the
   * other to show the result is not an artefact of one model.
   */
  get LLM_PROVIDER(): ProviderName {
    const value = (process.env.LLM_PROVIDER ?? 'groq').toLowerCase()
    if (value !== 'gemini' && value !== 'groq') {
      throw new Error(`LLM_PROVIDER must be "gemini" or "groq", got "${value}"`)
    }
    return value
  },

  get GEMINI_API_KEY(): string {
    return required('GEMINI_API_KEY')
  },
  // gemini-2.5-flash is no longer offered to new API keys.
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',

  get GROQ_API_KEY(): string {
    return required('GROQ_API_KEY')
  },
  // Groq's catalogue moves — llama-3.3-70b-versatile 404s as of Sept 2026.
  // Check what a key can actually reach with:
  //   GET https://api.groq.com/openai/v1/models
  GROQ_MODEL: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
}
