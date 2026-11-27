import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assetNames, buildManifest, checkRelease, checkSigner, releaseFiles, UPDATER_KEYS, verifySignature } from './release.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/release/', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./release.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const CONF = JSON.parse(readFileSync(fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'));
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

// The fixture was signed by `tauri signer sign --app-version 9.9.9` with a throwaway key.
const fixture = {
  data: readFileSync(join(FIXTURES, 'Lintel_9.9.9_amd64.deb')),
  signature: readFileSync(join(FIXTURES, 'Lintel_9.9.9_amd64.deb.sig'), 'utf8'),
  pubkey: readFileSync(join(FIXTURES, 'test-key.pub'), 'utf8').trim(),
};

test('verifySignature accepts a file signed by the Tauri signer for its version', () => {
  verifySignature(fixture.data, fixture.signature, fixture.pubkey, '9.9.9');
});

test('verifySignature rejects a file whose bytes changed after signing', () => {
  const changed = Buffer.concat([fixture.data, Buffer.from('x')]);
  assert.throws(() => verifySignature(changed, fixture.signature, fixture.pubkey, '9.9.9'), /does not match the file/);
});

test('verifySignature rejects another key and names both key ids (Ruling 342 L3)', () => {
  assert.throws(
    () => verifySignature(fixture.data, fixture.signature, CONF.plugins.updater.pubkey, '9.9.9'),
    /FF174E1AEFD35E6F.*7D003332D294B971/,
  );
});

test('verifySignature rejects a signature bound to another version', () => {
  assert.throws(() => verifySignature(fixture.data, fixture.signature, fixture.pubkey, '9.9.10'), /version 9\.9\.9, not 9\.9\.10/);
});

test('verifySignature rejects a version edited into the signed comment', () => {
  const text = Buffer.from(fixture.signature, 'base64').toString('utf8').replace('version:9.9.9', 'version:9.9.10');
  assert.throws(
    () => verifySignature(fixture.data, Buffer.from(text).toString('base64'), fixture.pubkey, '9.9.10'),
    /signed comment does not match/,
  );
});

/** Signs as the Tauri signer does: minisign, prehashed, with the version in the trusted comment. */
function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.from('0123456789abcdef', 'hex');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const pubText = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  return {
    pubkey: Buffer.from(pubText).toString('base64'),
    sign(data, file, version, comment = `timestamp:1\tfile:${file}\tversion:${version}`) {
      const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
      const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
      const text = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`;
      return Buffer.from(text).toString('base64');
    },
  };
}

test('verifySignature rejects a signature that names no version (J20)', () => {
  const key = testKey();
  const data = Buffer.from('update');
  const unbound = key.sign(data, 'f', null, 'timestamp:1\tfile:f');
  assert.throws(() => verifySignature(data, unbound, key.pubkey, '1.2.3'), /names no version/);
});

/** A release folder with every asset signed, and its latest.json. */
function signedRelease(version = '1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  temps.push(dir);
  const key = testKey();
  for (const file of Object.values(assetNames(version))) {
    const data = Buffer.from(`bytes of ${file}`);
    writeFileSync(join(dir, file), data);
    if (!file.endsWith('.dmg')) writeFileSync(join(dir, `${file}.sig`), key.sign(data, file, version));
  }
  const manifest = buildManifest({ dir, version, pubDate: '2026-11-27T00:00:00.000Z' });
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest));
  return { dir, key, manifest, version };
}

test('buildManifest writes all 10 platform keys, each with its .sig text and its asset URL', () => {
  const { dir, manifest } = signedRelease();
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    'darwin-aarch64',
    'darwin-universal',
    'darwin-x86_64',
    'linux-aarch64',
    'linux-aarch64-deb',
    'linux-aarch64-rpm',
    'linux-x86_64',
    'linux-x86_64-deb',
    'linux-x86_64-rpm',
    'windows-x86_64',
  ]);
  assert.equal(manifest.version, '1.2.3');
  const base = 'https://github.com/robgaskell/lintel/releases/download/v1.2.3';
  assert.deepEqual(manifest.platforms['linux-aarch64-rpm'], {
    signature: readFileSync(join(dir, 'Lintel-1.2.3-1.aarch64.rpm.sig'), 'utf8'),
    url: `${base}/Lintel-1.2.3-1.aarch64.rpm`,
  });
  assert.equal(manifest.platforms['linux-x86_64'].url, `${base}/Lintel_1.2.3_amd64.deb`);
  assert.equal(manifest.platforms['darwin-x86_64'].url, `${base}/Lintel_1.2.3_universal.app.tar.gz`);
  assert.equal(manifest.platforms['windows-x86_64'].url, `${base}/Lintel_1.2.3_x64-setup.exe`);
});

test('buildManifest throws, naming the file, when a .sig is missing', () => {
  const { dir, version } = signedRelease();
  rmSync(join(dir, `${assetNames(version).rpmX64}.sig`));
  assert.throws(() => buildManifest({ dir, version }), /Lintel-1\.2\.3-1\.x86_64\.rpm\.sig/);
});

test('checkRelease finds no problems in a complete, correctly signed release', () => {
  const { dir, key, version } = signedRelease();
  assert.deepEqual(checkRelease({ dir, version, pubkey: key.pubkey }), []);
});

test('checkRelease reports a missing key, an empty signature, a wrong URL and changed bytes', () => {
  const { dir, key, manifest, version } = signedRelease();
  delete manifest.platforms['linux-aarch64'];
  manifest.platforms['windows-x86_64'].signature = '';
  manifest.platforms['darwin-universal'].url = 'https://example.com/Lintel_1.2.3_universal.app.tar.gz';
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, assetNames(version).rpmX64), 'changed');
  const problems = checkRelease({ dir, version, pubkey: key.pubkey }).join('\n');
  assert.match(problems, /linux-aarch64: missing/);
  assert.match(problems, /windows-x86_64: no signature/);
  assert.match(problems, /darwin-universal: URL is https:\/\/example\.com/);
  assert.match(problems, /linux-x86_64-rpm: .*does not match the file/);
});

test('checkRelease reports a latest.json version that is not the app version (J09)', () => {
  const { dir, key, manifest, version } = signedRelease();
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ ...manifest, version: '1.2.4' }));
  assert.match(checkRelease({ dir, version, pubkey: key.pubkey }).join('\n'), /latest\.json version is 1\.2\.4, not 1\.2\.3/);
});

test('the check command exits 1 and prints its problems for a bad release folder (J14)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  temps.push(dir);
  writeFileSync(join(dir, 'stray.txt'), 'x');
  const run = spawnSync(process.execPath, [SCRIPT, 'check', dir], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /release: missing latest\.json/);
  assert.match(run.stderr, /release: unexpected file stray\.txt/);
});

test('checkRelease reports a missing asset and an unexpected file', () => {
  const { dir, key, version } = signedRelease();
  rmSync(join(dir, assetNames(version).dmg));
  copyFileSync(join(FIXTURES, 'test-key.pub'), join(dir, 'stray.txt'));
  const problems = checkRelease({ dir, version, pubkey: key.pubkey }).join('\n');
  assert.match(problems, /missing Lintel_1\.2\.3_universal\.dmg/);
  assert.match(problems, /unexpected file stray\.txt/);
});

test('releaseFiles lists the .dmg, six updaters, their .sig files and latest.json', () => {
  assert.deepEqual(releaseFiles('1.2.3').sort(), [
    'Lintel-1.2.3-1.aarch64.rpm',
    'Lintel-1.2.3-1.aarch64.rpm.sig',
    'Lintel-1.2.3-1.x86_64.rpm',
    'Lintel-1.2.3-1.x86_64.rpm.sig',
    'Lintel_1.2.3_amd64.deb',
    'Lintel_1.2.3_amd64.deb.sig',
    'Lintel_1.2.3_arm64.deb',
    'Lintel_1.2.3_arm64.deb.sig',
    'Lintel_1.2.3_universal.app.tar.gz',
    'Lintel_1.2.3_universal.app.tar.gz.sig',
    'Lintel_1.2.3_universal.dmg',
    'Lintel_1.2.3_x64-setup.exe',
    'Lintel_1.2.3_x64-setup.exe.sig',
    'latest.json',
  ]);
  assert.equal(Object.keys(UPDATER_KEYS).length, 10);
});

const LOCK = readFileSync(fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)), 'utf8');
const CLI_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).devDependencies['@tauri-apps/cli'];
const lockIntegrity = (name) => LOCK.match(new RegExp(`'${name}@${CLI_VERSION}':\\n    resolution: \\{integrity: (sha512-[^}]+)\\}`))[1];

/** An npm install folder as npm leaves it, with these packages and integrities. */
function signerInstall(packages) {
  const dir = mkdtempSync(join(tmpdir(), 'signer-'));
  temps.push(dir);
  mkdirSync(join(dir, 'node_modules'));
  const entries = Object.fromEntries(
    Object.entries(packages).map(([name, integrity]) => [`node_modules/${name}`, { version: CLI_VERSION, integrity }]),
  );
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: entries }));
  return dir;
}

const lockedSigner = () => ({
  '@tauri-apps/cli': lockIntegrity('@tauri-apps/cli'),
  '@tauri-apps/cli-linux-x64-gnu': lockIntegrity('@tauri-apps/cli-linux-x64-gnu'),
});

test('checkSigner accepts the signer packages npm installed with pnpm-lock.yaml integrities', () => {
  assert.deepEqual(checkSigner({ dir: signerInstall(lockedSigner()), lock: LOCK, version: CLI_VERSION }), []);
});

test('checkSigner rejects a signer package whose integrity differs from pnpm-lock.yaml', () => {
  const dir = signerInstall({ ...lockedSigner(), '@tauri-apps/cli-linux-x64-gnu': 'sha512-AAAA' });
  assert.match(checkSigner({ dir, lock: LOCK, version: CLI_VERSION }).join('\n'), /@tauri-apps\/cli-linux-x64-gnu@.* integrity sha512-AAAA is not pnpm-lock\.yaml's/);
});

test('checkSigner rejects a package that is not in pnpm-lock.yaml and a missing native binary', () => {
  const dir = signerInstall({ '@tauri-apps/cli': lockIntegrity('@tauri-apps/cli'), 'left-pad': 'sha512-BBBB' });
  const problems = checkSigner({ dir, lock: LOCK, version: CLI_VERSION }).join('\n');
  assert.match(problems, /left-pad@.* is not in pnpm-lock\.yaml/);
  assert.match(problems, /no @tauri-apps\/cli-linux-x64-gnu/);
});

// Ruling 342 (M1, M2, L1, L2, L4): the key and a write token never meet build code.
const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
const jobText = (job) => JSON.stringify(workflow.jobs[job]);
const steps = (job) => workflow.jobs[job].steps;
const stepIndex = (job, pattern) => steps(job).findIndex((s) => pattern.test(s.run ?? ''));
const runOf = (job, pattern) => steps(job)[stepIndex(job, pattern)];

test('release.yml triggers on v* tag pushes and by hand only, with no path filter', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
});

test('release.yml cancels only runs of the same ref and the same event', () => {
  assert.match(workflow.concurrency.group, /github\.ref/);
  assert.match(workflow.concurrency.group, /github\.event_name/);
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('no step is switched off or allowed to fail: each if is one of the per-OS or tag/manual conditions', () => {
  const allowed = [
    "runner.os == 'Linux'",
    "runner.os == 'macOS'",
    "runner.os != 'macOS'",
    "runner.os == 'Windows'",
    "github.event_name == 'push'",
    "github.event_name != 'push'",
  ];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['continue-on-error'], undefined, name);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined, `${name}: ${step.name ?? step.run ?? step.uses}`);
      if (step.if !== undefined) assert.ok(allowed.includes(step.if), `${name}: if ${step.if}`);
    }
  }
  assert.ok(steps('publish').every((s) => s.if === undefined), 'every publish step runs');
});

test('release.yml pins every action by a full commit SHA', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
    }
  }
});

test('every checkout in release.yml keeps no credentials', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      assert.equal(step.with?.['persist-credentials'], false, name);
    }
  }
});

test('only the publish job has any permission beyond read', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'publish') continue;
    for (const [scope, level] of Object.entries(job.permissions ?? {})) {
      assert.ok(['read', 'none'].includes(level), `${name}: ${scope}: ${level}`);
    }
    assert.doesNotMatch(jobText(name), /gh release|github\.token|GITHUB_TOKEN/, name);
  }
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write', actions: 'read' });
});

test('the publish job runs only on a v* tag push, after signing, for the pushed tag', () => {
  const publish = workflow.jobs.publish;
  assert.equal(publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  assert.equal(publish.needs, 'sign');
  assert.equal(publish.env.TAG, '${{ github.ref_name }}');
  assert.doesNotMatch(jobText('publish'), /secrets\.|pnpm|tauri build|signer/);
});

test('publish checks CI on the commit and the signed files before it creates one draft with --draft --verify-tag', () => {
  const ci = stepIndex('publish', /actions\/workflows\/ci\.yml\/runs\?head_sha=\$GITHUB_SHA&status=success/);
  const check = stepIndex('publish', /^node scripts\/release\.mjs check release$/m);
  const creates = steps('publish').filter((s) => /gh release create/.test(s.run ?? ''));
  assert.equal(creates.length, 1);
  const create = stepIndex('publish', /gh release create/);
  assert.ok(ci === 0 && check > ci && create > check, `${ci} ${check} ${create}`);
  assert.match(steps('publish')[ci].run, /test "\$passed" -gt 0 \|\| \{[^}]*exit 1; \}/);
  assert.match(creates[0].run, /gh release view "\$TAG"[^\n]*\n\s*echo "A release for \$TAG already exists"\n\s*exit 1/);
  assert.match(creates[0].run, /gh release create "\$TAG" [^\n]*--draft[^\n]*--verify-tag/);
});

test('after creating it, publish checks there is exactly one release for the tag, a draft, whose files verify', () => {
  const verify = runOf('publish', /gh release download/);
  assert.ok(stepIndex('publish', /gh release download/) > stepIndex('publish', /gh release create/));
  assert.match(verify.run, /select\(\.tag_name == \\"\$TAG\\"\)/);
  assert.match(verify.run, /test "\$count" = 1/);
  assert.match(verify.run, /--json isDraft --jq \.isDraft\)" = true/);
  assert.match(verify.run, /gh release download "\$TAG" [^\n]*--dir uploaded\n\s*node scripts\/release\.mjs check uploaded/);
});

test('the check job fails a tag run whose tag is not v<app version>', () => {
  const step = runOf('check', /GITHUB_REF_NAME/);
  assert.equal(step.if, "github.event_name == 'push'");
  assert.match(step.run, /version=\$\(node -p "require\('\.\/src-tauri\/tauri\.conf\.json'\)\.version"\)/);
  assert.match(step.run, /test "\$GITHUB_REF_NAME" = "v\$version" \|\| \{[^}]*exit 1; \}/);
  assert.ok(stepIndex('check', /^node scripts\/notices\.mjs --check$/m) >= 0);
});

test('build jobs build without updater signing: --no-sign, or no updater artifacts on macOS', () => {
  assert.equal(runOf('build', /pnpm tauri build --no-sign$/m).if, "runner.os != 'macOS'");
  const mac = runOf('build', /--target universal-apple-darwin/);
  assert.equal(mac.if, "runner.os == 'macOS'");
  assert.match(mac.run, /--config '\{"bundle":\{"createUpdaterArtifacts":false\}\}'/);
  assert.equal(steps('build').filter((s) => /tauri build/.test(s.run ?? '')).length, 2);
});

test('no job, step or workflow env outside the signer step names a secret', () => {
  assert.doesNotMatch(JSON.stringify(workflow.env ?? {}), /secrets\./);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const { steps: jobSteps, ...rest } = job;
    assert.doesNotMatch(JSON.stringify(rest), /secrets\./, `${name} job level`);
    for (const step of jobSteps) {
      if (!JSON.stringify(step).includes('secrets.')) continue;
      assert.equal(name, 'sign');
      assert.match(step.run, /^\s*while read -r file; do\n\s*"\$RUNNER_TEMP\/signer\/node_modules\/\.bin\/tauri" signer sign --app-version "\$VERSION" "release\/\$file"\n\s*done < "\$RUNNER_TEMP\/updaters\.txt"\s*$/);
      assert.deepEqual(Object.keys(step.env).sort(), ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']);
    }
  }
  assert.equal(steps('sign').filter((s) => JSON.stringify(s).includes('secrets.')).length, 1);
});

test('the sign job builds nothing and checks the bundles and the signer before signing', () => {
  assert.equal(workflow.jobs.sign.needs, 'build');
  assert.doesNotMatch(jobText('sign'), /pnpm[ /]|tauri build|cargo/);
  assert.ok(steps('sign').every((s) => !s.with?.cache), 'no restored cache');
  const signer = stepIndex('sign', /signer sign/);
  const sums = stepIndex('sign', /^sha256sum -c SHA256SUMS-\*$/m);
  const lock = stepIndex('sign', /node scripts\/release\.mjs check-signer/);
  assert.ok(sums >= 0 && sums < signer, 'checksums before signing');
  assert.ok(lock >= 0 && lock < signer, 'signer integrity before signing');
  const manifest = stepIndex('sign', /node scripts\/release\.mjs manifest release/);
  const check = stepIndex('sign', /^node scripts\/release\.mjs check release/m);
  assert.ok(signer < manifest && manifest < check, 'latest.json written then checked');
});

test('a manual run uploads only latest.json and the verification report, never signed files', () => {
  const uploads = steps('sign').filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
  const signed = uploads.find((s) => s.with.path === 'release/');
  assert.equal(signed.if, "github.event_name == 'push'");
  const report = uploads.find((s) => s !== signed);
  assert.equal(report.if, "github.event_name != 'push'");
  assert.equal(report.with.path, 'report/');
  const writes = runOf('sign', /report\/verification\.txt/).run;
  assert.match(writes, /cp release\/latest\.json report\//);
  assert.doesNotMatch(writes, /\.sig|cp release\/\*|cp -r release/);
  assert.equal(uploads.length, 2);
});
