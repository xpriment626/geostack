<script lang="ts">
  import { onMount } from 'svelte'
  import type { Navigate } from '../lib/nav'
  import { getProject, type Project } from '../lib/api'
  import RunInspector from './RunInspector.svelte'

  let { projectId, navigate }: { projectId: string; navigate: Navigate } = $props()

  type Tab = 'overview' | 'ideation' | 'runs'
  let tab = $state<Tab>('overview')
  let project = $state<Project | null>(null)
  let error = $state<string | null>(null)

  let meta = $derived.by(() => {
    if (!project?.topic_meta) return { targetQueries: [] as string[], anchorClaims: [] as string[] }
    try {
      const m = JSON.parse(project.topic_meta)
      return { targetQueries: m.targetQueries ?? [], anchorClaims: m.anchorClaims ?? [] }
    } catch {
      return { targetQueries: [], anchorClaims: [] }
    }
  })

  onMount(async () => {
    try {
      project = await getProject(projectId)
    } catch (e) {
      error = (e as Error).message
    }
  })
</script>

<div class="projhead">
  <div class="page hpad">
    <button class="btn btn-ghost back" onclick={() => navigate({ name: 'projects' })}>← Projects</button>
    {#if error}
      <p class="err">Couldn't load project ({error}).</p>
    {:else}
      <h1>{project?.name ?? '…'}</h1>
      {#if project?.description}<p class="muted desc">{project.description}</p>{/if}
    {/if}
    <nav class="tabs">
      <button class="tab" class:on={tab === 'overview'} onclick={() => (tab = 'overview')}>Overview</button>
      <button class="tab" class:on={tab === 'ideation'} onclick={() => (tab = 'ideation')}>Ideation</button>
      <button class="tab" class:on={tab === 'runs'} onclick={() => (tab = 'runs')}>Runs</button>
    </nav>
  </div>
</div>

{#if tab === 'overview'}
  <div class="page">
    <div class="cols">
      <div class="card block">
        <div class="block-head">
          <h2>Topic</h2>
          <button class="btn btn-ghost" onclick={() => navigate({ name: 'onboarding', projectId })}>Edit setup</button>
        </div>
        <dl>
          <dt>Audience</dt><dd>{project?.audience || '—'}</dd>
          <dt>Tone</dt><dd>{project?.tone || '—'}</dd>
        </dl>
      </div>
      <div class="card block">
        <h2>Target queries</h2>
        {#if meta.targetQueries.length}
          <ul>{#each meta.targetQueries as q}<li>{q}</li>{/each}</ul>
        {:else}<p class="faint">None yet — <button class="linkish" onclick={() => navigate({ name: 'onboarding', projectId })}>add some</button>.</p>{/if}
      </div>
      <div class="card block">
        <h2>Anchor claims</h2>
        {#if meta.anchorClaims.length}
          <ul>{#each meta.anchorClaims as cl}<li>{cl}</li>{/each}</ul>
        {:else}<p class="faint">None yet.</p>{/if}
      </div>
    </div>
  </div>
{:else if tab === 'ideation'}
  <div class="page">
    <div class="card placeholder">
      <div class="ph-mark">✦</div>
      <h2>Ideation board</h2>
      <p class="muted">Where daily GEO research surfaces article ideas to curate into runs. Coming next.</p>
    </div>
  </div>
{:else}
  <!-- Production / Runs — the run inspector, scoped to this project. -->
  <RunInspector {projectId} embedded />
{/if}

<style>
  .projhead { border-bottom: 1px solid var(--border); background: var(--surface); }
  .hpad { padding-top: 1.5rem; padding-bottom: 0; }
  .back { margin-bottom: 0.8rem; padding-left: 0; }
  h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
  .desc { margin: 0 0 0.8rem; font-size: 0.95rem; }
  .err { color: #b91c1c; }
  .tabs { display: flex; gap: 0.3rem; margin-top: 0.8rem; }
  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    color: var(--muted);
    font-size: 0.95rem;
    font-weight: 550;
    padding: 0.5rem 0.6rem 0.7rem;
  }
  .tab:hover { color: var(--text); }
  .tab.on { color: var(--text); border-bottom-color: var(--accent); }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
  .block { padding: 1.2rem 1.3rem; }
  .block-head { display: flex; align-items: center; justify-content: space-between; }
  .block h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 0.7rem; }
  .block-head h2 { margin: 0; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 1rem; }
  dt { color: var(--faint); font-size: 0.85rem; }
  dd { margin: 0; }
  .block ul { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .block li { font-size: 0.92rem; }
  .linkish { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
  .placeholder { text-align: center; padding: 3.5rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
  .ph-mark { font-size: 1.8rem; color: var(--accent); opacity: 0.5; }
  .placeholder h2 { margin: 0; font-size: 1.15rem; }
  .placeholder p { margin: 0; max-width: 26rem; }
</style>
