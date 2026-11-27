import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { EditorView } from '@codemirror/view';
import { message } from '@tauri-apps/plugin-dialog';
import { createDoc, docs, untitledCounter, type DocState } from '../docs/store.svelte';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings.svelte';
import { fakePreviewLayout } from '../../test/layout';
import { applyTheme } from '../theme/theme';
import { outline } from './outline.svelte';
import type { DockviewApi } from 'dockview-core';
import { Workspace } from './workspace';

vi.mock('../ipc', () => ({
  normalizePath: vi.fn(async (path: string) => path),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  transferPath: vi.fn(async () => {}),
  // applyTheme sets the window appearance too (Ruling 195).
  setWindowAppearance: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ setBackgroundColor: async () => {} }),
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

// A real pointer press: pointerdown then pointerup on the same element.
function press(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function tabFor(id: string): HTMLElement {
  const tab = host.querySelector<HTMLElement>(`.lintel-tab[data-doc-id="${id}"]`);
  if (!tab) throw new Error(`no tab for ${id}`);
  return tab;
}

beforeEach(() => {
  docs.clear();
  untitledCounter.n = 0;
  outline.visible = true;
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

    press(tabFor(a.id).querySelector('.close')!);
    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([]));
    expect(docs.has(a.id)).toBe(false);
  });

  it('shows a pin and no close button on a pinned tab', () => {
    const a = fileDoc('a.md');
    a.pinned = true;
    ws.openDoc(a);
    flushSync();

    expect(tabFor(a.id).querySelector('.pin')).not.toBeNull();
    expect(tabFor(a.id).querySelector('.close')).toBeNull();
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

  it.each(['Backspace', 'Delete'])('does nothing on %s on a pinned tab (Rulings 48, 165)', async (key) => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    ws.setPinned(a.id, true);
    flushSync();
    const tab = tabFor(a.id).closest<HTMLElement>('.dv-tab')!;
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    tab.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.defaultPrevented).toBe(true);
    expect(ws.docIdsInOrder()).toEqual([a.id]);
    expect(docs.has(a.id)).toBe(true);
  });

  it('selects a tab when its body is clicked, and never closes it (Rulings 135, 168)', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    flushSync();

    tabFor(a.id).querySelector<HTMLElement>('.name')!.click();
    expect(ws.activeDocId()).toBe(a.id);
    tabFor(b.id).closest<HTMLElement>('.dv-tab')!.click();
    expect(ws.activeDocId()).toBe(b.id);

    const tab = tabFor(b.id).closest<HTMLElement>('.dv-tab')!;
    for (const key of ['Enter', ' ']) {
      tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);
    expect(docs.size).toBe(2);
  });

  it('gives a tab no pressable or focusable control inside it (Ruling 171)', () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    b.text = 'unsaved';
    flushSync();

    for (const doc of [a, b]) {
      const tab = tabFor(doc.id).closest('.dv-tab')!;
      const controls = tab.querySelectorAll('button, input, select, textarea, a[href], [tabindex], [role=button]');
      expect(controls.length, doc.title).toBe(0);
      expect(tab.querySelector('.close')?.getAttribute('aria-hidden'), doc.title).toBe('true');
    }
  });

  it('selects, never closes, on a click with no pointer press, even on the close mark (Ruling 171)', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    flushSync();

    // An accessibility press sends a click with no pointerdown or pointerup.
    tabFor(a.id).querySelector<HTMLElement>('.close')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);
    expect(ws.activeDocId()).toBe(a.id);
  });

  it('closes only when the pointer goes down and up on the close mark', async () => {
    const a = fileDoc('a.md');
    const b = fileDoc('b.md');
    ws.openDoc(a);
    ws.openDoc(b);
    flushSync();
    const close = tabFor(a.id).querySelector('.close')!;

    // Down on the mark, then dragged away before release.
    close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    close.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    close.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    // Down elsewhere, released over the mark.
    tabFor(b.id).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    close.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);

    press(close);
    await vi.waitFor(() => expect(ws.docIdsInOrder()).toEqual([b.id]));
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

describe('Workspace theme (Ruling 152)', () => {
  it("switches dockview's theme class with the resolved theme", () => {
    const themed = () => host.querySelector('.lintel-dock')!;
    expect(themed().classList.contains('dockview-theme-light')).toBe(true);

    applyTheme({ ...structuredClone(DEFAULT_SETTINGS), theme: 'dark' } as Settings);
    expect(themed().classList.contains('dockview-theme-dark')).toBe(true);
    expect(themed().classList.contains('dockview-theme-light')).toBe(false);

    applyTheme({ ...structuredClone(DEFAULT_SETTINGS), theme: 'light' } as Settings);
    expect(themed().classList.contains('dockview-theme-light')).toBe(true);
  });
});

describe('Workspace pinning (Ruling 165)', () => {
  it('moves a pinned tab left of the unpinned ones, after tabs pinned before it', () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    for (const doc of [a, b, c]) ws.openDoc(doc);

    ws.setPinned(b.id, true);
    expect(ws.docIdsInOrder()).toEqual([b.id, a.id, c.id]);
    ws.setPinned(c.id, true);
    expect(ws.docIdsInOrder()).toEqual([b.id, c.id, a.id]);
    expect(c.pinned).toBe(true);
  });

  it('moves an unpinned tab right of the tabs still pinned', () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    for (const doc of [a, b, c]) ws.openDoc(doc);
    ws.setPinned(b.id, true);
    ws.setPinned(c.id, true);

    ws.setPinned(b.id, false);

    expect(ws.docIdsInOrder()).toEqual([c.id, b.id, a.id]);
    expect(b.pinned).toBe(false);
  });

  it('keeps the active tab active while sorting', () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    for (const doc of [a, b, c]) ws.openDoc(doc);
    ws.activate(a.id);

    ws.setPinned(c.id, true);

    expect(ws.activeDocId()).toBe(a.id);
  });

  it('shows the pin and drops the close button once pinned', () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);

    ws.setPinned(a.id, true);
    flushSync();

    expect(tabFor(a.id).querySelector('.pin')).not.toBeNull();
    expect(tabFor(a.id).querySelector('.close')).toBeNull();
  });

  it("keeps each group's shown tab when pinning in another group (Ruling 175)", () => {
    const [a1, a2, b1, b2, b3] = ['a1.md', 'a2.md', 'b1.md', 'b2.md', 'b3.md'].map(fileDoc);
    ws.openDoc(a1);
    ws.openDoc(a2);
    ws.openDoc(b1, { referenceId: a1.id, direction: 'right' });
    ws.openDoc(b2, { referenceId: b1.id });
    ws.openDoc(b3, { referenceId: b1.id });
    ws.activate(a1.id);
    const api = (ws as unknown as { api: DockviewApi }).api;
    const shownInB = () => api.getPanel(b1.id)!.group.activePanel?.id;
    expect(shownInB()).toBe(b3.id);

    ws.setPinned(b2.id, true);
    expect([ws.activeDocId(), shownInB()]).toEqual([a1.id, b3.id]);
    ws.setPinned(b3.id, true);
    expect([ws.activeDocId(), shownInB()]).toEqual([a1.id, b3.id]);
    expect(ws.docIdsInOrder()).toEqual([a1.id, a2.id, b2.id, b3.id, b1.id]);
  });

  it('never moves a tab from inside its own move event (Ruling 175)', () => {
    const [p1, p2, a] = ['p1.md', 'p2.md', 'a.md'].map(fileDoc);
    for (const doc of [p1, p2, a]) ws.openDoc(doc);
    ws.setPinned(p1.id, true);
    ws.setPinned(p2.id, true);
    const api = (ws as unknown as { api: DockviewApi }).api;
    const proto = Object.getPrototypeOf(api.getPanel(a.id)!.api) as { moveTo: (o: unknown) => void };
    const moveTo = proto.moveTo;
    let depth = 0;
    let deepest = 0;
    proto.moveTo = function (this: unknown, options: unknown) {
      deepest = Math.max(deepest, ++depth);
      try {
        moveTo.call(this, options);
      } finally {
        depth--;
      }
    };
    try {
      // Dropping the unpinned tab first needs two moves to put the pinned ones back in front.
      api.getPanel(a.id)!.api.moveTo({ index: 0 });
    } finally {
      proto.moveTo = moveTo;
    }

    expect(ws.docIdsInOrder()).toEqual([p1.id, p2.id, a.id]);
    expect(deepest).toBe(2);
  });

  it('puts pinned tabs first again after an unpinned tab is moved in front of them', () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    for (const doc of [a, b, c]) ws.openDoc(doc);
    ws.setPinned(a.id, true);

    (ws as unknown as { api: DockviewApi }).api.getPanel(c.id)!.api.moveTo({ index: 0 });

    expect(ws.docIdsInOrder()).toEqual([a.id, c.id, b.id]);
  });
});

