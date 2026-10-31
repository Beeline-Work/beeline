#!/usr/bin/env node
// Prepare only the dependency trees requested by the corner's work.
import { spawnSync } from 'node:child_process';

const flags = new Set(process.argv.slice(2));
const allowed = new Set(['--mobile', '--build', '--help']);
for (const flag of flags) {
  if (!allowed.has(flag)) throw new Error(`Unknown preparation option: ${flag}`);
}
if (flags.has('--help')) {
  console.log('Usage: npm run corner:prepare -- [--mobile] [--build]\nRoot dependencies are installed by default. Add --mobile for mobile work and --build when compiled workspace outputs are needed.');
} else {
  const run = (args) => {
    const result = spawnSync('npm', args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  run(['ci']);
  if (flags.has('--mobile')) run(['run', 'mobile:install']);
  if (flags.has('--build')) run(['run', 'build']);
}
