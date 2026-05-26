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
  interface RunDetail {
    id: string
    stage: string
    project_id?: string
    projectId?: string
    error?: string
    sessions?: SessionRow[]
    agentTurns?: AgentTurn[]
    research?: ResearchArtifact | null
    output?: RunOutput | null
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
      if (run.stage === 'done' || run.stage === 'failed') stopDetailPoll()
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
        audience,
        tone,
        raw: '# Brief\n\n' + anchorClaim,
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
        <label>Project ID</label>
        <input bind:value={formProjectId} />
      {/if}
      <label>Anchor claim</label>
      {#if projectClaims.length > 1}
        <select class="pick" onchange={(e) => (anchorClaim = (e.currentTarget as HTMLSelectElement).value)}>
          {#each projectClaims as cl}<option value={cl}>{cl.length > 64 ? cl.slice(0, 64) + '…' : cl}</option>{/each}
        </select>
      {/if}
      <textarea bind:value={anchorClaim}></textarea>
      <label>Target query</label>
      {#if projectQueries.length > 1}
        <select class="pick" onchange={(e) => (targetQuery = (e.currentTarget as HTMLSelectElement).value)}>
          {#each projectQueries as q}<option value={q}>{q.length > 64 ? q.slice(0, 64) + '…' : q}</option>{/each}
        </select>
      {/if}
      <input bind:value={targetQuery} />
      <div class="row2">
        <div>
          <label>Mode</label>
          <select bind:value={mode}><option>single</option><option>batch</option></select>
        </div>
        <div>
          <label>Depth</label>
          <select bind:value={depth}><option>deep-dive</option><option>listicle</option></select>
        </div>
      </div>
      <label>Audience</label>
      <input bind:value={audience} />
      <label>Tone</label>
      <input bind:value={tone} />
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
          <li class:active={r.id === selectedId} onclick={() => selectRun(r.id)}>
            <div class="rid">{r.id}</div>
            <span class="badge b-{r.stage}">{r.stage}</span>
            <span class="muted">{r.project_id ?? ''}</span>
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
  label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--muted); margin: 0.6rem 0 0.25rem; }
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
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
  .pick { margin-bottom: 0.4rem; color: var(--muted); }
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
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 0.4rem;
    cursor: pointer;
    transition: border-color 0.1s ease, background 0.1s ease;
  }
  .runlist li:hover { border-color: var(--faint); }
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
