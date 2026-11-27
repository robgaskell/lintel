import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildNotices, chooseLicence, parseSpdx, TARGETS } from './notices.mjs';

const SCRIPT = fileURLToPath(new URL('./notices.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const MIT_TEXT = 'MIT License\n\nCopyright (c) 2020 Ann Example\n\nPermission is hereby granted...\n';
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project folder with fake packages; `modules` lists the files the "build" used. */
function fakeTree(packages, { crates = [], inlined = null, holders = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'notices-'));
  temps.push(root);
  const modules = [join(root, 'src', 'main.ts')];
  for (const { name, files = {}, ...pkg } of packages) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
    writeFiles(dir, files);
    modules.push(join(dir, 'index.js'));
  }
  const crateList = crates.map(({ files = {}, ...c }) => {
    const dir = join(root, 'crates', c.name);
    mkdirSync(dir, { recursive: true });
    writeFiles(dir, files);
    return { version: '1.0.0', source: REGISTRY, licenseFile: null, authors: [], repository: null, dir, ...c };
  });
  writeFileSync(join(root, 'modules.json'), JSON.stringify(modules));
  writeFileSync(join(root, 'crates.json'), JSON.stringify(crateList));
  mkdirSync(join(root, 'scripts'));
  if (inlined) writeFileSync(join(root, 'scripts', 'notices-inlined.json'), JSON.stringify(inlined));
  if (holders) writeFileSync(join(root, 'scripts', 'notices-holders.json'), JSON.stringify(holders));
  return root;
}

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';

