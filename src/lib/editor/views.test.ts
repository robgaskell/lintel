import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings.svelte';
import { activeView, registerView, remeasureOnFontChange, setActiveDocSource, viewFor } from './views';

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

describe('remeasureOnFontChange (Ruling 161)', () => {
  type Measured = EditorView & { requestMeasure: ReturnType<typeof vi.fn> };
  const measured = () => ({ requestMeasure: vi.fn() }) as unknown as Measured;
  const withSettings = (patch: Partial<Settings>) =>
    ({ ...structuredClone(DEFAULT_SETTINGS), ...patch }) as Settings;

  it('re-measures every editor after a font or size change, and not for other changes', () => {
    const a = measured();
    const b = measured();
    const forget = [registerView('a', a), registerView('b', b)];
    const stop = remeasureOnFontChange();

    changed.cb!(withSettings({ theme: 'dark' }));
    expect(a.requestMeasure).not.toHaveBeenCalled();

    const fontChanges = [
      { fontSize: 20 },
      { readingFont: 'Georgia, serif' },
      { editorFont: 'Menlo, Consolas, monospace' },
    ];
    for (const patch of fontChanges) {
      a.requestMeasure.mockClear();
      b.requestMeasure.mockClear();
      changed.cb!(withSettings(patch));
      expect(a.requestMeasure).toHaveBeenCalledOnce();
      expect(b.requestMeasure).toHaveBeenCalledOnce();
    }

    stop();
    expect(changed.cb).toBeNull();
    forget.forEach((f) => f());
  });
});
