import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { IntentArtifact, type RunState } from './types.js'
import { chat, type ChatMessage } from './llm.js'
import { runProduction } from './orchestrator.js'
import {
	isCloud,
	initSchema,
	persistRun,
	recordSession,
	recordAgentTurn,
	getRun,
	getRunArchive,
	listRuns,
	createProject,
	updateProject,
	listProjects,
	getProject,
	deleteProject,
	deleteRun,
	deleteProjectRuns,
	createProfile,
	updateProfile,
	deleteProfile,
	listProfiles,
	getProfile
} from './db.js'
import { applyConfigToEnv, readConfig, writeConfig, redactedConfig, configPath, CONFIG_KEYS } from './local-config.js'

// ~/.geostack/config is the single source of truth for keys + storage (set via
// the Settings UI). This is the only config load — there is no committed repo
// .env auto-load, so the local-file store is the default and Turso is opt-in.
// A genuine shell env var still wins (applyConfigToEnv only fills what's unset),
// which keeps a dev override possible. Runs before anything reads process.env.
applyConfigToEnv()

const safeJson = (v: unknown) => {
	if (typeof v !== 'string') return v ?? null
	try {
		return JSON.parse(v)
	} catch {
		return v
	}
}

const textOrUndefined = (v: unknown) => {
	const s = String(v ?? '').trim()
	return s ? s : undefined
}

const profileContext = (p: Record<string, unknown>) => ({
	id: String(p.id ?? ''),
	name: String(p.name ?? ''),
	description: textOrUndefined(p.description),
	identity: textOrUndefined(p.identity),
	voice: textOrUndefined(p.voice),
	audience: textOrUndefined(p.audience),
	styleGuide: textOrUndefined(p.style_guide),
	contextNotes: textOrUndefined(p.context_notes)
})

// ---- intent capture (conductor-side chat interview) -------------------------

/** The topic model the interview captures — proposed by the LLM, confirmed by the user. */
const IntentProposal = z.object({
	description: z.string().optional().default(''),
	audience: z.string().optional().default(''),
	tone: z.string().optional().default(''),
	targetQueries: z.array(z.string()).default([]),
	anchorClaims: z.array(z.string()).default([])
})
type IntentProposal = z.infer<typeof IntentProposal>

/** The interviewer persona + the capture contract (a fenced JSON proposal when ready). */
function buildIntentSystemPrompt(name: string, description: string): string {
	const seed = description ? ` The user's one-line description: "${description}".` : ''
	return [
		'You are the intake interviewer for Geostack, a tool that helps people win citations in AI answer engines (GEO — generative engine optimization).',
		'A "project" is one topic the user wants AI assistants to cite THEM on. Through a short, natural conversation you capture the project\'s topic model so the downstream content fleet knows what to research and what positioning to anchor every article on.',
		'',
		`The project is "${name}".${seed}`,
		'',
		'You are capturing five things:',
		'- description: a one-to-two sentence positioning statement — the angle they want to own.',
		'- audience: who the content is written for.',
		'- tone: the voice of the content.',
		'- targetQueries: the questions/searches they want AI engines to cite them on (aim for 3–6).',
		'- anchorClaims: the differentiated claims / point of view they are building authority on (aim for 2–4).',
		'',
		'Conversation rules:',
		'- Open with ONE short sentence of context, then ask your FIRST question. Ask one — at most two — questions per turn. Keep it concrete; offer an example when a question is abstract.',
		'- Build on their answers and infer what you reasonably can; do not interrogate every field one by one.',
		'- Do NOT dump all questions at once. Do NOT output JSON until you are confident you can fill all five fields well (usually after 2–4 exchanges).',
		'- When you have enough, STOP asking questions and output your proposal as a SINGLE fenced ```json code block with EXACTLY these keys: description (string), audience (string), tone (string), targetQueries (array of strings), anchorClaims (array of strings).',
		'- Put one short sentence before the block (e.g. "Here\'s what I\'ve captured — confirm or tell me what to change:") and write nothing after the block.'
	].join('\n')
}

