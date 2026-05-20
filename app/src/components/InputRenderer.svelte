<script lang="ts">
  import type { QuestionEnvelope } from '../lib/envelopes'

  export let question: QuestionEnvelope
  export let onSubmit: (answer: string) => void
  export let disabled: boolean = false

  let textValue = ''
  let selectValue = ''
  let multiValue: string[] = []
  let confirmValue: 'yes' | 'no' | '' = ''

  // Reset local state whenever a new question arrives.
  $: question, (() => { textValue = ''; selectValue = ''; multiValue = []; confirmValue = '' })()

  function submit() {
    if (disabled) return
    switch (question.input_type) {
      case 'text':
      case 'textarea': {
        const v = textValue.trim()
        if (v) onSubmit(v)
        return
      }
      case 'select': {
        if (selectValue) onSubmit(selectValue)
        return
      }
      case 'multi_select': {
        if (multiValue.length) onSubmit(multiValue.join(', '))
        return
      }
      case 'confirm': {
        if (confirmValue) onSubmit(confirmValue)
        return
      }
    }
  }

  function toggleMulti(opt: string) {
    multiValue = multiValue.includes(opt)
      ? multiValue.filter((v) => v !== opt)
      : [...multiValue, opt]
  }

  function onKeydown(e: KeyboardEvent) {
    if (question.input_type === 'text' && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }
</script>

<form on:submit|preventDefault={submit} class="question">
  <label class="label">{question.label}</label>

  {#if question.input_type === 'text'}
    <input
      type="text"
      bind:value={textValue}
      placeholder={question.placeholder ?? ''}
      on:keydown={onKeydown}
      autofocus
      {disabled}
    />
  {:else if question.input_type === 'textarea'}
    <textarea
      bind:value={textValue}
      placeholder={question.placeholder ?? ''}
      rows="4"
      {disabled}
    />
  {:else if question.input_type === 'select' && question.options}
    <div class="options">
      {#each question.options as opt}
        <label class="option">
          <input type="radio" name="select" value={opt} bind:group={selectValue} {disabled} />
          <span>{opt}</span>
        </label>
      {/each}
    </div>
  {:else if question.input_type === 'multi_select' && question.options}
    <div class="options">
      {#each question.options as opt}
        <label class="option">
          <input
            type="checkbox"
            checked={multiValue.includes(opt)}
            on:change={() => toggleMulti(opt)}
            {disabled}
          />
          <span>{opt}</span>
        </label>
      {/each}
    </div>
  {:else if question.input_type === 'confirm'}
    <div class="confirm">
      <button
        type="button"
        class="pill"
        class:active={confirmValue === 'yes'}
        on:click={() => (confirmValue = 'yes')}
        {disabled}
      >Yes</button>
      <button
        type="button"
        class="pill"
        class:active={confirmValue === 'no'}
        on:click={() => (confirmValue = 'no')}
        {disabled}
      >No</button>
    </div>
  {/if}

  <button type="submit" class="submit" {disabled}>
    {disabled ? 'Sending…' : 'Continue'}
  </button>
</form>

<style>
  .question {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .label {
    font-size: 1.15rem;
    font-weight: 500;
    color: #111;
    line-height: 1.4;
  }

  input[type='text'],
  textarea {
    border: 1.5px solid #ddd;
    border-radius: 12px;
    padding: 0.75rem 1rem;
    font: inherit;
    font-size: 1rem;
    background: #fafafa;
    outline: none;
    transition: border-color 0.12s ease, background 0.12s ease;
  }

  input[type='text']:focus,
  textarea:focus {
    border-color: #111;
    background: #fff;
  }

  textarea {
    resize: vertical;
    min-height: 5rem;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.65rem 0.9rem;
    border: 1.5px solid #eee;
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 0.1s ease, background 0.1s ease;
  }

  .option:hover {
    border-color: #bbb;
    background: #fafafa;
  }

  .option input {
    margin: 0;
  }

  .confirm {
    display: flex;
    gap: 0.6rem;
  }

  .pill {
    flex: 1;
    padding: 0.65rem 1rem;
    border-radius: 12px;
    border: 1.5px solid #ddd;
    background: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 1rem;
    transition: all 0.1s ease;
  }

  .pill.active {
    background: #111;
    color: #fff;
    border-color: #111;
  }

  .submit {
    margin-top: 0.5rem;
    background: #111;
    color: #fff;
    border: none;
    border-radius: 999px;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    align-self: flex-end;
    transition: opacity 0.1s ease;
  }

  .submit:disabled {
    opacity: 0.6;
    cursor: wait;
  }
</style>
