import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { EditorView } from '@codemirror/view';
import { message } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, untitledCounter, type DocState } from '../docs/store.svelte';
import { Workspace } from './workspace';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
}));

const messageDialog = vi.mocked(message);
let host: HTMLElement;
let ws: Workspace;

function fileDoc(name: string): DocState {
  return createDoc({ path: `/notes/${name}`, raw: `# ${name}\n`, hash: 'h', mode: 'split' });
}

function tabFor(id: string): HTMLElement {
  const tab = host.querySelector<HTMLElement>(`.lintel-tab[data-doc-id="${id}"]`);
  if (!tab) throw new Error(`no tab for ${id}`);
  return tab;
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  messageDialog.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  ws = new Workspace(host);
});

afterEach(() => {
  ws.dispose();
  host.remove();
});

describe('Workspace', () => {
  it('shows each doc in a panel with its own tab and editor', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');

    ws.openDoc(a);
    ws.openDoc(b);
    flushSync();

    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);
    expect(tabFor(a.id).textContent).toContain('a.md');
    expect(tabFor(b.id).textContent).toContain('b.md');
    expect(host.querySelectorAll('.cm-editor').length).toBeGreaterThan(0);
  });

  it('makes the newest doc active and lets activate switch back', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    expect(ws.activeDocId()).toBe(b.id);

    ws.activate(a.id);

    expect(ws.activeDocId()).toBe(a.id);
  });

  it('reports active changes until unlistened', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    const seen: (string | null)[] = [];
    const stop = ws.onActiveChange((id) => seen.push(id));

    ws.openDoc(a);
    ws.openDoc(b);
    ws.activate(a.id);
    stop();
    ws.activate(b.id);

    expect(seen).toEqual([a.id, b.id, a.id]);
  });

  it('places docs beside or below a reference doc and lists them in visual order', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    const c = fileDoc('c.md');

    ws.openDoc(a);
    ws.openDoc(b, { referenceId: a.id, direction: 'right' });
    ws.openDoc(c, { referenceId: a.id, direction: 'below' });

    expect(ws.docIdsInOrder()).toEqual([a.id, c.id, b.id]);
  });

  it('shows a dot on the tab of a dirty doc', () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    flushSync();
    expect(tabFor(a.id).querySelector('.dirty')).toBeNull();

    a.text = 'changed';
    flushSync();

    expect(tabFor(a.id).querySelector('.dirty')).not.toBeNull();
  });

  it('keeps a dirty doc open when the close prompt is cancelled', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    a.text = 'changed';
    messageDialog.mockResolvedValue('Cancel');

    expect(await ws.closeDoc(a.id)).toBe(false);
    expect(ws.docIdsInOrder()).toEqual([a.id]);
    expect(docs.has(a.id)).toBe(true);
  });

  it('removes the panel and the doc once the close is confirmed', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    b.text = 'changed';
    messageDialog.mockResolvedValue("Don't Save");

    expect(await ws.closeDoc(b.id)).toBe(true);
    expect(ws.docIdsInOrder()).toEqual([a.id]);
    expect(docs.has(b.id)).toBe(false);
    expect(ws.activeDocId()).toBe(a.id);
  });

  it('reports no active doc after the last one closes', async () => {
    const a = fileDoc('a.md');
    const seen: (string | null)[] = [];
    ws.onActiveChange((id) => seen.push(id));
    ws.openDoc(a);

    await ws.closeDoc(a.id);

    expect(ws.activeDocId()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it('closes a tab from its close button', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    flushSync();

    tabFor(a.id).querySelector<HTMLButtonElement>('button.close')!.click();
    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([]));
    expect(docs.has(a.id)).toBe(false);
  });

  it('shows a pin and no close button on a pinned tab', () => {
    const a = fileDoc('a.md');
    a.pinned = true;
    ws.openDoc(a);
    flushSync();

    expect(tabFor(a.id).querySelector('.pin')).not.toBeNull();
    expect(tabFor(a.id).querySelector('button.close')).toBeNull();
  });

  it('stores only the doc id in the layout, never the text', () => {
    const a = fileDoc('a.md');
    a.text = 'secret buffer text';
    ws.openDoc(a);

    const json = JSON.stringify(ws.toJSON());

    expect(json).toContain(a.id);
    expect(json).not.toContain('secret buffer text');
  });

  it('restores a layout from toJSON', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b, { referenceId: a.id, direction: 'right' });
    ws.activate(a.id);
    const layout = ws.toJSON();
    ws.dispose();
    host.replaceChildren();

    ws = new Workspace(host);
    ws.fromJSON(layout);
    flushSync();

    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);
    expect(ws.activeDocId()).toBe(a.id);
    expect(tabFor(b.id).textContent).toContain('b.md');
  });

  it('activates a doc that is already open instead of adding a second panel', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);

    ws.openDoc(a);

    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);
    expect(ws.activeDocId()).toBe(a.id);
  });

  it('drops panels whose doc is no longer open when restoring a layout', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    const layout = ws.toJSON();
    docs.delete(b.id);

    ws.fromJSON(layout);

    expect(ws.docIdsInOrder()).toEqual([a.id]);
  });

  it('refreshTab updates the stored title after a rename', () => {
    const a = createDoc({ path: null, raw: '', hash: '', mode: 'split' });
    ws.openDoc(a);
    a.title = 'saved.md';

    ws.refreshTab(a.id);

    expect(JSON.stringify(ws.toJSON())).toContain('saved.md');
  });

  it('gives the editor keyboard focus when a doc opens and when its tab activates', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b, { referenceId: a.id, direction: 'right' });
    const editorOf = (id: string) =>
      host.querySelector(`[data-doc-pane="${id}"] .cm-content`) as HTMLElement;

    await vi.waitFor(() => expect(document.activeElement).toBe(editorOf(b.id)));

    ws.activate(a.id);
    await vi.waitFor(() => expect(document.activeElement).toBe(editorOf(a.id)));
  });

  it.each(['Backspace', 'Delete'])('asks before %s on a focused tab closes a dirty doc', async (key) => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    flushSync();
    a.text = 'changed';
    messageDialog.mockResolvedValue('Cancel');
    const tab = tabFor(a.id).closest<HTMLElement>('.dv-tab')!;
    tab.focus();

    tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(ws.docIdsInOrder()).toEqual([a.id]);
    expect(docs.has(a.id)).toBe(true);
  });

  it('closes a clean doc on Backspace on its tab, through the same path', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    flushSync();
    const tab = tabFor(a.id).closest<HTMLElement>('.dv-tab')!;

    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([]));
    expect(docs.has(a.id)).toBe(false);
  });

  it('destroys the editor when its doc closes', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    flushSync();
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');

    await ws.closeDoc(a.id);

    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
  });

  it('shares one prompt when the same doc is closed twice at once', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    a.text = 'changed';
    let answer: (label: string) => void = () => {};
    messageDialog.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    const first = ws.closeDoc(a.id);
    const second = ws.closeDoc(a.id);
    await vi.waitFor(() => expect(messageDialog).toHaveBeenCalled());
    answer("Don't Save");

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(messageDialog).toHaveBeenCalledTimes(1);
  });

  it('focuses the editor when the already-active doc is activated again', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    const editor = () => host.querySelector(`[data-doc-pane="${a.id}"] .cm-content`) as HTMLElement;
    await vi.waitFor(() => expect(document.activeElement).toBe(editor()));
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    ws.activate(a.id);

    await vi.waitFor(() => expect(document.activeElement).toBe(editor()));
    elsewhere.remove();
  });
});
