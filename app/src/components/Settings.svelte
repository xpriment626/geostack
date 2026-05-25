<script lang="ts">
  import { onMount } from 'svelte'
  import type { Navigate } from '../lib/nav'
  import { getConfig, putConfig, type ConfigStatus } from '../lib/api'

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { navigate }: { navigate: Navigate } = $props()

  let status = $state<ConfigStatus | null>(null)
  let saving = $state(false)
  let saved = $state(false)
  let error = $state<string | null>(null)

  // edit buffer — only non-empty fields are written
  let edits = $state<Record<string, string>>({})

  const FIELDS: { key: string; label: string; hint: string; required?: boolean }[] = [
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', hint: 'Required — the fleet calls models BYO-key.', required: true },
    { key: 'EXA_API_KEY', label: 'Exa API key', hint: 'Optional — higher research quotas.' },
    { key: 'VITE_REPLICATE_API_TOKEN', label: 'Replicate API token', hint: 'Optional — image generation.' },
    { key: 'TURSO_DATABASE_URL', label: 'Turso database URL', hint: 'Optional — cloud storage instead of the local file.' },
    { key: 'TURSO_AUTH_TOKEN', label: 'Turso auth token', hint: 'Required only if using Turso cloud.' },
  ]

  async function load() {
    try {
      status = await getConfig()
      error = null
    } catch (e) {
      error = (e as Error).message
    }
  }
  onMount(load)

  async function save() {
    saving = true
    saved = false
    error = null
    try {
      const body: Record<string, string> = {}
      for (const [k, v] of Object.entries(edits)) if (v.trim() !== '') body[k] = v.trim()
      await putConfig(body)
      edits = {}
      await load()
      saved = true
      setTimeout(() => (saved = false), 2500)
    } catch (e) {
      error = (e as Error).message
    }
    saving = false
  }
</script>

<div class="page page-narrow">
  <h1>Settings</h1>
  <p class="muted intro">Keys live in a single local config at <code>~/.geostack/config</code> — never committed, never sent anywhere but your own machine.</p>

  {#if status}
    <div class="card storage">
      <div>
        <span class="lbl faint">Storage</span>
        <strong>{status.storage.mode === 'cloud' ? 'Turso cloud' : 'Local file'}</strong>
      </div>
      <code class="path">{status.storage.mode === 'cloud' ? '(TURSO_DATABASE_URL set)' : '~/.geostack/geostack.db'}</code>
    </div>
  {/if}

  <div class="card form">
    {#each FIELDS as f}
      <div class="field">
        <label for={'cfg-' + f.key}>
          {f.label}
          {#if f.required}<span class="req">required</span>{/if}
          {#if status?.keys[f.key]?.set}<span class="set">set {status.keys[f.key].hint}</span>{/if}
        </label>
        <input
          id={'cfg-' + f.key}
          class="input"
          type="password"
          autocomplete="off"
          placeholder={status?.keys[f.key]?.set ? 'Enter a new value to replace' : 'Not set'}
          bind:value={edits[f.key]}
        />
        <p class="hint faint">{f.hint}</p>
      </div>
    {/each}

    {#if error}<p class="err">{error}</p>{/if}
    <div class="actions">
      <span class="note faint">Storage changes apply on next restart; key changes apply on the next run.</span>
      <button class="btn btn-primary" onclick={save} disabled={saving}>
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
      </button>
    </div>
  </div>
</div>

<style>
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; letter-spacing: -0.02em; }
  .intro { margin: 0 0 1.5rem; font-size: 0.95rem; }
  .intro code, .path { font-family: ui-monospace, monospace; font-size: 0.85em; }
  .storage { display: flex; align-items: center; justify-content: space-between; padding: 0.9rem 1.2rem; margin-bottom: 1rem; }
  .storage .lbl { display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .form { padding: 1.5rem; }
  .field .req { color: #b45309; font-weight: 600; font-size: 0.72rem; margin-left: 0.4rem; }
  .field .set { color: #15803d; font-weight: 600; font-size: 0.72rem; margin-left: 0.4rem; }
  .field .hint { margin: 0.3rem 0 0; font-size: 0.8rem; }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 0.5rem; }
  .note { font-size: 0.78rem; }
  .err { color: #b91c1c; font-size: 0.9rem; }
</style>
