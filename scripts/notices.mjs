// Writes THIRD_PARTY_NOTICES.md: every npm package in the built app (from Vite's module
// graph, lazy chunks included), every Rust crate linked on macOS, Windows or Linux, and the
// code other packages carry inside their own files (scripts/notices-inlined.json).
// Run: node scripts/notices.mjs. With --check it writes nothing and exits 1 when a licence
// is off the allow-list or the file is out of date.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEXTS_DIR = join(SCRIPT_DIR, 'licence-texts');
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';

/** Licences Lintel may ship under, in order of preference when a package offers a choice. */
export const ALLOWED = [
  'MIT',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Zlib',
  'Apache-2.0',
  'BSL-1.0',
  'Unicode-3.0',
  'CC0-1.0',
  'Unlicense',
];
/** Weak-copyleft licences allowed only for the packages named (spec; human answer 6). */
export const NAMED_EXCEPTIONS = { 'EPL-2.0': ['elkjs'], 'MPL-2.0': ['option-ext'] };
const ALLOWED_WITH = ['LLVM-exception'];
const RANK = [...ALLOWED, ...Object.keys(NAMED_EXCEPTIONS)];

// Packages whose package.json states no licence, read by hand. Keyed by version, so an
// upgrade must be read again.
const STATED = { 'khroma@2.1.0': 'MIT' };

// Vite's LICENSE.md goes on to list the Node-side tools inside Vite, none of which ship.
const CUT_AT = { vite: '\n# Licenses of bundled dependencies' };

const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
];

// ---------- SPDX expressions ----------

/** Parses an SPDX expression; `/` (old Cargo style) reads as OR. Throws on bad input. */
export function parseSpdx(text) {
  const tokens = text.match(/\(|\)|\/|[A-Za-z0-9.+:-]+/g) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) throw new Error(`bad licence expression "${text}"`);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;
  const or = () => {
    let node = and();
    while (isOp(peek(), 'OR') || peek() === '/') {
      i++;
      node = { or: [node, and()] };
    }
    return node;
  };
  const and = () => {
    let node = atom();
    while (isOp(peek(), 'AND')) {
      i++;
      node = { and: [node, atom()] };
    }
    return node;
  };
  const atom = () => {
    const t = tokens[i++];
    if (t === '(') {
      const node = or();
      if (tokens[i++] !== ')') throw new Error(`bad licence expression "${text}"`);
      return node;
    }
    if (t === undefined || t === ')' || t === '/' || ['AND', 'OR', 'WITH'].includes(t.toUpperCase())) {
      throw new Error(`bad licence expression "${text}"`);
    }
    if (isOp(peek(), 'WITH')) {
      i++;
      const exception = tokens[i++];
      if (!exception || exception === '(' || exception === ')') throw new Error(`bad licence expression "${text}"`);
      return { id: t, with: exception };
    }
    return { id: t };
  };
  const tree = or();
  if (i !== tokens.length) throw new Error(`bad licence expression "${text}"`);
  return tree;
}

/**
 * The licences `pkg` is used under: the most preferred allowed choice, as SPDX ids
 * (several for AND). Null when no choice is allowed.
 */
export function chooseLicence(expression, pkg) {
  const pick = (node) => {
    if (node.id) {
      const allowed =
        ALLOWED.includes(node.id) || (NAMED_EXCEPTIONS[node.id] ?? []).includes(pkg);
      if (!allowed || (node.with && !ALLOWED_WITH.includes(node.with))) return null;
      return [node.with ? `${node.id} WITH ${node.with}` : node.id];
    }
    if (node.and) {
      const [a, b] = node.and.map(pick);
      return a && b ? [...new Set([...a, ...b])] : null;
    }
    const options = node.or.map(pick).filter(Boolean);
    if (options.length === 0) return null;
    return options.reduce((best, next) => (worst(next) < worst(best) ? next : best));
  };
  return pick(parseSpdx(expression));
}

const baseId = (id) => id.split(' WITH ')[0];
const worst = (ids) => Math.max(...ids.map((id) => RANK.indexOf(baseId(id))));

// ---------- npm packages ----------

/** Runs a production Vite build in memory and returns the id of every module in every chunk. */
export async function viteModules(root) {
  const { build } = await import('vite');
  const ids = new Set();
  await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    mode: 'production',
    logLevel: 'error',
    build: { write: false },
    plugins: [
      {
        name: 'lintel-notices',
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === 'chunk') for (const id of Object.keys(chunk.modules)) ids.add(id);
          }
        },
      },
    ],
  });
  return [...ids];
}

