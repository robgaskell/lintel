import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, settings, type Settings } from '../settings/settings.svelte';
import { editorExtensions, fontCompartment } from './setup';
import { activeView, followEditorFont, registerView, setActiveDocSource, setEditorsLocked, viewFor } from './views';

const changed = vi.hoisted(() => ({ cb: null as ((s: Settings) => void) | null }));
vi.mock('../settings/settings.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings/settings.svelte')>()),
  onSettingsChanged: (cb: (s: Settings) => void) => {
    changed.cb = cb;
    return () => (changed.cb = null);
  },
}));

const fakeView = (name: string) => ({ name }) as unknown as EditorView;

afterEach(() => setActiveDocSource(null));

describe('editor view registry', () => {
  it('returns the view of the active doc', () => {
    const a = fakeView('a');
    const b = fakeView('b');
    const forgetA = registerView('doc-a', a);
    const forgetB = registerView('doc-b', b);
    setActiveDocSource({ activeDocId: () => 'doc-b' });

    expect(activeView()).toBe(b);

    forgetA();
    forgetB();
  });

  it('forgets a view, but not a newer one registered for the same doc', () => {
    const first = fakeView('first');
    const second = fakeView('second');
    const forgetFirst = registerView('doc', first);
    const forgetSecond = registerView('doc', second);

    forgetFirst();
    expect(viewFor('doc')).toBe(second);

    forgetSecond();
    expect(viewFor('doc')).toBeNull();
  });

  it('has no active view when no tab is active', () => {
    const forget = registerView('doc', fakeView('x'));
    setActiveDocSource({ activeDocId: () => null });

    expect(activeView()).toBeNull();
    forget();
  });
});

describe('followEditorFont (Ruling 170)', () => {
  const withSettings = (patch: Partial<Settings>) =>
    ({ ...structuredClone(DEFAULT_SETTINGS), ...patch }) as Settings;
  const editor = () =>
    new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'a', extensions: editorExtensions(() => {}) }),
    });

  it('gives editors made before the settings loaded the stored font at once', () => {
    const early = editor();
    const forget = registerView('doc-early', early);
    const before = fontCompartment.get(early.state);
    const sizeBefore = getComputedStyle(early.scrollDOM).fontSize;
    settings.fontSize = 22;
    try {
      const stop = followEditorFont();
      expect(fontCompartment.get(early.state)).not.toBe(before);
      expect(getComputedStyle(early.scrollDOM).fontSize).not.toBe(sizeBefore);
      stop();
    } finally {
      settings.fontSize = DEFAULT_SETTINGS.fontSize;
      forget();
      early.destroy();
    }
  });

  it("reconfigures each editor's font compartment on an editor font or size change only", () => {
    const views = [editor(), editor()];
    const forget = views.map((v, i) => registerView(`doc-${i}`, v));
    const stop = followEditorFont();
    const fonts = () => views.map((v) => fontCompartment.get(v.state));

    let before = fonts();
    for (const patch of [{ theme: 'dark' }, { readingFont: 'Georgia, serif' }] as const) {
      changed.cb!(withSettings(patch));
      expect(fonts(), JSON.stringify(patch)).toEqual(before);
      fonts().forEach((font, i) => expect(font).toBe(before[i]));
    }

    for (const patch of [{ fontSize: 20 }, { editorFont: 'Menlo, Consolas, monospace' }]) {
      changed.cb!(withSettings(patch));
      fonts().forEach((font, i) => expect(font, JSON.stringify(patch)).not.toBe(before[i]));
      before = fonts();
    }
    changed.cb!(withSettings({ fontSize: 20 }));
    for (const v of views) expect(getComputedStyle(v.scrollDOM).fontSize).toBe('18px');

    stop();
    expect(changed.cb).toBeNull();
    forget.forEach((f) => f());
    views.forEach((v) => v.destroy());
  });
});

describe('setEditorsLocked (Ruling 349)', () => {
  const editor = () =>
    new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'a', extensions: editorExtensions(() => {}) }),
    });

  it('makes every editor read-only, and those made while locked too, until unlocked', () => {
    const open = editor();
    const forget = registerView('doc-open', open);
    try {
      setEditorsLocked(true);
      const later = editor();
      for (const view of [open, later]) {
        expect(view.state.readOnly).toBe(true);
        expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
      }
      later.destroy();

      setEditorsLocked(false);
      expect(open.state.readOnly).toBe(false);
      expect(open.contentDOM.getAttribute('contenteditable')).toBe('true');
      expect(editor().state.readOnly).toBe(false);
    } finally {
      setEditorsLocked(false);
      forget();
      open.destroy();
    }
  });
});
