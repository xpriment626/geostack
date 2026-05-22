<script lang="ts">
  import { onDestroy } from 'svelte'
  import {
    createSession,
    closeSession,
    puppetCreateThread,
    puppetSendMessage,
    subscribeSessionEvents,
    type SessionIdentifier,
    type SessionEvent,
    type EventSubscription,
  } from '../lib/coral'
  import {
    parseEnvelope,
    type QuestionEnvelope,
    type BriefEnvelope,
    type FinalEnvelope,
  } from '../lib/envelopes'
  import { generateThumbnail } from '../lib/replicate'
  import InputRenderer from './InputRenderer.svelte'

  export let onComplete: (
    brief: BriefEnvelope,
    final: FinalEnvelope,
    thumbnailUrl: string,
  ) => void
  export let onCancel: () => void

  type Phase =
    | 'initial'
    | 'starting'
    | 'awaiting' // wizard: brief-agent thinking between Qs
    | 'asking' // wizard: rendering a question
    | 'submitting' // wizard: sending a user answer
    | 'awaiting-approval' // brief synthesised, awaiting user click
    | 'submitting-approval' // approval sent, waiting brief-agent Phase 2 kickoff
    | 'pipeline' // fan-out underway
    | 'error'

  interface LogEntry {
    who: 'user' | 'agent'
    text: string
  }

  // Pipeline progress flags
  interface PipelineStatus {
    research: 'pending' | 'done'
    thumbnail: 'pending' | 'generating' | 'done' | 'failed'
    draft: 'pending' | 'done'
    final: 'pending' | 'done'
  }

  let phase: Phase = 'initial'
  let topicSeed = ''
  let session: SessionIdentifier | null = null
  let wizardThreadId: string | null = null
  let pipelineThreadId: string | null = null
  let subscription: EventSubscription | null = null
  let currentQuestion: QuestionEnvelope | null = null
  let log: LogEntry[] = []
  let brief: BriefEnvelope | null = null
  let thumbnailUrl: string | null = null
  let final: FinalEnvelope | null = null
  let pipelineStatus: PipelineStatus = {
    research: 'pending',
    thumbnail: 'pending',
    draft: 'pending',
    final: 'pending',
  }
  let errorMessage = ''
  let handledBrief = false
  let handledApproval = false

  const USER_AGENT = 'user-proxy'
  const BRIEF_AGENT = 'brief-agent'
  const SEARCH_AGENT = 'search-agent'
  const CONTENT_AGENT = 'content-agent'
  const THUMBNAIL_AGENT = 'thumbnail-agent'
  const TEMPLATE_AGENT = 'template-agent'

  function appendLog(entry: LogEntry) {
    log = [...log, entry]
  }

  function setStatus(key: keyof PipelineStatus, value: PipelineStatus[keyof PipelineStatus]) {
    pipelineStatus = { ...pipelineStatus, [key]: value } as PipelineStatus
  }

  function maybeComplete() {
    if (brief && final && thumbnailUrl) {
      onComplete(brief, final, thumbnailUrl)
    }
  }

  function onEvent(e: SessionEvent) {
    if (e.type === 'thread_created') {
      const t = (e as any).thread
      if (t?.name === 'InstaLetter pipeline' && t?.creatorName === BRIEF_AGENT) {
        pipelineThreadId = t.id
        phase = 'pipeline'
      }
      return
    }

    if (e.type !== 'thread_message_sent') return
    const msg = (e as any).message
    if (!msg) return

    // Wizard thread: brief-agent talking to user
    if (msg.threadId === wizardThreadId && msg.senderName === BRIEF_AGENT) {
      handleWizardAgentMessage(msg.text)
      return
    }

    // Pipeline thread events
    if (pipelineThreadId && msg.threadId === pipelineThreadId) {
      switch (msg.senderName) {
        case SEARCH_AGENT:
          setStatus('research', 'done')
          break
        case THUMBNAIL_AGENT: {
          const env = parseEnvelope(msg.text)
          if (env?.type === 'thumbnail_prompt') {
            void runThumbnail(env.prompt, env.aspect_ratio, env.quality)
          }
          break
        }
        case CONTENT_AGENT: {
          const env = parseEnvelope(msg.text)
          if (env?.type === 'draft') {
            setStatus('draft', 'done')
          }
          break
        }
        case TEMPLATE_AGENT: {
          const env = parseEnvelope(msg.text)
          if (env?.type === 'final') {
            final = env
            setStatus('final', 'done')
            maybeComplete()
          }
          break
        }
      }
    }
  }

  async function runThumbnail(
    prompt: string,
    aspect: 'auto' | '1:1' | '3:2' | '2:3' | undefined,
    quality: 'low' | 'medium' | 'high' | 'auto' | undefined,
  ) {
    setStatus('thumbnail', 'generating')
    try {
      const ar = aspect === 'auto' || !aspect ? '3:2' : aspect
      const url = await generateThumbnail({
        prompt,
        aspect_ratio: ar,
        quality: quality ?? 'medium',
      })
      thumbnailUrl = url
      setStatus('thumbnail', 'done')
      maybeComplete()
    } catch (err: any) {
      console.error('thumbnail generation failed', err)
      setStatus('thumbnail', 'failed')
      errorMessage = `Thumbnail generation failed: ${err?.message ?? err}`
    }
  }

  function handleWizardAgentMessage(text: string) {
    const env = parseEnvelope(text)
    if (!env) {
      appendLog({ who: 'agent', text })
      return
    }
    if (env.type === 'question') {
      currentQuestion = env
      phase = 'asking'
      appendLog({ who: 'agent', text: env.label })
    } else if (env.type === 'brief') {
      if (handledBrief) return
      handledBrief = true
      brief = env
      currentQuestion = null
      phase = 'awaiting-approval'
    }
  }

  async function startSession(initialTopic: string) {
    phase = 'starting'
    errorMessage = ''
    log = [{ who: 'user', text: initialTopic }]
    try {
      session = await createSession({
        agentGraphRequest: {
          agents: [
            // Geostack executable-runtime agents. Each agent owns its own
            // OpenRouter-direct LLM client; the model is set per-agent via the
            // MODEL_NAME option in its coral-agent.toml (swap there for a
            // cost:capability trial). No proxy overrides on this runtime.
            {
              id: { name: BRIEF_AGENT, version: '0.1.0', registrySourceId: { type: 'local' } },
              name: BRIEF_AGENT,
              provider: { type: 'local', runtime: 'executable' },
            },
            {
              id: { name: SEARCH_AGENT, version: '0.1.0', registrySourceId: { type: 'local' } },
              name: SEARCH_AGENT,
              provider: { type: 'local', runtime: 'executable' },
            },
            {
              id: { name: CONTENT_AGENT, version: '0.1.0', registrySourceId: { type: 'local' } },
              name: CONTENT_AGENT,
              provider: { type: 'local', runtime: 'executable' },
            },
            {
              id: { name: THUMBNAIL_AGENT, version: '0.1.0', registrySourceId: { type: 'local' } },
              name: THUMBNAIL_AGENT,
              provider: { type: 'local', runtime: 'executable' },
            },
            {
              id: { name: TEMPLATE_AGENT, version: '0.1.0', registrySourceId: { type: 'local' } },
              name: TEMPLATE_AGENT,
              provider: { type: 'local', runtime: 'executable' },
            },
            {
              id: { name: 'puppet', version: '1.0.0', registrySourceId: { type: 'local' } },
              name: USER_AGENT,
              provider: { type: 'local', runtime: 'function' },
            },
          ],
          groups: [
            [
              BRIEF_AGENT,
              SEARCH_AGENT,
              CONTENT_AGENT,
              THUMBNAIL_AGENT,
              TEMPLATE_AGENT,
              USER_AGENT,
            ],
          ],
        },
        namespaceProvider: {
          type: 'create_if_not_exists',
          namespaceRequest: { name: 'instaletter' },
        },
      })

      subscription = subscribeSessionEvents(session, onEvent)

      const { thread } = await puppetCreateThread(session, USER_AGENT, {
        threadName: 'InstaLetter wizard',
        participantNames: [BRIEF_AGENT],
      })
      wizardThreadId = thread.id

      await puppetSendMessage(session, USER_AGENT, {
        threadId: wizardThreadId,
        content: initialTopic,
        mentions: [BRIEF_AGENT],
      })

      phase = 'awaiting'
    } catch (err: any) {
      console.error('startSession failed', err)
      errorMessage = err?.message ?? String(err)
      phase = 'error'
    }
  }

  async function submitAnswer(answer: string) {
    if (!session || !wizardThreadId) return
    phase = 'submitting'
    appendLog({ who: 'user', text: answer })
    try {
      await puppetSendMessage(session, USER_AGENT, {
        threadId: wizardThreadId,
        content: answer,
        mentions: [BRIEF_AGENT],
      })
      currentQuestion = null
      phase = 'awaiting'
    } catch (err: any) {
      errorMessage = err?.message ?? String(err)
      phase = 'error'
    }
  }

  async function approveBrief() {
    if (!session || !wizardThreadId || handledApproval) return
    handledApproval = true
    phase = 'submitting-approval'
    try {
      await puppetSendMessage(session, USER_AGENT, {
        threadId: wizardThreadId,
        content: JSON.stringify({ type: 'approval' }),
        mentions: [BRIEF_AGENT],
      })
      // brief-agent will create the pipeline thread; onEvent flips phase to 'pipeline'
    } catch (err: any) {
      handledApproval = false
      errorMessage = err?.message ?? String(err)
      phase = 'error'
    }
  }

  async function teardown() {
    if (subscription) subscription.close()
    subscription = null
    if (session) {
      try {
        await closeSession(session)
      } catch {}
      session = null
    }
    wizardThreadId = null
    pipelineThreadId = null
  }

  onDestroy(() => {
    void teardown()
  })

  function handleCancel() {
    void teardown().then(onCancel)
  }