// Bundler helpers have no file of their own; each comes from the package named here.
const VIRTUAL = [
  [/^vite\//, 'vite'],
  [/^rolldown\//, 'rolldown'],
  [/^@oxc-project\+runtime@[^/]+\//, '@oxc-project/runtime'],
];

/** Maps module ids to package folders. A module from no known package becomes a problem. */
export function packagesFromModules(root, ids, problems) {
  const dirs = new Map();
  for (const raw of ids) {
    const virtual = raw.startsWith('\0');
    const id = raw.replace(/^\0/, '').split('?')[0].replaceAll('\\', '/');
    const at = id.lastIndexOf('/node_modules/');
    if (at !== -1) {
      const rest = id.slice(at + 14).split('/');
      const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
      dirs.set(id.slice(0, at + 14) + name, true);
      continue;
    }
    const helper = VIRTUAL.find(([re]) => re.test(id));
    if (helper) {
      const dir = findPackage(root, helper[1]);
      if (dir) dirs.set(dir, true);
      else problems.push(`${helper[1]} (source of the bundled helper ${id}) is not installed`);
      continue;
    }
    const own = !virtual && (id + '/').startsWith(root.replaceAll('\\', '/') + '/');
    if (!own) problems.push(`unknown module in the bundle: ${id} -- say which package it comes from`);
  }
  const packages = new Map();
  for (const dir of dirs.keys()) {
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (!packages.has(key)) packages.set(key, { dir, pkg });
  }
  return [...packages.values()];
}

// Looks in the root's node_modules, then beside vite and rolldown: pnpm keeps a package's
// dependencies in the folder that holds the package.
function findPackage(root, name) {
  const places = [join(root, 'node_modules')];
  for (let i = 0; i < places.length; i++) {
    const dir = join(places[i], name);
    if (existsSync(join(dir, 'package.json'))) return realpathSync(dir);
    for (const via of ['vite', 'rolldown']) {
      const found = join(places[i], via);
      if (!existsSync(found)) continue;
      const parent = dirname(realpathSync(found));
      if (!places.includes(parent)) places.push(parent);
    }
  }
  return null;
}

function npmEntry({ dir, pkg }) {
  const stated = STATED[`${pkg.name}@${pkg.version}`];
  let expression = stated ?? pkg.license;
  if (typeof expression === 'object' && expression) expression = expression.type;
  if (!expression && Array.isArray(pkg.licenses)) {
    expression = pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  }
  return {
    kind: 'npm',
    name: pkg.name,
    version: pkg.version,
    expression: expression ?? null,
    source: repoUrl(pkg.repository) ?? pkg.homepage ?? null,
    holders: npmHolders(pkg),
    dir,
    cut: CUT_AT[pkg.name],
  };
}

function npmHolders(pkg) {
  const people = [pkg.author, ...(pkg.contributors ?? [])].filter(Boolean);
  return people.map((p) => (typeof p === 'string' ? p : p.name)).map(stripContact).filter(Boolean);
}

function repoUrl(repo) {
  const url = typeof repo === 'string' ? repo : repo?.url;
  if (!url) return null;
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (short) return `https://github.com/${short[1]}`;
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
}

// ---------- Rust crates ----------

/** Crates linked into the app on any release target: normal deps only, no proc macros. */
export function cargoCrates(root) {
  const cwd = join(root, 'src-tauri');
  const linked = new Set();
  for (const target of TARGETS) {
    const out = execFileSync(
      'cargo',
      ['tree', '--locked', '-e', 'normal,no-proc-macro', '--target', target, '--prefix', 'none', '-f', '{p}'],
      { cwd, encoding: 'utf8', maxBuffer: 64 << 20 },
    );
    for (const line of out.split('\n')) {
      const m = /^(\S+) v(\S+)/.exec(line.trim());
      if (m) linked.add(`${m[1]}@${m[2]}`);
    }
  }
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    }),
  );
  return meta.packages
    .filter((p) => p.source !== null && linked.has(`${p.name}@${p.version}`))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? null,
      licenseFile: p.license_file ?? null,
      authors: p.authors ?? [],
      repository: p.repository ?? null,
      dir: dirname(p.manifest_path),
    }));
}

function crateEntry(c) {
  return {
    kind: 'crate',
    name: c.name,
    version: c.version,
    expression: STATED[`${c.name}@${c.version}`] ?? c.license,
    source: c.repository ?? `https://crates.io/crates/${c.name}`,
    holders: c.authors.map(stripContact).filter(Boolean),
    dir: c.dir,
  };
}

