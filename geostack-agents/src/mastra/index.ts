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
import { makeGeoAgent } from './agents/geo-agent.js'
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
	'geo-agent': makeGeoAgent,
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
	'geo-agent': 8, // synthesise (+ revise on grounding feedback) + emit
	'verify-agent': 6, // check claims + route
	'style-agent': 4 // polish + emit output
}

export type AgentKey = keyof typeof agentFactories

export function isAgentKey(value: string): value is AgentKey {
	return value in agentFactories
}
