import { z } from 'zod'
import {
	createSession,
	closeSession,
	waitForAgentsReady,
	puppetCreateThread,
	puppetSendMessage,
	pollMessages,
	type CoralMessage,
	type CreateSessionRequest,
	type SessionIdentifier
} from './coral-client.js'
import {
	IntentArtifact,
	ResearchArtifact,
	ResearchResultEvent,
	StrategyEvent,
	DraftEvent,
	VerdictEvent,
	OutputEvent,
	ResearchSource,
	tryParseEvent,
	type RevisionRequest,
	type RunResearchSource,
	type RunState
} from './types.js'
import * as cfg from './config.js'

/**
 * The production run state-machine: off-Coral intent (already extracted) →
 * Coral session A (research, parallel-independent) → STRUCTURAL collapse →
 * Coral session B (synthesis, sequential w/ bounded rounds) → output.
 *
 * The conductor owns the lifecycle: it creates each session, ready-gates the
 * agents (executable cold-start), seeds the prior stage's artifact verbatim,
 * reads /extended as the source of truth for exit-events, and closes each
 * session when its artifact is in hand.
 */

// ---- pure helpers (offline-testable; no Coral I/O) --------------------------

/** Collect the latest research_result envelope per source from a message list. */
export function parseResearchResults(
	messages: CoralMessage[]
): Partial<Record<ResearchSource, ResearchResultEvent>> {
	const out: Partial<Record<ResearchSource, ResearchResultEvent>> = {}
	for (const m of messages) {
		const ev = tryParseEvent(m.text, ResearchResultEvent)
		if (ev) out[ev.source] = ev // last write wins (latest result for that source)
	}
	return out
}

/** Structural bundle — verbatim, no LLM; synthesis starts after this artifact. */
export function bundleResearchArtifact(
	intent: IntentArtifact,
	results: Partial<Record<ResearchSource, ResearchResultEvent>>
): ResearchArtifact {
	return ResearchArtifact.parse({
		intent,
		results: {
			arxiv: results.arxiv,
			deepwiki: results.deepwiki,
			exa: results.exa,
			grok: results.grok
		}
	})
}

/** Find a final output envelope in a message list, if present. */
export function parseOutput(messages: CoralMessage[]): OutputEvent | null {
	for (const m of messages) {
		const ev = tryParseEvent(m.text, OutputEvent)
		if (ev) return ev
	}
	return null
}

/**
 * Poll the session for the FIRST not-yet-seen message that parses as `schema`,
 * recording its id in `seen` so the next hop won't re-match it. This is the
 * star's per-hop await: the conductor sends to one agent and waits for that
 * agent's typed envelope. Seeding `seen` with every prior message id (incl. the
 * conductor's own trigger sends) is what disambiguates round N's draft from
 * round N-1's in a single shared thread.
 */
async function awaitEnvelope<T extends z.ZodTypeAny>(
	session: SessionIdentifier,
	schema: T,
	seen: Set<string>,
	timeoutMs: number
): Promise<z.infer<T> | null> {
	return pollMessages(
		session,
		(msgs) => {
			for (const m of msgs) {
				if (seen.has(m.id)) continue
				const ev = tryParseEvent(m.text, schema)
				if (ev) {
					seen.add(m.id)
					return ev
				}
			}
			return null
		},
		{ timeoutMs }
	)
}

// ---- session-request builders -----------------------------------------------

function executableAgent(name: string) {
	return {
		id: { name, version: cfg.AGENT_VERSION, registrySourceId: { type: 'local' as const } },
		name,
		provider: { type: 'local' as const, runtime: 'executable' as const }
	}
}

function proxyAgent() {
	return {
		id: { name: cfg.PROXY_ID_NAME, version: cfg.PROXY_VERSION, registrySourceId: { type: 'local' as const } },
		name: cfg.PROXY_NAME,
		provider: { type: 'local' as const, runtime: 'function' as const }
	}
}

function sessionRequest(workAgents: readonly string[]): CreateSessionRequest {
	const agents = [...workAgents.map(executableAgent), proxyAgent()]
	return {
		agentGraphRequest: {
			agents,
			groups: [[...workAgents, cfg.PROXY_NAME]]
		},
		namespaceProvider: {
			type: 'create_if_not_exists',
			namespaceRequest: { name: cfg.NAMESPACE, deleteOnLastSessionExit: false }
		},
		execution: { mode: 'immediate', runtimeSettings: { ttl: cfg.SESSION_TTL_MS } }
	}
}

