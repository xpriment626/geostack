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
	OutputEvent,
	ResearchSource,
	tryParseEvent,
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

/** Structural bundle — verbatim, no LLM. geo-agent is the synthesis step. */
export function bundleResearchArtifact(
	intent: IntentArtifact,
	results: Partial<Record<ResearchSource, ResearchResultEvent>>
): ResearchArtifact {
	return ResearchArtifact.parse({
		intent,
		results: {
			arxiv: results.arxiv,
			deepwiki: results.deepwiki,
			exa: results.exa
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

// ---- the run driver ---------------------------------------------------------

export interface RunHooks {
	log: (msg: string) => void
	/** Persist the run record at each lifecycle transition (Turso `runs`). */
	persist?: (run: RunState) => void
	/** Lifecycle instrument: a session opened/closed (feeds the Turso `sessions` archive). */
	onSession?: (e: { stage: 'research' | 'synthesis'; sessionId: string; phase: 'open' | 'closed' }) => void
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
	attempt: number
): Promise<ResearchArtifact> {
	const { log } = hooks
	let sessionA: SessionIdentifier | null = null
	try {
		log(`[${run.id}] research (attempt ${attempt}/${cfg.RESEARCH_ATTEMPTS}): creating session A (${cfg.RESEARCH_AGENTS.join(', ')})`)
		sessionA = await createSession(sessionRequest(cfg.RESEARCH_AGENTS))
		hooks.onSession?.({ stage: 'research', sessionId: sessionA.sessionId, phase: 'open' })

		const ready = await waitForAgentsReady(sessionA, [...cfg.RESEARCH_AGENTS], {
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
			participantNames: [...cfg.RESEARCH_AGENTS]
		})
		await puppetSendMessage(sessionA, cfg.PROXY_NAME, {
			threadId: thread.id,
			content: JSON.stringify(intent), // intent artifact, verbatim
			mentions: [...cfg.RESEARCH_AGENTS]
		})
		log(`[${run.id}] research: intent seeded into thread ${thread.id}`)

		const results = await pollMessages(
			sessionA,
			(msgs) => {
				const r = parseResearchResults(msgs)
				return Object.keys(r).length >= cfg.RESEARCH_AGENTS.length ? r : null
			},
			{ timeoutMs: cfg.RESEARCH_TIMEOUT_MS }
		)
		if (!results) throw new Error('research fan-out did not converge before timeout')

		// Fail loud on a fully-empty fan-out (no grounding ⇒ almost always a
		// connector/tool-load failure). Thrown so the caller can retry / fail.
		const totalSources = Object.values(results).reduce((n, ev) => n + (ev?.sources?.length ?? 0), 0)
		if (totalSources === 0) {
			const sources = cfg.RESEARCH_AGENTS.map((a) => a.replace('-agent', '')).join(' + ')
			throw new Error(`no research sources returned (${sources} both empty) — likely a connector/tool-load failure`)
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

	// ---------- Session A: research fan-out (retried, then fail loud) ----------
	run.stage = 'research'
	save()
	try {
		let lastErr: unknown
		for (let attempt = 1; attempt <= cfg.RESEARCH_ATTEMPTS; attempt++) {
			try {
				run.research = await researchFanout(run, intent, hooks, attempt)
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
		await puppetSendMessage(sessionB, cfg.PROXY_NAME, {
			threadId: thread.id,
			content: JSON.stringify(run.research), // research artifact (incl. intent), verbatim
			mentions: ['geo-agent'] // kick the sequence at geo
		})
		log(`[${run.id}] synthesis: research seeded into thread ${thread.id}`)

		const output = await pollMessages(sessionB, (msgs) => parseOutput(msgs), {
			timeoutMs: cfg.SYNTHESIS_TIMEOUT_MS
		})
		if (!output) throw new Error('synthesis did not emit output before timeout')

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
