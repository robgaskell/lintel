<script lang="ts">
  import { installCli, makeDefaultHandler } from '../lib/ipc';
  import { currentPlatform } from '../lib/os/platform';
  import { settings } from '../lib/settings/settings.svelte';
  import { save } from './save.svelte';

  const MAX_RECENT = 20;

  let draft = $state(String(settings.recentLimit));
  $effect(() => {
    draft = String(settings.recentLimit);
  });

  // Saved on blur or Enter, so typing 15 does not first rebuild the menu for 1 (Ruling 143).
  function commit() {
    const typed = draft.trim() === '' ? NaN : Number(draft);
    if (!Number.isFinite(typed)) {
      draft = String(settings.recentLimit);
      return;
    }
    const limit = Math.min(MAX_RECENT, Math.max(0, Math.round(typed)));
    draft = String(limit);
    if (limit !== settings.recentLimit) save({ recentLimit: limit });
  }

  interface Outcome {
    ok: boolean;
    text: string;
  }

  let installing = $state(false);
  let installed = $state<Outcome | null>(null);
  let defaulting = $state(false);
  let defaulted = $state<Outcome | null>(null);

  async function outcome(action: () => Promise<string>): Promise<Outcome> {
    try {
      return { ok: true, text: await action() };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }

  async function install() {
    installing = true;
    installed = null;
    installed = await outcome(installCli);
    installing = false;
  }

  async function makeDefault() {
    defaulting = true;
    defaulted = null;
    defaulted = await outcome(async () => {
      await makeDefaultHandler();
      // Windows apps may not set the default, so Rust opened Default apps instead.
      return currentPlatform() === 'windows'
        ? 'In Default apps, choose Lintel for .md and .markdown files.'
        : 'Lintel is now the default for Markdown files.';
    });
    defaulting = false;
  }
</script>

<div class="field">
  <label class="field-label" for="recent-limit">Recent files to show</label>
  <input
    id="recent-limit"
    class="count"
    type="number"
    min="0"
    max={MAX_RECENT}
    step="1"
    value={draft}
    aria-describedby="recent-limit-hint"
    oninput={(e) => (draft = e.currentTarget.value)}
    onblur={commit}
    onkeydown={(e) => e.key === 'Enter' && commit()}
  />
  <span class="hint" id="recent-limit-hint">0 hides File &gt; Open Recent.</span>
</div>

<div class="field">
  <div class="action-row">
    <span>Open Markdown files in Lintel from a terminal</span>
    <button type="button" class="choice" disabled={installing} aria-describedby="install-outcome" onclick={install}>
      Install command-line tool
    </button>
  </div>
  <p id="install-outcome" class="hint outcome" class:failed={installed?.ok === false} role="status">{installed?.text ?? ''}</p>
  <div class="action-row">
    <span>Open .md and .markdown files in Lintel by default</span>
    <button type="button" class="choice" disabled={defaulting} aria-describedby="default-outcome" onclick={makeDefault}>
      Make Lintel the default
    </button>
  </div>
  <p id="default-outcome" class="hint outcome" class:failed={defaulted?.ok === false} role="status">{defaulted?.text ?? ''}</p>
</div>

<style>
  .count {
    width: 80px;
  }

  .outcome {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .outcome:empty {
    display: none;
  }

  .outcome.failed {
    color: var(--lint-warning);
  }

  .action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
</style>
