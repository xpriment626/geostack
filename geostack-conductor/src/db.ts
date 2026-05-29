import { createClient, type Client } from '@libsql/client'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RunState } from './types.js'

/**
 * libsql store — projects + run archive + lifecycle/cost instrument.
 *
 * Local-first: defaults to an embedded file at ~/.geostack/geostack.db (zero
 * config). Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to point at Turso cloud
 * instead — same client, same schema. One store holds everything; the conductor
 * is the sole writer, so the embedded file has no concurrent-writer contention.
 *
 * Writes are best-effort; a DB hiccup never breaks a run.
 */

let client: Client | null = null

/** True when pointed at Turso cloud (vs the local embedded file). */
export function isCloud(): boolean {
	return !!process.env.TURSO_DATABASE_URL
}

/** Resolve the libsql URL: Turso cloud if configured, else a local file. */
function dbUrl(): string {
	if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL
	const dir = join(homedir(), '.geostack')
	mkdirSync(dir, { recursive: true })
	return `file:${join(dir, 'geostack.db')}`
}

/** Storage is always available now (local file by default), so this is always true. */
export function dbEnabled(): boolean {
	return true
}

function getClient(): Client | null {
	if (!client) {
		const url = dbUrl()
		const authToken = process.env.TURSO_AUTH_TOKEN // optional; ignored for file: URLs
		client = createClient(authToken ? { url, authToken } : { url })
	}
	return client
}

export async function initSchema(): Promise<void> {
	const c = getClient()
	if (!c) return
	await c.batch(
		[
			`CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY,
				name TEXT,
				description TEXT,
				audience TEXT,
				tone TEXT,
				profile_id TEXT,
				topic_meta TEXT,
				created_at INTEGER,
				updated_at INTEGER
			)`,
			`CREATE TABLE IF NOT EXISTS profiles (
				id TEXT PRIMARY KEY,
				name TEXT,
				description TEXT,
				identity TEXT,
				voice TEXT,
				audience TEXT,
				style_guide TEXT,
				context_notes TEXT,
				created_at INTEGER,
				updated_at INTEGER
			)`,
			`CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				project_id TEXT,
				kind TEXT DEFAULT 'production',
				stage TEXT,
				intent TEXT,
				research TEXT,
				output TEXT,
				error TEXT,
				created_at INTEGER,
				updated_at INTEGER
			)`,
			`CREATE TABLE IF NOT EXISTS agent_turns (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT,
				stage TEXT,
				agent TEXT,
				model TEXT,
				input_tokens INTEGER,
				output_tokens INTEGER,
				cost_usd REAL,
				created_at INTEGER
			)`,
			`CREATE TABLE IF NOT EXISTS sessions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT,
				stage TEXT,
				coral_session_id TEXT,
				started_at INTEGER,
				closed_at INTEGER
			)`
		],
		'write'
	)
	try {
		await c.execute(`ALTER TABLE projects ADD COLUMN profile_id TEXT`)
	} catch {
		// Existing local DBs already have the column after the first upgraded boot.
	}
	console.log(
		`[db] store ready (projects, profiles, runs, agent_turns, sessions) — ${isCloud() ? 'Turso cloud' : `local file ${join(homedir(), '.geostack', 'geostack.db')}`}`
	)
}

// ---- projects ---------------------------------------------------------------

export interface ProjectInput {
	name: string
	description?: string
	audience?: string
	tone?: string
	profileId?: string | null
	topicMeta?: unknown
}

