<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { message } from '@tauri-apps/plugin-dialog';
  import { cursors } from './lib/docs/cursor.svelte';
  import { countWords, saveStateOf } from './lib/docs/stats';
  import { docs } from './lib/docs/store.svelte';
  import { followEditorFont, setActiveDocSource } from './lib/editor/views';
  import { outline } from './lib/layout/outline.svelte';
  import { Workspace } from './lib/layout/workspace';
  import {
    setOutlineChecked,
    setSplitEnabled,
    syncAppMenu,
    takeAppMenu,
    type MenuHandlers,
  } from './lib/os/menu';
  import { listenTabSwitchKeys, makeMenuHandlers } from './lib/os/menuHandlers';
  import { listenForDrops, listenForOpenFiles, setWorkspace } from './lib/os/open';
  import { currentPlatform } from './lib/os/platform';
  import { listenForQuitRequests } from './lib/os/quit';
  import { getRecent, knownRecent, onRecentChanged } from './lib/os/recent';
  import {
    listenForForgets,
    missingNotice,
    restoreAllWindows,
    restoreWindow,
    scheduleWindowSave,
  } from './lib/os/session';
  import { handleCloseRequested } from './lib/os/window';
  import { listenForAdoption, listenForReveal } from './lib/os/windows';
  import { renderDelayMs } from './lib/render/scrollSync';
  import { loadSettings, settings } from './lib/settings/settings.svelte';
  import { followTheme } from './lib/theme/theme';
  import EmptyState from './lib/ui/EmptyState.svelte';
  import StatusBar from './lib/ui/StatusBar.svelte';

  const RECENT_SHOWN = 5;
  const NOTICE_MS = 10_000;
  const label = getCurrentWindow().label;

  let host: HTMLElement;
  let handlers = $state<MenuHandlers | null>(null);
  let activeId = $state<string | null>(null);
  const active = $derived(activeId === null ? undefined : docs.get(activeId));
  const cursor = $derived(activeId === null ? undefined : cursors.get(activeId));

  // Counted at once on a tab switch, then debounced like the preview (Ruling 109).
  let words = $state(0);
  let countedId: string | null = null;
  $effect(() => {
    if (!active) return;
    const { id, text } = active;
    if (id !== countedId) {
      countedId = id;
      words = countWords(text);
      return;
    }
    const delay = renderDelayMs(new TextEncoder().encode(text).length);
    const timer = setTimeout(() => (words = countWords(text)), delay);
    return () => clearTimeout(timer);
  });

  // Pin, mode and outline changes fire no layout event, so they are watched here (Ruling 209).
  $effect(() => {
    for (const doc of docs.values()) void [doc.pinned, doc.mode];
    void outline.visible;
    untrack(() => scheduleWindowSave(label));
  });

  // Until the next key or click, or 10 s (Ruling 212).
  let notice = $state<string | null>(null);
  function showNotice(text: string) {
    notice = text;
    const clear = () => {
      notice = null;
      clearTimeout(timer);
      window.removeEventListener('keydown', clear, true);
      window.removeEventListener('pointerdown', clear, true);
    };
    const timer = setTimeout(clear, NOTICE_MS);
    window.addEventListener('keydown', clear, true);
    window.addEventListener('pointerdown', clear, true);
  }

  // Open Recent's first entries for the empty window; the stored list first, then the checked one.
  let recent = $state<string[]>([]);
  let recentRequest = 0;
  function loadRecent() {
    const request = ++recentRequest;
    const limit = Math.min(settings.recentLimit, RECENT_SHOWN);
    const show = (paths: string[]) => {
      if (request === recentRequest) recent = paths;
    };
    void knownRecent(limit)
      .then(show)
      .then(() => getRecent(limit))
      .then(show)
      .catch((err) => console.error('Could not read the Open Recent list:', err));
  }
  $effect(() => {
    if (docs.size === 0) loadRecent();
  });

  onMount(() => {
    const workspace = new Workspace(host);
    setWorkspace(workspace);
    setActiveDocSource(workspace);
    const stopReveal = listenForReveal(workspace);
    // Last of the two: it tells the window that opened this one that it can hand a doc over.
    const stopAdoption = listenForAdoption();
    const stopDrops = listenForDrops();
    // onActiveChange makes no first call, so read the current value too (Ruling 111).
    activeId = workspace.activeDocId();
    const stopActive = workspace.onActiveChange((id) => (activeId = id));
    // View > Split Right and Split Down grey out for a lone tab, as in the tab menu (Ruling 192).
    const syncSplit = () => {
      const id = workspace.activeDocId();
      setSplitEnabled(id !== null && !workspace.isAloneInGroup(id)).catch((err) =>
        console.error('Could not update View > Split:', err),
      );
    };
    syncSplit();
    const stopLayout = workspace.onLayoutChange(() => {
      syncSplit();
      scheduleWindowSave(label);
    });
    const stopQuit = listenForQuitRequests();
    const stopForgets = listenForForgets(label);
    const stopRecent = onRecentChanged(() => {
      if (docs.size === 0) loadRecent();
    });
    handlers = makeMenuHandlers({
      workspace,
      currentWindow: getCurrentWindow,
      outline,
      setOutlineChecked,
    });
    const menuHandlers = handlers;
    const stopTabKeys = listenTabSwitchKeys(menuHandlers, currentPlatform());
    const showError = (err: unknown) => message(String(err), { title: 'Lintel', kind: 'error' });
    let disposed = false;
    let stopMenu = () => {};
    let stopTheme = () => {};
    let stopEditorFont = () => {};
    // Settings decide whether Open Recent shows; a failed load keeps the defaults. Until they
    // load, the theme is the one main.ts restored, so a forced theme never flashes (Ruling 150).
    loadSettings()
      .catch(showError)
      .then(() => {
        if (disposed) return;
        stopTheme = followTheme(() => settings);
        stopEditorFont = followEditorFont();
        stopMenu = syncAppMenu(menuHandlers, showError);
        // After the settings, which the restored docs' previews read.
        void restoreSession();
      });
    // After this window's restore, so a file it restores is not opened twice; before main
    // reopens the other windows, so main takes the files given at launch.
    let takingFiles = false;
    function takeOpenedFiles() {
      if (disposed || takingFiles) return;
      takingFiles = true;
      listenForOpenFiles();
    }
    async function restoreSession() {
      try {
        const { missing } = await restoreWindow(label);
        if (disposed) return;
        takeOpenedFiles();
        if (missing.length > 0) showNotice(missingNotice(missing.length));
        // The tick follows the focused window; this one may have taken focus before its
        // restore set the outline (Ruling 235).
        if (await getCurrentWindow().isFocused()) await setOutlineChecked(outline.visible);
        if (label === 'main') await restoreAllWindows();
      } catch (err) {
        console.error('Could not restore the last session:', err);
      } finally {
        takeOpenedFiles();
      }
    }
    const unlistenClose = getCurrentWindow().onCloseRequested((event) =>
      handleCloseRequested(event, workspace),
    );
    // The menu bar is shared: the focused window builds it, and its tick shows that
    // window's outline (Rulings 110, 188).
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      takeAppMenu();
      setOutlineChecked(outline.visible).catch((err) =>
        console.error('Could not tick View > Show Outline:', err),
      );
      syncSplit();
    });
    return () => {
      disposed = true;
      stopTabKeys();
      stopMenu();
      stopTheme();
      stopEditorFont();
      stopActive();
      stopLayout();
      stopQuit();
      stopForgets();
      stopRecent();
      stopReveal();
      stopAdoption();
      stopDrops();
      unlistenClose.then((stop) => stop());
      unlistenFocus.then((stop) => stop());
      setActiveDocSource(null);
      workspace.dispose();
    };
  });
