import { afterEach, describe, expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { activeView, registerView, setActiveDocSource, viewFor } from './views';

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
    registerView('doc', fakeView('x'));
    setActiveDocSource({ activeDocId: () => null });

    expect(activeView()).toBeNull();
  });
});
