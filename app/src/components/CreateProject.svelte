<script lang="ts">
  import type { Navigate } from '../lib/nav'
  import { createProject } from '../lib/api'

  let { navigate }: { navigate: Navigate } = $props()

  let name = $state('')
  let description = $state('')
  let saving = $state(false)
  let error = $state<string | null>(null)

  async function submit(e: Event) {
    e.preventDefault()
    if (!name.trim()) return
    saving = true
    error = null
    try {
      const p = await createProject({ name: name.trim(), description: description.trim() })
      // Straight into onboarding to capture topic metadata.
      navigate({ name: 'onboarding', projectId: p.id })
    } catch (e) {
      error = (e as Error).message
      saving = false
    }
  }
</script>

<div class="page page-narrow">
  <button class="btn btn-ghost back" onclick={() => navigate({ name: 'projects' })}>← Projects</button>
  <h1>New project</h1>
  <p class="muted intro">Name it and say what it's about. Next we'll capture the topic metadata.</p>

  <form class="card form" onsubmit={submit}>
    <div class="field">
      <label for="np-name">Project name</label>
      <input id="np-name" class="input" bind:value={name} placeholder="e.g. Agentic Memory" autocomplete="off" />
    </div>
    <div class="field">
      <label for="np-desc">What is this project about? <span class="hint">(one line)</span></label>
      <textarea
        id="np-desc"
        class="textarea"
        bind:value={description}
        placeholder="The positioning / angle you want to own in agent answers."
      ></textarea>
    </div>
    {#if error}<p class="err">Create failed: {error}</p>{/if}
    <div class="actions">
      <button type="button" class="btn" onclick={() => navigate({ name: 'projects' })}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={saving || !name.trim()}>
        {saving ? 'Creating…' : 'Create & continue →'}
      </button>
    </div>
  </form>
</div>

<style>
  .back { margin-bottom: 1rem; padding-left: 0; }
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; letter-spacing: -0.02em; }
  .intro { margin: 0 0 1.5rem; }
  .form { padding: 1.5rem; }
  .actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 0.5rem; }
  .err { color: #b91c1c; font-size: 0.9rem; }
</style>
