import { MCPClient } from '@mastra/mcp'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

/**
 * Coral MCP connection. coral-server injects CORAL_CONNECTION_URL into the
 * executable agent's environment; it already encodes the per-agent MCP
 * path, so we use it verbatim (matches the fabrick reference).
 */
const coralUrl = process.env.CORAL_CONNECTION_URL

export const coralMcpClient = coralUrl
	? new MCPClient({
			id: 'coral-mcp-client',
			timeout: 1_200_000,
			servers: {
				coral: { url: new URL(coralUrl) }
			}
		})
	: null

export async function getCoralTools() {
	if (!coralMcpClient) return {}
	return await coralMcpClient.listTools()
}

/**
 * Coral tools for an agent's LLM, with `wait_for_mention` removed. The
 * outer worker loop owns waiting (farringdon pattern) — letting the LLM
 * call wait_for_mention itself re-introduces the per-iteration token burn
 * we saw on the prototype runtime. We also drop close_thread; only the
 * orchestrator (brief-agent) manages thread lifecycle, and it does so via
 * the worker, not the LLM.
 */
export async function getCoralAgentTools(opts: { allowCloseThread?: boolean } = {}) {
	if (!coralMcpClient) return {}
	const all = await coralMcpClient.listTools()
	const filtered: Record<string, unknown> = {}
	for (const [key, tool] of Object.entries(all)) {
		if (/wait_for_mention/.test(key)) continue
		if (!opts.allowCloseThread && /close_thread/.test(key)) continue
		filtered[key] = tool
	}
	return filtered as typeof all
}

/** Raw access to the coral toolset (resolved tool objects) for the worker loop. */
export async function getCoralToolset(): Promise<Record<string, { execute?: (args: unknown, ctx: unknown) => Promise<unknown> }>> {
	if (!coralMcpClient) return {}
	const toolsets = await coralMcpClient.listToolsets()
	return (toolsets.coral ?? {}) as Record<string, { execute?: (args: unknown, ctx: unknown) => Promise<unknown> }>
}

/** Read the coral://state resource and return parsed JSON (or { raw }). */
export async function readCoralState(): Promise<unknown> {
	if (!coralMcpClient) return { error: 'no CORAL_CONNECTION_URL' }
	const result = await coralMcpClient.resources.read('coral', 'coral://state')
	const firstText = result.contents.find(
		(c): c is { uri: string; text: string; mimeType?: string } => 'text' in c
	)
	if (!firstText) return { error: 'coral://state returned no text' }
	try {
		return JSON.parse(firstText.text)
	} catch {
		return { raw: firstText.text }
	}
}

/**
 * coral_read_state surfaced as a tool, so an agent's LLM can inspect threads
 * mid-turn (e.g. brief-agent deriving the active thread + sender). Mastra
 * surfaces resources via resources.read() but does not auto-expose them as
 * tools — this wrapper bridges that.
 */
export const coralReadStateTool = createTool({
	id: 'coral_read_state',
	description:
		'Returns the full Coral session state snapshot (agents you can see + threads you participate in, with messages). Call after a mention to find the active thread id and who to mention back.',
	inputSchema: z.object({}).describe('No inputs — returns the full session state snapshot.'),
	execute: async () => readCoralState()
})

export function getCoralStateReadTool() {
	return { coral_read_state: coralReadStateTool }
}
