import type { Agent } from '@mastra/core/agent'
// InstaLetter demo agents (prototype-era; kept for fallback / re-enable).
import { makeBriefAgent } from './agents/brief-agent.js'
import { makeSearchAgent } from './agents/search-agent.js'
import { makeContentAgent } from './agents/content-agent.js'
import { makeThumbnailAgent } from './agents/thumbnail-agent.js'
import { makeTemplateAgent } from './agents/template-agent.js'
// GEO Content Fleet agents.
import { makeExaAgent } from './agents/exa-agent.js'
import { makeDeepwikiAgent } from './agents/deepwiki-agent.js'
import { makeGrokAgent } from './agents/grok-agent.js'
import { makeGeoAgent } from './agents/geo-agent.js'
import { makeStrategistAgent } from './agents/strategist-agent.js'
import { makeWriterAgent } from './agents/writer-agent.js'
import { makeVerifyAgent } from './agents/verify-agent.js'
import { makeStyleAgent } from './agents/style-agent.js'

/**
 * Lazy agent factories, keyed by the Coral agent name (so the worker's argv
 * matches each agent's coral-agent.toml `[agent] name`). Importing this is
 * cheap; MCP handshakes only happen when a factory runs.
 */
export const agentFactories: Record<string, () => Promise<Agent>> = {
	// InstaLetter demo
	'brief-agent': makeBriefAgent,
	'search-agent': makeSearchAgent,
	'content-agent': makeContentAgent,
	'thumbnail-agent': makeThumbnailAgent,
	'template-agent': makeTemplateAgent,
	// GEO Content Fleet
	'exa-agent': makeExaAgent,
	'deepwiki-agent': makeDeepwikiAgent,
	'grok-agent': makeGrokAgent, // live X discourse via Grok-4.3 x_search
	'geo-agent': makeGeoAgent, // retired from the active lane; kept for re-enable
	'strategist-agent': makeStrategistAgent, // GEO-strategy half of the old geo-agent
	'writer-agent': makeWriterAgent, // content-production half of the old geo-agent
	'verify-agent': makeVerifyAgent,
	'style-agent': makeStyleAgent
}

/** Per-agent step budget for one generate() turn (tool calls + final reply). */
export const agentMaxSteps: Record<string, number> = {
	'brief-agent': 8,
	'search-agent': 12,
	'content-agent': 6,
	'thumbnail-agent': 4,
	'template-agent': 4,
	// GEO fleet
	'exa-agent': 12, // a few Exa searches + emit
	'deepwiki-agent': 12, // structure/contents/ask calls + emit
	'grok-agent': 4, // x_search fires inside the response → reason + emit
	'geo-agent': 8, // (retired) synthesise + emit
	'strategist-agent': 8, // reason over research → strategy + emit
	'writer-agent': 8, // write draft (+ revise on grounding feedback) + emit
	'verify-agent': 6, // check claims + emit verdict
	'style-agent': 4 // polish + emit output
}

export type AgentKey = keyof typeof agentFactories

export function isAgentKey(value: string): value is AgentKey {
	return value in agentFactories
}
