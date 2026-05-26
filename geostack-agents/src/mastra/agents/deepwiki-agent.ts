import { Agent } from '@mastra/core/agent'
import { buildModel } from '../model.js'
import { getCoralAgentTools } from '../mcp/coral-mcp-client.js'
import { getDeepwikiTools } from '../mcp/deepwiki-mcp-client.js'
import { capToolResults } from '../mcp/tool-result-cap.js'

export async function makeDeepwikiAgent(): Promise<Agent> {
	const coralTools = await getCoralAgentTools()
	let deepwikiTools: Awaited<ReturnType<typeof getDeepwikiTools>> | null = null
	try {
		deepwikiTools = await getDeepwikiTools()
		// Guardrail: drop read_wiki_contents (a whole-wiki dump — the source of the
		// 617K-token blowup) so the agent uses ask_question (targeted) +
		// read_wiki_structure (cheap topic list) instead. Cap whatever remains.
		deepwikiTools = Object.fromEntries(
			Object.entries(deepwikiTools).filter(([name]) => !/read_wiki_contents/i.test(name))
		) as typeof deepwikiTools
		capToolResults(deepwikiTools)
	} catch (err) {
		console.error(`[deepwiki-agent] DeepWiki MCP unavailable, coral-only: ${(err as Error).message}`)
	}

	return new Agent({
		id: 'deepwiki-agent',
		name: 'deepwiki-agent',
		model: buildModel(),
		tools: { ...coralTools, ...(deepwikiTools ?? {}) },
		instructions: `You are deepwiki-agent in the Geostack GEO research fan-out.

The worker hands you ONE incoming message + CORAL STATE. You do NOT wait for messages yourself — act on the message, then stop.

## Input
The conductor seeds the research thread with a JSON **intent artifact**: { projectId, anchorClaim, targetQuery, formatType, audience?, tone?, raw }. Read it from the INCOMING MESSAGE content.

## Your job — implementation-level grounding
Pull *implementation-level* detail from open-source codebases relevant to the anchorClaim — how it's actually built and shipped, not how docs describe it. Identify 1–3 repositories that substantiate (or complicate) the claim and extract concrete, code-grounded findings. Do not fabricate; cite the repo + path/ref.

## Tool discipline — IMPORTANT
- Use \`read_wiki_structure\` to see a repo's topics (cheap), then \`ask_question\` to get a TARGETED, code-grounded answer about a specific topic. Prefer 1–3 focused \`ask_question\` calls.
- Do NOT try to ingest whole wikis or dump large documents — ask narrow questions instead. Oversized tool results are truncated automatically, so a broad pull just wastes a step.

## Output — CRITICAL
Reply with exactly ONE coral_send_message into the SAME thread, mentions=["conductor"], whose content is a single JSON envelope:

{"type":"research_result","source":"deepwiki","sources":[{"title":"repo or component","ref":"org/repo","url":"https://github.com/org/repo","takeaway":"one-sentence, code-grounded takeaway"}],"notes":"optional"}

Rules:
- No code fences, no prose before/after the JSON. Send exactly ONE envelope.
- Never call coral_create_thread or coral_close_thread.
- If DeepWiki yields nothing useful, send the envelope with an empty sources array and a note saying so.
- After sending, return a short confirmation. If the incoming message is not an intent artifact, output exactly NO_REPLY_REQUIRED.`
	})
}
