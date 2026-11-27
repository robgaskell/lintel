import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { eventModule, resetFakes } from '../../test/fakes';
import { docs, type DocState } from '../docs/store.svelte';
import { registerView } from '../editor/views';
import { DEFAULT_SETTINGS, settings } from '../settings/settings.svelte';
import type { LintIssue } from './lint';
import { lintExtension, relint } from './lintExtension';
import { attachLint, followLintSettings, lintIssues, settingsLintConfig } from './lintState.svelte';
import { configSource, currentConfig } from './config';

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../../test/fakes').then((f) => f.eventModule));
vi.mock('./lintExtension', () => ({ lintExtension: vi.fn(() => []), relint: vi.fn() }));
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  currentConfig: vi.fn(() => ({ MD004: false })),
  configSource: vi.fn(() => '.markdownlint.json'),
}));

const views: EditorView[] = [];
const cleanups: (() => void)[] = [];

function editor(): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc: 'text' }), parent: document.body });
  views.push(view);
  return view;
}

// The `onIssues` the latest lintExtension was given.
function lastReporter(): (issues: LintIssue[] | null) => void {
  return vi.mocked(lintExtension).mock.lastCall![1];
}

const issues = [{ rule: 'MD004' }] as LintIssue[];

beforeEach(() => {
  resetFakes();
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  vi.mocked(lintExtension).mockClear();
  vi.mocked(relint).mockClear();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const view of views.splice(0)) view.destroy();
});

describe('attachLint', () => {
  it("keeps the doc's latest issues for the status bar, null when not linted", () => {
    cleanups.push(attachLint('a', editor()));

    lastReporter()(issues);
    expect(lintIssues.get('a')).toBe(issues);
    lastReporter()(null);
    expect(lintIssues.get('a')).toBeNull();
  });

  it("lints with the doc's current config and names its file (Rulings 282, 287)", () => {
    const doc = { id: 'a', lintConfigPath: '/repo/.markdownlint.json' } as DocState;
    docs.set('a', doc);
    cleanups.push(attachLint('a', editor()), () => docs.delete('a'));
    const [getConfig, , getSource] = vi.mocked(lintExtension).mock.lastCall!;

    expect(getConfig()).toEqual({ MD004: false });
    expect(getSource!()).toBe('.markdownlint.json');
    expect(currentConfig).toHaveBeenLastCalledWith(doc);
    expect(configSource).toHaveBeenLastCalledWith(doc);
  });

  it('forgets them when the editor goes, unless a newer editor for the doc has reported', () => {
    const stopFirst = attachLint('a', editor());
    const first = lastReporter();
    first(issues);
    const stopSecond = attachLint('a', editor());
    lastReporter()([]);

    stopFirst();
    first(issues);
    expect(lintIssues.get('a')).toEqual([]);
    stopSecond();
    expect(lintIssues.has('a')).toBe(false);
  });
});

describe('settingsLintConfig', () => {
  it('is null while linting is off, so nothing is linted (Ruling 268)', () => {
    settings.lint.enabled = false;

    expect(settingsLintConfig()).toBeNull();
  });

  it('is a plain copy of the rules while it is on', () => {
    settings.lint.rules = { default: true, 'ul-style': false };

    const config = settingsLintConfig();

    expect(config).toEqual({ default: true, 'ul-style': false });
    expect(config).not.toBe(settings.lint.rules);
  });
});

describe('followLintSettings', () => {
  it('lints every editor at once when it starts, as the settings may have just loaded', () => {
    const a = editor();
    const b = editor();
    cleanups.push(registerView('a', a), registerView('b', b));

    cleanups.push(followLintSettings());

    expect(vi.mocked(relint).mock.calls.map(([view]) => view)).toEqual([a, b]);
  });

  it('lints every editor again after a lint change, and not after any other', async () => {
    const a = editor();
    const b = editor();
    cleanups.push(registerView('a', a), registerView('b', b));
    const stop = followLintSettings();
    cleanups.push(stop);
    vi.mocked(relint).mockClear();
    await Promise.resolve();

    await eventModule.emit('lintel://settings-changed', { revision: 1e6, changes: { fontSize: 20 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relint).not.toHaveBeenCalled();

    await eventModule.emit('lintel://settings-changed', {
      revision: 1e6 + 1,
      changes: { lint: { enabled: false, rules: { default: true } } },
    });
    await vi.waitFor(() => expect(relint).toHaveBeenCalledTimes(2));
    expect(vi.mocked(relint).mock.calls.map(([view]) => view)).toEqual([a, b]);
  });
});
