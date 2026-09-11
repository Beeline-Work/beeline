import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyWebDeployment, WEB_APP_ORIGIN } from './verify-web-deployment.mjs';

function expectedRelease() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-web-release.'));
  const file = path.join(directory, 'release.json');
  fs.writeFileSync(file, JSON.stringify({ version: 'v1.2.3', sourceSha: 'a'.repeat(40) }));
  return { directory, file };
}

test('proves the canonical deployment marker and Expo root', async () => {
  const fixture = expectedRelease();
  const requests = [];
  try {
    const result = await verifyWebDeployment({
      expectedReleasePath: fixture.file,
      attempts: 1,
      fetchImpl: async (url) => {
        requests.push(url);
        return url.endsWith('.json')
          ? Response.json({ version: 'v1.2.3', sourceSha: 'a'.repeat(40) })
          : new Response('<!doctype html><div id="root"></div>');
      },
    });
    assert.equal(result.version, 'v1.2.3');
    assert.deepEqual(requests, [
      `${WEB_APP_ORIGIN}/beeline-web-release.json`,
      `${WEB_APP_ORIGIN}/`,
    ]);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('refuses alternate origins and stale deployments', async () => {
  const fixture = expectedRelease();
  try {
    await assert.rejects(
      verifyWebDeployment({
        origin: 'https://usebeeline.app',
        expectedReleasePath: fixture.file,
        attempts: 1,
      }),
      /must be https:\/\/web\.usebeeline\.app/,
    );
    await assert.rejects(
      verifyWebDeployment({
        expectedReleasePath: fixture.file,
        attempts: 1,
        fetchImpl: async () => Response.json({ version: 'v1.2.2', sourceSha: 'b'.repeat(40) }),
      }),
      /did not converge.*release marker is v1\.2\.2/,
    );
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
