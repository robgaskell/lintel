import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message, open } from '@tauri-apps/plugin-dialog';
import { docs, saveDoc, saveDocAs, type DocState } from '../docs/store.svelte';
import { listenTabSwitchKeys, makeMenuHandlers, tabSwitchKey, type MenuHandlerDeps } from './menuHandlers';
import { newUntitled, openPaths } from './open';
import { isMac, type Platform } from './platform';
import { quitApp } from './quit';
import { clearRecent, recentMayHaveChanged } from './recent';
import { closeTabOrWindow } from './window';
import { focusedSettingsWindow, openSettingsWindow } from '../../settings/settingsWindow';
import { printDoc } from '../export/print';
import { exportHtml } from '../export/html';
import { exportDocx } from '../export/docx';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { copyNotices } from '../ipc';
import { settings, updateSettings } from '../settings/settings.svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock('../docs/store.svelte', () => ({ docs: new Map(), saveDoc: vi.fn(), saveDocAs: vi.fn() }));
vi.mock('./open', () => ({ newUntitled: vi.fn(), openPaths: vi.fn() }));
vi.mock('./platform', () => ({ isMac: vi.fn(() => true) }));
vi.mock('./quit', () => ({ quitApp: vi.fn() }));
vi.mock('./recent', () => ({ clearRecent: vi.fn(), recentMayHaveChanged: vi.fn() }));
vi.mock('./window', () => ({ closeTabOrWindow: vi.fn() }));
vi.mock('../export/print', () => ({ printDoc: vi.fn(async () => {}) }));
vi.mock('../export/html', () => ({ exportHtml: vi.fn(async () => {}) }));
vi.mock('../export/docx', () => ({ exportDocx: vi.fn(async () => {}) }));
vi.mock('../ipc', () => ({
  copyNotices: vi.fn(async () => '/Users/me/Library/Caches/com.robgaskell.lintel/THIRD_PARTY_NOTICES.md'),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: vi.fn(async () => {}), openUrl: vi.fn(async () => {}) }));
vi.mock('../settings/settings.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings/settings.svelte')>();
  return { ...actual, updateSettings: vi.fn(async (patch: object) => void Object.assign(actual.settings, patch)) };
});
vi.mock('../../settings/settingsWindow', () => ({
  focusedSettingsWindow: vi.fn(async () => null),
  openSettingsWindow: vi.fn(async () => {}),
}));

const mainWindow = {
  destroy: vi.fn(async () => {}),
  unminimize: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}),
};

function deps(): MenuHandlerDeps {
  return {
    workspace: {
      activeDocId: vi.fn(() => 'doc-1'),
      closeDoc: vi.fn(),
      refreshTab: vi.fn(),
      docIdsInOrder: vi.fn(() => []),
      activate: vi.fn(),
      nextTab: vi.fn(),
      previousTab: vi.fn(),
      split: vi.fn(),
    },
    currentWindow: vi.fn(() => mainWindow),
    outline: { visible: true },
    setOutlineChecked: vi.fn(async () => {}),
    setToolbarChecked: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(focusedSettingsWindow).mockResolvedValue(null);
  docs.clear();
  settings.showToolbar = true;
});