/** Create a project row. Returns the new id. */
export async function createProject(id: string, p: ProjectInput): Promise<void> {
	const c = getClient()
	if (!c) return
	const now = Date.now()
	try {
		await c.execute({
			sql: `INSERT INTO projects (id, name, description, audience, tone, profile_id, topic_meta, created_at, updated_at)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				id,
				p.name,
				p.description ?? '',
				p.audience ?? '',
				p.tone ?? '',
				p.profileId ?? null,
				p.topicMeta ? JSON.stringify(p.topicMeta) : null,
				now,
				now
			]
		})
	} catch (err) {
		console.warn(`[db] createProject failed: ${(err as Error).message}`)
	}
}

/** Patch a subset of a project's columns. */
export async function updateProject(id: string, p: Partial<ProjectInput>): Promise<void> {
	const c = getClient()
	if (!c) return
	const sets: string[] = []
	const args: (string | number | null)[] = []
	if (p.name !== undefined) (sets.push('name=?'), args.push(p.name))
	if (p.description !== undefined) (sets.push('description=?'), args.push(p.description))
	if (p.audience !== undefined) (sets.push('audience=?'), args.push(p.audience))
	if (p.tone !== undefined) (sets.push('tone=?'), args.push(p.tone))
	if (p.profileId !== undefined) (sets.push('profile_id=?'), args.push(p.profileId || null))
	if (p.topicMeta !== undefined) (sets.push('topic_meta=?'), args.push(JSON.stringify(p.topicMeta)))
	if (!sets.length) return
	sets.push('updated_at=?')
	args.push(Date.now(), id)
	try {
		await c.execute({ sql: `UPDATE projects SET ${sets.join(', ')} WHERE id=?`, args })
	} catch (err) {
		console.warn(`[db] updateProject failed: ${(err as Error).message}`)
	}
}

/** Delete a project and everything under it (its runs + their turns + sessions). */
export async function deleteProject(id: string): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		await c.batch(
			[
				{ sql: `DELETE FROM agent_turns WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`, args: [id] },
				{ sql: `DELETE FROM sessions WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`, args: [id] },
				{ sql: `DELETE FROM runs WHERE project_id = ?`, args: [id] },
				{ sql: `DELETE FROM projects WHERE id = ?`, args: [id] }
			],
			'write'
		)
	} catch (err) {
		console.warn(`[db] deleteProject failed: ${(err as Error).message}`)
	}
}

/** Delete one run and its archive rows (agent_turns + sessions). */
export async function deleteRun(runId: string): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		await c.batch(
			[
				{ sql: `DELETE FROM agent_turns WHERE run_id = ?`, args: [runId] },
				{ sql: `DELETE FROM sessions WHERE run_id = ?`, args: [runId] },
				{ sql: `DELETE FROM runs WHERE id = ?`, args: [runId] }
			],
			'write'
		)
	} catch (err) {
		console.warn(`[db] deleteRun failed: ${(err as Error).message}`)
	}
}

/** Delete all runs (and their archive rows) for a project, keeping the project. */
export async function deleteProjectRuns(projectId: string): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		await c.batch(
			[
				{ sql: `DELETE FROM agent_turns WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`, args: [projectId] },
				{ sql: `DELETE FROM sessions WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)`, args: [projectId] },
				{ sql: `DELETE FROM runs WHERE project_id = ?`, args: [projectId] }
			],
			'write'
		)
	} catch (err) {
		console.warn(`[db] deleteProjectRuns failed: ${(err as Error).message}`)
	}
}

// ---- profiles ---------------------------------------------------------------

export interface ProfileInput {
	name: string
	description?: string
	identity?: string
	voice?: string
	audience?: string
	styleGuide?: string
	contextNotes?: string
}

export async function createProfile(id: string, p: ProfileInput): Promise<void> {
	const c = getClient()
	if (!c) return
	const now = Date.now()
	try {
		await c.execute({
			sql: `INSERT INTO profiles (id, name, description, identity, voice, audience, style_guide, context_notes, created_at, updated_at)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				id,
				p.name,
				p.description ?? '',
				p.identity ?? '',
				p.voice ?? '',
				p.audience ?? '',
				p.styleGuide ?? '',
				p.contextNotes ?? '',
				now,
				now
			]
		})
	} catch (err) {
		console.warn(`[db] createProfile failed: ${(err as Error).message}`)
	}
}

