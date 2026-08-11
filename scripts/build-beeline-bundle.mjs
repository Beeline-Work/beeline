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
    '--define:import.meta.url="beeline:bundle"',
    `--outfile=${resolve(staging, 'lib', 'beeline', 'beeline-cli.mjs')}`,
  ]);

  await copyFile(binaries.agent, resolve(staging, 'bin', 'buzz-agent'));
  await copyFile(binaries.mcp, resolve(staging, 'bin', 'buzz-dev-mcp'));
  await chmod(resolve(staging, 'bin', 'buzz-agent'), 0o755);
  await chmod(resolve(staging, 'bin', 'buzz-dev-mcp'), 0o755);
  await writeFile(
    resolve(staging, 'bin', 'beeline'),
    `#!/bin/sh\nset -eu\nbin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nlib_dir=$(CDPATH= cd -- "$bin_dir/../lib/beeline" && pwd -P)\n: "\${BUZZ_AGENT_BIN:=$bin_dir/buzz-agent}"\n: "\${BUZZ_DEV_MCP_BIN:=$bin_dir/buzz-dev-mcp}"\nexport BUZZ_AGENT_BIN BUZZ_DEV_MCP_BIN\nexec node "$lib_dir/beeline-cli.mjs" "$@"\n`,
    { mode: 0o755 },
  );

  await writeFile(
    resolve(staging, 'bundle.json'),
    `${JSON.stringify({ schemaVersion: 1, name: 'beeline', platform, node: '>=20.11.0' }, null, 2)}\n`,
  );

  const filename = `beeline-${platform}.tar.gz`;
  const archive = resolve(outputRoot, filename);
  await rm(archive, { force: true });
  run('tar', ['-C', staging, '-czf', archive, 'bin', 'lib', 'bundle.json']);
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
  manifest.bundles ??= {};
  manifest.bundles[platform] = {
    file: filename,
    sha256: digest,
    bytes: archiveStat.size,
    node: '>=20.11.0',
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`build-beeline-bundle: ${archive}`);
  console.log(`build-beeline-bundle: sha256 ${digest}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