// Keys may name files in sub-folders, such as "vendor/x/LICENSE".
function writeFiles(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

function run(root, ...args) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--root', root, '--modules', join(root, 'modules.json'), '--crates', join(root, 'crates.json'), ...args],
    { encoding: 'utf8' },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const notices = (root) => readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');

const mit = { name: 'plain', license: 'MIT', files: { LICENSE: MIT_TEXT } };
const elk = {
  name: 'elkjs',
  license: 'EPL-2.0 OR GPL-3.0-or-later',
  files: { 'LICENSE.md': 'Eclipse Public License - v 2.0\n...' },
};

test('an MIT package and an EPL-2.0 OR GPL-3.0-or-later package pass --check, with EPL-2.0 chosen', () => {
  const root = fakeTree([mit, elk]);
  assert.equal(run(root).code, 0);
  const r = run(root, '--check');
  assert.equal(r.code, 0, r.err);
  assert.match(notices(root), /\*\*elkjs 1\.0\.0\*\*: EPL-2\.0 \(chosen from EPL-2\.0 OR GPL-3\.0-or-later\)/);
  assert.match(notices(root), /\*\*plain 1\.0\.0\*\*: MIT\./);
});

test('a GPL-3.0-only package fails --check with exit code 1 and is named', () => {
  const root = fakeTree([mit, { name: 'copyleft', license: 'GPL-3.0-only', files: { LICENSE: 'GPL' } }]);
  run(root);
  const r = run(root, '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /copyleft 1\.0\.0: licence "GPL-3\.0-only" is not on the allow-list/);
});

test('--check fails when a package is added without regenerating the notices', () => {
  const root = fakeTree([mit]);
  assert.equal(run(root).code, 0);
  const extra = join(root, 'node_modules', 'added');
  mkdirSync(extra);
  writeFileSync(join(extra, 'package.json'), JSON.stringify({ name: 'added', version: '2.0.0', license: 'MIT' }));
  writeFileSync(join(extra, 'LICENSE'), MIT_TEXT);
  const modules = JSON.parse(readFileSync(join(root, 'modules.json'), 'utf8'));
  writeFileSync(join(root, 'modules.json'), JSON.stringify([...modules, join(extra, 'index.js')]));
  const r = run(root, '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /THIRD_PARTY_NOTICES\.md is out of date/);
  assert.match(r.err, /new: added 2\.0\.0/);
});

test('--check fails when the notices file is missing', () => {
  const r = run(fakeTree([mit]), '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /out of date/);
});

test('an off-list crate licence fails --check and is named', () => {
  const root = fakeTree([mit], { crates: [{ name: 'gpl-crate', license: 'GPL-2.0', files: { LICENSE: 'GPL' } }] });
  run(root);
  const r = run(root, '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /gpl-crate 1\.0\.0: licence "GPL-2\.0" is not on the allow-list/);
});

test('MPL-2.0 is allowed for option-ext only, and EPL-2.0 for elkjs only', () => {
  assert.deepEqual(chooseLicence('MPL-2.0', 'option-ext'), ['MPL-2.0']);
  assert.equal(chooseLicence('MPL-2.0', 'other'), null);
  assert.deepEqual(chooseLicence('EPL-2.0', 'elkjs'), ['EPL-2.0']);
  assert.equal(chooseLicence('EPL-2.0 OR GPL-3.0-or-later', 'not-elkjs'), null);
});

test('the evaluator reads OR, AND, WITH, / and parentheses, and prefers MIT', () => {
  assert.deepEqual(chooseLicence('MIT OR Apache-2.0', 'x'), ['MIT']);
  assert.deepEqual(chooseLicence('Apache-2.0 OR MIT', 'x'), ['MIT']);
  assert.deepEqual(chooseLicence('MIT/Apache-2.0', 'x'), ['MIT']);
  assert.deepEqual(chooseLicence('(MPL-2.0 OR Apache-2.0)', 'dompurify'), ['Apache-2.0']);
  assert.deepEqual(chooseLicence('(MIT OR Apache-2.0) AND Unicode-3.0', 'x'), ['MIT', 'Unicode-3.0']);
  assert.deepEqual(chooseLicence('Apache-2.0 AND ISC', 'x'), ['Apache-2.0', 'ISC']);
  assert.deepEqual(chooseLicence('Apache-2.0 WITH LLVM-exception', 'x'), ['Apache-2.0 WITH LLVM-exception']);
  assert.deepEqual(
    chooseLicence('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT', 'x'),
    ['MIT'],
  );
  assert.equal(chooseLicence('Apache-2.0 WITH Unknown-exception', 'x'), null);
  assert.equal(chooseLicence('MIT AND GPL-2.0', 'x'), null);
  assert.deepEqual(chooseLicence('GPL-2.0 OR (BSD-3-Clause AND Zlib)', 'x'), ['BSD-3-Clause', 'Zlib']);
  // AND binds tighter than OR.
  assert.deepEqual(parseSpdx('A OR B AND C'), { or: [{ id: 'A' }, { and: [{ id: 'B' }, { id: 'C' }] }] });
  for (const bad of ['', 'MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH', 'MIT, Apache-2.0']) {
    assert.throws(() => parseSpdx(bad), /bad licence expression/, bad);
  }
});

test('the allow-list holds CC0-1.0, BSL-1.0, Unlicense, Zlib, 0BSD and Unicode-3.0', () => {
  for (const id of ['CC0-1.0', 'BSL-1.0', 'Unlicense', 'Zlib', '0BSD', 'Unicode-3.0', 'ISC', 'BSD-2-Clause']) {
    assert.deepEqual(chooseLicence(id, 'x'), [id]);
  }
});

test('identical texts are printed once', () => {
  const root = fakeTree([mit, { ...mit, name: 'twin' }]);
  run(root);
  const text = notices(root);
  assert.equal(text.split('Ann Example').length - 1, 1);
  assert.match(text, /Used by: plain 1\.0\.0, twin 1\.0\.0\./);
});

test('a package with no licence text gets the standard text and a copyright line', () => {
  const root = fakeTree([
    { name: 'bare', license: 'BSD-3-Clause', author: 'Bea Author <bea@example.com>' },
    { name: 'spdx-only', license: 'MIT', author: { name: 'Sam Spdx' }, files: { 'LICENSE.spdx': 'SPDXVersion: SPDX-2.1' } },
  ]);
  assert.equal(run(root).code, 0);
  const text = notices(root);
  assert.match(text, /Copyright \(c\) Bea Author\n\nRedistribution and use in source and binary forms/);
  assert.match(text, /Copyright \(c\) Sam Spdx\n\nPermission is hereby granted/);
  assert.doesNotMatch(text, /SPDXVersion/);
});

test('a crate with no licence file gets the standard text with its authors', () => {
  const root = fakeTree([], { crates: [{ name: 'bare-crate', license: 'BSL-1.0', authors: ['Dee Rust <d@example.com>'] }] });
  assert.equal(run(root).code, 0);
  assert.match(notices(root), /Copyright \(c\) Dee Rust\n\nBoost Software License/);
});

test('NOTICE files are included, and scripts named like licences are not', () => {
  const root = fakeTree([
    { ...mit, files: { LICENSE: MIT_TEXT, NOTICE: 'Parts derived from Lodash.', 'license-check.js': 'code()' } },
  ]);
  run(root);
  assert.match(notices(root), /Parts derived from Lodash\./);
  assert.doesNotMatch(notices(root), /code\(\)/);
});

test('a dual-licensed crate ships only the text of the licence chosen', () => {
  const root = fakeTree([], {
    crates: [
      {
        name: 'dual',
        license: 'MIT OR Apache-2.0',
        files: { 'LICENSE-MIT': 'The MIT text', 'LICENSE-APACHE': 'The Apache text' },
      },
    ],
  });
  run(root);
  assert.match(notices(root), /The MIT text/);
  assert.doesNotMatch(notices(root), /The Apache text/);
});

test('a module from no known package fails --check', () => {
  const root = fakeTree([mit]);
  const modules = JSON.parse(readFileSync(join(root, 'modules.json'), 'utf8'));
  writeFileSync(join(root, 'modules.json'), JSON.stringify([...modules, '\0mystery/helper.js']));
  run(root);
  const r = run(root, '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown module in the bundle: mystery\/helper\.js/);
});

test('a package that states no licence fails until it is read by hand', () => {
  const root = fakeTree([{ name: 'silent', files: { LICENSE: MIT_TEXT } }]);
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.err, /silent 1\.0\.0: no licence stated/);
});

test('inlined code is listed with its host, and a stale host fails --check', () => {
  const item = { name: 'tiny', version: '0.1.0', license: 'ISC', copyright: 'Copyright 2019 Tia Tiny' };
  const good = fakeTree([mit], { inlined: [{ in: 'plain@1.0.0', ...item }] });
  assert.equal(run(good).code, 0);
  assert.match(notices(good), /\*\*tiny 0\.1\.0 \(inside plain@1\.0\.0\)\*\*: ISC\./);
  assert.match(notices(good), /Copyright 2019 Tia Tiny\n\nISC License/);

  const stale = fakeTree([mit], { inlined: [{ in: 'plain@0.9.0', ...item }] });
  run(stale);
  const r = run(stale, '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /code inside plain@0\.9\.0, which is no longer in the app/);
});

test('buildNotices puts a text with backticks inside a longer fence', () => {
  const root = fakeTree([{ ...mit, files: { LICENSE: 'Use ``` with care' } }]);
  const { markdown } = buildNotices({
    npm: [{ dir: join(root, 'node_modules', 'plain'), pkg: { name: 'plain', version: '1.0.0', license: 'MIT' } }],
    crates: [],
    inlined: [],
  });
  assert.match(markdown, /````text\nUse ``` with care\n````/);
});

test('licence files in sub-folders and THIRD-PARTY files are read; tests and skipped files are not', () => {
  const root = fakeTree([
    {
      ...mit,
      files: {
        LICENSE: MIT_TEXT,
        'THIRD-PARTY-LICENSE': 'Bundled rollup text',
        'vendor/tiny/LICENSE': 'Vendored tiny text',
        'tests/COPYRIGHT': 'Test image text',
      },
    },
    { name: 'dompurify', license: 'Apache-2.0', files: { LICENSE: 'Apache text', 'src/license_header': '/*! banner */' } },
  ]);
  run(root);
  const text = notices(root);
  assert.match(text, /Bundled rollup text/);
  assert.match(text, /Vendored tiny text/);
  assert.doesNotMatch(text, /Test image text/);
  assert.doesNotMatch(text, /banner/);
});

test('a text an entry reaches twice is linked once', () => {
  const root = fakeTree([{ ...mit, files: { LICENSE: MIT_TEXT, 'helpers/LICENSE': MIT_TEXT } }]);
  run(root);
  assert.match(notices(root), /^- \*\*plain 1\.0\.0\*\*: MIT\. \[text 1\]\(#text-1\)\.$/m);
});

test('inlined code can take its text from a file in its host package', () => {
  const item = { name: 'spin', version: '0.5', license: 'MIT', textFrom: 'src/spin/LICENSE' };
  const root = fakeTree([], {
    crates: [{ name: 'host', license: 'MIT', files: { LICENSE: 'Host text', 'src/spin/LICENSE': 'Spin text' } }],
    inlined: [{ in: 'host@1.0.0', ...item }],
  });
  assert.equal(run(root).code, 0);
  assert.match(notices(root), /Used by: host 1\.0\.0, spin 0\.5 \(inside host@1\.0\.0\)\./);

  const moved = fakeTree([], {
    crates: [{ name: 'host', license: 'MIT', files: { LICENSE: 'Host text' } }],
    inlined: [{ in: 'host@1.0.0', ...item }],
  });
  const r = run(moved);
  assert.equal(r.code, 1);
  assert.match(r.err, /spin 0\.5 \(inside host@1\.0\.0\): src\/spin\/LICENSE is not in host@1\.0\.0/);
});

test('a package with no licence file and no author fails until its own copyright line is recorded', () => {
  const anon = { name: 'anon', license: 'MIT' };
  const bare = fakeTree([anon]);
  run(bare);
  const r = run(bare, '--check');
  assert.equal(r.code, 1);
  assert.match(r.err, /anon 1\.0\.0: no licence file and no copyright holder/);
  assert.doesNotMatch(notices(bare), /the anon authors/);

  const known = fakeTree([anon], { holders: { 'anon@1.0.0': { line: 'Copyright 2020 Anon Org', from: 'dist header' } } });
  assert.equal(run(known).code, 0);
  assert.match(notices(known), /Copyright 2020 Anon Org\n\nPermission is hereby granted/);

  const none = fakeTree([anon], { holders: { 'anon@1.0.0': { none: 'read by hand' } } });
  assert.equal(run(none).code, 0);
  assert.match(notices(none), /No copyright holder is named in this package's files\.\n\nPermission/);
});

test('inlined code with no copyright line and no text fails', () => {
  const root = fakeTree([mit], { inlined: [{ in: 'plain@1.0.0', name: 'bit', version: '1', license: 'MIT' }] });
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.err, /bit 1 \(inside plain@1\.0\.0\): no licence file and no copyright holder/);
});

test('a package with a NOTICE but no licence file fails', () => {
  const root = fakeTree([{ name: 'noticed', license: 'Apache-2.0', author: 'Nia', files: { NOTICE: 'Notice only' } }]);
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.err, /noticed 1\.0\.0: has a NOTICE but no licence file/);
});

test('a path crate with no registry source fails', () => {
  const root = fakeTree([], { crates: [{ name: 'local', license: 'MIT', source: null, files: { LICENSE: MIT_TEXT } }] });
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.err, /local 1\.0\.0: a path crate, not from a registry/);
});

test('crates are listed for every release platform', () => {
  assert.deepEqual(TARGETS, [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
  ]);
});

test('licence file names are matched on whole words, and .git is cut from source links', () => {
  const root = fakeTree([], {
    crates: [
      {
        name: 'permits',
        license: 'Apache-2.0',
        repository: 'https://github.com/example/permits.git',
        files: { 'LICENSE-APACHE': 'Apache text', 'LICENSE-PERMITS': 'Permits text' },
      },
    ],
  });
  run(root);
  assert.match(notices(root), /Permits text/);
  assert.match(notices(root), /Source: <https:\/\/github\.com\/example\/permits>\./);
});

test('the notices and licence texts keep LF line endings on every checkout', () => {
  for (const file of ['THIRD_PARTY_NOTICES.md', 'scripts/licence-texts/MIT.txt']) {
    const r = spawnSync('git', ['check-attr', 'eol', '--', file], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), `${file}: eol: lf`);
  }
});

// The committed file, as --check keeps it in step with the app (spec licence lines, Rulings 24, 274).
test('the real notices name the licences the spec and rulings require', () => {
  const text = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(text, /\*\*elkjs [\d.]+\*\*: EPL-2\.0 \(chosen from EPL-2\.0 OR GPL-3\.0-or-later\)/);
  assert.match(text, /Eclipse Public License - v 2\.0/);
  assert.match(text, /\*\*dompurify [\d.]+\*\*: Apache-2\.0 \(chosen from \(MPL-2\.0 OR Apache-2\.0\)\)/);
  assert.match(text, /\*\*option-ext [\d.]+\*\*: MPL-2\.0\..*Source: <https:/);
  assert.match(text, /Copyright \(c\) 2021 mathuo/); // dockview-core
  for (const name of ['markdownlint', 're2js', 'micromark', 'string-width', 'get-east-asian-width', 'svelte', 'vite', 'rolldown']) {
    assert.match(text, new RegExp(`^- \\*\\*${name} `, 'm'), name);
  }
  assert.match(text, /Parts of the test suite and compatibility layer in es-toolkit\/compat/);
  assert.match(text, /Microsoft Edge WebView2 SDK/);
  assert.match(text, /\(inside docx@/);
  assert.match(text, /\(inside @mermaid-js\/parser@/);
  assert.match(text, /\(inside mermaid@/);
  assert.doesNotMatch(text, /Copyright \(c\) the \S+ authors/);
  assert.match(text, /Copyright \(c\) 2023 Boshen/);
  assert.match(text, /Copyright 2019-2023 Tauri Programme within The Commons Conservancy\n\nPermission/);
  assert.match(text, /JamaJS/);
  assert.match(text, /This software incorporates material from third parties/); // WebView2 SDK NOTICE
});
