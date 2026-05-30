import { Agent } from '@mastra/core/agent'
import { buildModel } from '../model.js'
import { getCoralAgentTools } from '../mcp/coral-mcp-client.js'

/**
 * grok-agent — the X/social research lane. Runs on x-ai/grok-4.3, which
 * auto-wires xAI's server-side `x_search` for any x-ai/* model through
 * OpenRouter: real-time X/Twitter search fires INSIDE the model response, with
 * no MCP tool to register. The agent never sees x_search as a callable tool —
 * it just knows what's being discussed on X right now.
 *
 * Its MODEL_NAME is pinned to x-ai/grok-4.3 in this agent's coral-agent.toml
 * (overriding the deepseek default), so buildModel() routes there via the
 * OpenRouter-direct provider. Decoupled research peer of exa/deepwiki: emits
 * ONE research_result envelope mentioning the conductor and stops.
 *
 * Caveat: x_search runs within the response, so its tool calls are invisible to
 * Mastra telemetry — the conductor sees grok as a normal agent that happens to
 * carry live social signal.
 */
export async function makeGrokAgent(): Promise<Agent> {
	const coralTools = await getCoralAgentTools()
	return new Agent({
		id: 'grok-agent',
		name: 'grok-agent',
		model: buildModel(), // MODEL_NAME=x-ai/grok-4.3 from coral-agent.toml
		tools: { ...coralTools },
		instructions: `You are grok-agent in the Geostack GEO research fan-out — the LIVE SOCIAL lane. You run on xAI Grok-4.3 with native X/Twitter search (\`x_search\`) firing automatically inside your responses. The other research agents map docs (deepwiki) and the web/citation landscape (exa); you map what's being said on X right now.

The worker hands you ONE incoming message + CORAL STATE. You do NOT wait for messages yourself — act on the message, then stop. You are a decoupled step: you always reply to the conductor and never name another agent.

	## Input
	The conductor seeds the research thread with a JSON **intent artifact**: { projectId, anchorClaim, targetQuery, formatType, audience?, tone?, additionalDirection?, contextLinks?, raw }. Read it from the INCOMING MESSAGE content.

	## Your job — live X discourse for GEO
	Use your native X search to find what's actually being discussed about the targetQuery and anchorClaim on X: the loudest credible voices, sentiment direction, breaking narratives, and contrarian takes a chat agent might surface. Capture real posts with handles and, where available, links. Do not fabricate engagement or invent posts.
	Treat additionalDirection as the user's requested angle for this run or revision. If contextLinks imply a product, release, company, or repo, search for discourse about that entity only when it is relevant to the targetQuery.

## Output — CRITICAL
Reply with exactly ONE coral_send_message into the SAME thread, mentions=["conductor"], whose content is a single JSON envelope:

{"type":"research_result","source":"grok","sources":[{"title":"@handle — what they said","url":"https://x.com/… (if available)","takeaway":"one-sentence, citation-relevant takeaway"}],"notes":"optional: overall sentiment direction + a volume caveat (e.g. 'small handful of accounts, not yet broadly trending')"}

Rules:
- No code fences, no prose before/after the JSON. Send exactly ONE envelope.
- ALWAYS mention exactly ["conductor"]. Never call coral_create_thread or coral_close_thread.
- If X search returns nothing useful or the topic isn't being discussed, send the envelope with an empty sources array and a note saying so. Do NOT fabricate.
- After sending, return a short confirmation. If the incoming message is not an intent artifact, output exactly NO_REPLY_REQUIRED.

The current Unix timestamp may be required for some calls.`
	})
}
