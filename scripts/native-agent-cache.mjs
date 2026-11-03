// Pure compiler outputs in Actions cache, never release state or GitHub Releases.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One recipe owns both Cargo's real arguments and its cache identity.
export const NATIVE_CARGO_BUILD_FLAGS = Object.freeze([
  '--release', '--locked', '--package', 'buzz-agent', '--package', 'buzz-dev-mcp',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
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
  return { key, directory: `.beeline-tools/target/${platform}/release` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = nativeCacheIdentity(process.argv[2]);
  for (const [name, value] of Object.entries(identity)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
