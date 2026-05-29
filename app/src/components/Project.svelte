<script lang="ts">
  import { onMount } from 'svelte'
  import type { Navigate } from '../lib/nav'
  import { getProject, deleteProject, listProfiles, updateProject, type Profile, type Project } from '../lib/api'
  import RunInspector from './RunInspector.svelte'

  let { projectId, navigate }: { projectId: string; navigate: Navigate } = $props()
  let deleting = $state(false)

  async function delProject() {
    if (!project) return
    if (!confirm(`Delete "${project.name}" and all its runs? This can't be undone.`)) return
    deleting = true
    try {
      await deleteProject(projectId)
      navigate({ name: 'projects' })
    } catch (e) {
      alert('Delete failed: ' + (e as Error).message)
      deleting = false
    }
  }

  type Tab = 'overview' | 'ideation' | 'runs'
  let tab = $state<Tab>('overview')
  let project = $state<Project | null>(null)
  let profiles = $state<Profile[]>([])
  let selectedProfileId = $state('')
  let profileSaving = $state(false)
  let error = $state<string | null>(null)
  let runSeed = $state<{ anchorClaim?: string; targetQuery?: string } | null>(null)

  let meta = $derived.by(() => {
    if (!project?.topic_meta) return { targetQueries: [] as string[], anchorClaims: [] as string[] }
    try {
      const m = JSON.parse(project.topic_meta)
      return { targetQueries: m.targetQueries ?? [], anchorClaims: m.anchorClaims ?? [] }
    } catch {
      return { targetQueries: [], anchorClaims: [] }
    }
  })

  // Turn a search query into a declarative working headline.
  function headline(q: string): string {
    const t = q.trim().replace(/^(how|what|why|when|where|which|who|is|are|should|can|do|does)\s+/i, '')
    return t.charAt(0).toUpperCase() + t.slice(1)
  }

  // First-pass ideas: one card per target query, paired with a rotating anchor
  // claim as its angle. (Daily GEO research will feed this later.)
  type Idea = { id: string; title: string; targetQuery: string; anchorClaim: string }
  let ideas = $derived.by<Idea[]>(() => {
    const qs = meta.targetQueries as string[]
    const cls = meta.anchorClaims as string[]
    if (qs.length) {
      return qs.map((q, i) => ({
        id: 'q' + i,
        title: headline(q),
        targetQuery: q,
        anchorClaim: cls.length ? cls[i % cls.length] : '',
      }))
    }
    // No queries captured yet — fall back to claim-driven ideas.
    return cls.map((cl, i) => ({
      id: 'c' + i,
      title: cl.length > 64 ? cl.slice(0, 64) + '…' : cl,
      targetQuery: '',
      anchorClaim: cl,
    }))
  })

  function curate(idea: Idea) {
    runSeed = { anchorClaim: idea.anchorClaim, targetQuery: idea.targetQuery }
    tab = 'runs'
  }

  async function setProjectProfile() {
    if (!project) return
    profileSaving = true
    try {
      project = await updateProject(projectId, { profile_id: selectedProfileId || null })
    } catch (e) {
      alert('Profile update failed: ' + (e as Error).message)
    }
    profileSaving = false
  }

  onMount(async () => {
    try {
      project = await getProject(projectId)
      selectedProfileId = project.profile_id ?? ''
      profiles = await listProfiles()
    } catch (e) {
      error = (e as Error).message
    }
  })
</script>

<div class="projhead">
  <div class="page hpad">
    <div class="toprow">
      <button class="btn btn-ghost back" onclick={() => navigate({ name: 'projects' })}>← Projects</button>
      {#if project}
        <button class="btn btn-ghost danger" onclick={delProject} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete project'}
        </button>
      {/if}
    </div>
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
        <div class="block-head">
          <h2>Writer profile</h2>
          <button class="btn btn-ghost" onclick={() => navigate({ name: 'profiles' })}>Manage</button>
        </div>
        <label class="select-label" for="project-profile">Default for new runs</label>
        <select id="project-profile" bind:value={selectedProfileId} onchange={setProjectProfile} disabled={profileSaving}>
          <option value="">No profile (one-shot default)</option>
          {#each profiles as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
        <p class="faint helper">Runs can override this; no profile keeps the current project-only behavior.</p>
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
    {#if ideas.length}
      <div class="idea-intro">
        <p class="muted">
          Article ideas seeded from this project's target queries and anchor claims.
          Curate one into a run to draft it.
        </p>
      </div>
      <div class="ideas">
        {#each ideas as idea (idea.id)}
          <div class="card idea">
            <h3>{idea.title}</h3>
            {#if idea.targetQuery}
              <div class="idea-row">
                <span class="idea-tag">ranks for</span>
                <span class="idea-val">{idea.targetQuery}</span>
              </div>
            {/if}
            {#if idea.anchorClaim}
              <div class="idea-row">
                <span class="idea-tag">angle</span>
                <span class="idea-val">{idea.anchorClaim}</span>
              </div>
            {/if}
            <button class="btn btn-primary curate" onclick={() => curate(idea)}>
              Curate into run →
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <div class="card placeholder">
        <div class="ph-mark">✦</div>
        <h2>No ideas yet</h2>
        <p class="muted">
          Ideas are seeded from your target queries and anchor claims.
          <button class="linkish" onclick={() => navigate({ name: 'onboarding', projectId })}>Add some in setup</button>
          to populate this board.
        </p>
      </div>
    {/if}
  </div>
{:else}
  <!-- Production / Runs — the run inspector, scoped to this project. -->
  <RunInspector {projectId} embedded seed={runSeed} />
{/if}

<style>
  .projhead { border-bottom: 1px solid var(--border); background: var(--surface); }
  .hpad { padding-top: 1.5rem; padding-bottom: 0; }
  .toprow { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.8rem; }
  .back { padding-left: 0; }
  .danger { color: #b91c1c; }
  .danger:hover { color: #b91c1c; border-color: #fca5a5; }
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
  .select-label { display: block; color: var(--faint); font-size: 0.78rem; margin-bottom: 0.3rem; }
  select {
    width: 100%;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.6rem;
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  .helper { margin: 0.55rem 0 0; font-size: 0.82rem; }
  .block ul { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .block li { font-size: 0.92rem; }
  .linkish { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
  .placeholder { text-align: center; padding: 3.5rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
  .ph-mark { font-size: 1.8rem; color: var(--accent); opacity: 0.5; }
  .placeholder h2 { margin: 0; font-size: 1.15rem; }
  .placeholder p { margin: 0; max-width: 26rem; }
  .idea-intro { margin-bottom: 1rem; }
  .idea-intro p { margin: 0; max-width: 44rem; font-size: 0.92rem; }
  .ideas { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; }
  .idea { padding: 1.2rem 1.3rem; display: flex; flex-direction: column; gap: 0.7rem; }
  .idea h3 { margin: 0; font-size: 1.05rem; line-height: 1.3; letter-spacing: -0.01em; }
  .idea-row { display: flex; flex-direction: column; gap: 0.15rem; }
  .idea-tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
  .idea-val { font-size: 0.9rem; color: var(--muted); }
  .curate { margin-top: auto; align-self: flex-start; }
</style>
