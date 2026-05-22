import { createOpenRouter } from '@openrouter/ai-sdk-provider'

/**
 * Build the AI SDK language model for a Geostack agent.
 *
 * Geostack calls OpenRouter DIRECTLY (no Coral LLM proxy) — the "more model
 * flexibility" tier. The model id comes from the per-agent `MODEL_NAME` Coral
 * option, so swapping models for a trial is a one-line change in that agent's
 * coral-agent.toml — any OpenRouter model, no whitelist.
 *
 * We use the official `@openrouter/ai-sdk-provider` (not the generic
 * `@ai-sdk/openai`) specifically for DIVERSE MODEL SUPPORT: it round-trips
 * `reasoning_details` across multi-step tool calls and normalizes the
 * provider-specific thinking-block / signature quirks that otherwise break
 * reasoning models (deepseek, minimax, etc.) mid-task. It also exposes clean
 * reasoning control via `reasoning.effort`.
 *
 * REASONING_EFFORT (per-agent Coral option, optional): 'high' | 'medium' |
 * 'low' → passed through as reasoning.effort. Unset/unknown leaves the model's
 * default reasoning behavior. Non-reasoning models ignore it, so it's safe to
 * set globally. (This provider version types effort as high|medium|low; finer
 * control like disable/xhigh isn't exposed here.)
 */

type ReasoningEffort = 'high' | 'medium' | 'low'
const EFFORTS: ReasoningEffort[] = ['high', 'medium', 'low']

function reasoningSetting(): { reasoning: { effort: ReasoningEffort } } | undefined {
	const raw = (process.env.REASONING_EFFORT || '').trim().toLowerCase()
	return (EFFORTS as string[]).includes(raw) ? { reasoning: { effort: raw as ReasoningEffort } } : undefined
}

export function buildModel(modelOverride?: string) {
	// `||` (not `??`) so an empty-string env var (an unset Coral option
	// materialized as "") falls through to the next source.
	const modelName = modelOverride || process.env.MODEL_NAME || 'anthropic/claude-haiku-4.5'
	const baseURL = process.env.MODEL_BASE_URL || 'https://openrouter.ai/api/v1'
	const apiKey = process.env.MODEL_API_KEY || process.env.OPENROUTER_API_KEY || ''

	if (!apiKey) {
		console.warn(
			'[model] No MODEL_API_KEY / OPENROUTER_API_KEY set — OpenRouter calls will 401. Fill geostack-agents/.env.'
		)
	}

	const openrouter = createOpenRouter({ apiKey, baseURL })
	return openrouter(modelName, reasoningSetting())
}

/** The resolved model id, for cost attribution + logging. */
export function activeModelId(): string {
	return process.env.MODEL_NAME || 'anthropic/claude-haiku-4.5'
}
