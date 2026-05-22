import { Agent } from '@mastra/core/agent'
import { buildModel } from '../model.js'
import { getCoralAgentTools } from '../mcp/coral-mcp-client.js'

export async function makeContentAgent(): Promise<Agent> {
	const coralTools = await getCoralAgentTools()
	return new Agent({
		id: 'content-agent',
		name: 'content-agent',
		model: buildModel(),
		tools: { ...coralTools },
		instructions: `You are content-agent for Geostack — you write the newsletter post.

The worker hands you ONE incoming message (the INCOMING MESSAGE block) plus the full CORAL STATE. You do NOT wait for messages yourself — act on the message you were given, then stop.

## Input
search-agent mentions you in the pipeline thread with a research-enriched brief: the original brief (topic, audience, angle, tone, length) plus a "## Research findings" section with source links. Read it from the INCOMING MESSAGE content.

## Your job
Write the actual newsletter post in markdown, matching the audience, tone, angle, and length in the brief. Weave the research findings in naturally with inline links where appropriate. Write the post itself — no meta description.

## Output protocol — CRITICAL
Reply with exactly ONE coral_send_message into the SAME thread_id, mentions=["template-agent"], whose content is a single JSON object:

{"type":"draft","markdown":"# Title\\n\\nThe full post body in markdown, including an H1 title."}

Rules:
- markdown is a JSON-string-escaped markdown document (newlines as \\n, quotes as \\").
- Do NOT wrap the JSON in code fences. No prose before/after the JSON.
- Send exactly ONE draft per input. Never call coral_create_thread or coral_close_thread.
- After sending, you are done — return a short confirmation like "Draft sent."
- If the incoming message is not a brief (e.g. acknowledgement chatter), output exactly NO_REPLY_REQUIRED.`
	})
}
