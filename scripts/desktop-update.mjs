#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const SEMVER = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/;
const SIGNED_ASSETS = {
  'darwin-x86_64': 'Beeline-universal.app.tar.gz',
  'darwin-aarch64': 'Beeline-universal.app.tar.gz',
  'linux-x86_64': 'Beeline-x86_64.AppImage',
  'windows-x86_64': 'Beeline-x86_64-setup.exe',
};

function fail(message) { throw new Error(message); }

export function normalizeDesktopVersion(version) {
  const match = SEMVER.exec(version ?? '');
  if (!match) fail(`invalid desktop version: ${version ?? '<missing>'}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function nextDesktopVersion(version) {
  const normalized = normalizeDesktopVersion(version);
  const [major, minor, patch] = normalized.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

export function updaterBuildConfig({ version, publicKey, endpoint }) {
  const normalized = normalizeDesktopVersion(version);
  if (typeof publicKey !== 'string' || publicKey.trim().length === 0) {
    fail('TAURI_UPDATER_PUBLIC_KEY is required for a production desktop build');
  }
  let url;
  try { url = new URL(endpoint); } catch { fail('desktop updater endpoint is not a valid URL'); }
  if (url.protocol !== 'https:') fail('desktop updater endpoint must use HTTPS');
  return {
    version: normalized,
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: publicKey.trim(),
        endpoints: [url.toString()],
        windows: { installMode: 'passive' },
      },
    },
  };
}

export function createDesktopUpdateManifest({ directory, version, releaseTag, repository, publishedAt }) {
  const normalized = normalizeDesktopVersion(version);
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag ?? '')) fail('release tag must be vX.Y.Z');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) fail('invalid repository');
  const platforms = {};
  for (const [platform, file] of Object.entries(SIGNED_ASSETS)) {
    const signature = readFileSync(join(directory, `${file}.sig`), 'utf8').trim();
    if (!signature) fail(`${file}.sig is empty`);
    platforms[platform] = {
      signature,
      url: `https://github.com/${repository}/releases/download/${releaseTag}/${file}`,
    };
  }
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime())) fail('publishedAt must be an RFC 3339 date');
  return {
    version: normalized,
    pub_date: date.toISOString(),
    platforms,
  };
}

export function verifyDesktopUpdateManifest(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('served desktop update manifest differs from the release artifact');
  for (const [platform, asset] of Object.entries(SIGNED_ASSETS)) {
    const entry = actual.platforms?.[platform];
    if (!entry?.signature || basename(new URL(entry.url).pathname) !== asset) {
      fail(`desktop update manifest has no valid ${platform} payload`);
    }
  }
  return actual;
}

function options(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) result._.push(value);
    else result[value.slice(2)] = argv[++index];
  }
  return result;
}

async function main(argv) {
  const args = options(argv);
  if (args._[0] === 'config') {
    const config = updaterBuildConfig({
      version: args.version,
      publicKey: process.env.TAURI_UPDATER_PUBLIC_KEY,
      endpoint: args.endpoint,
    });
    writeFileSync(args.output, `${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  if (args._[0] === 'manifest') {
    const manifest = createDesktopUpdateManifest({
      directory: args.directory,
      version: args.version,
      releaseTag: args.tag,
      repository: args.repository,
      publishedAt: args['published-at'] ?? new Date().toISOString(),
    });
    writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (args._[0] === 'verify') {
    const actual = await fetch(args.url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) }).then((response) => {
      if (!response.ok) fail(`desktop update manifest returned HTTP ${response.status}`);
      return response.json();
    });
    verifyDesktopUpdateManifest(actual, JSON.parse(readFileSync(args.expected, 'utf8')));
    return;
  }
  fail('usage: desktop-update.mjs <config|manifest|verify>');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