const SOURCE_ORDER: RunResearchSource[] = ['exa', 'deepwiki', 'grok']
const SOURCE_TO_AGENT: Record<RunResearchSource, string> = {
	exa: 'exa-agent',
	deepwiki: 'deepwiki-agent',
	grok: 'grok-agent'
}

function researchSourcesFor(intent: IntentArtifact): RunResearchSource[] {
	const selected = new Set<RunResearchSource>(['exa'])
	for (const source of intent.researchSources ?? []) {
		if (SOURCE_ORDER.includes(source)) selected.add(source)
	}
	return SOURCE_ORDER.filter((source) => selected.has(source))
}

function researchAgentsFor(intent: IntentArtifact): string[] {
	return researchSourcesFor(intent).map((source) => SOURCE_TO_AGENT[source])
}

// ---- the run driver ---------------------------------------------------------

export interface RunHooks {
	log: (msg: string) => void
	/** Persist the run record at each lifecycle transition (Turso `runs`). */
	persist?: (run: RunState) => void
	/** Lifecycle instrument: a session opened/closed (feeds the Turso `sessions` archive). */
	onSession?: (e: { stage: string; sessionId: string; phase: 'open' | 'closed' }) => void
}

/**
 * One research fan-out attempt: own session, ready-gate, seed, poll, collapse.
 * Throws on any failure — including a ZERO-SOURCE result (almost always a
 * connector/tool-load failure), so the caller can retry or fail loud rather than
 * synthesize an ungrounded draft. Always closes its session.
 */
async function researchFanout(
	run: RunState,
	intent: IntentArtifact,
	hooks: RunHooks,
	attempt: number,
	researchAgents: readonly string[]
): Promise<ResearchArtifact> {
	const { log } = hooks
	let sessionA: SessionIdentifier | null = null
	try {
		log(`[${run.id}] research (attempt ${attempt}/${cfg.RESEARCH_ATTEMPTS}): creating session A (${researchAgents.join(', ')})`)
		sessionA = await createSession(sessionRequest(researchAgents))
		hooks.onSession?.({ stage: 'research', sessionId: sessionA.sessionId, phase: 'open' })

		const ready = await waitForAgentsReady(sessionA, [...researchAgents], {
			timeoutMs: cfg.READY_TIMEOUT_MS
		})
		if (!ready.ok) {
			throw new Error(
				ready.stopped.length
					? `research agents failed to start: ${ready.stopped.join(', ')}`
					: 'research agents not ready before timeout'
			)
		}
		log(`[${run.id}] research: agents ready`)

		const { thread } = await puppetCreateThread(sessionA, cfg.PROXY_NAME, {
			threadName: 'research',
			participantNames: [...researchAgents]
		})
		await puppetSendMessage(sessionA, cfg.PROXY_NAME, {
			threadId: thread.id,
			content: JSON.stringify(intent), // intent artifact, verbatim
			mentions: [...researchAgents]
		})
		log(`[${run.id}] research: intent seeded into thread ${thread.id}`)

		const results = await pollMessages(
			sessionA,
			(msgs) => {
				const r = parseResearchResults(msgs)
				return Object.keys(r).length >= researchAgents.length ? r : null
			},
			{ timeoutMs: cfg.RESEARCH_TIMEOUT_MS }
		)
		if (!results) throw new Error('research fan-out did not converge before timeout')

		// Fail loud on a fully-empty fan-out (no grounding ⇒ almost always a
		// connector/tool-load failure). Thrown so the caller can retry / fail.
		const totalSources = Object.values(results).reduce((n, ev) => n + (ev?.sources?.length ?? 0), 0)
		if (totalSources === 0) {
			const sources = researchAgents.map((a) => a.replace('-agent', '')).join(' + ')
			throw new Error(`no research sources returned (${sources} empty) — likely a connector/tool-load failure`)
		}

		log(`[${run.id}] research: collapsed ${Object.keys(results).join('+')} → ${totalSources} sources`)
		return bundleResearchArtifact(intent, results) // STRUCTURAL collapse, no LLM
	} finally {
		if (sessionA) {
			await closeSession(sessionA)
			hooks.onSession?.({ stage: 'research', sessionId: sessionA.sessionId, phase: 'closed' })
			log(`[${run.id}] research: session A closed`)
		}
	}
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const value of values) {
		const trimmed = value.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		out.push(trimmed)
	}
	return out
}

