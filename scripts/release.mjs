// Writes and checks the release's latest.json, the file installed copies of Lintel read to
// find updates. Uses Node's built-ins only, so the signing job installs nothing else.
// Run: node scripts/release.mjs updaters | manifest <dir> | check <dir>
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'robgaskell/lintel';
const CONF = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json');

/** The files the build jobs produce for `version`, as the bundler names them. */
export function assetNames(version) {
  return {
    dmg: `Lintel_${version}_universal.dmg`,
    mac: `Lintel_${version}_universal.app.tar.gz`,
    windows: `Lintel_${version}_x64-setup.exe`,
    debX64: `Lintel_${version}_amd64.deb`,
    rpmX64: `Lintel-${version}-1.x86_64.rpm`,
    debArm: `Lintel_${version}_arm64.deb`,
    rpmArm: `Lintel-${version}-1.aarch64.rpm`,
  };
}

// The updater looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
export const UPDATER_KEYS = {
  'darwin-universal': 'mac',
  'darwin-aarch64': 'mac',
  'darwin-x86_64': 'mac',
  'windows-x86_64': 'windows',
  'linux-x86_64': 'debX64',
  'linux-x86_64-deb': 'debX64',
  'linux-x86_64-rpm': 'rpmX64',
  'linux-aarch64': 'debArm',
  'linux-aarch64-deb': 'debArm',
  'linux-aarch64-rpm': 'rpmArm',
};

/** The files an installed Lintel downloads as an update; each gets a .sig. */
export function updaterFiles(version) {
  const names = assetNames(version);
  return [...new Set(Object.values(UPDATER_KEYS))].map((asset) => names[asset]);
}

export function releaseFiles(version) {
  const updaters = updaterFiles(version);
  return [assetNames(version).dmg, ...updaters, ...updaters.map((f) => `${f}.sig`), 'latest.json'];
}

function assetUrl(version, file) {
  return `https://github.com/${REPO}/releases/download/v${version}/${file}`;
}

/** latest.json for the signed files in `dir`. Throws when a signature is missing. */
export function buildManifest({ dir, version, pubDate = new Date().toISOString() }) {
  const names = assetNames(version);
  const platforms = {};
  for (const [key, asset] of Object.entries(UPDATER_KEYS)) {
    const sigFile = join(dir, `${names[asset]}.sig`);
    if (!existsSync(sigFile)) throw new Error(`missing signature ${names[asset]}.sig`);
    platforms[key] = { signature: readFileSync(sigFile, 'utf8').trim(), url: assetUrl(version, names[asset]) };
  }
  return {
    version,
    notes: 'See the README for install steps on each system.',
    pub_date: pubDate,
    platforms,
  };
}

const decode = (base64) => Buffer.from(base64.trim(), 'base64').toString('utf8');
// minisign prints a key id as the little-endian number in hex.
const keyIdText = (bytes) => Buffer.from(bytes).reverse().toString('hex').toUpperCase();

/**
 * Checks a Tauri updater signature (a base64 minisign signature) as the updater does,
 * including the version the Tauri signer writes into the signed comment.
 */
export function verifySignature(data, signatureB64, pubkeyB64, version) {
  const pub = Buffer.from(decode(pubkeyB64).split('\n')[1], 'base64');
  const [, sigLine, commentLine, globalLine] = decode(signatureB64).split('\n');
  const sig = Buffer.from(sigLine, 'base64');
  const pubId = keyIdText(pub.subarray(2, 10));
  const sigId = keyIdText(sig.subarray(2, 10));
  if (pubId !== sigId) throw new Error(`signed with key ${sigId}, but tauri.conf.json has key ${pubId}`);
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.subarray(10).toString('base64url') }, format: 'jwk' });
  const alg = sig.subarray(0, 2).toString();
  const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, signed, key, sig.subarray(10))) throw new Error('signature does not match the file');
  const comment = commentLine.replace(/^trusted comment: /, '');
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), key, Buffer.from(globalLine, 'base64'))) {
    throw new Error('signed comment does not match its signature');
  }
  const signedVersion = comment.split('\t').find((f) => f.startsWith('version:'))?.slice('version:'.length);
  if (signedVersion !== version) throw new Error(`signed for version ${signedVersion}, not ${version}`);
}

/** Problems with the release in `dir`: its files, latest.json, and every signature. */
export function checkRelease({ dir, version, pubkey }) {
  const problems = [];
  const expected = releaseFiles(version);
  for (const file of expected) if (!existsSync(join(dir, file))) problems.push(`missing ${file}`);
  for (const file of readdirSync(dir)) if (!expected.includes(file)) problems.push(`unexpected file ${file}`);
  if (!existsSync(join(dir, 'latest.json'))) return problems;

  const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  if (manifest.version !== version) problems.push(`latest.json version is ${manifest.version}, not ${version}`);
  const names = assetNames(version);
  for (const [key, asset] of Object.entries(UPDATER_KEYS)) {
    const entry = manifest.platforms?.[key];
    if (!entry) {
      problems.push(`${key}: missing from latest.json`);
      continue;
    }
    const url = assetUrl(version, names[asset]);
    if (entry.url !== url) problems.push(`${key}: URL is ${entry.url}, not ${url}`);
    if (!entry.signature) {
      problems.push(`${key}: no signature`);
      continue;
    }
    const file = join(dir, names[asset]);
    if (!existsSync(file)) continue;
    try {
      verifySignature(readFileSync(file), entry.signature, pubkey, version);
    } catch (err) {
      problems.push(`${key}: ${names[asset]} ${err.message}`);
    }
  }
  return problems;
}

function main([command, dir]) {
  const conf = JSON.parse(readFileSync(CONF, 'utf8'));
  const version = conf.version;
  if (command === 'updaters') {
    console.log(updaterFiles(version).join('\n'));
  } else if (command === 'manifest') {
    writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(buildManifest({ dir, version }), null, 2)}\n`);
  } else if (command === 'check') {
    const problems = checkRelease({ dir, version, pubkey: conf.plugins.updater.pubkey });
    for (const p of problems) console.error(`release: ${p}`);
    if (problems.length > 0) return 1;
    console.log(`release: ${releaseFiles(version).length} files and ${Object.keys(UPDATER_KEYS).length} latest.json keys check out for v${version}.`);
  } else {
    console.error('usage: node scripts/release.mjs updaters | manifest <dir> | check <dir>');
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
