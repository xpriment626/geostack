import type { Agent } from '@mastra/core/agent'
import { makeExaAgent } from './agents/exa-agent.js'
import { makeDeepwikiAgent } from './agents/deepwiki-agent.js'
import { makeGrokAgent } from './agents/grok-agent.js'
import { makeStrategistAgent } from './agents/strategist-agent.js'
import { makeWriterAgent } from './agents/writer-agent.js'
import { makeVerifyAgent } from './agents/verify-agent.js'
import { makeVisualAgent } from './agents/visual-agent.js'

/**
 * Lazy agent factories, keyed by the Coral agent name (so the worker's argv
 * matches each agent's coral-agent.toml `[agent] name`). Importing this is
 * cheap; MCP handshakes only happen when a factory runs.
 */
export const agentFactories: Record<string, () => Promise<Agent>> = {
	'exa-agent': makeExaAgent,
	'deepwiki-agent': makeDeepwikiAgent,
	'grok-agent': makeGrokAgent, // live X discourse via Grok-4.3 x_search
	'strategist-agent': makeStrategistAgent, // GEO strategy
	'writer-agent': makeWriterAgent, // content production
	'verify-agent': makeVerifyAgent,
	'visual-agent': makeVisualAgent
}

/** Per-agent step budget for one generate() turn (tool calls + final reply). */
export const agentMaxSteps: Record<string, number> = {
	'exa-agent': 12, // a few Exa searches + emit
	'deepwiki-agent': 12, // structure/contents/ask calls + emit
	'grok-agent': 4, // x_search fires inside the response → reason + emit
	'strategist-agent': 8, // reason over research → strategy + emit
	'writer-agent': 8, // write draft (+ revise on grounding feedback) + emit
	'verify-agent': 6, // check claims + emit verdict
	'visual-agent': 4 // presentation pass + emit output
}

export type AgentKey = keyof typeof agentFactories

export function isAgentKey(value: string): value is AgentKey {
	return value in agentFactories
}
