/** Orchestration constants for the GEO Content Fleet conductor. */

export const NAMESPACE = process.env.GEOSTACK_NAMESPACE ?? 'geostack'

// The conductor's proxy identity inside each Coral session. Mirrors the demo's
// proven use of the local `puppet` agent (type function) as a send/create proxy.
export const PROXY_ID_NAME = 'puppet'
export const PROXY_VERSION = '1.0.0'
export const PROXY_NAME = 'conductor'

export const AGENT_VERSION = '0.1.0'

// Research session A (arxiv deferred for reroll 1 — added once a source is picked).
export const RESEARCH_AGENTS = ['exa-agent', 'deepwiki-agent'] as const
// Synthesis session B.
export const SYNTHESIS_AGENTS = ['geo-agent', 'verify-agent', 'style-agent'] as const

// TTL backstop so a stuck session can't linger forever (ms).
export const SESSION_TTL_MS = Number(process.env.GEOSTACK_SESSION_TTL_MS ?? 1_800_000)

// Readiness + completion polling budgets (ms). Sized for slow reasoning models
// (deepseek-v4-pro ~3min/turn): research is 2 agents in parallel; synthesis is
// a 3-agent sequential chain (geo→verify→style) with up to 2 geo↔verify rounds,
// so it needs a much larger budget. Override per-run via env.
export const READY_TIMEOUT_MS = Number(process.env.GEOSTACK_READY_TIMEOUT_MS ?? 90_000)
export const RESEARCH_TIMEOUT_MS = Number(process.env.GEOSTACK_RESEARCH_TIMEOUT_MS ?? 360_000)
export const SYNTHESIS_TIMEOUT_MS = Number(process.env.GEOSTACK_SYNTHESIS_TIMEOUT_MS ?? 900_000)
