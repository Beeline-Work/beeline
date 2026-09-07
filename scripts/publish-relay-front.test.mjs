import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishRelayFront } from './publish-relay-front.mjs';

const REPOSITORY_WEB = path.resolve(import.meta.dirname, '..', 'relay-stack', 'web');

function copyWeb(target) {
  fs.cpSync(REPOSITORY_WEB, target, { recursive: true });
}

function readWeb(root) {
  return {
    apple: JSON.parse(
      fs.readFileSync(path.join(root, '.well-known', 'apple-app-site-association'), 'utf8'),
    ),
    android: JSON.parse(fs.readFileSync(path.join(root, '.well-known', 'assetlinks.json'), 'utf8')),
  };
}

test('publisher is repeatable and preserves host-only assets', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-front-publish.'));
  const target = path.join(temporary, 'web');
  const reloads = [];
  try {
    copyWeb(target);
    fs.mkdirSync(path.join(target, 'dl'), { recursive: true });
    fs.writeFileSync(path.join(target, 'dl', 'host-only.tar.gz'), 'keep me');
    const reload = async (composeRoot) => reloads.push(composeRoot);

    await publishRelayFront({
      sourceRoot: REPOSITORY_WEB,
      targetRoot: target,
      composeRoot: temporary,
      reload,
      currentlyServed: readWeb(REPOSITORY_WEB),
    });
    await publishRelayFront({
      sourceRoot: REPOSITORY_WEB,
      targetRoot: target,
      composeRoot: temporary,
      reload,
      currentlyServed: readWeb(REPOSITORY_WEB),
    });

    assert.equal(fs.readFileSync(path.join(target, 'dl', 'host-only.tar.gz'), 'utf8'), 'keep me');
    assert.deepEqual(reloads, [temporary, temporary]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('publisher refuses to remove a currently served association unless forced', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-front-publish.'));
  const target = path.join(temporary, 'web');
  try {
    copyWeb(target);
    const applePath = path.join(target, '.well-known', 'apple-app-site-association');
    const apple = JSON.parse(fs.readFileSync(applePath, 'utf8'));
    apple.applinks.details[0].paths.push('/legacy-still-live/*');
    fs.writeFileSync(applePath, `${JSON.stringify(apple, null, 2)}\n`);

    await assert.rejects(
      publishRelayFront({
        sourceRoot: REPOSITORY_WEB,
        targetRoot: target,
        composeRoot: temporary,
        reload: async () => assert.fail('must not reload after refusal'),
        currentlyServed: { ...readWeb(target), apple },
      }),
      /live only: .*path=\/legacy-still-live\/\*/,
    );

    let reloaded = false;
    await publishRelayFront({
      sourceRoot: REPOSITORY_WEB,
      targetRoot: target,
      composeRoot: temporary,
      force: true,
      reload: async () => {
        reloaded = true;
      },
    });
    assert.equal(reloaded, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
