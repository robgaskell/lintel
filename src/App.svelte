<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { message, open } from '@tauri-apps/plugin-dialog';
  import { confirmCloseAll, saveDoc, saveDocAs } from './lib/docs/store.svelte';
  import { Workspace } from './lib/layout/workspace';
  import { newUntitled, openPaths, setWorkspace } from './lib/os/open';

  let host: HTMLElement;
  let workspace: Workspace;

  async function chooseFiles() {
    const paths = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (paths) await openPaths(paths);
  }

  async function saveActive(as: boolean) {
    const id = workspace.activeDocId();
    if (!id) return;
    const saved = as ? await saveDocAs(id) : await saveDoc(id);
    if (saved) workspace.refreshTab(id);
  }

  async function closeActive() {
    const id = workspace.activeDocId();
    if (id) await workspace.closeDoc(id);
  }

  async function runMenu(id: string) {
    try {
      if (id === 'new') newUntitled();
      else if (id === 'open') await chooseFiles();
      else if (id === 'save') await saveActive(false);
      else if (id === 'save-as') await saveActive(true);
      else if (id === 'close-tab') await closeActive();
    } catch (err) {
      await message(String(err), { title: 'Lintel', kind: 'error' });
    }
  }

  async function confirmWindowClose(): Promise<boolean> {
    try {
      return await confirmCloseAll(workspace.docIdsInOrder(), (id) => workspace.activate(id));
    } catch (err) {
      await message(String(err), { title: 'Lintel', kind: 'error' });
      return false;
    }
  }

  onMount(() => {
    workspace = new Workspace(host);
    setWorkspace(workspace);
    // Temporary menu events from Rust; M1.3 replaces them.
    const unlistenMenu = listen<string>('lintel://menu', (event) => runMenu(event.payload));
    // Tauri destroys the window after this handler unless it calls preventDefault.
    const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await confirmWindowClose())) event.preventDefault();
    });
    return () => {
      unlistenMenu.then((stop) => stop());
      unlistenClose.then((stop) => stop());
      workspace.dispose();
    };
  });
</script>

<main class="app" bind:this={host}></main>

<style>
  .app {
    height: 100vh;
  }

  :global(.dockview-theme-light.lintel-dock) {
    color-scheme: light dark;
    --tab-strip: #ececea;
    --tab-close: #6b6b67;
    --tab-close-hover-bg: rgba(0, 0, 0, 0.07);
    --dv-group-view-background-color: var(--editor-bg);
    --dv-tabs-and-actions-container-background-color: var(--tab-strip);
    --dv-tabs-and-actions-container-height: 40px;
    --dv-tabs-and-actions-container-font-size: 13px;
    --dv-activegroup-visiblepanel-tab-background-color: var(--editor-bg);
    --dv-inactivegroup-visiblepanel-tab-background-color: var(--editor-bg);
    --dv-activegroup-hiddenpanel-tab-background-color: var(--tab-strip);
    --dv-inactivegroup-hiddenpanel-tab-background-color: var(--tab-strip);
    --dv-activegroup-visiblepanel-tab-color: var(--text);
    --dv-inactivegroup-visiblepanel-tab-color: var(--text);
    --dv-activegroup-hiddenpanel-tab-color: var(--muted-strong);
    --dv-inactivegroup-hiddenpanel-tab-color: var(--muted-strong);
    --dv-tab-divider-color: transparent;
    --dv-separator-border: var(--border);
  }

  @media (prefers-color-scheme: dark) {
    :global(.dockview-theme-light.lintel-dock) {
      --tab-strip: #252524;
      --tab-close: #a3a39e;
      --tab-close-hover-bg: rgba(255, 255, 255, 0.1);
    }
  }

  :global(.lintel-dock .dv-tabs-and-actions-container) {
    border-bottom: 1px solid var(--border);
  }

  :global(.lintel-dock .dv-tabs-container) {
    align-items: flex-end;
    gap: 2px;
    padding-left: 8px;
  }

  :global(.lintel-dock .dv-tab) {
    height: 32px;
    padding: 0 10px 0 12px;
    border-radius: 6px 6px 0 0;
  }

  :global(.lintel-dock .dv-tab.dv-active-tab) {
    font-weight: 600;
  }

  :global(.lintel-dock .dv-groupview.dv-active-group .dv-tab.dv-active-tab) {
    box-shadow: inset 0 2px 0 var(--accent);
  }

  :global(.lintel-dock .dv-tab:focus-visible::after) {
    border-radius: 6px 6px 0 0;
    outline: 2px solid var(--accent) !important;
    outline-offset: -2px;
  }
</style>
