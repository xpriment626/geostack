/**
 * Retry helper for remote MCP tool-loading.
 *
 * The research agents (exa, deepwiki) load their tools from hosted MCP servers
 * at cold start. A single transient handshake failure there used to drop the
 * tools entirely → the agent ran "coral-only", returned empty sources, and the
 * synthesis stage shipped an UNGROUNDED article with a hallucination disclaimer.
 * The servers are reliable in steady state, so a few quick retries turn a
 * one-off blip into a non-event.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	opts?: { attempts?: number; baseMs?: number; label?: string }
): Promise<T> {
	const attempts = opts?.attempts ?? 3
	const baseMs = opts?.baseMs ?? 400
	let lastErr: unknown
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fn()
		} catch (e) {
			lastErr = e
			if (i < attempts) {
				console.warn(
					`[mcp] ${opts?.label ?? 'tool load'} attempt ${i}/${attempts} failed: ${(e as Error).message.slice(0, 120)} — retrying`
				)
				await new Promise((r) => setTimeout(r, baseMs * i))
			}
		}
	}
	throw lastErr
}