// ---------- code inlined in other packages ----------

function inlinedEntry(item, hosts, problems) {
  if (!hosts.has(item.in)) {
    problems.push(`notices-inlined.json lists code inside ${item.in}, which is no longer in the app -- check the new version's files and update the list`);
  }
  return {
    kind: 'inlined',
    name: item.name,
    version: item.version,
    host: item.in,
    expression: item.license,
    source: item.source ?? null,
    holders: [],
    copyright: item.copyright,
    textFile: item.text ?? null,
    note: item.note ?? null,
  };
}

// ---------- licence texts ----------

const NOT_TEXT = /\.(c|m)?[jt]sx?$|\.json$|\.spdx$|\.map$/i;
const HINTS = [
  [/apache/i, 'Apache-2.0'],
  [/mit/i, 'MIT'],
  [/bsd/i, 'BSD'],
  [/zlib/i, 'Zlib'],
  [/boost|bsl/i, 'BSL-1.0'],
  [/unicode/i, 'Unicode-3.0'],
  [/isc/i, 'ISC'],
  [/cc0/i, 'CC0-1.0'],
  [/mpl/i, 'MPL-2.0'],
  [/epl/i, 'EPL-2.0'],
];

function licenceFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^licen[cs]e/i.test(f) && !NOT_TEXT.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

function noticeFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^notice/i.test(f) && !NOT_TEXT.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

// For a dual-licensed package, keep the file for the licence chosen; files named for no licence stay.
function filesForChoice(files, chosen) {
  const bases = chosen.map(baseId);
  return files.filter((f) => {
    const rest = f.replace(/^licen[cs]e/i, '');
    const hint = HINTS.find(([re]) => re.test(rest));
    if (!hint) return true;
    return bases.some((id) => id === hint[1] || (hint[1] === 'BSD' && id.startsWith('BSD-')));
  });
}

export function normalise(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function template(id) {
  const file = join(TEXTS_DIR, `${baseId(id)}.txt`);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

function copyrightLine(entry) {
  if (entry.copyright) return entry.copyright;
  const who = entry.holders.length > 0 ? entry.holders.join(', ') : `the ${entry.name} authors`;
  return `Copyright (c) ${who}`;
}

/** The texts that apply to one entry, or a problem when none can be found. */
function textsFor(entry, problems) {
  const label = entryLabel(entry);
  if (entry.textFile) {
    return [normalise(readFileSync(join(TEXTS_DIR, entry.textFile), 'utf8'))];
  }
  const texts = [];
  if (entry.dir) {
    const files = filesForChoice(licenceFiles(entry.dir), entry.chosen);
    for (const f of files) {
      let text = readFileSync(join(entry.dir, f), 'utf8');
      if (entry.cut && text.includes(entry.cut)) text = text.slice(0, text.indexOf(entry.cut));
      texts.push(normalise(text));
    }
    for (const f of noticeFiles(entry.dir)) texts.push(normalise(readFileSync(join(entry.dir, f), 'utf8')));
  }
  if (texts.length > 0) return texts;
  // No licence file: the standard text with a copyright line from the package's own metadata.
  for (const id of entry.chosen) {
    const body = template(id);
    if (!body) {
      problems.push(`${label}: no licence file and no standard text for ${id} in scripts/licence-texts`);
      continue;
    }
    texts.push(normalise(`${copyrightLine(entry)}\n\n${body}`));
  }
  return texts;
}

// ---------- the document ----------

function stripContact(s) {
  return String(s).replace(/\s*<[^>]*>/g, '').replace(/\s*\([^)]*\)/g, '').trim();
}

function entryLabel(e) {
  return e.kind === 'inlined' ? `${e.name} ${e.version} (inside ${e.host})` : `${e.name} ${e.version}`;
}

const byName = (a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0;

/** Builds the notices text and lists every problem found. Pure apart from reading licence files. */
export function buildNotices({ npm, crates, inlined }) {
  const problems = [];
  const entries = [
    ...npm.map(npmEntry).sort(byName),
    ...crates.map(crateEntry).sort(byName),
  ];
  const hosts = new Set(entries.map((e) => `${e.name}@${e.version}`));
  const inner = inlined
    .map((item) => inlinedEntry(item, hosts, problems))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : byName(a, b)));
  const all = [...entries, ...inner];

  const texts = new Map(); // text -> { n, users }
  for (const e of all) {
    if (!e.expression) {
      problems.push(`${entryLabel(e)}: no licence stated -- read its files and add it to STATED in scripts/notices.mjs`);
      continue;
    }
    try {
      e.chosen = chooseLicence(e.expression, e.name);
    } catch (err) {
      problems.push(`${entryLabel(e)}: ${err.message}`);
      continue;
    }
    if (!e.chosen) {
      problems.push(`${entryLabel(e)}: licence "${e.expression}" is not on the allow-list`);
      continue;
    }
    // A package that ships on its own as well already has its texts.
    const twin = e.kind === 'inlined' && entries.find((x) => x.name === e.name && x.version === e.version);
    if (twin?.textIds) {
      e.textIds = twin.textIds;
      for (const n of e.textIds) [...texts.values()].find((t) => t.n === n).users.push(entryLabel(e));
      continue;
    }
    e.textIds = textsFor(e, problems).map((text) => {
      if (!texts.has(text)) texts.set(text, { n: texts.size + 1, users: [] });
      const t = texts.get(text);
      t.users.push(entryLabel(e));
      return t.n;
    });
  }

  const line = (e) => {
    const chosen = e.chosen ? e.chosen.join(' AND ') : 'NOT ALLOWED';
    const choice = e.chosen && chosen !== e.expression ? ` (chosen from ${e.expression})` : '';
    const refs = (e.textIds ?? []).map((n) => `[text ${n}](#text-${n})`).join(', ');
    const source = e.source ? ` Source: <${e.source}>.` : '';
    const note = e.note ? ` ${e.note}` : '';
    return `- **${entryLabel(e)}**: ${chosen}${choice}. ${refs || 'No text'}.${source}${note}`;
  };
  const section = (title, list) => [`## ${title} (${list.length})`, '', ...list.map(line), ''];

  const out = [
    '# Third-party notices',
    '',
    'Lintel is MIT licensed. It includes the software below. Each entry names the licence Lintel uses it under, and links to the text that applies. A text shared by several entries is printed once.',
    '',
    'This file is generated by `node scripts/notices.mjs`. Do not edit it by hand.',
    '',
    ...section('JavaScript packages', all.filter((e) => e.kind === 'npm')),
    ...section('Rust crates', all.filter((e) => e.kind === 'crate')),
    ...section('Code inside other packages', inner),
    '## Licence texts',
    '',
  ];
  for (const [text, { n, users }] of texts) {
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)));
    out.push(`### Text ${n}`, '', `Used by: ${users.join(', ')}.`, '', `${fence}text`, text, fence, '');
  }
  return {
    markdown: out.join('\n'),
    problems,
    counts: {
      npm: entries.filter((e) => e.kind === 'npm').length,
      crates: entries.filter((e) => e.kind === 'crate').length,
      inlined: inner.length,
      texts: texts.size,
    },
  };
}

