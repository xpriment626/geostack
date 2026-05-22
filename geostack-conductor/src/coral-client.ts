import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Node Coral client for the conductor.
 *
 * Mirrors the PROVEN endpoint contracts from app/src/lib/coral.ts (which is
 * browser-bound — location/WebSocket — so can't be imported here) and adds the
 * two things the coral-agent-swarm skill mandates that coral.ts lacks:
 *   - GET /extended as the source of truth (the WS stream is best-effort).
 *   - readiness polling before sending (executable agents cold-start 20-40s).
 *
 * We deliberately do NOT invent a protocol — this is the documented HTTP API.
 */

const BASE = process.env.CORAL_SERVER_URL ?? 'http://localhost:5555'
const TOKEN = process.env.CORAL_TOKEN ?? 'local'

// ---- wire types (subset of coral-server's serialized shapes) ----------------

export interface SessionIdentifier {
	sessionId: string
	namespace: string
}

export interface CoralMessage {
	id: string
	threadId: string
	text: string
	senderName: string
	mentionNames: string[]
	timestamp: string
}

export interface CoralThread {
	id: string
	name: string
	creatorName: string
	participants?: string[]
	messages?: CoralMessage[]
	state?: unknown
}

export interface CoralAgentState {
	name: string
	status?: unknown // nested running -> connected -> thinking/waiting/sleeping
}

export interface ExtendedState {
	base: { namespace: string; status?: unknown }
	agents: CoralAgentState[]
	threads: CoralThread[]
}

export interface CreateSessionRequest {
	agentGraphRequest: {
		agents: Array<{
			id: { name: string; version: string; registrySourceId: { type: 'local' | 'marketplace' } }
			name: string
			provider: { type: 'local'; runtime: 'prototype' | 'executable' | 'docker' | 'function' }
			options?: Record<string, unknown>
			description?: string
			blocking?: boolean
		}>
		groups?: Array<string[]>
	}
	namespaceProvider:
		| { type: 'create_if_not_exists'; namespaceRequest: { name: string; deleteOnLastSessionExit?: boolean } }
		| { type: 'use_existing'; name: string }
	execution?: { mode: 'immediate'; runtimeSettings?: { ttl?: number } } | { mode: 'defer' }
}

// ---- low-level ---------------------------------------------------------------

function headers(): Record<string, string> {
	return { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`Coral ${res.status}: ${text || res.statusText}`)
	}
	return (await res.json()) as T
}

// ---- session lifecycle (proven contracts) -----------------------------------

export async function createSession(req: CreateSessionRequest): Promise<SessionIdentifier> {
	const res = await fetch(`${BASE}/api/v1/local/session`, {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify(req)
	})
	return jsonOrThrow<SessionIdentifier>(res)
}

export async function closeSession(s: SessionIdentifier): Promise<void> {
	await fetch(`${BASE}/api/v1/local/session/${s.namespace}/${s.sessionId}`, {
		method: 'DELETE',
		headers: headers()
	}).catch(() => {
		/* best-effort; closing a torn-down session is fine */
	})
}

export async function getExtended(s: SessionIdentifier): Promise<ExtendedState> {
	const res = await fetch(
		`${BASE}/api/v1/local/session/${s.namespace}/${s.sessionId}/extended`,
		{ headers: headers() }
	)
	return jsonOrThrow<ExtendedState>(res)
}

// ---- puppet (act as an agent — our conductor's proxy identity) --------------

export async function puppetCreateThread(
	s: SessionIdentifier,
	agentName: string,
	body: { threadName: string; participantNames: string[] }
): Promise<{ thread: CoralThread }> {
	const res = await fetch(
		`${BASE}/api/v1/puppet/${s.namespace}/${s.sessionId}/${agentName}/thread`,
		{ method: 'POST', headers: headers(), body: JSON.stringify(body) }
	)
	return jsonOrThrow(res)
}

export async function puppetSendMessage(
	s: SessionIdentifier,
	agentName: string,
	body: { threadId: string; content: string; mentions: string[] }
): Promise<{ status: string; message: CoralMessage }> {
	const res = await fetch(
		`${BASE}/api/v1/puppet/${s.namespace}/${s.sessionId}/${agentName}/thread/message`,
		{ method: 'POST', headers: headers(), body: JSON.stringify(body) }
	)
	return jsonOrThrow(res)
}

// ---- readiness + message polling (skill: /extended is source of truth) ------

export type AgentReadiness = 'ready' | 'starting' | 'stopped'

/** Classify an agent's nested status. Defensive — the status tree is loosely typed. */
export function agentReadiness(agent: CoralAgentState): AgentReadiness {
	const s = agent.status as
		| { type?: string; connectionStatus?: { type?: string; communicationStatus?: { type?: string } } }
		| undefined
	if (s?.type === 'stopped') return 'stopped'
	if (s?.type === 'running' && s.connectionStatus?.type === 'connected') {
		const comm = s.connectionStatus.communicationStatus?.type
		if (comm === 'waiting_message' || comm === 'thinking') return 'ready'
	}
	return 'starting'
}

/**
 * Poll /extended until every named agent is `ready`, or one is `stopped`
 * (failed to boot), or timeout. Honors the skill's cold-start guidance.
 */
export async function waitForAgentsReady(
	s: SessionIdentifier,
	agentNames: string[],
	opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ ok: boolean; stopped: string[] }> {
	const timeoutMs = opts.timeoutMs ?? 60_000
	const intervalMs = opts.intervalMs ?? 2_000
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const ext = await getExtended(s).catch(() => null)
		if (ext) {
			const wanted = ext.agents.filter((a) => agentNames.includes(a.name))
			const stopped = wanted.filter((a) => agentReadiness(a) === 'stopped').map((a) => a.name)
			if (stopped.length > 0) return { ok: false, stopped }
			if (wanted.length >= agentNames.length && wanted.every((a) => agentReadiness(a) === 'ready')) {
				return { ok: true, stopped: [] }
			}
		}
		await sleep(intervalMs)
	}
	return { ok: false, stopped: [] }
}

/** Flatten all messages across all threads in an extended snapshot. */
export function allMessages(ext: ExtendedState): CoralMessage[] {
	return ext.threads.flatMap((t) => t.messages ?? [])
}

/**
 * Poll /extended, scanning thread messages, until `predicate` is satisfied or
 * timeout. `predicate` receives the full message list each tick and returns a
 * result to resolve with, or null to keep waiting. This is the skill's
 * "GET /extended is the source of truth" loop — no reliance on the WS stream.
 */
export async function pollMessages<T>(
	s: SessionIdentifier,
	predicate: (messages: CoralMessage[]) => T | null,
	opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T | null> {
	const timeoutMs = opts.timeoutMs ?? 180_000
	const intervalMs = opts.intervalMs ?? 1_500
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const ext = await getExtended(s).catch(() => null)
		if (ext) {
			const hit = predicate(allMessages(ext))
			if (hit !== null) return hit
		}
		await sleep(intervalMs)
	}
	return null
}