function mergeResearchArtifact(base: ResearchArtifact, extra: ResearchArtifact): ResearchArtifact {
	const merged: Record<string, ResearchResultEvent | undefined> = {}
	for (const source of ['arxiv', 'deepwiki', 'exa', 'grok'] as const) {
		const a = base.results[source]
		const b = extra.results[source]
		if (!a && !b) continue
		if (!a) {
			merged[source] = b
			continue
		}
		if (!b) {
			merged[source] = a
			continue
		}
		const seen = new Set<string>()
		const sources = [...a.sources, ...b.sources].filter((ref) => {
			const key = ref.url || ref.ref || `${ref.title}:${ref.takeaway}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
		merged[source] = {
			type: 'research_result',
			source,
			sources,
			notes: [a.notes, b.notes].filter(Boolean).join('\n\nRevision research: ') || undefined
		}
	}
	return bundleResearchArtifact(extra.intent, merged)
}

export async function runRevision(run: RunState, revision: RevisionRequest, hooks: RunHooks): Promise<OutputEvent> {
	const { log } = hooks
	const save = () => hooks.persist?.(run)
	if (!run.intent) throw new Error('no intent artifact')
	if (!run.research) throw new Error('no research artifact to revise from')
	if (!run.output?.markdown) throw new Error('no output draft to revise')

	const revisionLinks = uniqueStrings(revision.contextLinks)
	const revisionIntent = IntentArtifact.parse({
		...run.intent,
		additionalDirection: uniqueStrings([
			run.intent.additionalDirection ?? '',
			`Revision request: ${revision.instruction}`
		]).join('\n\n'),
		contextLinks: uniqueStrings([...(run.intent.contextLinks ?? []), ...revisionLinks]),
		raw: [
			run.intent.raw,
			'',
			'# Revision request',
			revision.instruction,
			revisionLinks.length ? `\nContext links:\n${revisionLinks.map((url) => `- ${url}`).join('\n')}` : ''
		]
			.filter(Boolean)
			.join('\n')
	})

	let revisionResearch = ResearchArtifact.parse({ ...run.research, intent: revisionIntent })
	if (revisionLinks.length) {
		run.stage = 'research'
		save()
		const researchAgents = researchAgentsFor(revisionIntent)
		let lastErr: unknown
		for (let attempt = 1; attempt <= cfg.RESEARCH_ATTEMPTS; attempt++) {
			try {
				const extra = await researchFanout(run, revisionIntent, hooks, attempt, researchAgents)
				revisionResearch = mergeResearchArtifact(revisionResearch, extra)
				lastErr = undefined
				break
			} catch (err) {
				lastErr = err
				log(`[${run.id}] revision research attempt ${attempt}/${cfg.RESEARCH_ATTEMPTS} failed: ${(err as Error).message}`)
				if (attempt < cfg.RESEARCH_ATTEMPTS) log(`[${run.id}] retrying revision research fan-out…`)
			}
		}
		if (lastErr) {
			run.stage = 'done'
			run.error = `revision failed: ${(lastErr as Error).message}`
			save()
			throw lastErr
		}
		run.research = revisionResearch
		save()
	}

	let sessionB: SessionIdentifier | null = null
	try {
		run.stage = 'synthesis'
		save()
		log(`[${run.id}] revision: creating synthesis session (${cfg.SYNTHESIS_AGENTS.join(', ')})`)
		sessionB = await createSession(sessionRequest(cfg.SYNTHESIS_AGENTS))
		hooks.onSession?.({ stage: 'synthesis', sessionId: sessionB.sessionId, phase: 'open' })

		const ready = await waitForAgentsReady(sessionB, [...cfg.SYNTHESIS_AGENTS], {
			timeoutMs: cfg.READY_TIMEOUT_MS
		})
		if (!ready.ok) {
			throw new Error(
				ready.stopped.length
					? `revision agents failed to start: ${ready.stopped.join(', ')}`
					: 'revision agents not ready before timeout'
			)
		}
		log(`[${run.id}] revision: agents ready`)

		const { thread } = await puppetCreateThread(sessionB, cfg.PROXY_NAME, {
			threadName: 'revision',
			participantNames: [...cfg.SYNTHESIS_AGENTS]
		})

		const seen = new Set<string>()
		const sb = sessionB
		const send = async (content: string, mention: string): Promise<void> => {
			const { message } = await puppetSendMessage(sb, cfg.PROXY_NAME, {
				threadId: thread.id,
				content,
				mentions: [mention]
			})
			seen.add(message.id)
		}

		const strategyBrief = {
			type: 'revision_strategy_brief',
			instruction: revision.instruction,
			contextLinks: revisionLinks,
			currentOutput: run.output,
			research: revisionResearch
		}
		await send(JSON.stringify(strategyBrief), 'strategist-agent')
		const strategy = await awaitEnvelope(sessionB, StrategyEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
		if (!strategy) throw new Error('revision: strategist-agent did not emit a strategy before timeout')
		log(`[${run.id}] revision: strategy received (${strategy.claimTargets.length} claim targets)`)

		await send(
			JSON.stringify({
				type: 'revision_writing_brief',
				instruction: revision.instruction,
				contextLinks: revisionLinks,
				previousMarkdown: run.output.markdown,
				strategy,
				research: revisionResearch
			}),
			'writer-agent'
		)
		let draft = await awaitEnvelope(sessionB, DraftEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
		if (!draft) throw new Error('revision: writer-agent did not emit a draft before timeout')
		log(`[${run.id}] revision: draft received (${draft.claims.length} claims)`)

		let verdict: VerdictEvent | null = null
		for (let round = 1; round <= cfg.GROUNDING_ROUNDS; round++) {
			await send(JSON.stringify(draft), 'verify-agent')
			verdict = await awaitEnvelope(sessionB, VerdictEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
			if (!verdict) throw new Error('revision: verify-agent did not emit a verdict before timeout')
			const flagged = verdict.grounding.filter((g) => g.status === 'flagged')
			log(`[${run.id}] revision: verdict round ${round}/${cfg.GROUNDING_ROUNDS} — ${flagged.length} flagged / ${verdict.grounding.length} claims`)
			if (flagged.length === 0 || round === cfg.GROUNDING_ROUNDS) break
			await send(
				JSON.stringify({
					type: 'grounding_feedback',
					flagged: flagged.map((f) => ({ claim: f.claim, reason: f.reason ?? '' }))
				}),
				'writer-agent'
			)
			const revised = await awaitEnvelope(sessionB, DraftEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
			if (!revised) throw new Error(`revision: no revised draft (round ${round}) before timeout`)
			draft = revised
			log(`[${run.id}] revision: revised draft received (round ${round})`)
		}
		if (!verdict) throw new Error('revision: grounding loop produced no verdict')

		await send(
			JSON.stringify({ type: 'verified_draft', markdown: verdict.markdown, grounding: verdict.grounding }),
			'visual-agent'
		)
		const output = await awaitEnvelope(sessionB, OutputEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
		if (!output) throw new Error('revision: visual-agent did not emit output before timeout')

		run.output = output
		run.stage = 'done'
		run.error = undefined
		save()
		log(`[${run.id}] revision: output received (${output.markdown.length} chars) → done`)
		return output
	} catch (err) {
		run.stage = 'done'
		run.error = `revision failed: ${(err as Error).message}`
		save()
		throw err
	} finally {
		if (sessionB) {
			await closeSession(sessionB)
			hooks.onSession?.({ stage: 'synthesis', sessionId: sessionB.sessionId, phase: 'closed' })
			log(`[${run.id}] revision: synthesis session closed`)
		}
	}
}

export async function runProduction(run: RunState, hooks: RunHooks): Promise<void> {
	const { log } = hooks
	const save = () => hooks.persist?.(run)
	if (!run.intent) {
		run.stage = 'failed'
		run.error = 'no intent artifact'
		save()
		return
	}
	const intent = run.intent
	const researchAgents = researchAgentsFor(intent)

	// ---------- Session A: research fan-out (retried, then fail loud) ----------
	run.stage = 'research'
	save()
	try {
		let lastErr: unknown
		for (let attempt = 1; attempt <= cfg.RESEARCH_ATTEMPTS; attempt++) {
			try {
				run.research = await researchFanout(run, intent, hooks, attempt, researchAgents)
				lastErr = undefined
				break
			} catch (err) {
				lastErr = err
				log(`[${run.id}] research attempt ${attempt}/${cfg.RESEARCH_ATTEMPTS} failed: ${(err as Error).message}`)
				if (attempt < cfg.RESEARCH_ATTEMPTS) log(`[${run.id}] retrying research fan-out…`)
			}
		}
		if (lastErr) throw lastErr // exhausted attempts → fail loud
		save()
	} catch (err) {
		run.stage = 'failed'
		run.error = `research stage: ${(err as Error).message}`
		save()
		log(`[${run.id}] ${run.error}`)
		return
	}

	// ---------- Session B: synthesis ----------
	let sessionB: SessionIdentifier | null = null
	try {
		run.stage = 'synthesis'
		save()
		log(`[${run.id}] synthesis: creating session B (${cfg.SYNTHESIS_AGENTS.join(', ')})`)
		sessionB = await createSession(sessionRequest(cfg.SYNTHESIS_AGENTS))
		hooks.onSession?.({ stage: 'synthesis', sessionId: sessionB.sessionId, phase: 'open' })

		const ready = await waitForAgentsReady(sessionB, [...cfg.SYNTHESIS_AGENTS], {
			timeoutMs: cfg.READY_TIMEOUT_MS
		})
		if (!ready.ok) {
			throw new Error(
				ready.stopped.length
					? `synthesis agents failed to start: ${ready.stopped.join(', ')}`
					: 'synthesis agents not ready before timeout'
			)
		}
		log(`[${run.id}] synthesis: agents ready`)

		const { thread } = await puppetCreateThread(sessionB, cfg.PROXY_NAME, {
			threadName: 'synthesis',
			participantNames: [...cfg.SYNTHESIS_AGENTS]
		})

		// CONDUCTOR-DRIVEN STAR. Each agent emits ONE envelope mentioning the
		// conductor and stops; the conductor owns every hop and the grounding loop
		// (mirrors the research fan-out). `seen` tracks every message already
		// consumed — incl. the conductor's own trigger sends — so a later hop never
		// re-matches an earlier round's envelope in this single shared thread.
		const seen = new Set<string>()
		const sb = sessionB
		const send = async (content: string, mention: string): Promise<void> => {
			const { message } = await puppetSendMessage(sb, cfg.PROXY_NAME, {
				threadId: thread.id,
				content,
				mentions: [mention]
			})
			seen.add(message.id)
		}

		// Hop 1 — strategist: research artifact (incl. intent) → GEO strategy.
		await send(JSON.stringify(run.research), 'strategist-agent')
		log(`[${run.id}] synthesis: research seeded → strategist-agent (thread ${thread.id})`)
		const strategy = await awaitEnvelope(sessionB, StrategyEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
		if (!strategy) throw new Error('synthesis: strategist-agent did not emit a strategy before timeout')
		log(`[${run.id}] synthesis: strategy received (${strategy.claimTargets.length} claim targets)`)

		// Hop 2 — writer: strategy + research → draft.
		await send(JSON.stringify({ type: 'writing_brief', strategy, research: run.research }), 'writer-agent')
		let draft = await awaitEnvelope(sessionB, DraftEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
		if (!draft) throw new Error('synthesis: writer-agent did not emit a draft before timeout')
		log(`[${run.id}] synthesis: draft received (${draft.claims.length} claims)`)

		// Grounding loop — conductor-owned. draft↔verify, capped at GROUNDING_ROUNDS.
		let verdict: VerdictEvent | null = null
		for (let round = 1; round <= cfg.GROUNDING_ROUNDS; round++) {
			await send(JSON.stringify(draft), 'verify-agent')
			verdict = await awaitEnvelope(sessionB, VerdictEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
			if (!verdict) throw new Error('synthesis: verify-agent did not emit a verdict before timeout')
			const flagged = verdict.grounding.filter((g) => g.status === 'flagged')
			log(`[${run.id}] synthesis: verdict round ${round}/${cfg.GROUNDING_ROUNDS} — ${flagged.length} flagged / ${verdict.grounding.length} claims`)
			if (flagged.length === 0 || round === cfg.GROUNDING_ROUNDS) break
			// Hand the flags back to the writer for ONE revision, then await the draft.
			await send(
				JSON.stringify({
					type: 'grounding_feedback',
					flagged: flagged.map((f) => ({ claim: f.claim, reason: f.reason ?? '' }))
				}),
				'writer-agent'
			)
			const revised = await awaitEnvelope(sessionB, DraftEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
			if (!revised) throw new Error(`synthesis: no revised draft (round ${round}) before timeout`)
			draft = revised
			log(`[${run.id}] synthesis: revised draft received (round ${round})`)
		}
		if (!verdict) throw new Error('synthesis: grounding loop produced no verdict') // unreachable

		// Final hop — visual: verified draft → final output (the run's exit event).
		await send(
			JSON.stringify({ type: 'verified_draft', markdown: verdict.markdown, grounding: verdict.grounding }),
			'visual-agent'
		)
		const output = await awaitEnvelope(sessionB, OutputEvent, seen, cfg.SYNTHESIS_STEP_TIMEOUT_MS)
		if (!output) throw new Error('synthesis: visual-agent did not emit output before timeout')

		run.output = output
		run.stage = 'done'
		save()
		log(`[${run.id}] synthesis: output received (${output.markdown.length} chars) → done`)
	} catch (err) {
		run.stage = 'failed'
		run.error = `synthesis stage: ${(err as Error).message}`
		save()
		log(`[${run.id}] ${run.error}`)
	} finally {
		if (sessionB) {
			await closeSession(sessionB)
			hooks.onSession?.({ stage: 'synthesis', sessionId: sessionB.sessionId, phase: 'closed' })
			log(`[${run.id}] synthesis: session B closed`)
		}
	}
}