</script>

<section class="wizard">
  <header>
    <button class="back" on:click={handleCancel} aria-label="Cancel">←</button>
    <span class="title">InstaLetter wizard</span>
  </header>

  {#if phase === 'error'}
    <div class="error">
      <strong>Something went wrong</strong>
      <pre>{errorMessage}</pre>
      <button on:click={handleCancel}>Start over</button>
    </div>
  {:else if phase === 'initial'}
    <div class="prompt">
      <h2>What do you want to post about?</h2>
      <p class="hint">A topic, a question, a hot take — anything.</p>
      <textarea
        bind:value={topicSeed}
        placeholder="e.g. how small AI startups are quietly outshipping the big labs"
        rows="3"
        autofocus
      ></textarea>
      <button
        class="primary"
        disabled={!topicSeed.trim()}
        on:click={() => startSession(topicSeed.trim())}
      >Begin</button>
    </div>
  {:else if (phase === 'awaiting-approval' || phase === 'submitting-approval') && brief}
    <div class="approval">
      <div class="brief-card">
        <span class="kicker">Brief synthesised</span>
        <h2>{brief.title}</h2>
        <p class="summary">{brief.summary}</p>
        <div class="meta">
          <span><b>Audience:</b> {brief.audience}</span>
          <span><b>Angle:</b> {brief.angle}</span>
          <span><b>Tone:</b> {brief.tone}</span>
          <span><b>Length:</b> {brief.length}</span>
        </div>
      </div>
      <div class="approval-actions">
        <button class="ghost" on:click={handleCancel} disabled={phase === 'submitting-approval'}>Restart</button>
        <button class="primary" on:click={approveBrief} disabled={phase === 'submitting-approval'}>
          {phase === 'submitting-approval' ? 'Sending…' : 'Approve & generate'}
        </button>
      </div>
    </div>
  {:else if phase === 'pipeline' && brief}
    <div class="pipeline">
      <div class="brief-card compact">
        <span class="kicker">Brief approved</span>
        <h2>{brief.title}</h2>
      </div>
      <ul class="status">
        <li class="status-item {pipelineStatus.research}">
          <span class="icon">{pipelineStatus.research === 'done' ? '✓' : '◌'}</span>
          <span>Researching with Exa</span>
        </li>
        <li class="status-item {pipelineStatus.thumbnail}">
          <span class="icon">{pipelineStatus.thumbnail === 'done' ? '✓' : pipelineStatus.thumbnail === 'failed' ? '✕' : '◌'}</span>
          <span>
            {pipelineStatus.thumbnail === 'pending' ? 'Designing thumbnail' :
             pipelineStatus.thumbnail === 'generating' ? 'Rendering thumbnail (Replicate)' :
             pipelineStatus.thumbnail === 'done' ? 'Thumbnail ready' :
             'Thumbnail failed'}
          </span>
        </li>
        <li class="status-item {pipelineStatus.draft}">
          <span class="icon">{pipelineStatus.draft === 'done' ? '✓' : '◌'}</span>
          <span>Writing draft</span>
        </li>
        <li class="status-item {pipelineStatus.final}">
          <span class="icon">{pipelineStatus.final === 'done' ? '✓' : '◌'}</span>
          <span>Polishing final</span>
        </li>
      </ul>
    </div>
  {:else}
    <div class="conversation">
      {#each log as entry}
        <div class="bubble {entry.who}">
          <span class="role">{entry.who === 'user' ? 'You' : 'Brief agent'}</span>
          <p>{entry.text}</p>
        </div>
      {/each}

      {#if phase === 'asking' && currentQuestion}
        <div class="current">
          <InputRenderer
            question={currentQuestion}
            onSubmit={submitAnswer}
            disabled={false}
          />
        </div>
      {:else if phase === 'awaiting' || phase === 'starting' || phase === 'submitting'}
        <div class="waiting">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <em>{phase === 'starting' ? 'spinning up the agents' : phase === 'submitting' ? 'sending' : 'thinking'}…</em>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .wizard {
    width: 100%;
    max-width: 36rem;
    margin: 0 auto;
    padding: 2rem 2rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .back {
    border: none;
    background: transparent;
    font-size: 1.4rem;
    cursor: pointer;
    color: #555;
    padding: 0.25rem 0.5rem;
    line-height: 1;
  }
  .back:hover { color: #111; }

  .title {
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
  }

  .prompt { display: flex; flex-direction: column; gap: 1rem; }
  .prompt h2 { margin: 0; font-size: 1.65rem; line-height: 1.2; letter-spacing: -0.01em; }
  .prompt .hint { margin: 0; color: #666; font-size: 0.95rem; }

  textarea {
    border: 1.5px solid #ddd;
    border-radius: 12px;
    padding: 0.85rem 1rem;
    font: inherit;
    font-size: 1rem;
    background: #fafafa;
    outline: none;
    resize: vertical;
    min-height: 5rem;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  textarea:focus { border-color: #111; background: #fff; }

  button.primary {
    align-self: flex-end;
    background: #111;
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 0.75rem 1.75rem;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.1s ease;
  }
  button.primary:disabled { opacity: 0.35; cursor: not-allowed; }

  button.ghost {
    background: transparent;
    border: 1.5px solid #ddd;
    color: #333;
    border-radius: 999px;
    padding: 0.6rem 1.25rem;
    font-size: 0.95rem;
    cursor: pointer;
    transition: border-color 0.1s ease, color 0.1s ease;
  }
  button.ghost:hover { border-color: #111; color: #111; }
  button.ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  .conversation { display: flex; flex-direction: column; gap: 0.85rem; }
  .bubble { border-radius: 14px; padding: 0.7rem 1rem; max-width: 92%; }
  .bubble .role { font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: #999; }
  .bubble p { margin: 0.25rem 0 0; line-height: 1.4; color: #111; }
  .bubble.user { background: #f3f3f3; align-self: flex-end; }
  .bubble.agent { background: #fff; border: 1.5px solid #eee; align-self: flex-start; }

  .current {
    margin-top: 0.5rem;
    border-top: 1.5px dashed #eee;
    padding-top: 1.25rem;
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #888;
    padding: 0.5rem 0;
    font-style: italic;
    font-size: 0.95rem;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #bbb;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.15s; }
  .dot:nth-child(3) { animation-delay: 0.3s; }

  @keyframes pulse {
    0%, 100% { opacity: 0.3; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(-2px); }
  }

  .approval { display: flex; flex-direction: column; gap: 1.25rem; }
  .approval-actions {
    display: flex;
    gap: 0.6rem;
    align-self: flex-end;
  }

  .brief-card {
    border: 1.5px solid #eee;
    border-radius: 14px;
    padding: 1.25rem 1.5rem;
    background: #fff;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .brief-card.compact { padding: 1rem 1.25rem; }
  .brief-card .kicker {
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
  }
  .brief-card h2 {
    margin: 0.1rem 0;
    font-size: 1.4rem;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }
  .brief-card .summary {
    margin: 0;
    color: #444;
    font-size: 0.98rem;
    line-height: 1.45;
  }
  .brief-card .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: #555;
  }

  .pipeline { display: flex; flex-direction: column; gap: 1.25rem; }

  .status {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .status-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 1rem;
    border-radius: 12px;
    border: 1.5px solid #eee;
    background: #fff;
    color: #444;
    font-size: 0.98rem;
  }
  .status-item.done { color: #1a4b1a; background: #f3fbf3; border-color: #cbe7cb; }
  .status-item.generating { color: #114777; background: #f1f7ff; border-color: #c8dcf1; }
  .status-item.failed { color: #7a1f1f; background: #fff4f4; border-color: #f3c3c3; }
  .status-item .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 999px;
    background: #f0f0f0;
    color: #555;
    font-size: 0.85rem;
  }
  .status-item.done .icon { background: #c4eac4; color: #1a4b1a; }
  .status-item.generating .icon {
    background: #d1e4f5;
    color: #114777;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .status-item.failed .icon { background: #f3c3c3; color: #7a1f1f; }

  .error {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: #fff4f4;
    border: 1.5px solid #f3c3c3;
    border-radius: 12px;
  }
  .error pre { margin: 0; white-space: pre-wrap; font-size: 0.85rem; color: #6a1f1f; }
  .error button {
    align-self: flex-start;
    background: #111;
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 0.5rem 1.25rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
</style>
