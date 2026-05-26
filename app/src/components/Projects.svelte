<script lang="ts">
  import { onMount } from 'svelte'
  import type { Navigate } from '../lib/nav'
  import { listProjects, deleteProject, type Project } from '../lib/api'

  let { navigate }: { navigate: Navigate } = $props()

  let projects = $state<Project[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let busy = $state<string | null>(null)

  async function del(p: Project) {
    if (!confirm(`Delete "${p.name}" and all its runs? This can't be undone.`)) return
    busy = p.id
    try {
      await deleteProject(p.id)
      projects = projects.filter((x) => x.id !== p.id)
    } catch (e) {
      alert('Delete failed: ' + (e as Error).message)
    }
    busy = null
  }

  async function load() {
    loading = true
    try {
      projects = await listProjects()
      error = null
    } catch (e) {
      error = (e as Error).message
    }
    loading = false
  }
  onMount(load)
</script>

<div class="page">
  <div class="head">
    <div>
      <h1>Projects</h1>
      <p class="muted">Each project is a topic you're building citation authority on.</p>
    </div>
    <button class="btn btn-primary" onclick={() => navigate({ name: 'create' })}>+ New project</button>
  </div>

  {#if loading}
    <p class="faint">Loading…</p>
  {:else if error}
    <p class="err">Couldn't reach the conductor ({error}). Is the stack running?</p>
  {:else if projects.length === 0}
    <div class="card empty">
      <div class="empty-mark">◆</div>
      <h2>No projects yet</h2>
      <p class="muted">Create your first project and we'll walk you through capturing its topic.</p>
      <button class="btn btn-primary" onclick={() => navigate({ name: 'create' })}>+ New project</button>
    </div>
  {:else}
    <div class="grid">
      {#each projects as p (p.id)}
        <div class="card project" class:busy={busy === p.id}>
          <button class="project-open" onclick={() => navigate({ name: 'project', projectId: p.id })}>
            <h3>{p.name}</h3>
            <p class="desc">{p.description || 'No description yet'}</p>
            <div class="meta faint">
              {#if p.audience}<span>{p.audience}</span>{/if}
            </div>
          </button>
          <button class="del" title="Delete project" aria-label="Delete project" disabled={busy === p.id} onclick={() => del(p)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
  .head p { margin: 0; font-size: 0.95rem; }
  .err { color: #b91c1c; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .project {
    position: relative;
    transition: border-color 0.1s ease, transform 0.06s ease;
  }
  .project:hover { border-color: var(--accent); transform: translateY(-2px); }
  .project.busy { opacity: 0.5; pointer-events: none; }
  .project-open {
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: none;
    border: none;
    border-radius: inherit;
    color: inherit;
    font: inherit;
    padding: 1.1rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .project h3 { margin: 0; font-size: 1.05rem; padding-right: 1.2rem; }
  .project .desc { margin: 0; font-size: 0.9rem; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .project .meta { font-size: 0.8rem; margin-top: 0.2rem; }
  .del {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 1.7rem;
    height: 1.7rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--faint);
    font-size: 1.15rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease, background 0.1s ease, color 0.1s ease;
  }
  .project:hover .del, .del:focus-visible { opacity: 1; }
  .del:hover { background: #fee2e2; color: #b91c1c; }
  .empty { text-align: center; padding: 3rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 0.6rem; }
  .empty-mark { font-size: 2rem; color: var(--accent); opacity: 0.6; }
  .empty h2 { margin: 0; font-size: 1.2rem; }
  .empty p { margin: 0 0 0.6rem; max-width: 24rem; }
</style>
