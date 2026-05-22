import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Cost-tracking layer for cost:capability trials. Ported from farringdon's
 * Python `openrouter_price` + telemetry hooks, adapted to AI SDK usage
 * objects.
 *
 * AI SDK returns token usage on every generate result (and per-step). We
 * convert that into USD via pricing.yaml and accumulate per-turn +
 * cumulative totals, logged in the same shape as the prototype runtime's
 * proxy logs so numbers are comparable across runtimes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

interface PricingRow {
	input?: number
	output?: number
	context_window_tokens?: number
}

const pricingTable: Record<string, PricingRow> = (() => {
	try {
		const raw = readFileSync(join(__dirname, 'pricing.yaml'), 'utf-8')
		const parsed = parseYaml(raw) as { models?: Record<string, PricingRow> }
		return parsed?.models ?? {}
	} catch (err) {
		console.warn(`[cost] could not load pricing.yaml: ${(err as Error).message}`)
		return {}
	}
})()

const warnedUnknown = new Set<string>()

/** (inputPricePerToken, outputPricePerToken) in USD. Unknown model → 0,0. */
export function getModelPricing(modelId: string): { input: number; output: number } {
	const row = pricingTable[modelId]
	if (!row) {
		if (!warnedUnknown.has(modelId)) {
			warnedUnknown.add(modelId)
			console.warn(
				`[cost] no pricing.yaml row for "${modelId}" — cost will report 0. Add a row to track it.`
			)
		}
		return { input: 0, output: 0 }
	}
	return { input: (row.input ?? 0) / 1_000_000, output: (row.output ?? 0) / 1_000_000 }
}

export interface UsageLike {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
	promptTokens?: number
	completionTokens?: number
}

export interface UsageSummary {
	inputTokens: number
	outputTokens: number
	totalTokens: number
	estimatedCostUsd: number
}

/** Normalize an AI SDK usage object (handles both v4/v5 field names). */
function normalize(usage: UsageLike | undefined): { input: number; output: number } {
	if (!usage) return { input: 0, output: 0 }
	const input = usage.inputTokens ?? usage.promptTokens ?? 0
	const output = usage.outputTokens ?? usage.completionTokens ?? 0
	return { input, output }
}

export class CostTracker {
	private cumInput = 0
	private cumOutput = 0
	private cumCost = 0
	constructor(private readonly modelId: string) {}

	/** Score one generate() result's usage; returns this turn's summary. */
	record(usage: UsageLike | undefined): UsageSummary {
		const { input, output } = normalize(usage)
		const price = getModelPricing(this.modelId)
		const cost = input * price.input + output * price.output
		this.cumInput += input
		this.cumOutput += output
		this.cumCost += cost
		return {
			inputTokens: input,
			outputTokens: output,
			totalTokens: input + output,
			estimatedCostUsd: cost
		}
	}

	cumulative(): UsageSummary {
		return {
			inputTokens: this.cumInput,
			outputTokens: this.cumOutput,
			totalTokens: this.cumInput + this.cumOutput,
			estimatedCostUsd: this.cumCost
		}
	}
}

export function formatUsage(label: string, modelId: string, turn: UsageSummary, cum: UsageSummary): string {
	return (
		`[cost] ${label} model=${modelId} | ` +
		`turn in=${turn.inputTokens} out=${turn.outputTokens} $${turn.estimatedCostUsd.toFixed(6)} | ` +
		`cumulative in=${cum.inputTokens} out=${cum.outputTokens} $${cum.estimatedCostUsd.toFixed(6)}`
	)
}