/** Pull a fenced JSON proposal out of an assistant reply, if present. */
function extractProposal(text: string): { proposal: IntentProposal | null; display: string } {
	const m = text.match(/```json\s*([\s\S]*?)```/i)
	if (!m) return { proposal: null, display: text }
	try {
		const proposal = IntentProposal.parse(JSON.parse(m[1].trim()))
		return { proposal, display: text.replace(m[0], '').trim() }
	} catch {
		return { proposal: null, display: text }
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

// A run is "active" while its in-memory state is pre-terminal — deleting it then
// would race the orchestrator (which re-upserts the row on its next persist()).
const TERMINAL_STAGES = new Set(['done', 'failed'])
const runActive = (id: string) => {
	const r = runs.get(id)
	return !!r && !TERMINAL_STAGES.has(r.stage)
}
const projectHasActiveRun = (projectId: string) => {
	for (const r of runs.values()) if (r.projectId === projectId && !TERMINAL_STAGES.has(r.stage)) return true
	return false
}
const forgetProjectRuns = (projectId: string) => {
	for (const [id, r] of runs) if (r.projectId === projectId) runs.delete(id)
}

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
	let intent = parsed.data
	if (intent.profileId) {
		const profile = await getProfile(intent.profileId)
		if (!profile) return c.json({ error: 'profile not found' }, 404)
		intent = IntentArtifact.parse({ ...intent, profile: profileContext(profile) })
	}
	const run: RunState = {
		id: `run_${randomUUID()}`,
		projectId: intent.projectId,
		stage: 'intent',
		intent,
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

/** Recent runs for the inspector list — optionally scoped via ?projectId. */
app.get('/runs', async (c) => {
	const projectId = c.req.query('projectId') || undefined
	return c.json({ runs: await listRuns(50, projectId) })
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

/** Delete one run + its archive (turns, sessions). Blocked while the run is live. */
app.delete('/runs/:id', async (c) => {
	const id = c.req.param('id')
	if (runActive(id)) return c.json({ error: 'run in progress — wait for it to finish, then delete' }, 409)
	await deleteRun(id)
	runs.delete(id)
	return c.json({ ok: true })
})

// ---- projects ---------------------------------------------------------------

/** List projects (newest-updated first). */
app.get('/projects', async (c) => c.json({ projects: await listProjects() }))

/** Create a project. Body: { name, description?, audience?, tone?, topicMeta? }. */
app.post('/projects', async (c) => {
	const b = await c.req.json().catch(() => null)
	const name = (b?.name ?? '').toString().trim()
	if (!name) return c.json({ error: 'name required' }, 400)
	const id = `proj_${randomUUID()}`
	await createProject(id, {
		name,
		description: b.description,
		audience: b.audience,
		tone: b.tone,
		profileId: b.profileId ?? b.profile_id,
		topicMeta: b.topicMeta
	})
	return c.json({ id, ...(await getProject(id)) })
})

/** Fetch one project. */
app.get('/projects/:id', async (c) => {
	const p = await getProject(c.req.param('id'))
	if (!p) return c.json({ error: 'not found' }, 404)
	return c.json(p)
})

/** Patch a project (e.g. onboarding metadata). */
app.patch('/projects/:id', async (c) => {
	const id = c.req.param('id')
	const b = await c.req.json().catch(() => null)
	if (!b) return c.json({ error: 'invalid body' }, 400)
	await updateProject(id, {
		name: b.name,
		description: b.description,
		audience: b.audience,
		tone: b.tone,
		profileId: b.profileId ?? b.profile_id,
		topicMeta: b.topicMeta
	})
	return c.json(await getProject(id))
})

// ---- profiles ---------------------------------------------------------------

/** List reusable writer/company profiles. */
app.get('/profiles', async (c) => c.json({ profiles: await listProfiles() }))

/** Create a reusable writer/company profile. */
app.post('/profiles', async (c) => {
	const b = await c.req.json().catch(() => null)
	const name = (b?.name ?? '').toString().trim()
	if (!name) return c.json({ error: 'name required' }, 400)
	const id = `prof_${randomUUID()}`
	await createProfile(id, {
		name,
		description: b.description,
		identity: b.identity,
		voice: b.voice,
		audience: b.audience,
		styleGuide: b.styleGuide ?? b.style_guide,
		contextNotes: b.contextNotes ?? b.context_notes
	})
	return c.json(await getProfile(id))
})

/** Fetch one profile. */
app.get('/profiles/:id', async (c) => {
	const p = await getProfile(c.req.param('id'))
	if (!p) return c.json({ error: 'not found' }, 404)
	return c.json(p)
})

/** Patch profile fields. */
app.patch('/profiles/:id', async (c) => {
	const id = c.req.param('id')
	const b = await c.req.json().catch(() => null)
	if (!b) return c.json({ error: 'invalid body' }, 400)
	await updateProfile(id, {
		name: b.name,
		description: b.description,
		identity: b.identity,
		voice: b.voice,
		audience: b.audience,
		styleGuide: b.styleGuide ?? b.style_guide,
		contextNotes: b.contextNotes ?? b.context_notes
	})
	return c.json(await getProfile(id))
})

/** Delete a profile and remove it from any project defaults. */
app.delete('/profiles/:id', async (c) => {
	await deleteProfile(c.req.param('id'))
	return c.json({ ok: true })
})

/** Delete a project and everything under it (its runs + archive). Blocked if a run is live. */
app.delete('/projects/:id', async (c) => {
	const id = c.req.param('id')
	if (projectHasActiveRun(id)) return c.json({ error: 'a run for this project is in progress' }, 409)
	await deleteProject(id)
	forgetProjectRuns(id)
	return c.json({ ok: true })
})

/** Clear all runs for a project (keeps the project). Blocked if a run is live. */
app.delete('/projects/:id/runs', async (c) => {
	const id = c.req.param('id')
	if (projectHasActiveRun(id)) return c.json({ error: 'a run for this project is in progress' }, 409)
	await deleteProjectRuns(id)
	forgetProjectRuns(id)
	return c.json({ ok: true })
})

/**
 * Intent-capture chat. The conductor runs a 1:1 interview directly against
 * OpenRouter (deepseek-v4-pro) — no Coral session needed for a single-agent
 * conversation. Body: { messages: [{role,content}] } (user/assistant history,
 * no system). Returns { reply, proposal, usage, model }; `proposal` is non-null
 * once the model has enough to fill the topic model, and the frontend then
 * confirms it and PATCHes the project.
 */
app.post('/projects/:id/intent/chat', async (c) => {
	const id = c.req.param('id')
	const project = await getProject(id)
	if (!project) return c.json({ error: 'not found' }, 404)
	const b = await c.req.json().catch(() => null)
	const history: ChatMessage[] = Array.isArray(b?.messages)
		? b.messages
				.filter(
					(m: unknown): m is ChatMessage =>
						!!m &&
						typeof m === 'object' &&
						((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
						typeof (m as ChatMessage).content === 'string'
				)
				.map((m: ChatMessage) => ({ role: m.role, content: m.content }))
		: []
	const system = buildIntentSystemPrompt(String(project.name ?? ''), String(project.description ?? ''))
	// First touch: with no history the model would only see the system prompt and
	// often returns nothing, so the UI looked dead until the user typed. Inject a
	// kickoff user turn so the interview opens itself with the first question.
	const seed: ChatMessage[] = history.length
		? history
		: [{ role: 'user', content: 'Begin the interview now — greet me in one short sentence and ask your first question.' }]
	try {
		const res = await chat([{ role: 'system', content: system }, ...seed])
		const { proposal, display } = extractProposal(res.content)
		return c.json({ reply: display, proposal, usage: res.usage, model: res.model })
	} catch (e) {
		return c.json({ error: (e as Error).message }, 502)
	}
})

// ---- config (the Settings surface) ------------------------------------------

/** Redacted config + storage status for the Settings UI (never sends full keys). */
app.get('/config', (c) =>
	c.json({
		keys: redactedConfig(),
		storage: { mode: isCloud() ? 'cloud' : 'local', path: configPath() }
	})
)

/** Write config keys to ~/.geostack/config. Empty value clears a key. */
app.put('/config', async (c) => {
	const b = await c.req.json().catch(() => null)
	if (!b || typeof b !== 'object') return c.json({ error: 'invalid body' }, 400)
	const values: Record<string, string> = {}
	for (const k of CONFIG_KEYS) if (k in b) values[k] = String(b[k] ?? '')
	writeConfig(values)
	applyConfigToEnv() // pick up non-storage keys immediately (storage needs a restart)
	return c.json({ ok: true, keys: redactedConfig() })
})

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[conductor] listening on http://localhost:${info.port}`)
	console.log(`[conductor] storage: ${isCloud() ? 'Turso cloud' : 'local file (~/.geostack/geostack.db)'}`)
	void initSchema()
})
