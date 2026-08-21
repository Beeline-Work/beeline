#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');

const IOS_DISPLAY_VERSION = /^\d+(\.\d+){0,2}$/;

function assertIosDisplayVersion(candidate) {
  if (!IOS_DISPLAY_VERSION.test(candidate)) {
    throw new Error(
      `apps/mobile/package.json must use an iOS display version with one to three numeric components: ${candidate}`,
    );
  }
}

function main() {
  assertIosDisplayVersion(version);

  try {
    const tags = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', 'v[0-9]*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    const expectedTag = `v${version}`;
    if (tags.length > 0 && !tags.includes(expectedTag)) {
      throw new Error(`Release tag mismatch: package version is ${version}, HEAD has ${tags.join(', ')}`);
    }
  } catch (error) {
    if (error?.status !== undefined) throw error;
    throw error;
  }

  console.log(version);
}

if (require.main === module) main();

module.exports = { assertIosDisplayVersion };
