import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { save } from '@tauri-apps/plugin-dialog';
import * as jsonc from 'jsonc-parser';
import {
  adoptDoc,
  createDoc,
  docs,
  removeDoc,
  saveDoc,
  saveDocAs,
  setWatchFailureReporter,
  type DocState,
} from '../docs/store.svelte';
import { registerView } from '../editor/views';
import { findLintConfig, normalizePath, unwatchPath, watchPath, writeTextFile, type LintConfigResult } from '../ipc';
import { DEFAULT_SETTINGS, settings } from '../settings/settings.svelte';
import {
  configSource,
  configStatus,
  configWritten,
  currentConfig,
  followDocConfigs,
  handleConfigFileEvent,
  parseLintConfig,
  FOCUS_REFRESH_MS,
  refreshAllConfigs,
  refreshConfig,
  refreshConfigsOnFocus,
} from './config';
import { relint } from './lintExtension';

vi.mock('../ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc')>()),
  findLintConfig: vi.fn(),
  watchPath: vi.fn(async () => {}),
  unwatchPath: vi.fn(async () => {}),
  claimPath: vi.fn(async () => null),
  releasePath: vi.fn(async () => {}),
  normalizePath: vi.fn(async (path: string) => path),
  writeTextFile: vi.fn(async () => 'saved-hash'),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock('../os/recent', () => ({ recordRecent: vi.fn() }));
vi.mock('./lintExtension', () => ({ relint: vi.fn() }));
vi.mock('jsonc-parser', async (importOriginal) => {
  const real = await importOriginal<typeof import('jsonc-parser')>();
  return { ...real, parse: vi.fn(real.parse) };
});

const REPO = '/repo/.markdownlint.json';

function result(text: string, path = REPO, format: LintConfigResult['format'] = 'json'): LintConfigResult {
  return { path, format, text, hash: `hash of ${text}` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop = () => {};
const views: EditorView[] = [];

function open(path: string | null = '/repo/docs/a.md'): DocState {
  return createDoc({ path, raw: '- item\n', hash: 'doc-hash', mode: 'edit' });
}

function editorFor(doc: DocState): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc: doc.text }) });
  views.push(view);
  registerView(doc.id, view);
  return view;
}

beforeEach(() => {
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
  settings.lint.rules = { MD013: false };
  vi.mocked(findLintConfig).mockReset().mockResolvedValue(null);
  vi.mocked(watchPath).mockClear();
  vi.mocked(unwatchPath).mockClear();
  vi.mocked(relint).mockClear();
});

afterEach(async () => {
  stop();
  // Removing every doc with the hooks on lets go of each config and its watch.
  stop = followDocConfigs();
  for (const id of [...docs.keys()]) removeDoc(id);
  stop();
  stop = () => {};
  for (const view of views.splice(0)) view.destroy();
  await settled();
});

