#!/usr/bin/env node

import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'packages/usebeeline/dist/usebeeline.mjs');

await rm(dirname(output), { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
const result = spawnSync(
  'npx',
  [
    '--no-install',
    'esbuild',
    resolve(root, 'apps/body/dist/cli.js'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    '--banner:js=import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);',
    '--define:import.meta.url="usebeeline:npm"',
    `--outfile=${output}`,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await chmod(output, 0o755);