describe('makeMenuHandlers', () => {
  it('quits through quitApp with the workspace', async () => {
    const d = deps();
    makeMenuHandlers(d).quit();
    await vi.waitFor(() => expect(quitApp).toHaveBeenCalledWith(d.workspace));
  });

  it('maps New, Close Tab and Open Recent to their actions', async () => {
    const d = deps();
    const h = makeMenuHandlers(d);

    h.newDoc();
    h.closeTab();
    h.openRecent('/notes/a.md');

    await vi.waitFor(() => {
      expect(newUntitled).toHaveBeenCalledOnce();
      expect(closeTabOrWindow).toHaveBeenCalledWith(d.workspace, expect.anything());
      expect(openPaths).toHaveBeenCalledWith(['/notes/a.md']);
    });
  });

  it('re-reads the recent list after an Open Recent attempt, so a dead entry is pruned', async () => {
    let finishOpen: () => void = () => {};
    vi.mocked(openPaths).mockReturnValueOnce(new Promise<void>((resolve) => (finishOpen = resolve)));
    makeMenuHandlers(deps()).openRecent('/notes/gone.md');

    await vi.waitFor(() => expect(openPaths).toHaveBeenCalledWith(['/notes/gone.md']));
    expect(recentMayHaveChanged).not.toHaveBeenCalled();
    finishOpen();

    await vi.waitFor(() => expect(recentMayHaveChanged).toHaveBeenCalledOnce());
  });

  it('empties the recent list from Clear Menu', async () => {
    makeMenuHandlers(deps()).clearRecent();
    await vi.waitFor(() => expect(clearRecent).toHaveBeenCalledOnce());
    expect(message).not.toHaveBeenCalled();
  });

  it('saves the active doc and refreshes its tab', async () => {
    const d = deps();
    vi.mocked(saveDoc).mockResolvedValue(true);
    vi.mocked(saveDocAs).mockResolvedValue(true);
    const h = makeMenuHandlers(d);

    h.save();
    h.saveAs();

    await vi.waitFor(() => {
      expect(saveDoc).toHaveBeenCalledWith('doc-1');
      expect(saveDocAs).toHaveBeenCalledWith('doc-1');
      expect(d.workspace.refreshTab).toHaveBeenCalledTimes(2);
    });
  });

  it('opens several Markdown files, with no All files filter on macOS', async () => {
    vi.mocked(open).mockResolvedValue(['/a.md', '/b.md']);
    makeMenuHandlers(deps()).open();

    await vi.waitFor(() => expect(openPaths).toHaveBeenCalledWith(['/a.md', '/b.md']));
    expect(open).toHaveBeenCalledWith({
      multiple: true,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
  });

  it('adds an All files filter elsewhere', async () => {
    vi.mocked(isMac).mockReturnValueOnce(false);
    vi.mocked(open).mockResolvedValue(null);
    makeMenuHandlers(deps()).open();

    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(vi.mocked(open).mock.calls[0][0]?.filters).toContainEqual({
      name: 'All files',
      extensions: ['*'],
    });
  });

  it('sets the mode of the active doc only', async () => {
    const active = { id: 'doc-1', mode: 'split' } as DocState;
    const other = { id: 'doc-2', mode: 'split' } as DocState;
    docs.set(active.id, active);
    docs.set(other.id, other);

    makeMenuHandlers(deps()).setMode('read');

    await vi.waitFor(() => expect(active.mode).toBe('read'));
    expect(other.mode).toBe('split');
    expect(message).not.toHaveBeenCalled();
  });

  it('does nothing to modes when no doc is active', async () => {
    const doc = { id: 'doc-1', mode: 'split' } as DocState;
    docs.set(doc.id, doc);
    const d = deps();
    vi.mocked(d.workspace.activeDocId).mockReturnValue(null);

    makeMenuHandlers(d).setMode('edit');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(doc.mode).toBe('split');
    expect(message).not.toHaveBeenCalled();
  });

  it('toggles the outline and ticks the menu item to match (Ruling 110)', async () => {
    const d = deps();
    const h = makeMenuHandlers(d);

    h.toggleOutline();
    await vi.waitFor(() => expect(d.setOutlineChecked).toHaveBeenLastCalledWith(false));
    expect(d.outline.visible).toBe(false);

    h.toggleOutline();
    await vi.waitFor(() => expect(d.setOutlineChecked).toHaveBeenLastCalledWith(true));
    expect(d.outline.visible).toBe(true);
    expect(message).not.toHaveBeenCalled();
  });

  it('flips Settings.showToolbar for every window and ticks Show Toolbar to the saved value', async () => {
    const d = deps();
    const h = makeMenuHandlers(d);

    h.toggleToolbar();
    await vi.waitFor(() => expect(d.setToolbarChecked).toHaveBeenLastCalledWith(false));
    expect(updateSettings).toHaveBeenLastCalledWith({ showToolbar: false });

    h.toggleToolbar();
    await vi.waitFor(() => expect(d.setToolbarChecked).toHaveBeenLastCalledWith(true));
    expect(updateSettings).toHaveBeenLastCalledWith({ showToolbar: true });
    expect(message).not.toHaveBeenCalled();
  });

  it('puts the Show Toolbar tick back and shows why when the change cannot be saved', async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error('Settings could not be loaded'));
    const d = deps();

    makeMenuHandlers(d).toggleToolbar();

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith('Error: Settings could not be loaded', { title: 'Lintel', kind: 'error' }),
    );
    expect(d.setToolbarChecked).toHaveBeenLastCalledWith(true);
    expect(settings.showToolbar).toBe(true);
  });

  it('toggles the toolbar from a focused Settings window too, as the setting is app-wide', async () => {
    vi.mocked(focusedSettingsWindow).mockResolvedValue({} as never);
    const d = deps();

    makeMenuHandlers(d).toggleToolbar();

    await vi.waitFor(() => expect(d.setToolbarChecked).toHaveBeenLastCalledWith(false));
    expect(updateSettings).toHaveBeenCalledWith({ showToolbar: false });
  });

  it('prints the active doc, with the PDF hint for Export as PDF (Ruling 292)', async () => {
    const doc = { id: 'doc-1', mode: 'split' } as DocState;
    docs.set(doc.id, doc);
    const h = makeMenuHandlers(deps());

    h.print();
    h.exportPdf();

    await vi.waitFor(() => expect(printDoc).toHaveBeenCalledTimes(2));
    expect(printDoc).toHaveBeenNthCalledWith(1, doc, { pdfHint: false });
    expect(printDoc).toHaveBeenNthCalledWith(2, doc, { pdfHint: true });
  });

  it('shows a failed print in an error dialog (Ruling 303)', async () => {
    docs.set('doc-1', { id: 'doc-1', mode: 'split' } as DocState);
    vi.mocked(printDoc).mockRejectedValueOnce(new Error('print is not allowed'));

    makeMenuHandlers(deps()).print();

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith('Error: print is not allowed', { title: 'Lintel', kind: 'error' }),
    );
  });

  it('prints nothing with no doc open', async () => {
    const d = deps();
    vi.mocked(d.workspace.activeDocId).mockReturnValue(null);
    const h = makeMenuHandlers(d);

    h.print();
    h.exportPdf();

    await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(printDoc).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it('exports the active doc as HTML, and nothing with no doc open (Ruling 305)', async () => {
    const doc = { id: 'doc-1', mode: 'read' } as DocState;
    docs.set(doc.id, doc);
    const d = deps();
    makeMenuHandlers(d).exportHtml();
    await vi.waitFor(() => expect(exportHtml).toHaveBeenCalledWith(doc));

    vi.mocked(d.workspace.activeDocId).mockReturnValue(null);
    makeMenuHandlers(d).exportHtml();
    await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exportHtml).toHaveBeenCalledTimes(1);
  });

  it('shows a failed HTML export in an error dialog', async () => {
    docs.set('doc-1', { id: 'doc-1', mode: 'read' } as DocState);
    vi.mocked(exportHtml).mockRejectedValueOnce(new Error('This file is read-only.'));

    makeMenuHandlers(deps()).exportHtml();

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith('Error: This file is read-only.', { title: 'Lintel', kind: 'error' }),
    );
  });

  it('exports the active doc as Word, and nothing with no doc open', async () => {
    const doc = { id: 'doc-1', mode: 'read' } as DocState;
    docs.set(doc.id, doc);
    const d = deps();
    makeMenuHandlers(d).exportDocx();
    await vi.waitFor(() => expect(exportDocx).toHaveBeenCalledWith(doc));

    vi.mocked(d.workspace.activeDocId).mockReturnValue(null);
    makeMenuHandlers(d).exportDocx();
    await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exportDocx).toHaveBeenCalledTimes(1);
  });

  it('shows a failed Word export in an error dialog', async () => {
    docs.set('doc-1', { id: 'doc-1', mode: 'read' } as DocState);
    vi.mocked(exportDocx).mockRejectedValueOnce(new Error('This file is read-only.'));

    makeMenuHandlers(deps()).exportDocx();

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith('Error: This file is read-only.', { title: 'Lintel', kind: 'error' }),
    );
  });

  it('opens Settings, at a section when one is given (Rulings 141, 144)', async () => {
    const h = makeMenuHandlers(deps());

    h.openSettings();
    h.openSettings('files');

    await vi.waitFor(() => expect(openSettingsWindow).toHaveBeenCalledTimes(2));
    expect(openSettingsWindow).toHaveBeenNthCalledWith(1, undefined);
    expect(openSettingsWindow).toHaveBeenNthCalledWith(2, 'files');
  });

  it('opens a read-only copy of the notices, never the bundled file (Rulings 328, 332)', async () => {
    makeMenuHandlers(deps()).openNotices();

    await vi.waitFor(() =>
      expect(openPath).toHaveBeenCalledWith('/Users/me/Library/Caches/com.robgaskell.lintel/THIRD_PARTY_NOTICES.md'),
    );
    expect(copyNotices).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledOnce();
  });

  it('opens the repo page in the browser for Lintel on GitHub (spec 13a)', async () => {
    makeMenuHandlers(deps()).openGithub();

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://github.com/robgaskell/lintel'));
    expect(openUrl).toHaveBeenCalledOnce();
  });

  it('shows a failure to open the repo page in a dialog', async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No browser.'));

    makeMenuHandlers(deps()).openGithub();

    await vi.waitFor(() => expect(message).toHaveBeenCalledWith('Error: No browser.', { title: 'Lintel', kind: 'error' }));
  });

  it('opens nothing when the copy cannot be made, and says why', async () => {
    vi.mocked(copyNotices).mockRejectedValueOnce('Could not open the third-party notices: disk full');

    makeMenuHandlers(deps()).openNotices();

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith('Could not open the third-party notices: disk full', {
        title: 'Lintel',
        kind: 'error',
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it('shows a failure to open the notices in a dialog', async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error('No application knows how to open it.'));

    makeMenuHandlers(deps()).openNotices();

    await vi.waitFor(() =>
      expect(message).toHaveBeenCalledWith('Error: No application knows how to open it.', {
        title: 'Lintel',
        kind: 'error',
      }),
    );
  });

  describe('with Settings focused (Ruling 142)', () => {
    const settingsWindow = { destroy: vi.fn(async () => {}) };
    beforeEach(() => {
      vi.mocked(focusedSettingsWindow).mockResolvedValue(settingsWindow as never);
    });

    // The menu bar still belongs to a document window, which runs this.
    it('still opens the repo page for Lintel on GitHub', async () => {
      makeMenuHandlers(deps()).openGithub();

      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://github.com/robgaskell/lintel'));
    });

    it('leaves the main window alone for document commands', async () => {
      const doc = { id: 'doc-1', mode: 'split' } as DocState;
      docs.set(doc.id, doc);
      const d = deps();
      const h = makeMenuHandlers(d);

      for (const command of [h.save, h.saveAs, h.print, h.exportPdf]) command();
      h.setMode('read');

      await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalledTimes(5));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(saveDoc).not.toHaveBeenCalled();
      expect(saveDocAs).not.toHaveBeenCalled();
      expect(printDoc).not.toHaveBeenCalled();
      expect(doc.mode).toBe('split');
      expect(message).not.toHaveBeenCalled();
    });

    it('keeps the outline on Show Outline and puts back the tick the menu flipped (Ruling 157)', async () => {
      const d = deps();
      const h = makeMenuHandlers(d);

      h.toggleOutline();
      await vi.waitFor(() => expect(d.setOutlineChecked).toHaveBeenCalledWith(true));
      expect(d.outline.visible).toBe(true);

      d.outline.visible = false;
      h.toggleOutline();
      await vi.waitFor(() => expect(d.setOutlineChecked).toHaveBeenLastCalledWith(false));
      expect(d.outline.visible).toBe(false);
      expect(message).not.toHaveBeenCalled();
    });

    it('leaves the tabs alone for Show Next and Show Previous Tab', async () => {
      const d = deps();
      const h = makeMenuHandlers(d);

      h.nextTab();
      h.previousTab();

      await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(d.workspace.nextTab).not.toHaveBeenCalled();
      expect(d.workspace.previousTab).not.toHaveBeenCalled();
    });

    it('leaves the tabs alone for Split Right and Split Down', async () => {
      const d = deps();
      const h = makeMenuHandlers(d);

      h.split('right');
      h.split('below');

      await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(d.workspace.split).not.toHaveBeenCalled();
    });

    it('closes Settings on Close Tab, not a tab', async () => {
      makeMenuHandlers(deps()).closeTab();

      await vi.waitFor(() => expect(settingsWindow.destroy).toHaveBeenCalledOnce());
      expect(closeTabOrWindow).not.toHaveBeenCalled();
      expect(mainWindow.destroy).not.toHaveBeenCalled();
    });

    it('unminimises, shows and focuses the main window for New, Open and Open Recent, then acts there (Ruling 156)', async () => {
      const order: string[] = [];
      mainWindow.unminimize.mockImplementation(async () => void order.push('unminimize'));
      mainWindow.show.mockImplementation(async () => void order.push('show'));
      mainWindow.setFocus.mockImplementation(async () => void order.push('focus'));
      vi.mocked(newUntitled).mockImplementation(() => void order.push('new') as never);
      vi.mocked(open).mockResolvedValue(null);
      const h = makeMenuHandlers(deps());

      h.newDoc();
      await vi.waitFor(() => expect(order).toEqual(['unminimize', 'show', 'focus', 'new']));
      h.open();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      h.openRecent('/notes/a.md');
      await vi.waitFor(() => expect(openPaths).toHaveBeenCalledWith(['/notes/a.md']));

      expect(mainWindow.unminimize).toHaveBeenCalledTimes(3);
      expect(mainWindow.show).toHaveBeenCalledTimes(3);
      expect(mainWindow.setFocus).toHaveBeenCalledTimes(3);
    });
  });

  it('shows the next and previous tab of the workspace', async () => {
    const d = deps();
    const h = makeMenuHandlers(d);

    h.nextTab();
    await vi.waitFor(() => expect(d.workspace.nextTab).toHaveBeenCalledOnce());
    h.previousTab();
    await vi.waitFor(() => expect(d.workspace.previousTab).toHaveBeenCalledOnce());
  });

  it('splits the active tab right or below (Ruling 180)', async () => {
    const d = deps();
    const h = makeMenuHandlers(d);

    h.split('right');
    await vi.waitFor(() => expect(d.workspace.split).toHaveBeenLastCalledWith('doc-1', 'right'));
    h.split('below');
    await vi.waitFor(() => expect(d.workspace.split).toHaveBeenLastCalledWith('doc-1', 'below'));
  });

  it('splits nothing when no tab is open', async () => {
    const d = deps();
    vi.mocked(d.workspace.activeDocId).mockReturnValue(null);

    makeMenuHandlers(d).split('right');

    await vi.waitFor(() => expect(focusedSettingsWindow).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.workspace.split).not.toHaveBeenCalled();
  });

  it('shows an error from a handler in a dialog', async () => {
    vi.mocked(quitApp).mockRejectedValue(new Error('ipc down'));
    makeMenuHandlers(deps()).quit();
    await vi.waitFor(() =>
      expect(String(vi.mocked(message).mock.calls[0]?.[0])).toContain('ipc down'),
    );
  });
});

