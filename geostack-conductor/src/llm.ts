/**
 * Minimal OpenRouter chat client for conductor-side LLM work (intent capture).
 *
 * Deliberately a plain fetch — the conductor stays dependency-light (hono / zod
 * / libsql). The agents use the AI SDK for tool-calling + reasoning round-trips;
 * a 1:1 interview needs none of that, just chat completions.
 *
 * Key resolution mirrors the agents: OPENROUTER_API_KEY from ~/.geostack/config
 * (canonical) or a genuine shell env var. Model defaults to the fleet's
 * deepseek-v4-pro; override with INTENT_MODEL.
 */

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant'
	content: string
}

export interface ChatResult {
	content: string
	model: string
	usage: { inputTokens: number; outputTokens: number }
}

const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro'

export async function chat(
	messages: ChatMessage[],
	opts?: { model?: string; temperature?: number }
): Promise<ChatResult> {
	const apiKey = process.env.OPENROUTER_API_KEY || process.env.MODEL_API_KEY
	if (!apiKey) {
		throw new Error('OPENROUTER_API_KEY not set — add it in Settings (~/.geostack/config)')
	}
	const baseURL = process.env.MODEL_BASE_URL || 'https://openrouter.ai/api/v1'
	const model = opts?.model || process.env.INTENT_MODEL || DEFAULT_MODEL

	const r = await fetch(`${baseURL}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`,
			'x-title': 'Geostack'
		},
		body: JSON.stringify({ model, messages, temperature: opts?.temperature ?? 0.4 })
	})
	if (!r.ok) {
		const body = await r.text().catch(() => '')
		throw new Error(`openrouter ${r.status}: ${body.slice(0, 300)}`)
	}
	const data = (await r.json()) as {
		choices?: { message?: { content?: string } }[]
		usage?: { prompt_tokens?: number; completion_tokens?: number }
	}
	return {
		content: data.choices?.[0]?.message?.content ?? '',
		model,
		usage: {
			inputTokens: data.usage?.prompt_tokens ?? 0,
			outputTokens: data.usage?.completion_tokens ?? 0
		}
	}
}