describe('Workspace tab switching (Ruling 167)', () => {
  it('steps through the active group in visible order, pinned first, and wraps', () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    for (const doc of [a, b, c]) ws.openDoc(doc);
    ws.setPinned(c.id, true);
    ws.activate(c.id);

    const seen: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      ws.nextTab();
      seen.push(ws.activeDocId());
    }
    expect(seen).toEqual([a.id, b.id, c.id]);

    seen.length = 0;
    for (let i = 0; i < 3; i++) {
      ws.previousTab();
      seen.push(ws.activeDocId());
    }
    expect(seen).toEqual([b.id, a.id, c.id]);
  });

  it('stays within the active group', () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);
    ws.openDoc(c, { referenceId: a.id, direction: 'right' });
    ws.activate(b.id);

    ws.nextTab();
    expect(ws.activeDocId()).toBe(a.id);
    ws.previousTab();
    expect(ws.activeDocId()).toBe(b.id);
  });

  it('leaves focus alone with one tab', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    await vi.waitFor(() => expect(document.activeElement?.closest('.cm-editor')).not.toBeNull());
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    ws.nextTab();
    ws.previousTab();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('does nothing with one tab or none', () => {
    ws.nextTab();
    expect(ws.activeDocId()).toBeNull();

    const a = fileDoc('a.md');
    ws.openDoc(a);
    const seen: (string | null)[] = [];
    ws.onActiveChange((id) => seen.push(id));
    seen.length = 0; // dockview replays the current panel on subscribe

    ws.nextTab();
    ws.previousTab();

    expect(ws.activeDocId()).toBe(a.id);
    expect(seen).toEqual([]);
  });
});