</script>

<div class="app">
  <div class="work">
    <main class="dock" bind:this={host}></main>
    {#if docs.size === 0 && handlers}
      <EmptyState
        {recent}
        onOpen={handlers.open}
        onNew={handlers.newDoc}
        onOpenRecent={handlers.openRecent}
      />
    {/if}
  </div>
  {#if active}
    <StatusBar
      line={cursor?.line ?? 1}
      col={cursor?.col ?? 1}
      {words}
      saveState={saveStateOf(active)}
      lintCount={null}
      lintFixable={false}
      {notice}
      update="none"
      reading={active.mode === 'read'}
    />
  {:else if notice}
    <!-- With nothing restored there is no status bar, but the notice still shows (Ruling 235). -->
    <footer class="notice-bar"><span role="status">{notice}</span></footer>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .work {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .dock {
    height: 100%;
  }

  .notice-bar {
    display: flex;
    flex: 0 0 28px;
    align-items: center;
    justify-content: flex-end;
    box-sizing: border-box;
    padding: 0 12px;
    background: var(--chrome);
    border-top: 1px solid var(--border);
    color: var(--muted-strong);
    font-size: 12px;
  }

  /* Dockview's theme classes force a color-scheme; take the resolved theme instead. */
  :global(:is(.dockview-theme-light, .dockview-theme-dark).lintel-dock) {
    color-scheme: inherit;
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
    /* The divider shows the accent while hovered or dragged; drop targets are tinted with it. */
    --dv-active-sash-color: var(--accent);
    --dv-drag-over-background-color: color-mix(in srgb, var(--accent) 16%, transparent);
    --dv-drag-over-border: 1px solid var(--accent);
    --dv-drag-over-border-color: var(--accent);
  }

  :global(.lintel-dock .dv-tabs-and-actions-container) {
    border-bottom: 1px solid var(--border);
  }

  :global(.lintel-dock .dv-tabs-container) {
    color-scheme: var(--scheme);
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
