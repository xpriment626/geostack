/** Orchestration constants for the GEO Content Fleet conductor. */

export const NAMESPACE = process.env.GEOSTACK_NAMESPACE ?? 'geostack'

// The conductor's proxy identity inside each Coral session. Mirrors the demo's
// proven use of the local `puppet` agent (type function) as a send/create proxy.
export const PROXY_ID_NAME = 'puppet'
export const PROXY_VERSION = '1.0.0'
export const PROXY_NAME = 'conductor'

export const AGENT_VERSION = '0.1.0'

// Research session A: web/citation landscape (exa), docs (deepwiki), live X
// discourse (grok-4.3 via x_search). grok routes through the OpenAI-compat
// .chat() shape in model.ts (the @openrouter provider's tool serialization
// breaks grok). arxiv deferred until a source is picked.
export const RESEARCH_AGENTS = ['exa-agent', 'deepwiki-agent', 'grok-agent'] as const
// Synthesis session B. GEO strategy and writing are split; the conductor drives
// strategist → writer → verify → visual.
export const SYNTHESIS_AGENTS = ['strategist-agent', 'writer-agent', 'verify-agent', 'visual-agent'] as const

// How many times to attempt the research fan-out. A fresh session re-spawns the
// agents (new MCP tool-load), so a retry recovers from a transient connector
// failure that left a stage with zero sources. >1 ⇒ retry before failing loud.
export const RESEARCH_ATTEMPTS = Number(process.env.GEOSTACK_RESEARCH_ATTEMPTS ?? 2)

// TTL backstop so a stuck session can't linger forever (ms).
export const SESSION_TTL_MS = Number(process.env.GEOSTACK_SESSION_TTL_MS ?? 1_800_000)

// Readiness + completion polling budgets (ms). Sized for slow reasoning models
// (deepseek-v4-pro ~3min/turn): research is N agents in parallel; synthesis is
// now a CONDUCTOR-DRIVEN STAR — the conductor waits for one agent's envelope
// before the next hop. Override per-run via env.
export const READY_TIMEOUT_MS = Number(process.env.GEOSTACK_READY_TIMEOUT_MS ?? 90_000)
export const RESEARCH_TIMEOUT_MS = Number(process.env.GEOSTACK_RESEARCH_TIMEOUT_MS ?? 360_000)
// Legacy whole-stage ceiling reference (the star uses the per-hop budget below).
export const SYNTHESIS_TIMEOUT_MS = Number(process.env.GEOSTACK_SYNTHESIS_TIMEOUT_MS ?? 900_000)

// PER-HOP synthesis budget: how long the conductor waits for any single agent's
// envelope (one slow reasoning turn ≈ 3min). Total stage time ≈ hops × this.
export const SYNTHESIS_STEP_TIMEOUT_MS = Number(process.env.GEOSTACK_SYNTHESIS_STEP_TIMEOUT_MS ?? 300_000)

// Max grounding rounds the conductor drives (writer↔verify). The conductor owns
// this cap now — the agents are stateless about the loop. Matches the old hard
// 2-round limit verify-agent used to self-enforce.
export const GROUNDING_ROUNDS = Number(process.env.GEOSTACK_GROUNDING_ROUNDS ?? 2)