describe('tab switching keys (Ruling 167)', () => {
  const key = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });

  it('reads Ctrl+Tab and Ctrl+Shift+Tab on macOS', () => {
    expect(tabSwitchKey(key('Tab', { ctrlKey: true }), 'macos')).toBe('next');
    expect(tabSwitchKey(key('Tab', { ctrlKey: true, shiftKey: true }), 'macos')).toBe('previous');
    expect(tabSwitchKey(key('Tab'), 'macos')).toBeNull();
    expect(tabSwitchKey(key('Tab', { ctrlKey: true, metaKey: true }), 'macos')).toBeNull();
    expect(tabSwitchKey(key('PageDown', { ctrlKey: true }), 'macos')).toBeNull();
  });

  it.each(['windows', 'linux'] as const)('reads Ctrl+PageDown and Ctrl+PageUp on %s', (platform) => {
    expect(tabSwitchKey(key('PageDown', { ctrlKey: true }), platform)).toBe('next');
    expect(tabSwitchKey(key('PageUp', { ctrlKey: true }), platform)).toBe('previous');
    expect(tabSwitchKey(key('PageDown'), platform)).toBeNull();
    expect(tabSwitchKey(key('PageDown', { ctrlKey: true, shiftKey: true }), platform)).toBeNull();
    // Ctrl+Tab is the Window menu's own accelerator here.
    expect(tabSwitchKey(key('Tab', { ctrlKey: true }), platform)).toBeNull();
  });

  it("leaves each Window menu chord to the menu, so one press switches once (Ruling 174)", async () => {
    const menuChords = {
      macos: [
        key('}', { code: 'BracketRight', metaKey: true, shiftKey: true }),
        key('{', { code: 'BracketLeft', metaKey: true, shiftKey: true }),
        key(']', { code: 'BracketRight', metaKey: true, shiftKey: true }),
      ],
      windows: [key('Tab', { ctrlKey: true }), key('Tab', { ctrlKey: true, shiftKey: true })],
      linux: [key('Tab', { ctrlKey: true }), key('Tab', { ctrlKey: true, shiftKey: true })],
    };
    for (const [platform, chords] of Object.entries(menuChords)) {
      for (const chord of chords) expect(tabSwitchKey(chord, platform as Platform), `${platform} ${chord.key}`).toBeNull();
    }

    const d = deps();
    const stop = listenTabSwitchKeys(makeMenuHandlers(d), 'macos');
    document.body.dispatchEvent(key('Tab', { ctrlKey: true }));
    stop();
    await vi.waitFor(() => expect(d.workspace.nextTab).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.workspace.nextTab).toHaveBeenCalledOnce();
  });

  it('runs the handler before the editor sees the key, until stopped', () => {
    const h = { nextTab: vi.fn(), previousTab: vi.fn() };
    const editor = document.createElement('div');
    const editorSaw = vi.fn();
    editor.addEventListener('keydown', editorSaw);
    document.body.append(editor);
    const stop = listenTabSwitchKeys(h, 'macos');

    const next = key('Tab', { ctrlKey: true });
    editor.dispatchEvent(next);
    editor.dispatchEvent(key('Tab', { ctrlKey: true, shiftKey: true }));
    editor.dispatchEvent(key('a'));

    expect(h.nextTab).toHaveBeenCalledOnce();
    expect(h.previousTab).toHaveBeenCalledOnce();
    expect(next.defaultPrevented).toBe(true);
    expect(editorSaw).toHaveBeenCalledOnce();

    stop();
    editor.dispatchEvent(key('Tab', { ctrlKey: true }));
    expect(h.nextTab).toHaveBeenCalledOnce();
    editor.remove();
  });
});
