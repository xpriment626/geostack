<script lang="ts">
  import { onMount } from 'svelte'
  import type { Navigate } from '../lib/nav'
  import { getProject, updateProject, type Project } from '../lib/api'

  let { projectId, navigate }: { projectId: string; navigate: Navigate } = $props()

  let project = $state<Project | null>(null)
  let step = $state(0)
  let saving = $state(false)

  // captured metadata
  let audience = $state('')
  let tone = $state('')
  let queries = $state<string[]>([''])
  let claims = $state<string[]>([''])

  const STEPS = ['Audience & voice', 'Target queries', 'Anchor claims']

  onMount(async () => {
    try {
      project = await getProject(projectId)
      if (project?.audience) audience = project.audience
      if (project?.tone) tone = project.tone
    } catch {
      /* show form anyway */
    }
  })

  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean)
  function addTo(which: 'q' | 'c') {
    if (which === 'q') queries = [...queries, '']
    else claims = [...claims, '']
  }
  function removeFrom(which: 'q' | 'c', i: number) {
    if (which === 'q') queries = queries.filter((_, idx) => idx !== i)
    else claims = claims.filter((_, idx) => idx !== i)
  }

  async function finish() {
    saving = true
    try {
      await updateProject(projectId, {
        audience: audience.trim(),
        tone: tone.trim(),
        topicMeta: { targetQueries: clean(queries), anchorClaims: clean(claims) },
      })
      navigate({ name: 'project', projectId })
    } catch {
      saving = false
    }
  }
</script>

<div class="page page-narrow">
  <button class="btn btn-ghost back" onclick={() => navigate({ name: 'project', projectId })}>Skip for now →</button>
  <h1>Set up {project?.name ?? 'your project'}</h1>
  <p class="muted intro">A little topic metadata sharpens what the fleet researches and how it writes.</p>

  <div class="stepper">
    {#each STEPS as s, i}
      <div class="dot" class:on={i <= step} class:current={i === step}></div>
      {#if i < STEPS.length - 1}<div class="line" class:on={i < step}></div>{/if}
    {/each}
  </div>
  <p class="steplabel faint">Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>

  <div class="card form">
    {#if step === 0}
      <div class="field">
        <label for="ob-aud">Audience <span class="hint">who are you writing for?</span></label>
        <input id="ob-aud" class="input" bind:value={audience} placeholder="e.g. engineers building multi-agent systems" />
      </div>
      <div class="field">
        <label for="ob-tone">Tone <span class="hint">the voice of your content</span></label>
        <input id="ob-tone" class="input" bind:value={tone} placeholder="e.g. authoritative, technical, plain" />
      </div>
    {:else if step === 1}
      <p class="grouphint muted">The questions you want agents to cite <em>you</em> on when users ask them.</p>
      {#each queries as _, i}
        <div class="listrow">
          <input class="input" bind:value={queries[i]} placeholder="e.g. how should AI agents manage long-term memory" />
          {#if queries.length > 1}<button class="btn btn-ghost rm" onclick={() => removeFrom('q', i)}>✕</button>{/if}
        </div>
      {/each}
      <button class="btn add" onclick={() => addTo('q')}>+ Add query</button>
    {:else}
      <p class="grouphint muted">The claims you're building citation authority on — the fleet grounds against these.</p>
      {#each claims as _, i}
        <div class="listrow">
          <textarea class="textarea" bind:value={claims[i]} placeholder="e.g. Durable agentic memory needs structural curation, not bigger context windows"></textarea>
          {#if claims.length > 1}<button class="btn btn-ghost rm" onclick={() => removeFrom('c', i)}>✕</button>{/if}
        </div>
      {/each}
      <button class="btn add" onclick={() => addTo('c')}>+ Add claim</button>
    {/if}

    <div class="actions">
      {#if step > 0}<button class="btn" onclick={() => (step -= 1)}>← Back</button>{/if}
      <div class="spacer"></div>
      {#if step < STEPS.length - 1}
        <button class="btn btn-primary" onclick={() => (step += 1)}>Next →</button>
      {:else}
        <button class="btn btn-primary" onclick={finish} disabled={saving}>{saving ? 'Saving…' : 'Finish setup'}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .back { margin-bottom: 1rem; padding-left: 0; }
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; letter-spacing: -0.02em; }
  .intro { margin: 0 0 1.5rem; }
  .stepper { display: flex; align-items: center; gap: 0; margin-bottom: 0.5rem; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--border-strong); flex: none; }
  .dot.on { background: var(--accent); }
  .dot.current { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent); }
  .line { height: 2px; flex: 1; background: var(--border-strong); margin: 0 0.4rem; }
  .line.on { background: var(--accent); }
  .steplabel { margin: 0 0 1.2rem; font-size: 0.85rem; }
  .form { padding: 1.5rem; }
  .grouphint { margin: 0 0 1rem; font-size: 0.9rem; }
  .listrow { display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 0.6rem; }
  .listrow .input, .listrow .textarea { flex: 1; }
  .rm { padding: 0.5rem 0.6rem; color: var(--faint); }
  .add { margin-top: 0.2rem; }
  .actions { display: flex; align-items: center; gap: 0.6rem; margin-top: 1.2rem; }
  .spacer { flex: 1; }
</style>
