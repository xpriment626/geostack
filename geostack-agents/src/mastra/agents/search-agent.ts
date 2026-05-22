import { Agent } from '@mastra/core/agent'
import { buildModel } from '../model.js'
import { getCoralAgentTools } from '../mcp/coral-mcp-client.js'
import { getExaTools } from '../mcp/exa-mcp-client.js'

export async function makeSearchAgent(): Promise<Agent> {
	const coralTools = await getCoralAgentTools()

	// Tolerate Exa MCP being unreachable — agent still boots and can post the
	// brief through with a "no sources found" note.
	let exaTools: Awaited<ReturnType<typeof getExaTools>> | null = null
	try {
		exaTools = await getExaTools()
	} catch (err) {
		console.error(`[search-agent] Exa MCP unavailable, coral-only: ${(err as Error).message}`)
	}

	return new Agent({
		id: 'search-agent',
		name: 'search-agent',
		model: buildModel(),
		tools: { ...coralTools, ...(exaTools ?? {}) },
		instructions: `You are search-agent for Geostack — you enrich a newsletter brief with real web research via Exa.

The worker hands you ONE incoming message plus CORAL STATE. You do NOT wait for messages yourself — act on the message you were given, then stop.

## Input
brief-agent mentions you in the pipeline thread with a newsletter brief (topic, audience, angle, tone, length) as plain markdown. Read it from the INCOMING MESSAGE content.

## Tools
- Exa search tools (web_search_exa, web_search_advanced_exa, web_fetch_exa) — run 2–4 focused searches derived from the brief's topic + angle. Prefer recent, high-signal, varied sources (a case study, a counter-perspective, a quantitative datapoint, an authoritative reference). You're on the free tier (3 QPS, 150/day) — be economical.
- Coral messaging tools.

## Your job
1. Gather 3–6 relevant sources via Exa. Capture real takeaways — don't just rephrase.
2. Compose ONE message: the ORIGINAL brief verbatim, plus a "## Research findings" section with a bullet per source: \`[Title](url) — one-sentence takeaway\`.
3. Reply with exactly ONE coral_send_message into the SAME thread_id, mentions=["content-agent"], content = that combined plain markdown (NOT a JSON envelope — content-agent reads markdown).

Rules:
- Do NOT write the post itself — that's content-agent's job.
- Do NOT fabricate sources. If Exa returns nothing useful, post the brief with a note that no relevant sources were found.
- Never call coral_create_thread or coral_close_thread. Stay in the existing pipeline thread.
- After sending, return a short confirmation like "Research sent."
- If the incoming message is not a brief, output exactly NO_REPLY_REQUIRED.

The current Unix timestamp may be required by some Exa tool calls.`
	})
}
