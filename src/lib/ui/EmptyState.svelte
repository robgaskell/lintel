<script lang="ts">
  import { isMac } from '../os/platform';

  let {
    recent,
    onOpen,
    onNew,
    onOpenRecent,
  }: {
    recent: string[]; // newest first
    onOpen: () => void;
    onNew: () => void;
    onOpenRecent: (path: string) => void;
  } = $props();

  const mod = isMac() ? 'Cmd' : 'Ctrl';

  function split(path: string): { name: string; folder: string } {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return { name: path.slice(cut + 1), folder: path.slice(0, Math.max(cut, 0)) };
  }
</script>

<div class="empty-state">
  <div class="card">
    <p class="lead">
      <button type="button" class="link" onclick={onOpen}>Open a file</button> ({mod}+O) or
      <button type="button" class="link" onclick={onNew}>create one</button> ({mod}+N)
    </p>
    {#if recent.length > 0}
      <h2>Recent</h2>
      <ul>
        {#each recent as path (path)}
          {@const { name, folder } = split(path)}
          <li>
            <button type="button" class="recent" title={path} onclick={() => onOpenRecent(path)}>
              <span class="name">{name}</span>
              <span class="folder">{folder}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--editor-bg);
    color: var(--muted-strong);
  }

  .card {
    width: min(420px, 100%);
  }

  .lead {
    margin: 0;
    font-size: 15px;
    text-align: center;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  h2 {
    margin: 28px 0 6px;
    padding: 0 10px;
    color: var(--muted-strong);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .recent {
    display: flex;
    width: 100%;
    gap: 8px;
    align-items: baseline;
    padding: 6px 10px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .recent:hover {
    background: var(--toolbar-hover);
  }

  .name {
    flex: none;
    font-weight: 600;
  }

  .folder {
    overflow: hidden;
    color: var(--muted-strong);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link:focus-visible,
  .recent:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
</style>
