import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assetNames, buildManifest, checkRelease, releaseFiles, UPDATER_KEYS, verifySignature } from './release.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/release/', import.meta.url));
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

test('a signature made by the Tauri signer verifies', () => {
  verifySignature(fixture.data, fixture.signature, fixture.pubkey, '9.9.9');
});

test('changed bytes fail the signature check', () => {
  const changed = Buffer.concat([fixture.data, Buffer.from('x')]);
  assert.throws(() => verifySignature(changed, fixture.signature, fixture.pubkey, '9.9.9'), /does not match the file/);
});

test('a signature from another key names both key ids (Ruling 342 L3)', () => {
  assert.throws(
    () => verifySignature(fixture.data, fixture.signature, CONF.plugins.updater.pubkey, '9.9.9'),
    /FF174E1AEFD35E6F.*7D003332D294B971/,
  );
});

test('a signature for another version fails', () => {
  assert.throws(() => verifySignature(fixture.data, fixture.signature, fixture.pubkey, '9.9.10'), /version 9\.9\.9, not 9\.9\.10/);
});

test('a version edited into the signed comment fails', () => {
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
    sign(data, file, version) {
      const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
      const comment = `timestamp:1\tfile:${file}\tversion:${version}`;
      const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
      const text = `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`;
      return Buffer.from(text).toString('base64');
    },
  };
}

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

test('latest.json names every platform key, each with its signature and asset URL', () => {
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

test('latest.json is not written while a signature is missing', () => {
  const { dir, version } = signedRelease();
  rmSync(join(dir, `${assetNames(version).rpmX64}.sig`));
  assert.throws(() => buildManifest({ dir, version }), /Lintel-1\.2\.3-1\.x86_64\.rpm\.sig/);
});

test('a complete, correctly signed release has no problems', () => {
  const { dir, key, version } = signedRelease();
  assert.deepEqual(checkRelease({ dir, version, pubkey: key.pubkey }), []);
});

test('the release check reports a missing key, an empty signature, a wrong URL and changed bytes', () => {
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

test('the release check reports a missing asset and an unexpected file', () => {
  const { dir, key, version } = signedRelease();
  rmSync(join(dir, assetNames(version).dmg));
  copyFileSync(join(FIXTURES, 'test-key.pub'), join(dir, 'stray.txt'));
  const problems = checkRelease({ dir, version, pubkey: key.pubkey }).join('\n');
  assert.match(problems, /missing Lintel_1\.2\.3_universal\.dmg/);
  assert.match(problems, /unexpected file stray\.txt/);
});

test('the release ships the installers, their signatures and latest.json', () => {
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

// Ruling 342 (M1, M2, L1, L2, L4): the key and a write token never meet build code.
const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
const jobText = (job) => JSON.stringify(workflow.jobs[job]);
const steps = (job) => workflow.jobs[job].steps;

test('release.yml runs on v* tags and by hand only, one run per ref and event', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
  assert.match(workflow.concurrency.group, /github\.event_name/);
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('release.yml pins every action by commit and keeps no checkout credentials', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.uses) continue;
      assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
      if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false, name);
    }
  }
});

test('only the tag-only publish job may write, and it creates one draft release', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'publish') continue;
    assert.ok(!job.permissions || job.permissions.contents === 'read', name);
    assert.doesNotMatch(jobText(name), /gh release|github\.token|GITHUB_TOKEN/, name);
  }
  const publish = workflow.jobs.publish;
  assert.equal(publish.permissions.contents, 'write');
  assert.equal(publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  assert.deepEqual(publish.needs, 'sign');
  assert.doesNotMatch(jobText('publish'), /secrets\.|pnpm|tauri build|signer/);
  const creates = steps('publish').filter((s) => /gh release create/.test(s.run ?? ''));
  assert.equal(creates.length, 1);
  assert.match(creates[0].run, /gh release create "\$TAG" [^\n]*--draft/);
  assert.match(jobText('publish'), /actions\/workflows\/ci\.yml\/runs\?head_sha=/);
});

test('the signing key reaches only the signer, in a job that builds nothing', () => {
  for (const name of Object.keys(workflow.jobs)) {
    if (name !== 'sign') assert.doesNotMatch(jobText(name), /secrets\./, name);
  }
  assert.doesNotMatch(jobText('sign'), /pnpm|tauri build|cargo/);
  assert.ok(steps('sign').every((s) => !s.with?.cache), 'no restored cache in the signing job');
  for (const step of steps('sign')) {
    const usesKey = JSON.stringify(step).includes('secrets.');
    if (usesKey) assert.match(step.run, /signer sign/);
  }
  assert.ok(steps('sign').some((s) => JSON.stringify(s).includes('secrets.TAURI_SIGNING_PRIVATE_KEY')));
  assert.deepEqual(workflow.jobs.sign.needs, 'build');
});
