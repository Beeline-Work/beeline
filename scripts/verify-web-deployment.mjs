#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const WEB_APP_ORIGIN = 'https://web.usebeeline.app';
export const RELEASE_PATH = '/beeline-web-release.json';

function fail(message) {
  throw new Error(message);
}

export async function verifyWebDeployment({
  origin = WEB_APP_ORIGIN,
  expectedReleasePath,
  attempts = 20,
  fetchImpl = fetch,
}) {
  if (new URL(origin).origin !== origin || origin !== WEB_APP_ORIGIN) {
    fail(`web verification origin must be ${WEB_APP_ORIGIN}`);
  }
  const expected = JSON.parse(await readFile(expectedReleasePath, 'utf8'));
  if (!/^v\d+\.\d+\.\d+$/.test(expected.version ?? '')) fail('invalid expected web version');
  if (!/^[0-9a-f]{7,64}$/.test(expected.sourceSha ?? '')) fail('invalid expected web sourceSha');

  let lastError = 'no response';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const marker = await fetchImpl(`${origin}${RELEASE_PATH}`, { redirect: 'error' });
      if (!marker.ok) throw new Error(`release marker returned ${marker.status}`);
      const actual = await marker.json();
      if (actual.version !== expected.version || actual.sourceSha !== expected.sourceSha) {
        throw new Error(`release marker is ${actual.version ?? '?'}@${actual.sourceSha ?? '?'}`);
      }
      const root = await fetchImpl(`${origin}/`, { redirect: 'error' });
      if (!root.ok) throw new Error(`app root returned ${root.status}`);
      const html = await root.text();
      if (!/<div[^>]+id=["']root["']/.test(html)) throw new Error('app root is not an Expo document');
      return actual;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  fail(`web deployment did not converge after ${attempts} attempts: ${lastError}`);
}

async function main() {
  const option = (name) => process.argv[process.argv.indexOf(name) + 1];
  await verifyWebDeployment({
    expectedReleasePath: option('--expected-release'),
    attempts: Number(option('--attempts') || 20),
  });
  console.log(`web deployment verified at ${WEB_APP_ORIGIN}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`verify-web-deployment: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
