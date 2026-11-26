import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message, open } from '@tauri-apps/plugin-dialog';
import { saveDoc, saveDocAs } from '../docs/store.svelte';
import { makeMenuHandlers, type MenuHandlerDeps } from './menuHandlers';
import { newUntitled, openPaths } from './open';
import { isMac } from './platform';
import { quitApp } from './quit';
import { clearRecent } from './recent';
import { closeTabOrWindow } from './window';

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock('../docs/store.svelte', () => ({ saveDoc: vi.fn(), saveDocAs: vi.fn() }));
vi.mock('./open', () => ({ newUntitled: vi.fn(), openPaths: vi.fn() }));
vi.mock('./platform', () => ({ isMac: vi.fn(() => true) }));
vi.mock('./quit', () => ({ quitApp: vi.fn() }));
vi.mock('./recent', () => ({ clearRecent: vi.fn() }));
vi.mock('./window', () => ({ closeTabOrWindow: vi.fn() }));

function deps(): MenuHandlerDeps {
  return {
    workspace: {
      activeDocId: vi.fn(() => 'doc-1'),
      closeDoc: vi.fn(),
      refreshTab: vi.fn(),
      docIdsInOrder: vi.fn(() => []),
      activate: vi.fn(),
    },
    currentWindow: vi.fn(() => ({ destroy: vi.fn(async () => {}) })),
  };
}

beforeEach(() => vi.clearAllMocks());

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

  it('says so when an item without a handler yet is chosen', async () => {
    makeMenuHandlers(deps()).print();
    await vi.waitFor(() =>
      expect(String(vi.mocked(message).mock.calls[0]?.[0])).toContain('Not implemented yet'),
    );
  });

  it('shows an error from a handler in a dialog', async () => {
    vi.mocked(quitApp).mockRejectedValue(new Error('ipc down'));
    makeMenuHandlers(deps()).quit();
    await vi.waitFor(() =>
      expect(String(vi.mocked(message).mock.calls[0]?.[0])).toContain('ipc down'),
    );
  });
});
