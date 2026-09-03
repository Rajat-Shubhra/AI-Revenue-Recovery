// Carried from Quark: server/src/agent/provider.ts. Nothing in it was
// notes/kanban-coupled — it is a bare Gemini REST client — so it comes across
// unchanged apart from the import path.
//
// It is hand-rolled `fetch`, not the Google SDK. That is deliberate: it is the
// version already debugged against a live key, including the two failure modes
// below (never echo the response body, which can contain the key; and treat a
// promptFeedback block as an error rather than an empty answer).
import { env } from './env'

/**
 * One interface, so swapping Gemini for another provider later touches this
 * file only. Both take a system prompt and a user message and return text.
 */
export type AgentProvider = {
  name: string
  model: string
  complete(systemPrompt: string, userMessage: string): Promise<string>
}

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

export function geminiProvider(model = env.GEMINI_MODEL): AgentProvider {
  return {
    name: 'gemini',
    model,
    async complete(systemPrompt, userMessage) {
      const response = await fetch(
        `${GEMINI_ENDPOINT}/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
              // Makes Gemini return bare JSON with no markdown fences.
              response_mime_type: 'application/json',
              // Classification should be stable, not creative.
              temperature: 0.2,
            },
          }),
        },
      )

      if (!response.ok) {
        // Never surface the body verbatim to the client — it can echo the key.
        const detail = await response.text()
        console.error(`[agent] gemini ${response.status}: ${detail.slice(0, 500)}`)
        throw new Error(`Model request failed (${response.status})`)
      }

      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
        promptFeedback?: { blockReason?: string }
      }

      if (body.promptFeedback?.blockReason) {
        throw new Error(`Model declined to answer (${body.promptFeedback.blockReason})`)
      }

      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
      if (!text.trim()) throw new Error('Model returned an empty response')
      return text
    },
  }
}
