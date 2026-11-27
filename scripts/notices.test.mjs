import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildNotices, chooseLicence, parseSpdx } from './notices.mjs';

const SCRIPT = fileURLToPath(new URL('./notices.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const MIT_TEXT = 'MIT License\n\nCopyright (c) 2020 Ann Example\n\nPermission is hereby granted...\n';
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project folder with fake packages; `modules` lists the files the "build" used. */
function fakeTree(packages, { crates = [], inlined = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'notices-'));
  temps.push(root);
  const modules = [join(root, 'src', 'main.ts')];
  for (const { name, files = {}, ...pkg } of packages) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    modules.push(join(dir, 'index.js'));
  }
  const crateList = crates.map(({ files = {}, ...c }) => {
    const dir = join(root, 'crates', c.name);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return { version: '1.0.0', licenseFile: null, authors: [], repository: null, dir, ...c };
  });
  writeFileSync(join(root, 'modules.json'), JSON.stringify(modules));
  writeFileSync(join(root, 'crates.json'), JSON.stringify(crateList));
  if (inlined) {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'notices-inlined.json'), JSON.stringify(inlined));
  }
  return root;
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
});
