<script lang="ts">
  import { readingMinutes } from '../docs/stats';

  let {
    line,
    col,
    words,
    saveState,
    lintCount,
    lintFixable,
    onFixAll,
    notice,
    noticeDetails = null,
    update,
    onUpdate,
    reading = false,
  }: {
    line: number;
    col: number;
    words: number;
    saveState: 'saved' | 'unsaved' | 'untitled';
    lintCount: number | null;
    lintFixable: boolean;
    onFixAll?: () => void;
    notice: string | null;
    noticeDetails?: string | null; // shown on hover
    update: 'none' | 'ready';
    onUpdate?: () => void;
    reading?: boolean; // Read mode shows reading time instead of cursor and save state
  } = $props();

  const SAVE_LABEL = { saved: 'Saved', unsaved: 'Unsaved', untitled: 'Not saved yet' } as const;

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
</script>

<footer class="status-bar">
  <span class="group">
    <span class="facts">
      {#if reading}
        <span>{plural(words, 'word', 'words')}</span>
        <span aria-hidden="true">·</span>
        <span>{readingMinutes(words)} min read</span>
      {:else}
        <span>Ln {line}, Col {col}</span>
        <span aria-hidden="true">·</span>
        <span>{plural(words, 'word', 'words')}</span>
        <span aria-hidden="true">·</span>
        <span>{SAVE_LABEL[saveState]}</span>
      {/if}
    </span>
    {#if lintCount !== null}
      <span class="lint">{plural(lintCount, 'lint warning', 'lint warnings')}</span>
      {#if lintFixable && onFixAll}
        <button type="button" class="link" onclick={onFixAll}>Fix all</button>
      {/if}
    {/if}
  </span>
  <span class="group right">
    {#if notice}
      <span role="status" title={noticeDetails}>{notice}</span>
    {:else}
      <span>Markdown · UTF-8</span>
    {/if}
    {#if update === 'ready'}
      <button type="button" class="link update" onclick={onUpdate}>Update ready: restart</button>
    {/if}
  </span>
</footer>

<style>
  .status-bar {
    display: flex;
    flex: 0 0 28px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-sizing: border-box;
    height: 28px;
    padding: 0 12px;
    overflow: hidden;
    background: var(--chrome);
    border-top: 1px solid var(--border);
    /* --muted fails 4.5:1 on --chrome (Ruling 111). */
    color: var(--muted-strong);
    font-size: 12px;
    white-space: nowrap;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .right {
    gap: 12px;
  }

  .facts {
    display: flex;
    gap: 4px;
  }

  .lint {
    color: var(--lint-warning);
    font-weight: 600;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  .update {
    font-weight: 600;
  }

  .link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
</style>
