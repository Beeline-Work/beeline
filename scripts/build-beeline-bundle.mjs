#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const UPSTREAM_REF = process.env.BEELINE_BUZZ_REF ?? '07a3c768d619db31fee3f0590f9433cdd1213e8f';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = resolve(repoRoot, '.beeline-tools');
const outputRoot = resolve(repoRoot, 'relay-stack', 'web', 'dl');
const supportedPlatforms = new Set(['linux-x64', 'darwin-arm64']);

function fail(message) {
  console.error(`build-beeline-bundle: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0) return '';
  return result.stdout.trim();
}

function hostPlatform() {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : '';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  return os && arch ? `${os}-${arch}` : '';
}

function parsePlatform() {
  const index = process.argv.indexOf('--platform');
  const platform = index >= 0 ? process.argv[index + 1] : hostPlatform();
  if (!platform || !supportedPlatforms.has(platform)) {
    fail(`unsupported platform '${platform ?? ''}'; expected linux-x64 or darwin-arm64`);
  }
  return platform;
}

async function executable(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveAgentBinaries(platform) {
  let agent = process.env.BUZZ_AGENT_BIN ?? '';
  let mcp = process.env.BUZZ_DEV_MCP_BIN ?? '';
  if (Boolean(agent) !== Boolean(mcp)) {
    fail('set both BUZZ_AGENT_BIN and BUZZ_DEV_MCP_BIN, or neither');
  }

  if (!agent && platform === hostPlatform()) {
    agent = capture('sh', ['-c', 'command -v buzz-agent || true']);
    mcp = capture('sh', ['-c', 'command -v buzz-dev-mcp || true']);
  }

  if (!agent || !mcp) {
    if (platform !== hostPlatform()) {
      fail(
        `cross-platform ${platform} binaries must be supplied with BUZZ_AGENT_BIN and BUZZ_DEV_MCP_BIN`,
      );
    }
    if (!capture('sh', ['-c', 'command -v cargo || true'])) {
      fail('cargo is required to build buzz-agent and buzz-dev-mcp');
    }
    const upstreamRoot = resolve(toolsRoot, 'block-buzz');
    const targetRoot = resolve(toolsRoot, 'target', platform);
    await mkdir(toolsRoot, { recursive: true });
    try {
      await access(resolve(upstreamRoot, '.git'));
    } catch {
      run('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        'https://github.com/block/buzz.git',
        upstreamRoot,
      ]);
    }
    run('git', ['-C', upstreamRoot, 'fetch', '--depth', '1', 'origin', UPSTREAM_REF]);
    run('git', ['-C', upstreamRoot, 'checkout', '--detach', '--force', 'FETCH_HEAD']);
    run('cargo', [
      'build',
      '--manifest-path',
      resolve(upstreamRoot, 'Cargo.toml'),
      '--release',
      '--locked',
      '--package',
      'buzz-agent',
      '--package',
      'buzz-dev-mcp',
      '--target-dir',
      targetRoot,
    ]);
    agent = resolve(targetRoot, 'release', 'buzz-agent');
    mcp = resolve(targetRoot, 'release', 'buzz-dev-mcp');
  }

  for (const path of [agent, mcp]) {
    if (!(await executable(path))) fail(`executable not found: ${path}`);
  }
  return { agent: resolve(agent), mcp: resolve(mcp) };
}

function assertBinaryPlatform(path, platform) {
  const description = capture('file', ['-b', path]);
  if (!description) return;
  const valid =
    platform === 'linux-x64'
      ? description.includes('ELF 64-bit') && description.includes('x86-64')
      : description.includes('Mach-O') &&
        (description.includes('arm64') || description.includes('universal binary'));
  if (!valid) fail(`${basename(path)} is not a ${platform} executable (${description})`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  const contents = await readFile(path);
  hash.update(contents);
  return hash.digest('hex');
}

async function main() {
  const platform = parsePlatform();
  const binaries = await resolveAgentBinaries(platform);
  assertBinaryPlatform(binaries.agent, platform);
  assertBinaryPlatform(binaries.mcp, platform);

  const sourceCommit =
    process.env.BEELINE_BUNDLE_COMMIT ?? capture('git', ['rev-parse', 'HEAD']) ?? '';
  if (!sourceCommit) fail('could not determine the source commit (set BEELINE_BUNDLE_COMMIT)');
  const buildVersion =
    process.env.BEELINE_BUNDLE_VERSION ??
    new Date().toISOString().slice(0, 10).replace(/-/g, '.');

  run('npm', ['run', 'build', '-w', '@beeline/nostr']);
  run('npm', ['run', 'build', '-w', '@beeline/buzz-client']);
  run('npm', ['run', 'build', '-w', '@beeline/gate']);
  run('npm', ['run', 'build', '-w', '@beeline/body']);

  const staging = resolve(toolsRoot, 'bundle', platform);
  await rm(staging, { recursive: true, force: true });
  await mkdir(resolve(staging, 'bin'), { recursive: true });
  await mkdir(resolve(staging, 'lib', 'beeline'), { recursive: true });
  await mkdir(outputRoot, { recursive: true });

  run('npx', [
    '--no-install',
    'esbuild',
    resolve(repoRoot, 'apps/body/dist/cli.js'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    "--banner:js=import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
    '--define:import.meta.url="beeline:bundle"',
    `--outfile=${resolve(staging, 'lib', 'beeline', 'beeline-cli.mjs')}`,
  ]);
  run('npx', [
    '--no-install',
    'esbuild',
    resolve(repoRoot, 'apps/body/dist/read-only-mcp.js'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    `--outfile=${resolve(staging, 'lib', 'beeline', 'beeline-readonly-mcp.mjs')}`,
  ]);

  await copyFile(binaries.agent, resolve(staging, 'bin', 'buzz-agent'));
  await copyFile(binaries.mcp, resolve(staging, 'bin', 'buzz-dev-mcp'));
  await chmod(resolve(staging, 'bin', 'buzz-agent'), 0o755);
  await chmod(resolve(staging, 'bin', 'buzz-dev-mcp'), 0o755);
  // The in-bundle wrappers never hand node a '..' component (node's module
  // resolver mis-resolves '..' after a symlinked directory — the exact
  // MODULE_NOT_FOUND shape from the layout regression). Executed through the
  // installed forwarders, BEELINE_LIB_DIR is already exported by the
  // forwarder as the clean ANCHOR path (<prefix>/lib/beeline); executed
  // directly inside a bundle, the wrapper computes its own release's lib the
  // same cd+pwd way. See apps/body/src/self-update.ts, "THE CONTRACT".
  const wrapperPrologue = [
    '#!/bin/sh',
    'set -eu',
    'case $0 in',
    '  /*) script_path=$0 ;;',
    '  *) script_path=$(pwd -P)/$0 ;;',
    'esac',
    'if [ -z "${BEELINE_LIB_DIR:-}" ]; then',
    '  BEELINE_LIB_DIR=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)/lib/beeline',
    'fi',
    'export BEELINE_LIB_DIR',
  ].join('\n');
  await writeFile(
    resolve(staging, 'bin', 'buzz-readonly-mcp'),
    `${wrapperPrologue}\nexec node "$BEELINE_LIB_DIR/beeline-readonly-mcp.mjs"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    resolve(staging, 'bin', 'beeline'),
    `${wrapperPrologue}\n: "\${BUZZ_AGENT_BIN:=$(dirname -- "$script_path")/buzz-agent}"\n: "\${BUZZ_DEV_MCP_BIN:=$(dirname -- "$script_path")/buzz-dev-mcp}"\n: "\${BUZZ_READONLY_MCP_BIN:=$(dirname -- "$script_path")/buzz-readonly-mcp}"\n# Self-update needs to know its own install anchor (import.meta.url is defined away inside the esbuild bundle).\nexport BUZZ_AGENT_BIN BUZZ_DEV_MCP_BIN BUZZ_READONLY_MCP_BIN\nexec node "$BEELINE_LIB_DIR/lib/beeline/beeline-cli.mjs" "$@"\n`,
    { mode: 0o755 },
  );

  await writeFile(
    resolve(staging, 'lib', 'beeline', 'bundle.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: 'beeline',
        platform,
        node: '>=20.11.0',
        // Self-update identity (self-update.ts reads this from the INSTALLED
        // bundle — never from a checkout). version is a comparable
        // YYYY.MM.DD build date; commit is the exact source revision.
        commit: sourceCommit,
        version: buildVersion,
      },
      null,
      2,
    )}\n`,
  );

  const filename = `beeline-${platform}.tar.gz`;
  const archive = resolve(outputRoot, filename);
  await rm(archive, { force: true });
  run('tar', ['-C', staging, '-czf', archive, 'bin', 'lib']);
  const digest = await sha256(archive);
  await writeFile(`${archive}.sha256`, `${digest}  ${filename}\n`);

  const manifestPath = resolve(outputRoot, 'manifest.json');
  let manifest = { schemaVersion: 1, bundles: {} };
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    // First platform built.
  }
  const archiveStat = await stat(archive);
  manifest.schemaVersion = 1;
  manifest.sourceCommit = sourceCommit;
  manifest.version = buildVersion;
  manifest.bundles ??= {};
  manifest.bundles[platform] = {
    file: filename,
    sha256: digest,
    bytes: archiveStat.size,
    node: '>=20.11.0',
    commit: sourceCommit,
    version: buildVersion,
  };
  // Prove the just-written artifact installs and starts from a cwd with no
  // checkout and no BUZZ_READONLY_MCP_* overrides. This keeps release bundles
  // from drifting behind the read-only boundary implemented by Body.
  // Cross-platform builds cannot run this probe; manifest.json records the
  // honest per-platform verification status instead of implying it, and is
  // written only AFTER the probe so it never claims an unverified bundle.
  let verified = false;
  if (platform === hostPlatform()) {
    run(process.execPath, [
      resolve(repoRoot, 'scripts', 'verify-beeline-install.mjs'),
      '--platform',
      platform,
    ]);
    verified = true;
  } else {
    console.log(
      `build-beeline-bundle: skipping executable install probe for cross-platform ${platform}`,
    );
  }

  manifest.bundles[platform].verified = verified;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`build-beeline-bundle: ${archive}`);
  console.log(`build-beeline-bundle: sha256 ${digest}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
