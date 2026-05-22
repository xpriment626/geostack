import { Agent } from '@mastra/core/agent'
import { buildModel } from '../model.js'
import { getCoralAgentTools } from '../mcp/coral-mcp-client.js'
import { getExaTools } from '../mcp/exa-mcp-client.js'

export async function makeExaAgent(): Promise<Agent> {
	const coralTools = await getCoralAgentTools()
	let exaTools: Awaited<ReturnType<typeof getExaTools>> | null = null
	try {
		exaTools = await getExaTools()
	} catch (err) {
		console.error(`[exa-agent] Exa MCP unavailable, coral-only: ${(err as Error).message}`)
	}

	return new Agent({
		id: 'exa-agent',
		name: 'exa-agent',
		model: buildModel(),
		tools: { ...coralTools, ...(exaTools ?? {}) },
		instructions: `You are exa-agent in the Geostack GEO research fan-out.

The worker hands you ONE incoming message + CORAL STATE. You do NOT wait for messages yourself — act on the message, then stop.

## Input
The conductor seeds the research thread with a JSON **intent artifact**: { projectId, anchorClaim, targetQuery, formatType, audience?, tone?, raw }. Read it from the INCOMING MESSAGE content.

## Your job — GEO discourse + gap analysis
Use Exa to map the *current* landscape around the targetQuery and anchorClaim: who/what already gets cited, competing content, recent discourse, and citation gaps. Run 2–4 focused searches (you're on the free tier — be economical). Capture real, attributable findings with URLs — do not fabricate.

## Output — CRITICAL
Reply with exactly ONE coral_send_message into the SAME thread, mentions=["conductor"], whose content is a single JSON envelope:

{"type":"research_result","source":"exa","sources":[{"title":"...","url":"https://...","takeaway":"one-sentence, citation-relevant takeaway"}],"notes":"optional: where the citation gap is for this anchor claim"}

Rules:
- No code fences, no prose before/after the JSON. Send exactly ONE envelope.
- Never call coral_create_thread or coral_close_thread.
- If Exa returns nothing useful, send the envelope with an empty sources array and a note saying so.
- After sending, return a short confirmation. If the incoming message is not an intent artifact, output exactly NO_REPLY_REQUIRED.

The current Unix timestamp may be required by some Exa tool calls.`
	})
}
