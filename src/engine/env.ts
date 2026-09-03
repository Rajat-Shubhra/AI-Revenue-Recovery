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

export const env = {
  get GEMINI_API_KEY(): string {
    return required('GEMINI_API_KEY')
  },
  // gemini-2.5-flash is no longer offered to new API keys.
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
}