describe('parseLintConfig', () => {
  it('accepts JSONC with comments and trailing commas', () => {
    const text = '{\n  // lists use asterisks\n  "MD004": { "style": "asterisk" },\n  /* off */ "MD013": false,\n}';
    expect(parseLintConfig(result(text, '/r/.markdownlint.jsonc', 'jsonc'))).toEqual({
      config: { MD004: { style: 'asterisk' }, MD013: false },
      error: null,
      note: null,
    });
  });

  it('returns an error naming the line for invalid JSON', () => {
    const parsed = parseLintConfig(result('{\n  "MD013": false\n  "MD004": true\n}'));
    expect(parsed.config).toBeNull();
    expect(parsed.error).toBe('Comma expected on line 3.');
  });

  it('parses YAML MD013: false', () => {
    const parsed = parseLintConfig(result('MD013: false\n', '/r/.markdownlint.yaml', 'yaml'));
    expect(parsed).toEqual({ config: { MD013: false }, error: null, note: null });
  });

  it('returns the YAML error for invalid YAML', () => {
    const parsed = parseLintConfig(result('MD013: [false\n', '/r/.markdownlint.yml', 'yaml'));
    expect(parsed.config).toBeNull();
    expect(parsed.error).toMatch(/flow sequence/i);
  });

  it('strips a UTF-8 byte order mark', () => {
    expect(parseLintConfig(result('\uFEFF{ "MD013": false }')).config).toEqual({ MD013: false });
  });

  it.each([
    ['an array', '[1, 2]', 'json'],
    ['a number', '42', 'json'],
    ['null', 'null', 'json'],
    ['an empty YAML file', '', 'yaml'],
    ['a YAML string', 'just text', 'yaml'],
    ['a YAML list', '- MD013\n', 'yaml'],
  ] as const)('refuses %s, which holds no rules', (_, text, format) => {
    expect(parseLintConfig(result(text, '/r/c', format))).toEqual({
      config: null,
      error: 'Expected a set of rules, such as MD013: false.',
      note: null,
    });
  });

  it('drops extends: null without a note (Ruling 299)', () => {
    expect(parseLintConfig(result('{ "extends": null, "MD013": false }'))).toEqual({
      config: { MD013: false },
      error: null,
      note: null,
    });
  });

  it('drops a __proto__ key, so the rules stay a plain object (Ruling 299)', () => {
    const { config } = parseLintConfig(result('{ "__proto__": { "MD013": false }, "MD004": { "__proto__": {} } }'));

    expect(config).toEqual({ MD004: {} });
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(Object.getPrototypeOf((config as { MD004: object }).MD004)).toBe(Object.prototype);
    expect((config as { MD013?: boolean }).MD013).toBeUndefined();
  });

  it('reports a config that loops back on itself as an error (Ruling 310)', () => {
    const parsed = parseLintConfig(result('MD004: &rules\n  again: *rules\n', '/r/.markdownlint.yaml', 'yaml'));

    expect(parsed).toEqual({ config: null, error: 'The file refers to itself in a loop.', note: null });
  });

  it('keeps a YAML alias used twice, which is no loop', () => {
    const parsed = parseLintConfig(result('MD004: &style\n  style: dash\nMD005: *style\n', '/r/c.yaml', 'yaml'));

    expect(parsed.config).toEqual({ MD004: { style: 'dash' }, MD005: { style: 'dash' } });
  });

  it('drops extends, with a note, since it could read any file', () => {
    const parsed = parseLintConfig(result('{ "extends": "../../base.json", "MD013": false }'));
    expect(parsed).toEqual({
      config: { MD013: false },
      error: null,
      note: '.markdownlint.json: extends is not followed',
    });
  });
});

