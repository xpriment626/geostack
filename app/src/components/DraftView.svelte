<script lang="ts">
  import type { BriefEnvelope, FinalEnvelope } from '../lib/envelopes'
  import { marked } from 'marked'

  export let brief: BriefEnvelope
  export let final: FinalEnvelope
  export let thumbnailUrl: string
  export let onReset: () => void

  // Demo-grade — template-agent output is fully trusted in this local trial.
  $: rendered = marked.parse(final.markdown, { async: false }) as string
</script>

<section class="post">
  <header>
    <span class="kicker">Published</span>
  </header>

  {#if thumbnailUrl}
    <figure class="hero">
      <img src={thumbnailUrl} alt="" />
    </figure>
  {/if}

  <article>
    {@html rendered}
  </article>

  <details class="brief-summary">
    <summary>Brief used</summary>
    <div class="grid">
      <div><span class="key">Topic</span><p>{brief.topic}</p></div>
      <div><span class="key">Audience</span><p>{brief.audience}</p></div>
      <div><span class="key">Angle</span><p>{brief.angle}</p></div>
      <div><span class="key">Tone</span><p>{brief.tone}</p></div>
      <div class="full"><span class="key">Length</span><p>{brief.length}</p></div>
    </div>
  </details>

  <button class="reset" on:click={onReset}>Start over</button>
</section>

<style>
  .post {
    width: 100%;
    max-width: 44rem;
    margin: 0 auto;
    padding: 3rem 2rem 5rem;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }

  header { display: flex; flex-direction: column; gap: 0.4rem; }
  .kicker {
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
  }

  .hero {
    margin: 0;
    overflow: hidden;
    border-radius: 16px;
    background: #f4f4f1;
    aspect-ratio: 3 / 2;
  }
  .hero img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  article {
    line-height: 1.6;
    color: #111;
    font-size: 1.05rem;
  }

  article :global(h1) { font-size: 2.1rem; line-height: 1.15; margin: 0.4rem 0 0.6rem; letter-spacing: -0.01em; }
  article :global(h1 + p em), article :global(h1 + p) { color: #555; font-size: 1.05rem; }
  article :global(h2) { font-size: 1.45rem; line-height: 1.2; margin: 1.8rem 0 0.6rem; letter-spacing: -0.005em; }
  article :global(h3) { font-size: 1.18rem; line-height: 1.25; margin: 1.4rem 0 0.5rem; }
  article :global(p)  { margin: 0.95rem 0; }
  article :global(ul), article :global(ol) { padding-left: 1.4rem; }
  article :global(li) { margin: 0.3rem 0; }
  article :global(a)  { color: #1145d6; text-decoration: underline; text-underline-offset: 2px; }
  article :global(blockquote) {
    margin: 1rem 0;
    padding: 0.5rem 1rem;
    border-left: 3px solid #ddd;
    color: #444;
    background: #fafafa;
    border-radius: 0 8px 8px 0;
  }
  article :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
    background: #f3f3f3;
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  article :global(pre) {
    background: #0f1115;
    color: #e6e6e6;
    border-radius: 10px;
    padding: 1rem;
    overflow-x: auto;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  article :global(pre code) { background: transparent; padding: 0; color: inherit; }

  .brief-summary {
    border: 1.5px solid #eee;
    border-radius: 12px;
    padding: 0.75rem 1rem;
    background: #fff;
    color: #555;
  }
  .brief-summary summary {
    cursor: pointer;
    font-size: 0.85rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .grid {
    margin-top: 0.75rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .grid > div { background: #fafafa; border-radius: 8px; padding: 0.6rem 0.8rem; }
  .grid > .full { grid-column: 1 / -1; }
  .key {
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #888;
  }
  .grid p { margin: 0.25rem 0 0; font-size: 0.95rem; color: #111; line-height: 1.35; }

  .reset {
    align-self: flex-start;
    background: transparent;
    border: 1.5px solid #ddd;
    color: #333;
    border-radius: 999px;
    padding: 0.6rem 1.25rem;
    font-size: 0.95rem;
    cursor: pointer;
    transition: border-color 0.1s ease, color 0.1s ease;
  }
  .reset:hover { border-color: #111; color: #111; }
</style>
