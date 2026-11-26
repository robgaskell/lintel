<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { message } from '@tauri-apps/plugin-dialog';
  import { setActiveDocSource } from './lib/editor/views';
  import { Workspace } from './lib/layout/workspace';
  import { buildAppMenu } from './lib/os/menu';
  import { makeMenuHandlers } from './lib/os/menuHandlers';
  import { setWorkspace } from './lib/os/open';
  import { handleCloseRequested } from './lib/os/window';

  let host: HTMLElement;

  onMount(() => {
    const workspace = new Workspace(host);
    setWorkspace(workspace);
    setActiveDocSource(workspace);
    const handlers = makeMenuHandlers({ workspace, currentWindow: getCurrentWindow });
    buildAppMenu(handlers, []).catch((err) =>
      message(String(err), { title: 'Lintel', kind: 'error' }),
    );
    const unlistenClose = getCurrentWindow().onCloseRequested((event) =>
      handleCloseRequested(event, workspace),
    );
    return () => {
      unlistenClose.then((stop) => stop());
      setActiveDocSource(null);
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