describe('currentConfig and refreshConfig', () => {
  it('gives the Settings rules until refreshConfig resolves, then the file rules', async () => {
    const doc = open();
    const found = deferred<LintConfigResult | null>();
    vi.mocked(findLintConfig).mockReturnValue(found.promise);

    const refreshing = refreshConfig(doc);
    expect(currentConfig(doc)).toEqual({ MD013: false });

    found.resolve(result('{ "MD004": { "style": "asterisk" } }'));
    await refreshing;
    expect(findLintConfig).toHaveBeenCalledWith('/repo/docs/a.md');
    expect(currentConfig(doc)).toEqual({ MD004: { style: 'asterisk' } });
    expect(doc.lintConfigPath).toBe(REPO);
  });

  it('lints the view again once', async () => {
    const doc = open();
    const view = editorFor(doc);
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));

    await refreshConfig(doc, view);

    expect(relint).toHaveBeenCalledOnce();
    expect(relint).toHaveBeenCalledWith(view);
  });

  it("lints the doc's own editor when given no view", async () => {
    const doc = open();
    const view = editorFor(doc);
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));

    await refreshConfig(doc);

    expect(relint).toHaveBeenCalledExactlyOnceWith(view);
  });

  it('lints again only when the config file, its text or the failure changed', async () => {
    const doc = open();
    editorFor(doc);
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));
    await refreshConfig(doc);
    await refreshConfig(doc);
    expect(relint).toHaveBeenCalledTimes(1);

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    await refreshConfig(doc);
    expect(relint).toHaveBeenCalledTimes(2);

    vi.mocked(findLintConfig).mockResolvedValue(null);
    await refreshConfig(doc);
    await refreshConfig(doc);
    expect(relint).toHaveBeenCalledTimes(3);

    vi.mocked(findLintConfig).mockRejectedValue('unreadable');
    await refreshConfig(doc);
    expect(relint).toHaveBeenCalledTimes(4);
  });

  it('lints each doc using a changed config again, whichever refresh ends first', async () => {
    const a = open('/repo/a.md');
    const b = open('/repo/b.md');
    const [viewA, viewB] = [editorFor(a), editorFor(b)];
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));
    await refreshConfig(a);
    await refreshConfig(b);
    vi.mocked(relint).mockClear();

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    await refreshConfig(a);
    await refreshConfig(b);

    expect(vi.mocked(relint).mock.calls).toEqual([[viewA], [viewB]]);
  });

  it('gives null while linting is off, even with a config file (Ruling 268)', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    await refreshConfig(doc);

    settings.lint.enabled = false;

    expect(currentConfig(doc)).toBeNull();
    expect(currentConfig(undefined)).toBeNull();
  });

  it('gives a copy, so a lint cannot change the cached rules', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": { "style": "dash" } }'));
    await refreshConfig(doc);

    (currentConfig(doc) as { MD004: { style: string } }).MD004.style = 'plus';

    expect(currentConfig(doc)).toEqual({ MD004: { style: 'dash' } });
  });

  it('names the file that sets the rules, or null for Settings', async () => {
    const doc = open();
    expect(configSource(doc)).toBeNull();
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));

    await refreshConfig(doc);

    expect(configSource(doc)).toBe('.markdownlint.json');
  });

  it('falls back to the Settings rules for a broken config and says so', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD013": }'));

    await refreshConfig(doc);

    expect(currentConfig(doc)).toEqual({ MD013: false });
    expect(configSource(doc)).toBeNull();
    expect(configStatus(doc)).toEqual({
      text: 'Lint config error: .markdownlint.json',
      details: 'Value expected on line 1.',
    });
  });

  it('says nothing about a broken config while linting is off', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('{'));
    await refreshConfig(doc);

    settings.lint.enabled = false;

    expect(configStatus(doc)).toBeNull();
  });

  it('notes an extends it did not follow', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "extends": "base.json" }'));

    await refreshConfig(doc);

    expect(configStatus(doc)).toEqual({ text: '.markdownlint.json: extends is not followed', details: null });
  });

  it('uses the Settings rules and shows the error when the search fails', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockRejectedValue('/repo/.markdownlint.json is not UTF-8 text.');

    await refreshConfig(doc);

    expect(currentConfig(doc)).toEqual({ MD013: false });
    expect(configStatus(doc)).toEqual({
      text: 'Lint config error',
      details: '/repo/.markdownlint.json is not UTF-8 text.',
    });
  });

  it('shows a looping config in the status bar and resolves (Ruling 310)', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('a: &x\n  b: *x\n', '/repo/.markdownlint.yaml', 'yaml'));

    await expect(refreshConfig(doc)).resolves.toBeUndefined();

    expect(configStatus(doc)).toEqual({
      text: 'Lint config error: .markdownlint.yaml',
      details: 'The file refers to itself in a loop.',
    });
  });

  it('names the config file the search could not read (Ruling 299)', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockRejectedValue({
      path: '/repo/.markdownlint.yaml',
      message: 'Lintel reads lint config files in UTF-8 only.',
      timedOut: false,
    });

    await refreshConfig(doc);

    expect(configStatus(doc)).toEqual({
      text: 'Lint config error: .markdownlint.yaml',
      details: 'Lintel reads lint config files in UTF-8 only.',
    });
  });

  it('clears the error once the config reads again (Ruling 298)', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockRejectedValueOnce({ path: REPO, message: 'Could not read the file', timedOut: false });
    await refreshConfig(doc);
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));

    await refreshConfig(doc);

    expect(configStatus(doc)).toBeNull();
    expect(currentConfig(doc)).toEqual({ MD004: false });
  });

  it('keeps the config it has when the search runs out of time (Ruling 298)', async () => {
    const doc = open();
    editorFor(doc);
    vi.mocked(findLintConfig).mockResolvedValueOnce(result('{ "MD004": false }'));
    await refreshConfig(doc);
    vi.mocked(relint).mockClear();
    vi.mocked(findLintConfig).mockRejectedValue({ path: null, message: 'took too long', timedOut: true });

    await refreshConfig(doc);

    expect(doc.lintConfigPath).toBe(REPO);
    expect(currentConfig(doc)).toEqual({ MD004: false });
    expect(configStatus(doc)).toBeNull();
    expect(relint).not.toHaveBeenCalled();
  });

  it('parses a config again only when its path or hash changed (Ruling 298)', async () => {
    const doc = open();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    vi.mocked(jsonc.parse).mockClear();

    await refreshConfig(doc);
    await refreshConfig(doc);
    expect(jsonc.parse).toHaveBeenCalledTimes(1);

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": true }'));
    await refreshConfig(doc);
    expect(jsonc.parse).toHaveBeenCalledTimes(2);
    expect(currentConfig(doc)).toEqual({ MD004: true });
  });

  it('drops an older refresh that ends after a newer one', async () => {
    const doc = open();
    const view = editorFor(doc);
    const older = deferred<LintConfigResult | null>();
    vi.mocked(findLintConfig).mockReturnValueOnce(older.promise).mockResolvedValueOnce(result('{ "MD001": false }'));

    const first = refreshConfig(doc);
    await refreshConfig(doc);
    older.resolve(result('{ "MD002": false }'));
    await first;

    expect(currentConfig(doc)).toEqual({ MD001: false });
    expect(relint).toHaveBeenCalledExactlyOnceWith(view);
  });

  it('uses the Settings rules for a doc with no file', async () => {
    const doc = open(null);

    await refreshConfig(doc);

    expect(findLintConfig).not.toHaveBeenCalled();
    expect(doc.lintConfigPath).toBeNull();
    expect(currentConfig(doc)).toEqual({ MD013: false });
  });
});