export async function updateProfile(id: string, p: Partial<ProfileInput>): Promise<void> {
	const c = getClient()
	if (!c) return
	const sets: string[] = []
	const args: (string | number)[] = []
	if (p.name !== undefined) (sets.push('name=?'), args.push(p.name))
	if (p.description !== undefined) (sets.push('description=?'), args.push(p.description))
	if (p.identity !== undefined) (sets.push('identity=?'), args.push(p.identity))
	if (p.voice !== undefined) (sets.push('voice=?'), args.push(p.voice))
	if (p.audience !== undefined) (sets.push('audience=?'), args.push(p.audience))
	if (p.styleGuide !== undefined) (sets.push('style_guide=?'), args.push(p.styleGuide))
	if (p.contextNotes !== undefined) (sets.push('context_notes=?'), args.push(p.contextNotes))
	if (!sets.length) return
	sets.push('updated_at=?')
	args.push(Date.now(), id)
	try {
		await c.execute({ sql: `UPDATE profiles SET ${sets.join(', ')} WHERE id=?`, args })
	} catch (err) {
		console.warn(`[db] updateProfile failed: ${(err as Error).message}`)
	}
}

export async function deleteProfile(id: string): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		await c.batch(
			[
				{ sql: `UPDATE projects SET profile_id = NULL WHERE profile_id = ?`, args: [id] },
				{ sql: `DELETE FROM profiles WHERE id = ?`, args: [id] }
			],
			'write'
		)
	} catch (err) {
		console.warn(`[db] deleteProfile failed: ${(err as Error).message}`)
	}
}

export async function listProfiles(): Promise<Row[]> {
	const c = getClient()
	if (!c) return []
	try {
		const r = await c.execute(`SELECT * FROM profiles ORDER BY updated_at DESC`)
		return r.rows as Row[]
	} catch (err) {
		console.warn(`[db] listProfiles failed: ${(err as Error).message}`)
		return []
	}
}

export async function getProfile(id: string): Promise<Row | null> {
	const c = getClient()
	if (!c) return null
	try {
		const r = await c.execute({ sql: `SELECT * FROM profiles WHERE id=?`, args: [id] })
		return (r.rows[0] as Row) ?? null
	} catch (err) {
		console.warn(`[db] getProfile failed: ${(err as Error).message}`)
		return null
	}
}

export async function listProjects(): Promise<Row[]> {
	const c = getClient()
	if (!c) return []
	try {
		const r = await c.execute(`SELECT * FROM projects ORDER BY updated_at DESC`)
		return r.rows as Row[]
	} catch (err) {
		console.warn(`[db] listProjects failed: ${(err as Error).message}`)
		return []
	}
}

export async function getProject(id: string): Promise<Row | null> {
	const c = getClient()
	if (!c) return null
	try {
		const r = await c.execute({ sql: `SELECT * FROM projects WHERE id=?`, args: [id] })
		return (r.rows[0] as Row) ?? null
	} catch (err) {
		console.warn(`[db] getProject failed: ${(err as Error).message}`)
		return null
	}
}

/** Upsert the run row at each lifecycle transition. */
export async function persistRun(run: RunState): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		const now = Date.now()
		await c.execute({
			sql: `INSERT INTO runs (id, project_id, kind, stage, intent, research, output, error, created_at, updated_at)
			      VALUES (?, ?, 'production', ?, ?, ?, ?, ?, ?, ?)
			      ON CONFLICT(id) DO UPDATE SET
			        stage=excluded.stage, intent=excluded.intent, research=excluded.research,
			        output=excluded.output, error=excluded.error, updated_at=excluded.updated_at`,
			args: [
				run.id,
				run.projectId,
				run.stage,
				run.intent ? JSON.stringify(run.intent) : null,
				run.research ? JSON.stringify(run.research) : null,
				run.output ? JSON.stringify(run.output) : null,
				run.error ?? null,
				run.createdAt,
				now
			]
		})
	} catch (err) {
		console.warn(`[db] persistRun failed: ${(err as Error).message}`)
	}
}

