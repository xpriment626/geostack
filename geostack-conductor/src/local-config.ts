import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Single local config at ~/.geostack/config — dotenv format, so BOTH sides read
 * it: the conductor parses it here, and the agents' startup.sh `source`s it.
 * This is the one place keys live (collapsing the scattered .env files).
 *
 * The Settings UI writes it via the conductor's /config endpoints. Stored 0600
 * (user-only) since it holds API keys.
 */

const DIR = join(homedir(), '.geostack')
const FILE = join(DIR, 'config')

/** Keys the Settings surface manages. */
export const CONFIG_KEYS = [
	'OPENROUTER_API_KEY',
	'EXA_API_KEY',
	'TURSO_DATABASE_URL',
	'TURSO_AUTH_TOKEN',
	'VITE_REPLICATE_API_TOKEN'
] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

export function configPath(): string {
	return FILE
}

/** Parse ~/.geostack/config (dotenv) → map. Missing file → {}. */
export function readConfig(): Record<string, string> {
	if (!existsSync(FILE)) return {}
	const out: Record<string, string> = {}
	for (const line of readFileSync(FILE, 'utf-8').split('\n')) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
		if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
	}
	return out
}

/** Merge + persist the given values (empty string clears a key). 0600. */
export function writeConfig(values: Partial<Record<ConfigKey, string>>): void {
	mkdirSync(DIR, { recursive: true })
	const merged = { ...readConfig() }
	for (const [k, v] of Object.entries(values)) {
		if (v == null || v === '') delete merged[k]
		else merged[k] = v
	}
	const body = Object.entries(merged)
		.map(([k, v]) => `${k}=${v}`)
		.join('\n')
	writeFileSync(FILE, body + (body ? '\n' : ''), { mode: 0o600 })
}

/**
 * Load the config file into process.env at startup — the file is the source of
 * truth for managed keys (so the Settings UI takes effect), but an explicitly
 * set shell env var still wins (handy for dev overrides).
 */
export function applyConfigToEnv(): void {
	const cfg = readConfig()
	for (const [k, v] of Object.entries(cfg)) {
		if (v && process.env[k] === undefined) process.env[k] = v
	}
}

/** A redacted view for the Settings UI — never sends full secrets to the browser. */
export function redactedConfig(): Record<string, { set: boolean; hint: string }> {
	const cfg = readConfig()
	const out: Record<string, { set: boolean; hint: string }> = {}
	for (const k of CONFIG_KEYS) {
		const v = cfg[k] ?? ''
		out[k] = { set: !!v, hint: v ? `…${v.slice(-4)}` : '' }
	}
	return out
}
