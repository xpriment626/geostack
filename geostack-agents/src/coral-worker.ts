import type { Agent } from '@mastra/core/agent'
import { agentFactories, isAgentKey, agentMaxSteps, type AgentKey } from './mastra/index.js'
import { getCoralToolset, readCoralState } from './mastra/mcp/coral-mcp-client.js'
import { CostTracker, formatUsage } from './mastra/cost-tracker.js'
import { activeModelId } from './mastra/model.js'

/**
 * Geostack executable-runtime worker. Mirrors the farringdon production
 * loop, in TypeScript/Mastra:
 *
 *   1. The WORKER owns coral_wait_for_mention (the LLM never calls it).
 *   2. On a mention, run ONE multi-step agent.generate() — the LLM does its
 *      reasoning + tool calls + coral_send_message reply within that single
 *      call (so a thinking model's reasoning is preserved across the steps
 *      of a task).
 *   3. Score token usage → USD via the cost tracker, log per-turn +
 *      cumulative.
 *   4. NO_REPLY_REQUIRED short-circuits non-actionable chatter (no wasted
 *      re-engagement).
 *
 * OpenRouter-direct: the model id comes from each agent's MODEL_NAME Coral
 * option. Swap models for a trial by editing that option — any OpenRouter
 * model, no whitelist.
 */

const NO_REPLY = 'NO_REPLY_REQUIRED'

// Bounded per-turn generate retry — recovers a transient truncated/5xx upstream
// response (the synthesis star mentions each agent only once, so without this a
// single flaky response would fail the whole run). 2 ⇒ one retry.
const GENERATE_ATTEMPTS = Number(process.env.GEOSTACK_GENERATE_ATTEMPTS ?? 2)
const GENERATE_RETRY_MS = Number(process.env.GEOSTACK_GENERATE_RETRY_MS ?? 2500)

