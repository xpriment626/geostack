<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { marked } from 'marked'
  import type { Navigate } from '../lib/nav'
  import {
    getProject,
    updateProject,
    intentChat,
    type ChatMessage,
    type IntentProposal,
  } from '../lib/api'

  let { projectId, navigate }: { projectId: string; navigate: Navigate } = $props()

  let projectName = $state('')
  let messages = $state<ChatMessage[]>([])
  let draft = $state('')
  let thinking = $state(false)
  let error = $state<string | null>(null)
  let proposal = $state<IntentProposal | null>(null)
  let model = $state('')
  let totalIn = $state(0)
  let totalOut = $state(0)
  let saving = $state(false)
  let scroller = $state<HTMLDivElement | null>(null)

  async function scrollDown() {
    await tick()
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  // Send the current history to the interviewer and append its reply.
  async function turn() {
    thinking = true
    error = null
    proposal = null
    try {
      const res = await intentChat(projectId, messages)
      model = res.model
      totalIn += res.usage.inputTokens
      totalOut += res.usage.outputTokens
      if (res.reply) messages = [...messages, { role: 'assistant', content: res.reply }]
      if (res.proposal) proposal = res.proposal
      await scrollDown()
    } catch (e) {
      error = (e as Error).message
    }
    thinking = false
  }

  async function send() {
    const text = draft.trim()
    if (!text || thinking) return
    messages = [...messages, { role: 'user', content: text }]
    draft = ''
    await scrollDown()
    await turn()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  async function saveProposal() {
    if (!proposal) return
    saving = true
    try {
      await updateProject(projectId, {
        description: proposal.description,
        audience: proposal.audience,
        tone: proposal.tone,
        topicMeta: { targetQueries: proposal.targetQueries, anchorClaims: proposal.anchorClaims },
      })
      navigate({ name: 'project', projectId })
    } catch (e) {
      error = (e as Error).message
      saving = false
    }
  }

  const render = (md: string) => marked.parse(md) as string

  onMount(async () => {
    try {
      const p = await getProject(projectId)
      projectName = p.name
    } catch {
      /* still usable */
    }
    // Kick off the interview: empty history → the model greets + asks first.
    await turn()
  })
</script>

<div class="page page-narrow chat-page">
  <button class="btn btn-ghost back" onclick={() => navigate({ name: 'project', projectId })}>Skip for now →</button>
  <h1>Set up {projectName || 'your project'}</h1>
  <p class="muted intro">A quick interview to capture what this project is about — it anchors every idea and run.</p>

  <div class="chat" bind:this={scroller}>
    {#each messages as m}
      <div class="msg {m.role}">
        {#if m.role === 'assistant'}
          <div class="bubble bot">{@html render(m.content)}</div>
        {:else}
          <div class="bubble me">{m.content}</div>
        {/if}
      </div>
    {/each}
    {#if thinking}
      <div class="msg assistant"><div class="bubble bot typing">…</div></div>
    {/if}
    {#if error}
      <p class="err">{error}{#if error.includes('502') || error.toLowerCase().includes('openrouter')} — is <code>OPENROUTER_API_KEY</code> set? Check Settings.{/if}</p>
    {/if}
  </div>

  {#if proposal}
    <div class="card proposal">
      <h2>Captured topic</h2>
      <dl>
        <dt>Description</dt><dd>{proposal.description || '—'}</dd>
        <dt>Audience</dt><dd>{proposal.audience || '—'}</dd>
        <dt>Tone</dt><dd>{proposal.tone || '—'}</dd>
      </dl>
      <div class="lists">
        <div>
          <span class="ltag">Target queries</span>
          <ul>{#each proposal.targetQueries as q}<li>{q}</li>{:else}<li class="faint">none</li>{/each}</ul>
        </div>
        <div>
          <span class="ltag">Anchor claims</span>
          <ul>{#each proposal.anchorClaims as cl}<li>{cl}</li>{:else}<li class="faint">none</li>{/each}</ul>
        </div>
      </div>
      <div class="proposal-actions">
        <button class="btn" onclick={() => (proposal = null)}>Keep refining</button>
        <button class="btn btn-primary" onclick={saveProposal} disabled={saving}>
          {saving ? 'Saving…' : 'Looks good — save'}
        </button>
      </div>
    </div>
  {:else}
    <div class="composer">
      <textarea
        class="textarea"
        bind:value={draft}
        onkeydown={onKey}
        placeholder={thinking ? 'Thinking…' : 'Type your answer…'}
        disabled={thinking}
        rows="2"
      ></textarea>
      <button class="btn btn-primary send" onclick={send} disabled={thinking || !draft.trim()}>Send</button>
    </div>
  {/if}

  {#if model}
    <p class="meta faint">{model} · {totalIn + totalOut} tokens this session</p>
  {/if}
</div>

<style>
  .back { margin-bottom: 1rem; padding-left: 0; }
  h1 { font-size: 1.5rem; margin: 0 0 0.3rem; letter-spacing: -0.02em; }
  .intro { margin: 0 0 1.2rem; }
  .chat {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    max-height: 52vh;
    overflow-y: auto;
    padding: 0.2rem;
    margin-bottom: 1rem;
  }
  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .bubble {
    max-width: 80%;
    padding: 0.7rem 0.95rem;
    border-radius: 14px;
    font-size: 0.95rem;
    line-height: 1.5;
  }
  .bubble.bot { background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
  .bubble.me { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
  .bubble.typing { color: var(--faint); letter-spacing: 0.15em; }
  .bubble :global(p) { margin: 0 0 0.5rem; }
  .bubble :global(p:last-child) { margin: 0; }
  .bubble :global(ul), .bubble :global(ol) { margin: 0.3rem 0; padding-left: 1.2rem; }
  .err { color: #b91c1c; font-size: 0.9rem; }
  .err code { font-family: ui-monospace, monospace; font-size: 0.85em; }
  .composer { display: flex; gap: 0.6rem; align-items: flex-end; }
  .composer .textarea { flex: 1; resize: vertical; min-height: 2.6rem; }
  .send { white-space: nowrap; }
  .proposal { padding: 1.3rem 1.4rem; }
  .proposal h2 { margin: 0 0 0.8rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .proposal dl { margin: 0 0 1rem; display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 1rem; }
  .proposal dt { color: var(--faint); font-size: 0.85rem; }
  .proposal dd { margin: 0; font-size: 0.92rem; }
  .lists { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; margin-bottom: 1.2rem; }
  .ltag { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
  .lists ul { margin: 0.4rem 0 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .lists li { font-size: 0.9rem; }
  .proposal-actions { display: flex; justify-content: flex-end; gap: 0.6rem; }
  .meta { margin: 0.8rem 0 0; font-size: 0.78rem; text-align: right; }
</style>
