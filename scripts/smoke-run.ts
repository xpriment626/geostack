#!/usr/bin/env bun
/**
 * THROWAWAY smoke harness for the conductor-driven synthesis star (Stage A/B).
 * Fires one production run straight at the conductor with a hand-built intent
 * artifact (no UI / no intent-chat), then polls until done/failed, printing
 * stage transitions. Bypasses everything but the orchestrator so a run is the
 * cheapest possible exercise of research fan-out + the new synthesis hops.
 *
 *   bun run scripts/smoke-run.ts
 */
const API = process.env.CONDUCTOR_URL ?? 'http://localhost:8787'
const researchSources = (process.env.GEOSTACK_SMOKE_SOURCES ?? 'exa')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean)

const intent = {
	projectId: `smoke_${Date.now()}`,
	anchorClaim:
		"DeepSeek-V3's mixture-of-experts design reaches frontier-class reasoning at a fraction of the usual training cost",
	targetQuery: 'how does DeepSeek train competitive LLMs so cheaply',
	formatType: { mode: 'single', depth: 'deep-dive' },
	researchSources,
	audience: 'ML engineers and technical founders',
	tone: 'precise, analytical, no hype',
	raw: [
		'# Brief',
		'Anchor: DeepSeek-V3 MoE → frontier reasoning at low training cost.',
		'Target query: how DeepSeek trains competitive LLMs cheaply.',
		'Want a citation-dense deep-dive that a chat agent would cite when asked',
		'"why is DeepSeek so cheap to train". Ground every claim in real sources.'
	].join('\n')
}

async function main() {
	console.log(`→ POST ${API}/runs  (project ${intent.projectId})`)
	const res = await fetch(`${API}/runs`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ intent })
	})
	if (!res.ok) {
		console.error(`✗ POST /runs failed: ${res.status} ${await res.text()}`)
		process.exit(1)
	}
	const { runId } = (await res.json()) as { runId: string; stage: string }
	console.log(`✓ run started: ${runId}`)

	let lastStage = ''
	const started = Date.now()
	// Generous ceiling: research (≤6m) + a multi-hop synthesis star on a slow
	// reasoning model. We just watch; the conductor enforces its own timeouts.
	const deadline = started + 30 * 60_000
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 4000))
		const r = await fetch(`${API}/runs/${runId}`).catch(() => null)
		if (!r || !r.ok) continue
		const run = (await r.json()) as {
			stage: string
			error?: string
			output?: { markdown: string; grounding?: unknown[] }
		}
		if (run.stage !== lastStage) {
			const t = ((Date.now() - started) / 1000).toFixed(0)
			console.log(`  [${t}s] stage → ${run.stage}`)
			lastStage = run.stage
		}
		if (run.stage === 'done') {
			const md = run.output?.markdown ?? ''
			console.log(`\n✓ DONE — ${md.length} chars, ${run.output?.grounding?.length ?? 0} grounding entries`)
			console.log('───────── output head ─────────')
			console.log(md.slice(0, 1200))
			console.log('───────────────────────────────')
			process.exit(0)
		}
		if (run.stage === 'failed') {
			console.error(`\n✗ FAILED: ${run.error}`)
			process.exit(2)
		}
	}
	console.error('\n✗ timed out waiting for run to finish')
	process.exit(3)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
