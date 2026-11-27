import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { save } from '@tauri-apps/plugin-dialog';
import { adoptDoc, createDoc, docs, removeDoc, saveDoc, saveDocAs, type DocState } from '../docs/store.svelte';
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
  refreshAllConfigs,
  refreshConfig,
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

  it('moves to the farther config, and unwatches the old one, when it is deleted', async () => {
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
    expect(unwatchPath).toHaveBeenCalledWith(near);
    expect(watchPath).toHaveBeenCalledWith(REPO, 'hash of { "MD013": true }');
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

    expect(writeTextFile).toHaveBeenCalledWith(REPO, '{ "MD004": true }');
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

  it('logs, and does not reject, when watching the config fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(watchPath).mockRejectedValueOnce(new Error('the file watcher could not start'));
    vi.mocked(findLintConfig).mockResolvedValue(result('{}'));
    const doc = open(null);
    doc.path = '/repo/c.md';

    await refreshConfig(doc);
    await settled();

    expect(error).toHaveBeenCalledWith('Could not watch the lint config:', expect.any(Error));
    error.mockRestore();
  });
});
