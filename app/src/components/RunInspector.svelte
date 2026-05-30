<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { marked } from 'marked'
  import { getProject } from '../lib/api'

  let {
    onBack,
    projectId,
    embedded = false,
    seed = null,
  }: {
    onBack?: () => void
    projectId?: string
    embedded?: boolean
    seed?: { anchorClaim?: string; targetQuery?: string } | null
  } = $props()

  // ---- shapes (mirror the conductor's /runs + /runs/:id) -------------------
  interface RunListItem {
    id: string
    project_id?: string
    stage: string
    created_at?: number
    error?: string
  }
  interface AgentTurn {
    stage: string
    agent: string
    model: string
    input_tokens: number
    output_tokens: number
    cost_usd: number
  }
  interface SessionRow {
    stage: string
    coral_session_id: string
    started_at: number
    closed_at?: number | null
  }
  interface GroundingItem { status: string; claim: string; reason?: string }
  interface RunOutput { markdown?: string; grounding?: GroundingItem[] }
  interface ResearchSourceResult { source?: string; sources?: unknown[]; notes?: string }
  interface ResearchArtifact { results?: Record<string, ResearchSourceResult | undefined> }
  interface RevisionRow {
    id: string
    status: 'running' | 'done' | 'failed'
    instruction: string
    contextLinks?: string[]
    context_links?: string
    error?: string
    created_at?: number
    updated_at?: number
  }
  interface RunIntent {
    researchSources?: string[]
    additionalDirection?: string
    contextLinks?: string[]
  }
  interface RunDetail {
    id: string
    stage: string
    project_id?: string
    projectId?: string
    error?: string
    sessions?: SessionRow[]
    agentTurns?: AgentTurn[]
    intent?: RunIntent | null
    research?: ResearchArtifact | null
    output?: RunOutput | null
    revisions?: RevisionRow[]
  }

  const STAGES = ['intent', 'research', 'synthesis', 'done']
  const API = '/conductor'

  let runs = $state<RunListItem[]>([])
  let selectedId = $state<string | null>(null)
  let detail = $state<RunDetail | null>(null)
  let starting = $state(false)
  let loadError = $state<string | null>(null)

  // new-run form (only works while the conductor + coral server are up).
  // When embedded in a project, projectId comes from the prop and the field is hidden.
  let formProjectId = $state('agentic-memory')
  let anchorClaim = $state(
    'Durable agentic memory requires structural curation (dedup + reorganization), not merely larger context windows'
  )
  let targetQuery = $state('how should AI agents manage long-term memory across sessions')
  let mode = $state<'single' | 'batch'>('single')
  let depth = $state<'deep-dive' | 'listicle'>('deep-dive')
  let audience = $state('engineers building multi-agent systems')
  let tone = $state('authoritative, technical, plain')
  let additionalDirection = $state('')
  let contextLinksText = $state('')
  let useDeepwiki = $state(false)
  let useGrok = $state(false)
  let revisionInstruction = $state('')
  let revisionLinksText = $state('')
  let revisionRunning = $state(false)

  // When embedded in a project, the form seeds from the project's captured
  // topic metadata (and offers its claims/queries as quick picks).
  let projectClaims = $state<string[]>([])
  let projectQueries = $state<string[]>([])

  let listTimer: ReturnType<typeof setInterval> | null = null
  let detailTimer: ReturnType<typeof setInterval> | null = null

  async function api(path: string, opts?: RequestInit) {
    const r = await fetch(API + path, opts)
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    return r.json()
  }

  const fmtCost = (n: unknown) => '$' + (Number(n) || 0).toFixed(5)
  const fmtDur = (a?: number | null, b?: number | null) =>
    a && b ? ((b - a) / 1000).toFixed(1) + 's' : a ? 'open' : '—'
  const shortId = (s?: string) => (s ? String(s).slice(0, 8) : '')
  const researchLabel = (sources?: string[]) => {
    const s = sources?.length ? sources : ['exa']
    return s.map((x) => (x === 'deepwiki' ? 'DeepWiki' : x === 'grok' ? 'Grok/X' : 'Exa')).join(' + ')
  }
  const parseLinks = (text: string) =>
    Array.from(
      new Set(
        text
          .split(/[\n,]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      )
    )
  let researchSources = $derived.by(() => [
    'exa',
    ...(useDeepwiki ? ['deepwiki'] : []),
    ...(useGrok ? ['grok'] : []),
  ])

  async function loadRuns() {
    try {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      const { runs: list } = await api('/runs' + q)
      runs = list ?? []
      loadError = null
    } catch (e) {
      loadError = (e as Error).message
    }
  }

  async function renderRun() {
    if (!selectedId) return
    try {
      const run: RunDetail = await api('/runs/' + selectedId)
      detail = run
      revisionRunning = !!run.revisions?.some((r) => r.status === 'running')
      if ((run.stage === 'done' || run.stage === 'failed') && !revisionRunning) stopDetailPoll()
    } catch {
      /* conductor may be mid-restart */
    }
  }

  function stopDetailPoll() {
    if (detailTimer) {
      clearInterval(detailTimer)
      detailTimer = null
    }
  }

  async function selectRun(id: string) {
    selectedId = id
    detail = null
    stopDetailPoll()
    await renderRun()
    void loadRuns()
    detailTimer = setInterval(renderRun, 3000)
  }

  async function startRun() {
    starting = true
    try {
      const intent = {
        projectId: projectId ?? formProjectId,
        anchorClaim,
        targetQuery,
        formatType: { mode, depth },
        researchSources,
        audience,
        tone,
        additionalDirection: additionalDirection.trim() || undefined,
        contextLinks: parseLinks(contextLinksText),
        raw: [
          '# Brief',
          '',
          anchorClaim,
          additionalDirection.trim() ? `\n## Direction\n\n${additionalDirection.trim()}` : '',
          contextLinksText.trim() ? `\n## Context links\n\n${parseLinks(contextLinksText).map((url) => `- ${url}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
      const { runId } = await api('/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent }),
      })
      await selectRun(runId)
      void loadRuns()
    } catch (e) {
      alert('Start failed: ' + (e as Error).message)
    }
    starting = false
  }

  async function submitRevision() {
    if (!detail?.id || !revisionInstruction.trim() || revisionRunning) return
    revisionRunning = true
    try {
      await api(`/runs/${detail.id}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instruction: revisionInstruction.trim(),
          contextLinks: parseLinks(revisionLinksText),
        }),
      })
      revisionInstruction = ''
      revisionLinksText = ''
      await renderRun()
      if (!detailTimer) detailTimer = setInterval(renderRun, 3000)
      void loadRuns()
    } catch (e) {
      revisionRunning = false
      alert('Revision failed: ' + (e as Error).message)
    }
  }

  // One-click delete for fast throwaway pruning (no confirm — runs are cheap).
  async function delRun(e: Event, id: string) {
    e.stopPropagation()
    try {
      await api('/runs/' + id, { method: 'DELETE' })
      runs = runs.filter((r) => r.id !== id)
      if (selectedId === id) {
        selectedId = null
        detail = null
        stopDetailPoll()
      }
    } catch (err) {
      alert('Delete failed: ' + (err as Error).message)
    }
  }

  // Clear every run for this project (confirmed — bigger blast radius).
  async function clearRuns() {
    if (!projectId || !confirm('Delete ALL runs for this project? This can’t be undone.')) return
    try {
      await api('/projects/' + projectId + '/runs', { method: 'DELETE' })
      runs = []
      selectedId = null
      detail = null
      stopDetailPoll()
    } catch (err) {
      alert('Clear failed: ' + (err as Error).message)
    }
  }

  function reached(stage: string, step: string) {
    if (stage === 'failed') return STAGES.indexOf(step) <= STAGES.indexOf('research')
    return STAGES.indexOf(step) <= STAGES.indexOf(stage)
  }

  // ---- derived views -------------------------------------------------------
  let turns = $derived(detail?.agentTurns ?? [])
  let totalCost = $derived(turns.reduce((a, t) => a + (Number(t.cost_usd) || 0), 0))
  let outputHtml = $derived(
    detail?.output?.markdown ? (marked.parse(detail.output.markdown) as string) : ''
  )
  let researchRows = $derived.by(() => {
    const r = detail?.research?.results
    if (!r) return [] as { source: string; count: number; notes: string }[]
    return Object.entries(r)
      .filter(([, v]) => v)
      .map(([key, v]) => ({ source: v?.source ?? key, count: v?.sources?.length ?? 0, notes: v?.notes ?? '' }))
  })
  let latestRevision = $derived.by(() => {
    const revisions = detail?.revisions ?? []
    return revisions.length ? revisions[revisions.length - 1] : null
  })
  async function prefillFromProject() {
    if (!projectId) return
    try {
      const p = await getProject(projectId)
      if (p.audience) audience = p.audience
      if (p.tone) tone = p.tone
      const meta = p.topic_meta ? JSON.parse(p.topic_meta) : {}
      projectClaims = Array.isArray(meta.anchorClaims) ? meta.anchorClaims : []
      projectQueries = Array.isArray(meta.targetQueries) ? meta.targetQueries : []
      // A curated idea (seed) takes precedence over the project's first entry.
      if (projectClaims.length) anchorClaim = seed?.anchorClaim || projectClaims[0]
      if (projectQueries.length) targetQuery = seed?.targetQuery || projectQueries[0]
      if (seed?.anchorClaim) anchorClaim = seed.anchorClaim
      if (seed?.targetQuery) targetQuery = seed.targetQuery
    } catch {
      /* keep defaults */
    }
  }

  // Apply a curated idea seeded from the Ideation tab.
  $effect(() => {
    if (seed?.anchorClaim) anchorClaim = seed.anchorClaim
    if (seed?.targetQuery) targetQuery = seed.targetQuery
  })

  onMount(() => {
    void loadRuns()
    listTimer = setInterval(loadRuns, 5000)
    void prefillFromProject()
  })
  onDestroy(() => {
    if (listTimer) clearInterval(listTimer)
    stopDetailPoll()
  })
</script>

<div class="inspector" class:embedded>
  {#if !embedded}
    <header>
      <button class="back" onclick={() => onBack?.()}>← Back</button>
      <h1>Geostack</h1>
      <span class="sub">Run Inspector — GEO Content Fleet</span>
    </header>
  {/if}

  <div class="wrap">
    <aside class="left">
      <h2>New run</h2>
      {#if !projectId}
        <label for="run-project-id">Project ID</label>
        <input id="run-project-id" bind:value={formProjectId} />
      {/if}
      <label for="run-anchor-claim">Anchor claim</label>
      {#if projectClaims.length > 1}
        <select class="pick" onchange={(e) => (anchorClaim = (e.currentTarget as HTMLSelectElement).value)}>
          {#each projectClaims as cl}<option value={cl}>{cl.length > 64 ? cl.slice(0, 64) + '…' : cl}</option>{/each}
        </select>
      {/if}
      <textarea id="run-anchor-claim" bind:value={anchorClaim}></textarea>
      <label for="run-target-query">Target query</label>
      {#if projectQueries.length > 1}
        <select class="pick" onchange={(e) => (targetQuery = (e.currentTarget as HTMLSelectElement).value)}>
          {#each projectQueries as q}<option value={q}>{q.length > 64 ? q.slice(0, 64) + '…' : q}</option>{/each}
        </select>
      {/if}
      <input id="run-target-query" bind:value={targetQuery} />
      <div class="row2">
        <div>
          <label for="run-mode">Mode</label>
          <select id="run-mode" bind:value={mode}><option>single</option><option>batch</option></select>
        </div>
        <div>
          <label for="run-depth">Depth</label>
          <select id="run-depth" bind:value={depth}><option>deep-dive</option><option>listicle</option></select>
        </div>
      </div>
      <div class="field-label">Research</div>
      <div class="research-box">
        <div class="locked">
          <span class="source-pill locked-pill">Exa</span>
          <span class="faint">required web enrichment</span>
        </div>
        <label class="check">
          <input type="checkbox" bind:checked={useDeepwiki} />
          <span>DeepWiki</span>
          <small>repo/docs context</small>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={useGrok} />
          <span>Grok / X</span>
          <small>live social discourse</small>
        </label>
      </div>
      <label for="run-audience">Audience</label>
      <input id="run-audience" bind:value={audience} />
      <label for="run-tone">Tone</label>
      <input id="run-tone" bind:value={tone} />
      <label for="run-direction">Direction</label>
      <textarea
        id="run-direction"
        class="short-textarea"
        bind:value={additionalDirection}
        placeholder="Optional angle, constraints, or references to weave in"
      ></textarea>
      <label for="run-links">Source links</label>
      <textarea
        id="run-links"
        class="short-textarea links-input"
        bind:value={contextLinksText}
        placeholder="Optional URLs, one per line"
      ></textarea>
      <button class="start" onclick={startRun} disabled={starting}>
        {starting ? 'Starting…' : 'Start run'}
      </button>

      <h2 class="runs-head">
        <span>Recent runs</span>
        <span class="rh-actions">
          {#if projectId && runs.length}
            <button class="secondary" onclick={clearRuns} title="Delete all runs for this project">Clear all</button>
          {/if}
          <button class="secondary" onclick={loadRuns} title="Refresh">↻</button>
        </span>
      </h2>
      {#if loadError}
        <p class="err">conductor unreachable — is it running on :8787? ({loadError})</p>
      {/if}
      <ul class="runlist">
        {#each runs as r (r.id)}
          <li class:active={r.id === selectedId}>
            <button class="runpick" onclick={() => selectRun(r.id)}>
              <div class="rid">{r.id}</div>
              <span class="badge b-{r.stage}">{r.stage}</span>
              <span class="muted">{r.project_id ?? ''}</span>
            </button>
            <button class="del-run" title="Delete run" aria-label="Delete run" onclick={(e) => delRun(e, r.id)}>×</button>
          </li>
        {:else}
          <li class="muted">no runs yet</li>
        {/each}
      </ul>
    </aside>

    <section class="right">
      {#if !detail}
        <div class="empty">Select or start a run.</div>
      {:else}
        <div class="detail-head">
          <span class="badge b-{detail.stage}">{detail.stage}</span>
          <span class="mono muted">{detail.id}</span>
          {#if detail.error}<span class="g-flagged">{detail.error}</span>{/if}
        </div>

        <div class="timeline">
          {#each STAGES as s, i}
            <span class="step" class:on={reached(detail.stage, s)}>{s}</span>
            {#if i < STAGES.length - 1}<span class="arrow">→</span>{/if}
          {/each}
        </div>
        <div class="run-meta">
          <span><strong>Research</strong> {researchLabel(detail.intent?.researchSources)}</span>
          {#if detail.intent?.additionalDirection}<span><strong>Direction</strong> {detail.intent.additionalDirection}</span>{/if}
          {#if detail.intent?.contextLinks?.length}<span><strong>Links</strong> {detail.intent.contextLinks.length}</span>{/if}
        </div>

        <h2>Sessions <span class="muted">(spin-up / close lifecycle)</span></h2>
        <table>
          <thead><tr><th>Stage</th><th>Coral session</th><th>Duration</th></tr></thead>
          <tbody>
            {#each detail.sessions ?? [] as s}
              <tr>
                <td><span class="badge b-{s.stage}">{s.stage}</span></td>
                <td class="mono">{shortId(s.coral_session_id)}</td>
                <td class="num mono">{fmtDur(s.started_at, s.closed_at)}</td>
              </tr>
            {:else}
              <tr><td colspan="3" class="muted">no sessions yet</td></tr>
            {/each}
          </tbody>
        </table>

        <h2>
          Agent turns
          <span class="muted">
            (cost · {turns.length} turns · total <span class="total">{fmtCost(totalCost)}</span>)
          </span>
        </h2>
        <table>
          <thead>
            <tr><th>Stage</th><th>Agent</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr>
          </thead>
          <tbody>
            {#each turns as t}
              <tr>
                <td><span class="badge b-{t.stage}">{t.stage}</span></td>
                <td>{t.agent}</td>
                <td class="mono muted">{t.model}</td>
                <td class="num">{t.input_tokens}</td>
                <td class="num">{t.output_tokens}</td>
                <td class="num">{fmtCost(t.cost_usd)}</td>
              </tr>
            {:else}
              <tr><td colspan="6" class="muted">no turns reported yet</td></tr>
            {/each}
          </tbody>
        </table>

        {#if researchRows.length}
          <h2>Research sources <span class="muted">(grounding inputs per fan-out agent)</span></h2>
          <table>
            <thead><tr><th>Source</th><th class="num">Sources</th><th>Notes</th></tr></thead>
            <tbody>
              {#each researchRows as r}
                <tr>
                  <td>{r.source}</td>
                  <td class="num" class:empty-src={r.count === 0}>{r.count}</td>
                  <td class="muted">{r.notes || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}

        <h2>Output</h2>
        {#if detail.output?.markdown}
          <div class="output">{@html outputHtml}</div>
          <div class="revision-panel">
            <div class="revision-head">
              <h2>Workspace revision</h2>
              {#if latestRevision}
                <span class="revision-state state-{latestRevision.status}">{latestRevision.status}</span>
              {/if}
            </div>
            <label for="revision-instruction">Instruction</label>
            <textarea
              id="revision-instruction"
              bind:value={revisionInstruction}
              placeholder="Enrich, tighten, redirect, or add a sourced angle"
              disabled={revisionRunning}
            ></textarea>
            <label for="revision-links">Source links</label>
            <textarea
              id="revision-links"
              class="short-textarea links-input"
              bind:value={revisionLinksText}
              placeholder="Optional URLs, one per line"
              disabled={revisionRunning}
            ></textarea>
            <button class="start revise" onclick={submitRevision} disabled={revisionRunning || !revisionInstruction.trim()}>
              {revisionRunning ? 'Revising…' : 'Run revision'}
            </button>
            {#if latestRevision?.error}
              <p class="err">{latestRevision.error}</p>
            {/if}
            {#if detail.revisions?.length}
              <ul class="revision-list">
                {#each detail.revisions as rev, i}
                  <li>
                    <span class="revision-state state-{rev.status}">v{i + 2} · {rev.status}</span>
                    <span>{rev.instruction}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          {#if detail.output.grounding?.length}
            <h2>Grounding</h2>
            <ul class="grounding">
              {#each detail.output.grounding as g}
                <li class="g-{g.status}">
                  [{g.status}] {g.claim}{#if g.reason} — <span class="muted">{g.reason}</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          <div class="muted">no output yet…</div>
        {/if}
      {/if}
    </section>
  </div>
</div>

<style>
  /* Light "runs workspace" — uses the shared product tokens so it reads as one
     surface with the rest of the app (Overview / Ideation / Settings). */
  .inspector { color: var(--text); }
  .inspector * { box-sizing: border-box; }

  /* Standalone header (only when not embedded). */
  header {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    background: var(--surface);
  }
  header h1 { font-size: 1.05rem; margin: 0; font-weight: 700; }
  header .sub { color: var(--muted); font-size: 0.8rem; }

  .wrap {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 1.25rem;
    align-items: start;
    max-width: 76rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 4rem;
  }

  /* Both panes are product cards. The new-run form sticks while the detail scrolls. */
  .left,
  .right {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .left {
    padding: 1.1rem 1.2rem;
    position: sticky;
    top: 1.5rem;
    max-height: calc(100vh - 3rem);
    overflow-y: auto;
  }
  .right { padding: 1.3rem 1.5rem; min-height: 26rem; }

  h2 {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 1.3rem 0 0.6rem;
    font-weight: 600;
  }
  .left h2:first-child { margin-top: 0; }
  .runs-head { display: flex; justify-content: space-between; align-items: center; }
  .rh-actions { display: flex; gap: 0.3rem; align-items: center; }
  label,
  .field-label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--muted); margin: 0.6rem 0 0.25rem; }
  input, select, textarea {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    color: var(--text);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.6rem;
    font: inherit;
    font-size: 0.9rem;
  }
  input:focus, select:focus, textarea:focus {
    outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-color: var(--accent);
  }
  textarea { resize: vertical; min-height: 3.5rem; }
  .short-textarea { min-height: 4.6rem; }
  .links-input { font-family: ui-monospace, monospace; font-size: 0.78rem; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
  .pick { margin-bottom: 0.4rem; color: var(--muted); }
  .research-box {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.55rem;
    background: var(--bg);
  }
  .locked,
  .check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    color: var(--text);
    font-size: 0.86rem;
  }
  .check { cursor: pointer; }
  .check input { width: auto; margin: 0; }
  .check small { color: var(--muted); margin-left: auto; font-size: 0.72rem; }
  .source-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 0.08rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 700;
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
    color: var(--accent-ink);
  }
  .locked-pill { border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border)); }
  button.start {
    background: var(--accent);
    color: #fff;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.9rem;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    margin-top: 0.9rem;
    width: 100%;
    transition: background 0.1s ease, border-color 0.1s ease;
  }
  button.start:hover:not(:disabled) { background: var(--accent-ink); border-color: var(--accent-ink); }
  button.start:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--surface);
    color: var(--muted);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 0.2rem 0.55rem;
    font: inherit;
    cursor: pointer;
  }
  button.secondary:hover { border-color: var(--faint); color: var(--text); }
  .err { color: #b91c1c; font-size: 0.8rem; }
  .runlist { list-style: none; padding: 0; margin: 0; }
  .runlist li {
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 0.4rem;
    transition: border-color 0.1s ease, background 0.1s ease;
    overflow: hidden;
  }
  .runlist li:hover { border-color: var(--faint); }
  .runpick {
    width: 100%;
    display: block;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    padding: 0.55rem 2rem 0.55rem 0.65rem;
    font: inherit;
    cursor: pointer;
  }
  .del-run {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    width: 1.4rem;
    height: 1.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--faint);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease, background 0.1s ease, color 0.1s ease;
  }
  .runlist li:hover .del-run, .del-run:focus-visible { opacity: 1; }
  .del-run:hover { background: #fee2e2; color: #b91c1c; }
  .runlist li.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
  .runlist .rid { font-family: ui-monospace, monospace; font-size: 0.7rem; color: var(--muted); }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .b-intent { background: #fef3c7; color: #92400e; }
  .b-research { background: #dbeafe; color: #1e40af; }
  .b-synthesis { background: #ede9fe; color: #6d28d9; }
  .b-done { background: #dcfce7; color: #166534; }
  .b-failed { background: #fee2e2; color: #b91c1c; }
  .detail-head { display: flex; align-items: center; gap: 0.6rem; }
  .timeline { display: flex; gap: 0.4rem; align-items: center; margin: 0.5rem 0 1.2rem; flex-wrap: wrap; }
  .timeline .step { padding: 0.2rem 0.65rem; border-radius: var(--radius-sm); background: var(--bg); border: 1px solid var(--border); color: var(--faint); font-size: 0.78rem; }
  .timeline .step.on { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
  .timeline .arrow { color: var(--faint); }
  .run-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: -0.4rem 0 1rem;
  }
  .run-meta span {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--muted);
    padding: 0.25rem 0.55rem;
    font-size: 0.78rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .run-meta strong { color: var(--text); margin-right: 0.25rem; }
  table { width: 100%; border-collapse: collapse; margin: 0.3rem 0 1rem; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); }
  th {
    color: var(--muted);
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty-src { color: #b45309; font-weight: 700; }
  .mono { font-family: ui-monospace, monospace; font-size: 0.78rem; }
  .output {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.9rem 1.2rem;
    max-height: 560px;
    overflow-y: auto;
  }
  .output :global(h1),
  .output :global(h2),
  .output :global(h3) { color: var(--text); text-transform: none; letter-spacing: 0; margin: 0.9rem 0 0.5rem; }
  .output :global(p),
  .output :global(li) { color: var(--text); }
  .output :global(a) { color: var(--accent); }
  .output :global(code) {
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .output :global(pre) {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0.75rem;
    border-radius: var(--radius-sm);
    overflow-x: auto;
  }
  .revision-panel {
    border-top: 1px solid var(--border);
    margin-top: 1rem;
    padding-top: 0.2rem;
  }
  .revision-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .revision-head h2 { margin-top: 1rem; }
  .revise { max-width: 14rem; margin-top: 0.7rem; }
  .revision-state {
    border-radius: 999px;
    padding: 0.12rem 0.55rem;
    font-size: 0.7rem;
    font-weight: 700;
  }
  .state-running { background: #ede9fe; color: #6d28d9; }
  .state-done { background: #dcfce7; color: #166534; }
  .state-failed { background: #fee2e2; color: #b91c1c; }
  .revision-list {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .revision-list li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem;
    align-items: start;
    color: var(--muted);
    font-size: 0.82rem;
  }
  .muted { color: var(--muted); }
  .total { font-weight: 700; color: #166534; }
  .empty { color: var(--faint); padding: 2rem 0; text-align: center; }
  .grounding { padding-left: 1.1rem; }
  .g-grounded { color: #166534; }
  .g-flagged { color: #b45309; }

  @media (max-width: 720px) {
    .wrap { grid-template-columns: 1fr; }
    .left { position: static; max-height: none; }
  }
</style>
