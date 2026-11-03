// Pure build outputs: never release state. Immutable, input-keyed prereleases
// keep native binaries available when the shared Actions cache evicts them.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARIES = ['buzz-agent', 'buzz-dev-mcp'];
const INDEX = 'native-agent-cache.json';
// One recipe owns both Cargo's real arguments and its cache identity.
export const NATIVE_CARGO_BUILD_FLAGS = Object.freeze([
  '--release', '--locked', '--package', 'buzz-agent', '--package', 'buzz-dev-mcp',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function assertIdentity(identity) {
  if (!/^buzz-agent-v2-(?:linux-x64|darwin-arm64|darwin-x64)-[0-9a-f]{64}$/.test(identity.key ?? '') ||
      identity.tag !== `helper-native-${identity.key}`) throw new Error('invalid native cache identity');
}
function capture(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function nativeCacheIdentity(platform, { env = process.env, captureVersion = capture } = {}) {
  if (!['linux-x64', 'darwin-arm64', 'darwin-x64'].includes(platform)) throw new Error('unsupported native cache platform');
  const builder = readFileSync(new URL('./build-beeline-bundle.mjs', import.meta.url), 'utf8');
  const ref = env.BEELINE_BUZZ_REF ?? /BEELINE_BUZZ_REF \?\? '([0-9a-f]{40})'/.exec(builder)?.[1];
  if (!/^[0-9a-f]{40}$/.test(ref ?? '')) throw new Error('native cache requires a pinned upstream commit');
  const mac = platform.startsWith('darwin');
  const inputs = {
    platform, ref,
    build: NATIVE_CARGO_BUILD_FLAGS,
    rustc: captureVersion('rustc', ['-vV']), cargo: captureVersion('cargo', ['--version']),
    compiler: captureVersion(env.CC || (mac ? 'xcrun' : 'cc'), mac && !env.CC ? ['clang', '--version'] : ['--version']),
    cxx: captureVersion(env.CXX || (mac ? 'xcrun' : 'c++'), mac && !env.CXX ? ['clang++', '--version'] : ['--version']),
    sdk: mac ? captureVersion('xcrun', ['--show-sdk-version']) : captureVersion('ldd', ['--version']),
    flags: Object.fromEntries([
      'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CARGO_PROFILE_RELEASE_LTO',
      'MACOSX_DEPLOYMENT_TARGET', 'SDKROOT', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS',
    ].concat(Object.keys(env).filter(name => /^CARGO_(?:PROFILE_RELEASE_|TARGET_.*_(?:RUSTFLAGS|LINKER)$)/.test(name))).sort().map(name => [name, env[name] ?? ''])),
  };
  if (!inputs.rustc || !inputs.cargo || !inputs.compiler || !inputs.cxx || !inputs.sdk) throw new Error('native cache compiler identity is incomplete');
  const key = `buzz-agent-v2-${platform}-${hash(JSON.stringify(inputs))}`;
  return { key, tag: `helper-native-${key}`, directory: `.beeline-tools/target/${platform}/release` };
}

export async function restoreNativeBinaries({ github, repo, identity, directory = identity.directory, verifyOnly = false }) {
  assertIdentity(identity);
  const { data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag: identity.tag });
  if (!release.prerelease || release.draft) throw new Error('native cache must be a published prerelease');
  const download = async name => {
    const asset = release.assets.find(asset => asset.name === name);
    if (!asset) throw new Error(`native cache missing ${name}`);
    const { data } = await github.rest.repos.getReleaseAsset({ ...repo, asset_id: asset.id, headers: { accept: 'application/octet-stream' } });
    return Buffer.from(data);
  };
  const index = JSON.parse((await download(INDEX)).toString('utf8'));
  if (index.schemaVersion !== 1 || index.key !== identity.key) throw new Error('native cache identity mismatch');
  // Validate the complete pair before either binary becomes available.
  const files = await Promise.all(BINARIES.map(async name => {
    const bytes = await download(name);
    if (!bytes.length || index.binaries?.[name]?.bytes !== bytes.length || index.binaries[name].sha256 !== hash(bytes)) {
      throw new Error(`native cache integrity mismatch for ${name}`);
    }
    return { name, bytes };
  }));
  if (verifyOnly) return true;
  await mkdir(directory, { recursive: true });
  for (const { name, bytes } of files) {
    await writeFile(resolve(directory, name), bytes);
    await chmod(resolve(directory, name), 0o755);
  }
  return true;
}

export async function saveNativeBinaries({ github, repo, identity, directory = identity.directory, sourceSha }) {
  assertIdentity(identity);
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('native cache needs its producer commit');
  try {
    await restoreNativeBinaries({ github, repo, identity, verifyOnly: true });
    return; // An existing verified immutable cache needs no writes.
  } catch { /* A verified fresh build repairs missing or partial cache bytes. */ }
  const files = await Promise.all(BINARIES.map(async name => {
    const bytes = await readFile(resolve(directory, name));
    if (!bytes.length) throw new Error(`empty native binary ${name}`);
    return { name, bytes };
  }));
  const index = { schemaVersion: 1, key: identity.key, binaries: Object.fromEntries(files.map(({ name, bytes }) => [name, { bytes: bytes.length, sha256: hash(bytes) }])) };
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag: identity.tag }));
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      ({ data: release } = await github.rest.repos.createRelease({
        ...repo, tag_name: identity.tag, target_commitish: sourceSha,
        name: identity.key, prerelease: true, make_latest: 'false',
        body: 'Verified native helper build outputs, keyed by upstream commit, platform, compiler and build flags. Not a production release.',
      }));
    } catch (error) {
      if (error.status !== 422) throw error;
      ({ data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag: identity.tag }));
    }
  }
  if (!release.prerelease || release.draft) throw new Error('refusing to modify a non-cache release');
  // The index is the commit point. Missing/partial uploads remain cache misses.
  for (const { name, bytes } of [...files, { name: INDEX, bytes: Buffer.from(`${JSON.stringify(index)}\n`) }]) {
    const previous = release.assets.find(asset => asset.name === name);
    if (previous) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: previous.id });
    await github.rest.repos.uploadReleaseAsset({
      ...repo, release_id: release.id, name, data: bytes,
      headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length },
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = nativeCacheIdentity(process.argv[2]);
  for (const [name, value] of Object.entries(identity)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
