<script lang="ts">
  import Projects from './components/Projects.svelte'
  import CreateProject from './components/CreateProject.svelte'
  import IntentChat from './components/IntentChat.svelte'
  import Onboarding from './components/Onboarding.svelte'
  import Project from './components/Project.svelte'
  import Settings from './components/Settings.svelte'
  import type { Route } from './lib/nav'

  let route = $state<Route>({ name: 'projects' })
  const navigate = (r: Route) => (route = r)
</script>

<div class="shell">
  <header class="topbar">
    <button class="wordmark" onclick={() => navigate({ name: 'projects' })}>
      <span class="logo">◆</span> Geostack
    </button>
    <nav>
      <button
        class="navlink"
        class:active={route.name === 'projects' || route.name === 'create' || route.name === 'project' || route.name === 'onboarding' || route.name === 'intent'}
        onclick={() => navigate({ name: 'projects' })}>Projects</button>
      <button class="navlink" class:active={route.name === 'settings'} onclick={() => navigate({ name: 'settings' })}>
        Settings
      </button>
    </nav>
  </header>

  <main>
    {#if route.name === 'projects'}
      <Projects {navigate} />
    {:else if route.name === 'create'}
      <CreateProject {navigate} />
    {:else if route.name === 'intent'}
      <IntentChat projectId={route.projectId} {navigate} />
    {:else if route.name === 'onboarding'}
      <Onboarding projectId={route.projectId} {navigate} />
    {:else if route.name === 'project'}
      <Project projectId={route.projectId} {navigate} />
    {:else if route.name === 'settings'}
      <Settings {navigate} />
    {/if}
  </main>
</div>

<style>
  .shell { min-height: 100vh; display: flex; flex-direction: column; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 1.5rem;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: saturate(1.2) blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .wordmark {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
    padding: 0;
  }
  .wordmark .logo { color: var(--accent); font-size: 0.9rem; }
  nav { display: flex; gap: 0.25rem; }
  .navlink {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted);
    font-size: 0.92rem;
    font-weight: 550;
    padding: 0.4rem 0.7rem;
    border-radius: var(--radius-sm);
  }
  .navlink:hover { color: var(--text); background: var(--surface); }
  .navlink.active { color: var(--text); background: var(--surface); box-shadow: inset 0 0 0 1px var(--border); }
  main { flex: 1; }
</style>