describe('watching config files', () => {
  it('watches each config once per window with its hash, until the last doc using it goes', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));
    const a = open('/repo/a.md');
    const b = open('/repo/b.md');
    await settled();

    const configWatches = () => vi.mocked(watchPath).mock.calls.filter(([path]) => path === REPO);
    expect(configWatches()).toEqual([[REPO, 'hash of {}']]);

    removeDoc(a.id);
    await settled();
    expect(unwatchPath).not.toHaveBeenCalledWith(REPO);

    removeDoc(b.id);
    await settled();
    expect(vi.mocked(unwatchPath).mock.calls.filter(([path]) => path === REPO)).toEqual([[REPO]]);
  });

  it('re-reads the config when it changes on disk and lints with the new rules', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const doc = open();
    await settled();

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": true }'));
    handleConfigFileEvent(REPO);
    await settled();

    expect(currentConfig(doc)).toEqual({ MD004: true });
    expect(vi.mocked(watchPath).mock.calls.filter(([path]) => path === REPO)).toHaveLength(1);
  });

  it('ignores events for files no doc uses as its config', async () => {
    stop = followDocConfigs();
    open();
    await settled();
    vi.mocked(findLintConfig).mockClear();

    handleConfigFileEvent('/elsewhere/.markdownlint.json');
    await settled();

    expect(findLintConfig).not.toHaveBeenCalled();
  });

  it('moves to the farther config when the nearer is deleted, and back when it returns (Ruling 346)', async () => {
    stop = followDocConfigs();
    const near = '/repo/docs/.markdownlint.yaml';
    vi.mocked(findLintConfig).mockResolvedValue(result('MD004: false', near, 'yaml'));
    const doc = open();
    await settled();

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD013": true }'));
    handleConfigFileEvent(near);
    await settled();

    expect(doc.lintConfigPath).toBe(REPO);
    expect(currentConfig(doc)).toEqual({ MD013: true });
    expect(unwatchPath).not.toHaveBeenCalledWith(near);
    expect(watchPath).toHaveBeenCalledWith(REPO, 'hash of { "MD013": true }');

    vi.mocked(findLintConfig).mockResolvedValue(result('MD004: true', near, 'yaml'));
    handleConfigFileEvent(near);
    await settled();
    expect(currentConfig(doc)).toEqual({ MD004: true });
    expect(unwatchPath).toHaveBeenCalledWith(REPO);
  });

  it('looks again for every doc when the window asks, finding a new config', async () => {
    stop = followDocConfigs();
    const doc = open();
    await settled();
    expect(doc.lintConfigPath).toBeNull();

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD001": false }'));
    refreshAllConfigs();
    await settled();

    expect(currentConfig(doc)).toEqual({ MD001: false });
  });

  it('looks again for every doc when Lintel writes a file with a config name', async () => {
    stop = followDocConfigs();
    const doc = open();
    await settled();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD001": false }'));

    configWritten('/repo/notes.md');
    await settled();
    expect(doc.lintConfigPath).toBeNull();

    configWritten(REPO);
    await settled();
    expect(doc.lintConfigPath).toBe(REPO);
  });

  it("re-reads a config this window saves as a doc, since Rust tells only other windows (Ruling 283)", async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const doc = open();
    const config = createDoc({ path: REPO, raw: '{ "MD004": false }', hash: 'h', mode: 'edit' });
    await settled();

    config.text = '{ "MD004": true }';
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": true }'));
    await saveDoc(config.id);
    await settled();

    expect(writeTextFile).toHaveBeenCalledWith(REPO, '{ "MD004": true }', 'h');
    expect(currentConfig(doc)).toEqual({ MD004: true });
  });

  it('looks up the config of a doc again after Save As', async () => {
    stop = followDocConfigs();
    const doc = open(null);
    await settled();
    vi.mocked(save).mockResolvedValue('/other/b.md');
    vi.mocked(normalizePath).mockImplementation(async (path) => path);
    const other = result('{ "MD009": false }', '/other/.markdownlint.json');
    vi.mocked(findLintConfig).mockResolvedValue(other);

    await saveDocAs(doc.id);
    await settled();

    expect(findLintConfig).toHaveBeenLastCalledWith('/other/b.md');
    expect(currentConfig(doc)).toEqual({ MD009: false });
  });

  it('lints a doc that comes back to the window again, as its config was let go', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const doc = open();
    await settled();
    removeDoc(doc.id, { keepClaim: true });

    const back = adoptDoc({ ...doc });
    const view = editorFor(back);
    vi.mocked(relint).mockClear();
    await settled();

    expect(relint).toHaveBeenCalledExactlyOnceWith(view);
    expect(currentConfig(back)).toEqual({ MD004: false });
  });

  it('drops a refresh still running when its doc leaves the window', async () => {
    stop = followDocConfigs();
    const found = deferred<LintConfigResult | null>();
    vi.mocked(findLintConfig).mockReturnValue(found.promise);
    const doc = open();

    removeDoc(doc.id);
    found.resolve(result('{}'));
    await settled();

    expect(watchPath).not.toHaveBeenCalledWith(REPO, expect.anything());
  });

  it('says live reload is off when watching the config fails, and does not reject (Ruling 298)', async () => {
    const reported: unknown[] = [];
    setWatchFailureReporter((err) => reported.push(err));
    const failure = new Error('the file watcher could not start');
    vi.mocked(watchPath).mockRejectedValueOnce(failure);
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));
    const doc = open(null);
    doc.path = '/repo/c.md';

    await refreshConfig(doc);
    await settled();

    expect(reported).toEqual([failure]);
    setWatchFailureReporter((err) => console.error(err));
  });

  it('keeps watching the config while it cannot be read, so its repair is heard (Ruling 298)', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const doc = open();
    await settled();

    vi.mocked(findLintConfig).mockRejectedValue({ path: REPO, message: 'Could not read the file', timedOut: false });
    handleConfigFileEvent(REPO);
    await settled();
    expect(currentConfig(doc)).toEqual({ MD013: false });
    expect(unwatchPath).not.toHaveBeenCalledWith(REPO);

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": true }'));
    handleConfigFileEvent(REPO);
    await settled();
    expect(currentConfig(doc)).toEqual({ MD004: true });
  });

  it('looks again on window focus at most once in 5 s (Ruling 298)', async () => {
    stop = followDocConfigs();
    open();
    await settled();
    vi.mocked(findLintConfig).mockClear();

    refreshConfigsOnFocus(100_000);
    refreshConfigsOnFocus(100_000 + FOCUS_REFRESH_MS - 1);
    expect(findLintConfig).toHaveBeenCalledTimes(1);

    refreshConfigsOnFocus(100_000 + FOCUS_REFRESH_MS);
    expect(findLintConfig).toHaveBeenCalledTimes(2);
    expect(FOCUS_REFRESH_MS).toBe(5000);
  });

  it('gives a focus inside the 5 s one look at their end, however many come (Ruling 310)', async () => {
    vi.useFakeTimers();
    try {
      stop = followDocConfigs();
      open();
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(findLintConfig).mockClear();

      refreshConfigsOnFocus(100_000);
      refreshConfigsOnFocus(102_000);
      refreshConfigsOnFocus(103_000);
      expect(findLintConfig).toHaveBeenCalledTimes(1);

      // Scheduled by the focus at 102,000 for the end of the window at 105,000.
      await vi.advanceTimersByTimeAsync(2_999);
      expect(findLintConfig).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(findLintConfig).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(findLintConfig).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times the focus looks by a clock that is never set back (Ruling 310)', async () => {
    stop = followDocConfigs();
    open();
    await settled();
    vi.mocked(findLintConfig).mockClear();
    const wall = vi.spyOn(Date, 'now');
    const monotonic = vi.spyOn(performance, 'now');
    try {
      wall.mockReturnValue(2_000_000_000_000);
      monotonic.mockReturnValue(50_000);
      refreshConfigsOnFocus();
      // The wall clock goes back an hour; the monotonic one moves on.
      wall.mockReturnValue(2_000_000_000_000 - 3_600_000);
      monotonic.mockReturnValue(50_000 + FOCUS_REFRESH_MS);
      refreshConfigsOnFocus();

      expect(findLintConfig).toHaveBeenCalledTimes(2);
    } finally {
      wall.mockRestore();
      monotonic.mockRestore();
    }
  });

  it('watches a nearer broken config that replaced the one in use, so its repair is heard (Ruling 310)', async () => {
    stop = followDocConfigs();
    const near = '/repo/docs/.markdownlint.yaml';
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const doc = open();
    await settled();

    vi.mocked(findLintConfig).mockRejectedValue({ path: near, message: 'Could not read the file', timedOut: false });
    handleConfigFileEvent(REPO);
    await settled();
    expect(watchPath).toHaveBeenCalledWith(near, '');
    expect(unwatchPath).not.toHaveBeenCalledWith(REPO);

    vi.mocked(findLintConfig).mockResolvedValue(result('MD004: true', near, 'yaml'));
    handleConfigFileEvent(near);
    await settled();
    expect(configStatus(doc)).toBeNull();
    expect(currentConfig(doc)).toEqual({ MD004: true });
    expect(unwatchPath).toHaveBeenCalledWith(REPO);
  });

  it('watches a config that is broken when the doc opens, so its repair is heard (Ruling 310)', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockRejectedValue({ path: REPO, message: 'Could not read the file', timedOut: false });
    const doc = open();
    await settled();
    expect(watchPath).toHaveBeenCalledWith(REPO, '');

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": true }'));
    handleConfigFileEvent(REPO);
    await settled();

    expect(configStatus(doc)).toBeNull();
    expect(currentConfig(doc)).toEqual({ MD004: true });
    expect(vi.mocked(watchPath).mock.calls.filter(([path]) => path === REPO)).toHaveLength(1);
  });

  it('keeps watching a deleted config, so its re-creation is heard (Ruling 346)', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const doc = open();
    await settled();

    vi.mocked(findLintConfig).mockResolvedValue(null);
    handleConfigFileEvent(REPO);
    await settled();
    expect(currentConfig(doc)).toEqual({ MD013: false });
    // A later look, as on focus, still finds nothing and still keeps the watch.
    refreshAllConfigs();
    await settled();
    expect(configSource(doc)).toBeNull();
    expect(unwatchPath).not.toHaveBeenCalledWith(REPO);

    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": true }'));
    handleConfigFileEvent(REPO);
    await settled();
    expect(currentConfig(doc)).toEqual({ MD004: true });
    expect(vi.mocked(watchPath).mock.calls.filter(([path]) => path === REPO)).toHaveLength(1);
  });

  it('keeps watching a deleted config with Windows paths too (Ruling 346)', async () => {
    stop = followDocConfigs();
    const config = 'C:\\repo\\.markdownlint.json';
    vi.mocked(findLintConfig).mockResolvedValue(result('{}', config));
    const inside = open('C:\\repo\\docs\\a.md');
    open('C:\\repository\\b.md');
    await settled();

    vi.mocked(findLintConfig).mockResolvedValue(null);
    handleConfigFileEvent(config);
    await settled();
    expect(unwatchPath).not.toHaveBeenCalledWith(config);

    // C:\repository is not inside C:\repo, so that doc let go already.
    removeDoc(inside.id);
    await settled();
    expect(unwatchPath).toHaveBeenCalledWith(config);
  });

  it('lets go of a deleted config once the doc moves where it cannot apply, or closes (Ruling 346)', async () => {
    stop = followDocConfigs();
    vi.mocked(findLintConfig).mockResolvedValue(result('{ "MD004": false }'));
    const moved = open('/repo/docs/a.md');
    const closed = open('/repo/b.md');
    await settled();
    vi.mocked(findLintConfig).mockResolvedValue(null);
    handleConfigFileEvent(REPO);
    await settled();

    vi.mocked(save).mockResolvedValue('/other/a.md');
    vi.mocked(normalizePath).mockImplementation(async (path) => path);
    await saveDocAs(moved.id);
    await settled();
    expect(unwatchPath).not.toHaveBeenCalledWith(REPO);

    removeDoc(closed.id);
    await settled();
    expect(unwatchPath).toHaveBeenCalledWith(REPO);
  });

  it('lets go of the failing file once the doc moves to another config or closes', async () => {
    stop = followDocConfigs();
    const near = '/repo/docs/.markdownlint.yaml';
    vi.mocked(findLintConfig).mockRejectedValue({ path: near, message: 'Could not read the file', timedOut: false });
    const doc = open();
    await settled();

    removeDoc(doc.id);
    await settled();

    expect(unwatchPath).toHaveBeenCalledWith(near);
  });
});
