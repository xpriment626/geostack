<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { marked } from 'marked'

  let {
    onBack,
    projectId,
    embedded = false,
  }: { onBack?: () => void; projectId?: string; embedded?: boolean } = $props()

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
  interface RunDetail {
    id: string
    stage: string
    project_id?: string
    projectId?: string
    error?: string
    sessions?: SessionRow[]
    agentTurns?: AgentTurn[]
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

  onMount(() => {
    void loadRuns()
    listTimer = setInterval(loadRuns, 5000)
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
      <textarea bind:value={anchorClaim}></textarea>
      <label>Target query</label>
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
        Recent runs <button class="secondary" onclick={loadRuns}>↻</button>
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
  /* Dark, dense "advanced view" — scoped so it doesn't fight the app's light theme. */
  .inspector {
    color-scheme: dark;
    background: #0b0c0e;
    color: #e6e7e9;
    min-height: 100vh;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
  }
  .inspector * { box-sizing: border-box; }
  header {
    padding: 14px 20px;
    border-bottom: 1px solid #1d2025;
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: #7c8190; font-size: 12px; }
  .back {
    background: #1b1e24;
    color: #b9c0cc;
    border: 1px solid #262b33;
    border-radius: 6px;
    padding: 5px 12px;
    font: inherit;
    cursor: pointer;
  }
  .back:hover { border-color: #2f6feb; }
  .wrap {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: calc(100vh - 51px);
  }
  /* Embedded as a project's Runs tab — no standalone header; fit below the
     app top bar + project header instead of claiming the whole viewport. */
  .inspector.embedded { min-height: auto; }
  .inspector.embedded .wrap { height: calc(100vh - 210px); min-height: 30rem; }
  .left { border-right: 1px solid #1d2025; overflow-y: auto; padding: 16px; }
  .right { overflow-y: auto; padding: 20px 24px; }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #7c8190;
    margin: 18px 0 8px;
  }
  .runs-head { display: flex; justify-content: space-between; align-items: center; }
  label { display: block; font-size: 12px; color: #9aa0ad; margin: 8px 0 3px; }
  input, select, textarea {
    width: 100%;
    background: #121419;
    border: 1px solid #262b33;
    color: #e6e7e9;
    border-radius: 6px;
    padding: 7px 9px;
    font: inherit;
  }
  textarea { resize: vertical; min-height: 56px; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  button.start {
    background: #2f6feb;
    color: #fff;
    border: 0;
    border-radius: 6px;
    padding: 9px 14px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    margin-top: 12px;
    width: 100%;
  }
  button.start:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: #1b1e24;
    color: #b9c0cc;
    border: 1px solid #262b33;
    border-radius: 6px;
    padding: 3px 9px;
    font: inherit;
    cursor: pointer;
  }
  .err { color: #ff8a8a; font-size: 12px; }
  .runlist { list-style: none; padding: 0; margin: 0; }
  .runlist li {
    padding: 9px 10px;
    border: 1px solid #1d2025;
    border-radius: 7px;
    margin-bottom: 6px;
    cursor: pointer;
  }
  .runlist li:hover { border-color: #2f6feb; }
  .runlist li.active { border-color: #2f6feb; background: #11161f; }
  .runlist .rid { font-family: ui-monospace, monospace; font-size: 11px; color: #9aa0ad; }
  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .b-intent { background: #2a2f1a; color: #d6e07a; }
  .b-research { background: #14233a; color: #6fb6ff; }
  .b-synthesis { background: #2a1a33; color: #d29bff; }
  .b-done { background: #143420; color: #6fe09a; }
  .b-failed { background: #3a1414; color: #ff8a8a; }
  .detail-head { display: flex; align-items: center; gap: 10px; }
  .timeline { display: flex; gap: 6px; align-items: center; margin: 6px 0 18px; flex-wrap: wrap; }
  .timeline .step { padding: 3px 10px; border-radius: 6px; background: #15181d; color: #565c68; font-size: 12px; }
  .timeline .step.on { color: #e6e7e9; }
  .timeline .arrow { color: #3a3f47; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 16px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1a1d22; }
  th {
    color: #7c8190;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .output {
    background: #0e1014;
    border: 1px solid #1d2025;
    border-radius: 8px;
    padding: 14px 18px;
    max-height: 520px;
    overflow-y: auto;
  }
  .output :global(h1),
  .output :global(h2),
  .output :global(h3) { color: #e6e7e9; text-transform: none; letter-spacing: 0; margin: 14px 0 8px; }
  .output :global(p),
  .output :global(li) { color: #c7cbd2; }
  .output :global(a) { color: #6fb6ff; }
  .output :global(code) {
    background: #1a1d22;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .output :global(pre) {
    background: #15181d;
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  .muted { color: #7c8190; }
  .total { font-weight: 700; color: #6fe09a; }
  .empty { color: #565c68; padding: 30px 0; text-align: center; }
  .grounding { padding-left: 18px; }
  .g-grounded { color: #6fe09a; }
  .g-flagged { color: #ffb86b; }
</style>