const rawKey = process.argv[2]
if (!rawKey || !isAgentKey(rawKey)) {
	console.error(
		`Usage: coral-worker.ts <agentKey>\n  agentKey ∈ { ${Object.keys(agentFactories).join(', ')} }`
	)
	process.exit(1)
}
const agentKey: AgentKey = rawKey

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [${agentKey}] ${msg}`)

log(`Booted. agentId=${process.env.CORAL_AGENT_ID} session=${process.env.CORAL_SESSION_ID}`)
log(`Model=${activeModelId()} (OpenRouter direct)`)

// ---- coral toolset (worker-owned wait/send) ---------------------------------

interface CoralToolset {
	[key: string]: { execute?: (args: unknown, ctx: unknown) => Promise<unknown> }
}

function findTool(toolset: CoralToolset, pattern: RegExp) {
	const entry = Object.entries(toolset).find(([k]) => pattern.test(k))
	return entry?.[1]
}

interface IncomingMessage {
	id: string
	threadId: string
	text: string
	senderName: string
}

/** Defensively pull a SessionThreadMessage out of the wait tool result. */
function parseWaitResult(result: unknown): IncomingMessage | null {
	let obj: any = result
	// MCP tool results may arrive wrapped in { content: [{ type:'text', text }] }
	if (obj && typeof obj === 'object' && Array.isArray(obj.content)) {
		const textBlock = obj.content.find((c: any) => typeof c?.text === 'string')
		if (textBlock) {
			try {
				obj = JSON.parse(textBlock.text)
			} catch {
				/* leave as-is */
			}
		}
	}
	if (obj && typeof obj === 'object' && 'structuredContent' in obj) obj = obj.structuredContent
	const msg = obj?.message ?? obj
	if (!msg || typeof msg !== 'object' || typeof msg.text !== 'string') return null
	if (!msg.threadId || !msg.senderName) return null
	return {
		id: String(msg.id ?? `${msg.threadId}:${msg.senderName}:${msg.text.slice(0, 24)}`),
		threadId: String(msg.threadId),
		text: String(msg.text),
		senderName: String(msg.senderName)
	}
}

// ---- main loop --------------------------------------------------------------

async function main() {
	const toolset = (await getCoralToolset()) as CoralToolset
	const waitTool = findTool(toolset, /wait_for_mention/)
	if (!waitTool?.execute) {
		log('FATAL: coral_wait_for_mention not available — cannot run.')
		process.exit(1)
	}

	const agent: Agent = await agentFactories[agentKey]()
	const maxSteps = agentMaxSteps[agentKey] ?? 20
	const cost = new CostTracker(activeModelId())
	log('Agent ready. Entering wait_for_mention loop.')

	let cursorMs = 0 // first wait replays pre-existing mentions; then advances
	const handled = new Set<string>()
	let iteration = 0
	let consecutiveWaitErrors = 0
	const MAX_WAIT_ERRORS = 5 // exit after this many — session likely torn down

	while (true) {
		const beforeWait = Date.now()
		let waitResult: unknown
		try {
			waitResult = await waitTool.execute({ currentUnixTime: cursorMs, maxWaitMs: 60000 }, {})
			consecutiveWaitErrors = 0
		} catch (err) {
			consecutiveWaitErrors += 1
			log(
				`wait_for_mention errored (${consecutiveWaitErrors}/${MAX_WAIT_ERRORS}): ${(err as Error).message}`
			)
			if (consecutiveWaitErrors >= MAX_WAIT_ERRORS) {
				log('Coral connection gone (session likely ended) — exiting cleanly.')
				process.exit(0)
			}
			await new Promise((r) => setTimeout(r, 2000))
			continue
		}

		const msg = parseWaitResult(waitResult)
		cursorMs = beforeWait // next wait replays anything that lands from here on
		if (!msg) continue // timeout — loop
		if (handled.has(msg.id)) continue // dedup re-delivery
		handled.add(msg.id)

		iteration += 1
		log(`mention #${iteration} from ${msg.senderName} in thread ${msg.threadId}: ${msg.text.slice(0, 120)}`)

		let coralState = ''
		try {
			coralState = JSON.stringify(await readCoralState())
		} catch (err) {
			log(`could not read coral state: ${(err as Error).message}`)
		}

		const userMessage = [
			`## INCOMING MESSAGE`,
			`thread_id: ${msg.threadId}`,
			`from: ${msg.senderName}`,
			`content:`,
			msg.text,
			``,
			`## CORAL STATE`,
			coralState,
			``,
			`Handle this message now per your instructions. Use thread_id="${msg.threadId}" and mention the relevant agent(s) when you reply via coral_send_message. If no reply is warranted, output exactly ${NO_REPLY}.`
		].join('\n')

		// One multi-step generate per mention — with a bounded retry. Large
		// generations on a busy provider occasionally come back truncated
		// (AI_APICallError "Invalid JSON response" / "Unexpected end of JSON
		// input") or hit a transient 5xx. The conductor-driven synthesis star has
		// no per-hop retry of its own (an agent is mentioned once per hop), so a
		// single transient hiccup would otherwise fail the whole run. Retry the
		// turn here, where the error actually happens, so every agent is robust.
		let result: Awaited<ReturnType<Agent['generate']>> | null = null
		for (let attempt = 1; attempt <= GENERATE_ATTEMPTS; attempt++) {
			try {
				result = await agent.generate(userMessage, { maxSteps })
				break
			} catch (err) {
				const m = (err as Error).message
				if (attempt < GENERATE_ATTEMPTS) {
					log(`turn #${iteration} generate ${attempt}/${GENERATE_ATTEMPTS} failed (${m}) — retrying`)
					await new Promise((r) => setTimeout(r, GENERATE_RETRY_MS))
				} else {
					log(`turn #${iteration} errored after ${GENERATE_ATTEMPTS} attempts: ${m}`)
				}
			}
		}
		if (!result) continue // gave up this turn — loop back to wait_for_mention
		const usage = (result as { usage?: Parameters<CostTracker['record']>[0] }).usage
		const turn = cost.record(usage)
		void reportUsage(turn) // best-effort cost archive → conductor → Turso agent_turns
		const text = (result.text ?? '').trim()
		log(formatUsage(`turn #${iteration}`, activeModelId(), turn, cost.cumulative()))
		if (text === NO_REPLY) log(`turn #${iteration}: NO_REPLY_REQUIRED`)
		else log(`turn #${iteration} done: ${text.slice(0, 120)}`)
	}
}

/**
 * Report a turn's token usage + cost to the conductor (→ Turso agent_turns).
 * The conductor maps CORAL_SESSION_ID → run + stage. Best-effort: a failed
 * report must never break a turn. Agents run locally, so localhost reaches the
 * conductor; override with CONDUCTOR_URL if needed.
 */
async function reportUsage(turn: {
	inputTokens: number
	outputTokens: number
	estimatedCostUsd: number
}): Promise<void> {
	const coralSessionId = process.env.CORAL_SESSION_ID
	if (!coralSessionId) return
	const url = `${process.env.CONDUCTOR_URL || 'http://localhost:8787'}/internal/turns`
	try {
		await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				coralSessionId,
				agent: agentKey,
				model: activeModelId(),
				inputTokens: turn.inputTokens,
				outputTokens: turn.outputTokens,
				costUsd: turn.estimatedCostUsd
			})
		})
	} catch {
		/* best-effort */
	}
}

main().catch((err) => {
	log(`FATAL: ${(err as Error).message}`)
	console.error(err)
	process.exit(1)
})