describe('Workspace split (Ruling 178)', () => {
  type Node = { type: 'leaf'; data: { views: string[] } } | { type: 'branch'; data: Node[] };
  type Shape = string[] | Shape[];
  // Branches alternate direction under a HORIZONTAL root: a row of columns of rows.
  const shapeOf = (node: Node): Shape =>
    node.type === 'leaf' ? node.data.views : (node.data.map(shapeOf) as Shape);
  const grid = () => (ws.toJSON() as { grid: { root: Node; orientation: string } }).grid;
  const editorOf = (id: string) => host.querySelector(`[data-doc-pane="${id}"] .cm-editor`);

  it("moves a tab into a new group on the right, leaving the rest in the first", () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);

    ws.split(a.id, 'right');

    expect(ws.groupCount()).toBe(2);
    expect(grid().orientation).toBe('HORIZONTAL');
    expect(shapeOf(grid().root)).toEqual([[b.id], [a.id]]);
    expect(ws.isAloneInGroup(a.id)).toBe(true);
    expect(ws.isAloneInGroup(b.id)).toBe(true);
    expect(ws.activeDocId()).toBe(a.id);
  });

  it('moves a tab into a new group below', () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);

    ws.split(b.id, 'below');

    expect(ws.groupCount()).toBe(2);
    expect(grid().orientation).toBe('HORIZONTAL');
    expect(shapeOf(grid().root)).toEqual([[[a.id], [b.id]]]);
  });

  it('never makes a second panel for the same doc, and keeps its editor', () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(b);
    ws.openDoc(a);
    flushSync();
    const editor = editorOf(a.id);
    EditorView.findFromDOM(editor as HTMLElement)!.dispatch({ changes: { from: 0, insert: 'kept ' } });

    ws.split(a.id, 'right');
    flushSync();

    expect(host.querySelectorAll(`.lintel-tab[data-doc-id="${a.id}"]`)).toHaveLength(1);
    expect(host.querySelectorAll(`[data-doc-pane="${a.id}"]`)).toHaveLength(1);
    expect(editorOf(a.id)).toBe(editor);
    expect(a.text).toBe('kept # a.md\n');
  });

  it('leaves a tab that is alone in its group where it is', () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    const api = (ws as unknown as { api: DockviewApi }).api;
    const moveTo = vi.spyOn(api.getPanel(a.id)!.api, 'moveTo');
    ws.split(a.id, 'right');
    ws.split(a.id, 'below');
    expect(moveTo).not.toHaveBeenCalled();
    expect(ws.groupCount()).toBe(1);

    ws.openDoc(b);
    ws.split(b.id, 'below');
    ws.split(b.id, 'right');
    ws.split(a.id, 'below');
    expect(ws.groupCount()).toBe(2);
  });

  it('removes a group when its last tab closes', async () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    for (const doc of [a, b, c]) ws.openDoc(doc);
    ws.split(c.id, 'right');
    expect(ws.groupCount()).toBe(2);

    await ws.closeDoc(c.id);

    expect(ws.groupCount()).toBe(1);
    expect(ws.docIdsInOrder()).toEqual([a.id, b.id]);
  });

  it('says whether a tab is alone in its group, and false for an unknown id', () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    expect(ws.isAloneInGroup(a.id)).toBe(true);
    ws.openDoc(b);
    expect(ws.isAloneInGroup(a.id)).toBe(false);
    expect(ws.isAloneInGroup('nope')).toBe(false);
  });

  it('gives the moved tab the keyboard focus, even when it was already active', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);
    flushSync();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    ws.split(b.id, 'right');

    const focusedPane = () => document.activeElement?.closest('[data-doc-pane]')?.getAttribute('data-doc-pane');
    await vi.waitFor(() => expect(focusedPane()).toBe(b.id));
    elsewhere.remove();
  });

  it('brings the moved editor and preview back to their line, as a move out of the page resets scroll', async () => {
    const restoreLayout = fakePreviewLayout();
    const a = createDoc({ path: '/notes/a.md', raw: '# A\n\nb\n\n## C\n\nd\n\n### E\n\nf\n', hash: 'h', mode: 'split' });
    const b = fileDoc('b.md');
    ws.openDoc(b);
    ws.openDoc(a);
    flushSync();
    const preview = host.querySelector(`[data-doc-pane="${a.id}"] .preview`) as HTMLElement;
    const view = EditorView.findFromDOM(editorOf(a.id) as HTMLElement)!;
    // With the fake layout, 200 px down the preview is line 5 (## C).
    preview.scrollTop = 200;
    preview.dispatchEvent(new Event('scroll'));
    preview.scrollTop = 0; // what leaving the page does
    const dispatch = vi.spyOn(view, 'dispatch');

    ws.split(a.id, 'right');

    // scrollIntoView's target is not public; its range says where the editor is sent.
    const target = (spec: unknown) =>
      (spec as { effects?: { value?: { range?: { head: number } } } }).effects?.value?.range?.head;
    await vi.waitFor(() => expect(dispatch.mock.calls.map(([spec]) => target(spec))).toContain(view.state.doc.line(5).from));
    expect(preview.scrollTop).toBe(200);
    restoreLayout();
  });
});

