<script lang="ts">
  export let onNewPost: () => void
</script>

<section class="landing">
  <header>
    <h1>InstaLetter</h1>
    <p class="tagline">Create research-enriched newsletter posts instantly</p>
  </header>
  <button class="primary" on:click={onNewPost}>New Post</button>
</section>

<style>
  .landing {
    width: 100%;
    max-width: 32rem;
    margin: 0 auto;
    padding: 4rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2rem;
    text-align: center;
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  h1 {
    margin: 0;
    font-family: 'Caveat', 'Comic Sans MS', system-ui, sans-serif;
    font-size: 3.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .tagline {
    margin: 0;
    font-size: 1.05rem;
    color: #555;
    max-width: 22rem;
    line-height: 1.4;
  }

  button.primary {
    background: #111;
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 0.85rem 2.5rem;
    font-size: 1.05rem;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 3px 0 0 #111, 0 6px 18px -10px rgba(0, 0, 0, 0.35);
    transition: transform 0.08s ease, box-shadow 0.08s ease;
  }

  button.primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 0 0 #111, 0 10px 22px -10px rgba(0, 0, 0, 0.4);
  }

  button.primary:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 0 #111;
  }
</style>
