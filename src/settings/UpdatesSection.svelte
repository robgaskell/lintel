<script lang="ts">
  import { onMount } from 'svelte';
  import { checkForUpdates, followUpdatesInSettings, type UpdateState } from '../lib/os/updater';
  import { settings } from '../lib/settings/settings.svelte';
  import { save } from './save.svelte';

  let update = $state<UpdateState | null>(null);
  let askError = $state('');
  // Shown instead of the last result until the state next changes.
  let note = $state('');
  const busy = $derived(
    update?.status === 'checking' || update?.status === 'downloading' || update?.status === 'installing',
  );

  onMount(() =>
    followUpdatesInSettings((state) => {
      update = state;
      note = '';
    }),
  );

  async function checkNow() {
    askError = '';
    // A downloaded update is not checked again (Ruling 349).
    if (update?.status === 'ready') {
      note = 'An update is ready. Restart to install it.';
      return;
    }
    try {
      await checkForUpdates();
    } catch (err) {
      askError = `Could not check for updates: ${err}`;
    }
  }

  function lastResult(state: UpdateState): string {
    switch (state.status) {
      case 'checking':
        return 'Checking for updates…';
      case 'downloading':
        return `Downloading Lintel ${state.version}…`;
      case 'ready':
        return `Lintel ${state.version} is ready. Choose “Update ready: restart” in a document window to install it.`;
      case 'installing':
        return `Installing Lintel ${state.version}…`;
      case 'error':
        return state.error ?? 'The last check failed.';
      case 'none':
        return state.lastChecked === null
          ? 'Not checked yet.'
          : `Lintel is up to date. Last checked ${new Date(state.lastChecked).toLocaleString()}.`;
    }
  }
</script>

<div class="field">
  <span class="field-label">Version</span>
  <span>{update ? `Lintel ${update.appVersion}` : ''}</span>
</div>

<div class="field">
  <label class="switch-row">
    <input
      type="checkbox"
      role="switch"
      checked={settings.updates.autoCheck}
      onchange={(e) => save({ updates: { autoCheck: e.currentTarget.checked } })}
    />
    Check for updates automatically
  </label>
  <span class="hint">Lintel checks GitHub once a day and downloads an update in the background.</span>
</div>

<div class="field">
  <div>
    <button type="button" class="choice" disabled={busy} aria-describedby="update-result" onclick={checkNow}>
      Check now
    </button>
  </div>
  <p id="update-result" class="hint result" class:failed={update?.status === 'error' || askError !== ''} role="status">{askError || note || (update ? lastResult(update) : '')}</p>
</div>

<style>
  .switch-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .switch-row input {
    margin: 0;
    accent-color: var(--accent);
  }

  .result {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .result:empty {
    display: none;
  }

  .result.failed {
    color: var(--lint-warning);
  }
</style>