describe('Workspace outline placement (Rulings 181, 191)', () => {
  const outlines = () => [...host.querySelectorAll('nav[aria-label="Outline"]')];
  const outlineTexts = () => [...outlines()[0].querySelectorAll('a')].map((a) => a.textContent);
  const paneOf = (nav: Element) => nav.closest('[data-doc-pane]')?.getAttribute('data-doc-pane');

  it('shows one outline, under the top-left group\'s tab strip and toolbar, for the active doc', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);
    ws.split(b.id, 'right');

    await vi.waitFor(() => expect(outlineTexts()).toEqual(['b.md']));
    expect(outlines()).toHaveLength(1);
    const nav = outlines()[0];
    expect(paneOf(nav)).toBe(a.id);
    // Below the strip (outside the pane) and the toolbar, beside the document.
    expect(nav.closest('.panes')?.previousElementSibling?.classList.contains('toolbar')).toBe(true);
    expect(nav.closest('.window-outline')?.nextElementSibling?.classList.contains('doc-column')).toBe(true);

    ws.activate(a.id);
    await vi.waitFor(() => expect(outlineTexts()).toEqual(['a.md']));
    expect(paneOf(outlines()[0])).toBe(a.id);
  });

  it('moves to the pane now shown at the top left', async () => {
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);
    ws.split(b.id, 'below');
    ws.openDoc(c, { referenceId: a.id });
    await vi.waitFor(() => expect(paneOf(outlines()[0])).toBe(c.id));
    expect(outlineTexts()).toEqual(['c.md']);

    await ws.closeDoc(c.id);
    await ws.closeDoc(a.id);
    await vi.waitFor(() => expect(paneOf(outlines()[0])).toBe(b.id));
    expect(outlines()).toHaveLength(1);
  });

  it('shows none when the outline is turned off', async () => {
    const a = fileDoc('a.md');
    ws.openDoc(a);
    await vi.waitFor(() => expect(outlines()).toHaveLength(1));

    outline.visible = false;
    flushSync();
    expect(outlines()).toHaveLength(0);
  });
});

