#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`apps/mobile/package.json has an invalid release version: ${version}`);
}

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
