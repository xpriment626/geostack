import { createClient, type Client } from '@libsql/client'
import type { RunState } from './types.js'

/**
 * Turso (libsql) archive layer — the run record + lifecycle/cost instrument.
 *
 * Split-by-kind per the design doc: Turso holds the immutable-ish run archive
 * (runs / agent_turns / sessions); Supabase will hold live app state later.
 *
 * ALL writes are best-effort and the whole layer no-ops when creds are absent,
 * so the conductor runs fine without Turso configured (and a DB hiccup never
 * breaks a run).
 */

let client: Client | null = null

export function dbEnabled(): boolean {
	return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN)
}

function getClient(): Client | null {
	if (!dbEnabled()) return null
	if (!client) {
		client = createClient({
			url: process.env.TURSO_DATABASE_URL!,
			authToken: process.env.TURSO_AUTH_TOKEN!
		})
	}
	return client
}

export async function initSchema(): Promise<void> {
	const c = getClient()
	if (!c) {
		console.log('[db] Turso not configured (no TURSO_DATABASE_URL/AUTH_TOKEN) — archive disabled.')
		return
	}
	await c.batch(
		[
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
	console.log('[db] Turso archive ready (runs, agent_turns, sessions).')
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

/** Recent runs, newest first — for the inspector's run list. */
export async function listRuns(limit = 50): Promise<Row[]> {
	const c = getClient()
	if (!c) return []
	try {
		const r = await c.execute({
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
