<script lang="ts">
  import { onMount } from 'svelte'
  import type { Navigate } from '../lib/nav'
  import {
    createProfile,
    deleteProfile,
    listProfiles,
    updateProfile,
    type Profile,
  } from '../lib/api'

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { navigate }: { navigate: Navigate } = $props()

  type ProfileForm = {
    name: string
    description: string
    identity: string
    voice: string
    audience: string
    style_guide: string
    context_notes: string
  }

  const blank = (): ProfileForm => ({
    name: '',
    description: '',
    identity: '',
    voice: '',
    audience: '',
    style_guide: '',
    context_notes: '',
  })

  let profiles = $state<Profile[]>([])
  let selectedId = $state<string | null>(null)
  let form = $state<ProfileForm>(blank())
  let loading = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)

  let selected = $derived(profiles.find((p) => p.id === selectedId) ?? null)
  let dirty = $derived(
    !selected ||
      form.name !== (selected.name ?? '') ||
      form.description !== (selected.description ?? '') ||
      form.identity !== (selected.identity ?? '') ||
      form.voice !== (selected.voice ?? '') ||
      form.audience !== (selected.audience ?? '') ||
      form.style_guide !== (selected.style_guide ?? '') ||
      form.context_notes !== (selected.context_notes ?? '')
  )

  function loadForm(p: Profile | null) {
    form = p
      ? {
          name: p.name ?? '',
          description: p.description ?? '',
          identity: p.identity ?? '',
          voice: p.voice ?? '',
          audience: p.audience ?? '',
          style_guide: p.style_guide ?? '',
          context_notes: p.context_notes ?? '',
        }
      : blank()
  }

  function select(p: Profile | null) {
    selectedId = p?.id ?? null
    loadForm(p)
  }

  async function load() {
    loading = true
    try {
      profiles = await listProfiles()
      if (selectedId) {
        const stillExists = profiles.find((p) => p.id === selectedId) ?? null
        select(stillExists)
      } else if (profiles.length && !form.name) {
        select(profiles[0])
      }
      error = null
    } catch (e) {
      error = (e as Error).message
    }
    loading = false
  }

  async function save() {
    const name = form.name.trim()
    if (!name) {
      error = 'Profile name is required.'
      return
    }
    saving = true
    error = null
    try {
      const body = { ...form, name }
      const saved = selectedId ? await updateProfile(selectedId, body) : await createProfile(body)
      selectedId = saved.id
      await load()
    } catch (e) {
      error = (e as Error).message
    }
    saving = false
  }

  async function remove() {
    if (!selected || !confirm(`Delete "${selected.name}"? Project defaults using it will be cleared.`)) return
    saving = true
    try {
      await deleteProfile(selected.id)
      selectedId = null
      form = blank()
      await load()
    } catch (e) {
      error = (e as Error).message
    }
    saving = false
  }

  onMount(load)
</script>

<div class="page">
  <div class="head">
    <div>
      <h1>Profiles</h1>
      <p class="muted intro">
        Reusable writer or company context. Runs still work without one; selecting a profile adds positioning,
        voice, and long-lived context to the intent artifact.
      </p>
    </div>
    <button class="btn btn-primary" onclick={() => select(null)}>New profile</button>
  </div>

  {#if error}<p class="err">{error}</p>{/if}

  <div class="grid">
    <aside class="card list">
      <h2>Saved profiles</h2>
      {#if loading}
        <p class="faint">Loading...</p>
      {:else if profiles.length}
        {#each profiles as p (p.id)}
          <button class="profile-row" class:on={p.id === selectedId} onclick={() => select(p)}>
            <strong>{p.name}</strong>
            <span>{p.identity || p.description || 'No identity set'}</span>
          </button>
        {/each}
      {:else}
        <p class="faint">No profiles yet. Create one for company, author, or research-lab positioning.</p>
      {/if}
    </aside>

    <section class="card form">
      <div class="form-head">
        <h2>{selected ? 'Edit profile' : 'New profile'}</h2>
        {#if selected}
          <button class="btn btn-ghost danger" onclick={remove} disabled={saving}>Delete</button>
        {/if}
      </div>

      <label for="profile-name">Name</label>
      <input id="profile-name" class="input" bind:value={form.name} placeholder="DeepSeek researcher" />

      <label for="profile-description">Short description</label>
      <input id="profile-description" class="input" bind:value={form.description} placeholder="Author profile used for technical GEO articles" />

      <label for="profile-identity">Identity / positioning</label>
      <textarea
        id="profile-identity"
        bind:value={form.identity}
        placeholder="Who the article is written on behalf of, and what authority or perspective it should project."
      ></textarea>

      <label for="profile-voice">Voice</label>
      <textarea
        id="profile-voice"
        bind:value={form.voice}
        placeholder="How this profile should sound: terse, analytical, research-forward, pragmatic, etc."
      ></textarea>

      <label for="profile-audience">Default audience</label>
      <input id="profile-audience" class="input" bind:value={form.audience} placeholder="ML engineers, technical founders, infra teams..." />

      <label for="profile-style">Style guide</label>
      <textarea
        id="profile-style"
        bind:value={form.style_guide}
        placeholder="Preferred structure, wording, banned phrases, citation style, visual style notes."
      ></textarea>

      <label for="profile-context">Context notes</label>
      <textarea
        id="profile-context"
        bind:value={form.context_notes}
        placeholder="Long-lived facts or constraints the agents may use. Do not paste secrets."
      ></textarea>

      <div class="actions">
        <span class="faint">{dirty ? 'Unsaved changes' : 'Saved'}</span>
        <button class="btn btn-primary" onclick={save} disabled={saving}>{saving ? 'Saving...' : 'Save profile'}</button>
      </div>
    </section>
  </div>
</div>

<style>
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; letter-spacing: -0.02em; }
  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 0.8rem; }
  .head { display: flex; align-items: start; justify-content: space-between; gap: 1rem; margin-bottom: 1.2rem; }
  .intro { margin: 0; max-width: 45rem; font-size: 0.95rem; }
  .grid { display: grid; grid-template-columns: minmax(15rem, 20rem) 1fr; gap: 1rem; align-items: start; }
  .list, .form { padding: 1.2rem 1.3rem; }
  .list { position: sticky; top: 5rem; }
  .profile-row {
    width: 100%;
    text-align: left;
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: var(--radius-sm);
    padding: 0.75rem 0.85rem;
    margin-bottom: 0.55rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .profile-row strong { color: var(--text); }
  .profile-row span { color: var(--muted); font-size: 0.84rem; line-height: 1.35; }
  .profile-row:hover { border-color: var(--faint); }
  .profile-row.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
  .form-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--muted); margin: 0.75rem 0 0.25rem; }
  input, textarea {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    color: var(--text);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.65rem;
    font: inherit;
    font-size: 0.92rem;
  }
  textarea { min-height: 5rem; resize: vertical; line-height: 1.45; }
  input:focus, textarea:focus {
    outline: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-color: var(--accent);
  }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; }
  .danger { color: #b91c1c; }
  .danger:hover { color: #b91c1c; border-color: #fca5a5; }
  .err { color: #b91c1c; }
  @media (max-width: 760px) {
    .head { flex-direction: column; }
    .grid { grid-template-columns: 1fr; }
    .list { position: static; }
  }
</style>