/** Record a session opening (started_at) or closing (closed_at) — lifecycle/stress-test instrument. */
export async function recordSession(e: {
	runId: string
	stage: string
	sessionId: string
	phase: 'open' | 'closed'
}): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		const now = Date.now()
		if (e.phase === 'open') {
			await c.execute({
				sql: `INSERT INTO sessions (run_id, stage, coral_session_id, started_at) VALUES (?, ?, ?, ?)`,
				args: [e.runId, e.stage, e.sessionId, now]
			})
		} else {
			await c.execute({
				sql: `UPDATE sessions SET closed_at=? WHERE run_id=? AND coral_session_id=? AND closed_at IS NULL`,
				args: [now, e.runId, e.sessionId]
			})
		}
	} catch (err) {
		console.warn(`[db] recordSession failed: ${(err as Error).message}`)
	}
}

type Row = Record<string, unknown>

/** Read a persisted run row (for runs no longer in the conductor's memory). */
export async function getRun(runId: string): Promise<Row | null> {
	const c = getClient()
	if (!c) return null
	try {
		const r = await c.execute({ sql: `SELECT * FROM runs WHERE id = ?`, args: [runId] })
		return (r.rows[0] as Row) ?? null
	} catch (err) {
		console.warn(`[db] getRun failed: ${(err as Error).message}`)
		return null
	}
}

/** Sessions (lifecycle timing) + agent_turns (cost) for one run — feeds the inspector. */
export async function getRunArchive(runId: string): Promise<{ sessions: Row[]; agentTurns: Row[] }> {
	const c = getClient()
	if (!c) return { sessions: [], agentTurns: [] }
	try {
		const s = await c.execute({
			sql: `SELECT stage, coral_session_id, started_at, closed_at FROM sessions WHERE run_id = ? ORDER BY started_at`,
			args: [runId]
		})
		const t = await c.execute({
			sql: `SELECT stage, agent, model, input_tokens, output_tokens, cost_usd, created_at FROM agent_turns WHERE run_id = ? ORDER BY created_at`,
			args: [runId]
		})
		return { sessions: s.rows as Row[], agentTurns: t.rows as Row[] }
	} catch (err) {
		console.warn(`[db] getRunArchive failed: ${(err as Error).message}`)
		return { sessions: [], agentTurns: [] }
	}
}

/** Recent runs, newest first — optionally scoped to one project. */
export async function listRuns(limit = 50, projectId?: string): Promise<Row[]> {
	const c = getClient()
	if (!c) return []
	try {
		const r = projectId
			? await c.execute({
					sql: `SELECT id, project_id, stage, error, created_at, updated_at FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
					args: [projectId, limit]
				})
			: await c.execute({
					sql: `SELECT id, project_id, stage, error, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT ?`,
					args: [limit]
				})
		return r.rows as Row[]
	} catch (err) {
		console.warn(`[db] listRuns failed: ${(err as Error).message}`)
		return []
	}
}

/** Record one agent turn's token usage + cost (populated by worker reporting — task #15). */
export async function recordAgentTurn(t: {
	runId: string
	stage: string
	agent: string
	model: string
	inputTokens: number
	outputTokens: number
	costUsd: number
}): Promise<void> {
	const c = getClient()
	if (!c) return
	try {
		await c.execute({
			sql: `INSERT INTO agent_turns (run_id, stage, agent, model, input_tokens, output_tokens, cost_usd, created_at)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [t.runId, t.stage, t.agent, t.model, t.inputTokens, t.outputTokens, t.costUsd, Date.now()]
		})
	} catch (err) {
		console.warn(`[db] recordAgentTurn failed: ${(err as Error).message}`)
	}
}
