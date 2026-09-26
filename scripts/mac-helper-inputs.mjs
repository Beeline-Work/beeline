#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Inputs to npm build, esbuild, the native buzz build, and the install probe.
// Release identity is deliberately excluded: bundle.json is regenerated when
// carrying a payload into a new release. The workflow and this list are inputs
// too, so a change to the build recipe requires a cold build.
export const MAC_HELPER_INPUTS = [
  '.github/workflows/unified-release.yml',
  'apps/body/',
  'packages/nostr/',
  'packages/api-contract/',
  'packages/buzz-client/',
  'apps/gate/',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'scripts/build-beeline-bundle.mjs',
  'scripts/beeline-archive.mjs',
  'scripts/mac-helper-inputs.mjs',
  'scripts/verify-beeline-install.mjs',
  'scripts/pages-site.mjs',
  'scripts/app-associations.mjs',
  'relay-stack/web/install.sh',
];

function capture(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function macHelperInputs() {
  const files = capture('git', ['ls-files', '--', ...MAC_HELPER_INPUTS]).split('\n').filter(Boolean);
  // The upstream source and native compiler are part of the payload even
  // though neither is in this repository. A floating stable toolchain may
  // change between releases, so compare its exact version on each Mac.
  const environment = {
    platform: process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : '',
    buzzRef: process.env.BEELINE_BUZZ_REF ?? '07a3c768d619db31fee3f0590f9433cdd1213e8f',
    node: process.version,
    rustc: capture('rustc', ['-vV']),
    cargo: capture('cargo', ['--version']),
    sdk: capture('xcrun', ['--show-sdk-version']),
    xcode: capture('xcodebuild', ['-version']),
    clang: capture('xcrun', ['clang', '--version']),
    os: capture('sw_vers', ['-productVersion']),
    kernel: capture('uname', ['-v']),
    imageVersion: process.env.ImageVersion ?? '',
    nativeFlags: Object.fromEntries([
      'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'MACOSX_DEPLOYMENT_TARGET',
      'SDKROOT', 'CC', 'CXX', 'CFLAGS', 'LDFLAGS',
    ].map(name => [name, process.env[name] ?? ''])),
  };
  const digest = hashMacHelperInputs(files.map(file => [file, readFileSync(resolve(root, file))]), environment);
  return {
    schemaVersion: 1,
    platform: environment.platform,
    digest,
    reuseSafe: Boolean(files.length && environment.platform && /^[0-9a-f]{40}$/.test(environment.buzzRef) &&
      environment.rustc && environment.cargo && environment.sdk && environment.xcode &&
      environment.clang && environment.os && environment.kernel),
  };
}

export function hashMacHelperInputs(files, environment) {
  const hash = createHash('sha256');
  for (const [name, bytes] of files.sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  return hash.update(JSON.stringify(environment)).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[process.argv.indexOf('--output') + 1];
  if (!output) throw new Error('usage: mac-helper-inputs.mjs --platform PLATFORM --output FILE');
  writeFileSync(output, `${JSON.stringify(macHelperInputs())}\n`);
}
