#!/usr/bin/env node
// Prepare only the dependency trees requested by the corner's work.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--extra') {
  if (args.length !== 2) throw new Error('Usage: npm run corner:prepare -- --extra <path>');
  const path = realpathSync(args[1]);
  const registry = resolve('.beeline-extra-dependencies');
  mkdirSync(registry, { recursive: true });
  writeFileSync(resolve(registry, createHash('sha256').update(path).digest('hex')), path);
  console.log('Extra-copy dependencies requested. Beeline prepares and seals them at the next turn. Keep temporary rigs inside this corner or its agent home.');
  process.exit(0);
}
const flags = new Set(args);
const allowed = new Set(['--mobile', '--build', '--help']);
for (const flag of flags) {
  if (!allowed.has(flag)) throw new Error(`Unknown preparation option: ${flag}`);
}
if (flags.has('--help')) {
  console.log('Usage: npm run corner:prepare -- [--mobile] [--build] | --extra <path>\nRoot dependencies are installed by default. Add --mobile for mobile work and --build when compiled workspace outputs are needed.');
} else {
  const run = (args) => {
    const result = spawnSync('npm', args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (process.env.BEELINE_READONLY_DEPENDENCIES !== '1') run(['ci']);
  if (flags.has('--mobile')) {
    if (process.env.BEELINE_READONLY_DEPENDENCIES === '1') {
      writeFileSync('.beeline-dependency-request', 'mobile');
      console.log('Mobile dependencies requested. Beeline prepares and mounts them automatically at the next turn.');
    } else run(['run', 'mobile:install']);
  }
  if (flags.has('--build')) run(['run', 'build']);
}
