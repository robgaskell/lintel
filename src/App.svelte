<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { message, open } from '@tauri-apps/plugin-dialog';
  import { saveDoc, saveDocAs } from './lib/docs/store.svelte';
  import { setActiveDocSource } from './lib/editor/views';
  import { Workspace } from './lib/layout/workspace';
  import { buildAppMenu, type MenuHandlers } from './lib/os/menu';
  import { newUntitled, openPaths, setWorkspace } from './lib/os/open';
  import { isMac } from './lib/os/platform';
  import { quitApp } from './lib/os/quit';
  import { closeTabOrWindow, handleCloseRequested } from './lib/os/window';

  let host: HTMLElement;
  let workspace: Workspace;

  const MARKDOWN = { name: 'Markdown', extensions: ['md', 'markdown'] };
  // macOS merges all filters into one list with no picker, so "All files" would undo the first (Ruling 38).
  const OPEN_FILTERS = isMac() ? [MARKDOWN] : [MARKDOWN, { name: 'All files', extensions: ['*'] }];

  async function chooseFiles() {
    const paths = await open({ multiple: true, directory: false, filters: OPEN_FILTERS });
    if (paths) await openPaths(paths);
  }

  async function saveActive(as: boolean) {
    const id = workspace.activeDocId();
    if (!id) return;
    const saved = as ? await saveDocAs(id) : await saveDoc(id);
    if (saved) workspace.refreshTab(id);
  }

  // Menu actions are fire-and-forget, so errors are shown here.
  function guarded(action: () => void | Promise<void>) {
    return () => {
      Promise.resolve()
        .then(action)
        .catch((err) => message(String(err), { title: 'Lintel', kind: 'error' }));
    };
  }

  // Later steps fill in the handlers for menu items they enable.
  const notYet = () => {};

  const handlers: MenuHandlers = {
    quit: guarded(() => quitApp(workspace)),
    newDoc: guarded(newUntitled),
    open: guarded(chooseFiles),
    openRecent: (path) => guarded(() => openPaths([path]))(),
    clearRecent: notYet,
    save: guarded(() => saveActive(false)),
    saveAs: guarded(() => saveActive(true)),
    closeTab: guarded(() => closeTabOrWindow(workspace, getCurrentWindow())),
    setMode: notYet,
    toggleOutline: notYet,
    print: notYet,
    exportPdf: notYet,
    exportHtml: notYet,
    exportDocx: notYet,
    openSettings: notYet,
  };

  onMount(() => {
    workspace = new Workspace(host);
    setWorkspace(workspace);
    setActiveDocSource(workspace);
    guarded(() => buildAppMenu(handlers, []))();
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
