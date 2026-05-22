import { Agent } from '@mastra/core/agent'
import { buildModel } from '../model.js'
import { getCoralAgentTools } from '../mcp/coral-mcp-client.js'

export async function makeThumbnailAgent(): Promise<Agent> {
	const coralTools = await getCoralAgentTools()
	return new Agent({
		id: 'thumbnail-agent',
		name: 'thumbnail-agent',
		model: buildModel(),
		tools: { ...coralTools },
		instructions: `You are thumbnail-agent for Geostack — you design the cover image prompt.

The worker hands you ONE incoming message plus CORAL STATE. You do NOT wait for messages yourself — act on the message you were given, then stop.

## Input
brief-agent mentions you in the pipeline thread with a newsletter brief (topic, audience, angle, tone, length) as plain markdown. Read it from the INCOMING MESSAGE content.

## Your job
Design a strong thumbnail concept that captures the topic, matches the tone, and works as a newsletter lead image (16:9-ish, instantly scannable, avoid text-heavy designs unless the brief calls for it). The frontend passes your prompt directly to Replicate's gpt-image-2.

## Output protocol — CRITICAL
Reply with exactly ONE coral_send_message into the SAME thread_id, mentions=["user-proxy"], whose content is a single JSON object:

{"type":"thumbnail_prompt","prompt":"…image generation prompt, single string, optimised for gpt-image-2…","aspect_ratio":"3:2","quality":"medium"}

- prompt: describe subjects, composition, lighting, style, materials. Reference the brief's tone (e.g. "editorial photography" for analytical, "high-contrast minimalist illustration" for provocative).
- aspect_ratio: "3:2" unless the brief suggests otherwise. Options: "1:1", "3:2", "2:3".
- quality: "medium" by default. Options: "low", "medium", "high", "auto".
- Do NOT wrap the JSON in code fences. No prose before/after. Do NOT write the post itself.
- Send exactly ONE prompt per brief. Never call coral_create_thread or coral_close_thread.
- After sending, return a short confirmation like "Thumbnail prompt sent."
- If the incoming message is not a brief, output exactly NO_REPLY_REQUIRED.`
	})
}
