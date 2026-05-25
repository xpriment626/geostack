// Load geostack-conductor/.env (Turso creds etc.) if present — no dep needed.
try {
	process.loadEnvFile()
} catch {
	/* no .env — fine; vars may come from the environment */
}

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { IntentArtifact, type RunState } from './types.js'
import { runProduction } from './orchestrator.js'
import {
	dbEnabled,
	initSchema,
	persistRun,
	recordSession,
	recordAgentTurn,
	getRun,
	getRunArchive,
	listRuns
} from './db.js'

const safeJson = (v: unknown) => {
	if (typeof v !== 'string') return v ?? null
	try {
		return JSON.parse(v)
	} catch {
		return v
	}
}

/**
 * Geostack conductor.
 *
 * Owns the off-Coral intent flow + orchestration of short-lived Coral work
 * sessions (research → synthesis), holding artifacts between them. HTTP surface
 * + in-memory run registry; the Turso archive replaces the in-memory map next (#12).
 *
 * API-only: the run-inspector UI now lives in the Svelte app (app/src/components/
 * RunInspector.svelte), which reaches these routes via the /conductor Vite proxy.
 * inspector.html is kept in this dir as a standalone reference only.
 */

const app = new Hono()

// In-memory run registry (live runs). Turso is the durable archive.
const runs = new Map<string, RunState>()
// Maps a Coral session id → its run + stage, so agents can report per-turn cost
// keyed only by their CORAL_SESSION_ID (which they already have in env).
const sessionIndex = new Map<string, { runId: string; stage: string }>()

app.get('/health', (c) => c.json({ ok: true, service: 'geostack-conductor' }))

/**
 * Start a production run from a structured intent artifact. (The caller supplies
 * the artifact directly for now; the wizard→intent-extraction endpoint lands with
 * the curation/intent work.) Returns immediately; the run drives asynchronously —
 * poll GET /runs/:id for stage + artifacts.
 */
app.post('/runs', async (c) => {
	const body = await c.req.json().catch(() => null)
	const parsed = IntentArtifact.safeParse(body?.intent)
	if (!parsed.success) {
		return c.json({ error: 'invalid intent artifact', issues: parsed.error.issues }, 400)
	}
	const run: RunState = {
		id: `run_${randomUUID()}`,
		projectId: parsed.data.projectId,
		stage: 'intent',
		intent: parsed.data,
		createdAt: Date.now()
	}
	runs.set(run.id, run)
	void persistRun(run) // initial archive row

	// Fire-and-forget; the run mutates `run` in place as it progresses.
	void runProduction(run, {
		log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
		persist: (r) => void persistRun(r),
		onSession: (e) => {
			if (e.phase === 'open') sessionIndex.set(e.sessionId, { runId: run.id, stage: e.stage })
			void recordSession({ runId: run.id, ...e })
		}
	}).catch((err) => {
		run.stage = 'failed'
		run.error = `unhandled: ${(err as Error).message}`
		void persistRun(run)
		console.error(`[${run.id}] unhandled run error`, err)
	})

	return c.json({ runId: run.id, stage: run.stage })
})

/**
 * Internal endpoint for agents to report per-turn token usage + cost (task #15
 * wires the worker side). Best-effort archive into Turso `agent_turns`.
 */
app.post('/internal/turns', async (c) => {
	const b = await c.req.json().catch(() => null)
	if (!b?.agent) return c.json({ error: 'agent required' }, 400)
	// Resolve run + stage: explicit fields win, else map from the Coral session id.
	let runId: string | undefined = b.runId ? String(b.runId) : undefined
	let stage: string | undefined = b.stage ? String(b.stage) : undefined
	if (b.coralSessionId) {
		const idx = sessionIndex.get(String(b.coralSessionId))
		if (idx) {
			runId = runId ?? idx.runId
			stage = stage ?? idx.stage
		}
	}
	if (!runId) return c.json({ error: 'unresolved run (no runId or known coralSessionId)' }, 400)
	void recordAgentTurn({
		runId,
		stage: stage ?? '',
		agent: String(b.agent),
		model: String(b.model ?? ''),
		inputTokens: Number(b.inputTokens ?? 0),
		outputTokens: Number(b.outputTokens ?? 0),
		costUsd: Number(b.costUsd ?? 0)
	})
	return c.json({ ok: true })
})

/** Recent runs for the inspector list (Turso, with in-memory fallback). */
app.get('/runs', async (c) => {
	if (dbEnabled()) return c.json({ runs: await listRuns(50) })
	return c.json({
		runs: [...runs.values()]
			.sort((a, b) => b.createdAt - a.createdAt)
			.map((r) => ({ id: r.id, project_id: r.projectId, stage: r.stage, created_at: r.createdAt }))
	})
})

/** One run: live in-memory state if active, else the persisted row; always with archive (sessions + agent_turns). */
app.get('/runs/:id', async (c) => {
	const id = c.req.param('id')
	const archive = await getRunArchive(id)
	const live = runs.get(id)
	if (live) return c.json({ ...live, ...archive })
	const persisted = await getRun(id)
	if (!persisted) return c.json({ error: 'not found' }, 404)
	return c.json({
		...persisted,
		intent: safeJson(persisted.intent),
		research: safeJson(persisted.research),
		output: safeJson(persisted.output),
		...archive
	})
})

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[conductor] listening on http://localhost:${info.port}`)
	console.log(`[conductor] Turso archive: ${dbEnabled() ? 'enabled' : 'disabled (no creds)'}`)
	void initSchema()
})
