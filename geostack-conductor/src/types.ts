import { z } from 'zod'

/**
 * Shared contract between the conductor, the Coral agents, and the frontend.
 *
 * Two hard rules from the design doc are encoded here:
 *  - The intent artifact is a STRUCTURED object passed verbatim to every agent
 *    that needs it — no summarisation between handoffs.
 *  - The research artifact is a STRUCTURAL bundle of each research agent's
 *    output (no LLM, no compaction). geo-agent is the synthesis step.
 */

// ---- Intent artifact (produced off-Coral, seeds session A) ------------------

export const FormatType = z.object({
	mode: z.enum(['single', 'batch']),
	depth: z.enum(['listicle', 'deep-dive'])
})

export const IntentArtifact = z.object({
	projectId: z.string(), // stubbed for reroll 1; real once projects land
	anchorClaim: z.string(), // the claim we're building citation authority on
	targetQuery: z.string(), // the agent-search query space to win "who to cite" in
	formatType: FormatType,
	audience: z.string().optional(),
	tone: z.string().optional(),
	raw: z.string() // full structured brief in markdown, passed verbatim to agents
})
export type IntentArtifact = z.infer<typeof IntentArtifact>

// ---- Research stage (session A) ---------------------------------------------

export const ResearchSource = z.enum(['arxiv', 'deepwiki', 'exa'])
export type ResearchSource = z.infer<typeof ResearchSource>

export const SourceRef = z.object({
	title: z.string(),
	url: z.string().optional(),
	ref: z.string().optional(), // e.g. arxiv id, repo path
	takeaway: z.string()
})

/** Exit event emitted by each research agent into session A. */
export const ResearchResultEvent = z.object({
	type: z.literal('research_result'),
	source: ResearchSource,
	sources: z.array(SourceRef),
	notes: z.string().optional()
})
export type ResearchResultEvent = z.infer<typeof ResearchResultEvent>

/**
 * Structural bundle the conductor assembles from the research_result events —
 * verbatim, no LLM. Seeds session B alongside the intent artifact.
 */
export const ResearchArtifact = z.object({
	intent: IntentArtifact,
	// Explicit optional keys (not z.record) so the fixed research-source set is
	// clear and the bundle stays valid even with a partial fan-out.
	results: z.object({
		arxiv: ResearchResultEvent.optional(),
		deepwiki: ResearchResultEvent.optional(),
		exa: ResearchResultEvent.optional()
	})
})
export type ResearchArtifact = z.infer<typeof ResearchArtifact>

// ---- Synthesis stage (session B) --------------------------------------------

export const GroundingEntry = z.object({
	claim: z.string(),
	status: z.enum(['grounded', 'flagged']),
	reason: z.string().optional()
})

/** Exit event emitted by style-agent into session B — the final output. */
export const OutputEvent = z.object({
	type: z.literal('output'),
	markdown: z.string(),
	imageUrl: z.string().optional(),
	grounding: z.array(GroundingEntry).optional()
})
export type OutputEvent = z.infer<typeof OutputEvent>

// ---- Run lifecycle (conductor-owned, archived to Turso) ---------------------

export const RunStage = z.enum(['intent', 'research', 'synthesis', 'done', 'failed'])
export type RunStage = z.infer<typeof RunStage>

export interface RunState {
	id: string
	projectId: string
	stage: RunStage
	intent?: IntentArtifact
	research?: ResearchArtifact
	output?: OutputEvent
	createdAt: number
	error?: string
}

/** Best-effort parse of a JSON envelope posted by an agent into a Coral thread. */
export function tryParseEvent<T extends z.ZodTypeAny>(text: string, schema: T): z.infer<T> | null {
	const stripped = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/```\s*$/i, '')
		.trim()
	try {
		return schema.parse(JSON.parse(stripped))
	} catch {
		return null
	}
}
