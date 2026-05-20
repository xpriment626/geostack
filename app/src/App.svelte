<script lang="ts">
  import Landing from './components/Landing.svelte'
  import Wizard from './components/Wizard.svelte'
  import DraftView from './components/DraftView.svelte'
  import type { BriefEnvelope, FinalEnvelope } from './lib/envelopes'

  type View = 'landing' | 'wizard' | 'done'

  let view: View = 'landing'
  let brief: BriefEnvelope | null = null
  let final: FinalEnvelope | null = null
  let thumbnailUrl: string | null = null

  function startWizard() {
    brief = null
    final = null
    thumbnailUrl = null
    view = 'wizard'
  }

  function onComplete(b: BriefEnvelope, f: FinalEnvelope, t: string) {
    brief = b
    final = f
    thumbnailUrl = t
    view = 'done'
  }

  function reset() {
    brief = null
    final = null
    thumbnailUrl = null
    view = 'landing'
  }
</script>

<main>
  {#if view === 'landing'}
    <Landing onNewPost={startWizard} />
  {:else if view === 'wizard'}
    <Wizard {onComplete} onCancel={reset} />
  {:else if view === 'done' && brief && final && thumbnailUrl}
    <DraftView {brief} {final} {thumbnailUrl} onReset={reset} />
  {/if}
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
  }
</style>
