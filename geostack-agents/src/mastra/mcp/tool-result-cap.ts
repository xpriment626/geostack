/**
 * Tool-result size cap — the structural guardrail against the deepwiki cost
 * blowup (a single read_wiki_contents dump, re-fed as input across a 12-step
 * generate(), ballooned one turn to 617K input tokens / ~$0.27).
 *
 * MCP tool results are re-sent as model input on every subsequent step, so an
 * unbounded result compounds quadratically. We wrap each external-content tool's
 * `execute` to truncate oversized text blocks BEFORE they re-enter context. The
 * truncation marker also nudges the model to ask a narrower question instead.
 *
 * Applied to the research toolsets (deepwiki, exa) — NOT the coral messaging
 * tools, whose results are small acks/state. Each agent runs in its own worker
 * process, so wrapping mutates only that process's tool objects.
 */

const DEFAULT_MAX_CHARS = Number(process.env.GEOSTACK_TOOL_RESULT_MAX_CHARS ?? 24_000)

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return (
		s.slice(0, max) +
		`\n\n…[truncated ${s.length - max} chars by Geostack tool-result cap — ask a narrower question or a more specific tool to get focused detail]`
	)
}

/** Cap the text payload of a single MCP tool result, sharing one budget across blocks. */
function capResult(result: unknown, maxChars: number): unknown {
	try {
		if (typeof result === 'string') return truncate(result, maxChars)
		if (result && typeof result === 'object') {
			const r = result as { content?: unknown[] }
			if (Array.isArray(r.content)) {
				let budget = maxChars
				r.content = r.content.map((block) => {
					const b = block as { text?: unknown }
					if (b && typeof b.text === 'string') {
						const capped = truncate(b.text, Math.max(0, budget))
						budget -= Math.min(b.text.length, maxChars)
						return { ...b, text: capped }
					}
					return block
				})
			}
		}
		return result
	} catch {
		return result
	}
}

/** Wrap each tool's `execute` to cap its result. Returns the same object (mutated in place). */
export function capToolResults<T extends Record<string, unknown>>(tools: T, maxChars = DEFAULT_MAX_CHARS): T {
	for (const tool of Object.values(tools)) {
		const t = tool as { execute?: (...args: unknown[]) => Promise<unknown> }
		if (t && typeof t.execute === 'function') {
			const orig = t.execute.bind(t)
			t.execute = async (...args: unknown[]) => capResult(await orig(...args), maxChars)
		}
	}
	return tools
}