describe('Workspace layout changes', () => {
  it('reports splits, tab switches and closes until unlistened', async () => {
    const [a, b] = ['a.md', 'b.md'].map(fileDoc);
    ws.openDoc(a);
    ws.openDoc(b);
    const changed = vi.fn();
    const stop = ws.onLayoutChange(changed);

    ws.split(b.id, 'right');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    ws.activate(a.id);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));

    stop();
    await ws.closeDoc(b.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe('Workspace groups and the outline under the pointer (Ruling 195)', () => {
  const outlineLink = (text: string) =>
    [...host.querySelectorAll<HTMLElement>('nav[aria-label="Outline"] a')].find((a) => a.textContent === text);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };

  // a on the left, which hosts the outline; b on the right and active.
  async function twoGroups() {
    const a = fileDoc('a.md');
    const b = createDoc({ path: '/notes/b.md', raw: '# B\n\ntext\n\n## Two\n', hash: 'h', mode: 'split' });
    ws.openDoc(a);
    ws.openDoc(b);
    ws.split(b.id, 'right');
    await vi.waitFor(() => expect(outlineLink('Two')).toBeDefined());
    return { a, b };
  }

  it('picks a heading in the doc the outline lists, and leaves the active group alone', async () => {
    const { b } = await twoGroups();
    const link = outlineLink('Two')!;

    // As a browser does: a press focuses the link unless its mousedown is cancelled.
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(down);
    if (!down.defaultPrevented) link.focus();
    await settle();
    (outlineLink('Two') ?? link).click();
    await settle();

    expect(ws.activeDocId()).toBe(b.id);
    expect(outlineLink('Two')).toBeDefined();
    const view = EditorView.findFromDOM(host.querySelector(`[data-doc-pane="${b.id}"] .cm-editor`) as HTMLElement)!;
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
  });

  it('leaves the active group alone when the keyboard moves into the outline', async () => {
    const { b } = await twoGroups();

    outlineLink('Two')!.focus();
    await settle();

    expect(ws.activeDocId()).toBe(b.id);
    expect(outlineLink('Two')).toBeDefined();
  });

  it("makes a group active on a press anywhere in its preview or editor, without moving focus", async () => {
    const { a, b } = await twoGroups();
    const press = (el: Element) =>
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    const before = document.activeElement;

    press(host.querySelector(`[data-doc-pane="${a.id}"] .preview`)!);
    expect(ws.activeDocId()).toBe(a.id);
    await settle();
    expect(document.activeElement).toBe(before);

    press(host.querySelector(`[data-doc-pane="${b.id}"] .cm-scroller`)!);
    expect(ws.activeDocId()).toBe(b.id);
  });
});