// ---------- command line ----------

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

/** Returns the exit code. `--modules` and `--crates` take JSON files instead of building (tests). */
export async function main(args, log = console) {
  const root = option(args, '--root') ?? join(SCRIPT_DIR, '..');
  const check = args.includes('--check');
  const problems = [];
  const modulesFile = option(args, '--modules');
  const ids = modulesFile ? readJson(modulesFile) : await viteModules(root);
  const npm = packagesFromModules(root, ids, problems);
  const cratesFile = option(args, '--crates');
  const crates = cratesFile ? readJson(cratesFile) : cargoCrates(root);
  const inlinedFile = join(root, 'scripts', 'notices-inlined.json');
  const inlined = existsSync(inlinedFile) ? readJson(inlinedFile) : [];

  const result = buildNotices({ npm, crates, inlined });
  problems.push(...result.problems);
  const target = join(root, NOTICES_FILE);
  const { npm: n, crates: c, inlined: i, texts: t } = result.counts;
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current !== result.markdown) {
      problems.push(`${NOTICES_FILE} is out of date -- run: node scripts/notices.mjs`);
      const names = (md) => new Set((md ?? '').split('\n').filter((l) => l.startsWith('- **')).map((l) => l.split('**')[1]));
      const [was, now] = [names(current), names(result.markdown)];
      for (const name of now) if (!was.has(name)) problems.push(`  new: ${name}`);
      for (const name of was) if (!now.has(name)) problems.push(`  gone: ${name}`);
    }
  } else {
    writeFileSync(target, result.markdown);
    log.log(`Wrote ${NOTICES_FILE}: ${n} npm packages, ${c} crates, ${i} inlined, ${t} texts.`);
  }
  for (const p of problems) log.error(`notices: ${p}`);
  if (check && problems.length === 0) log.log(`${NOTICES_FILE} is up to date: ${n} npm packages, ${c} crates, ${i} inlined.`);
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
