#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};

const fromRepo = (value) => (isAbsolute(value) ? value : resolve(repoRoot, value));
const directory = fromRepo(valueAfter('--directory', '.'));
const baselinePath = fromRepo(valueAfter('--baseline', 'knip-baseline.json'));
const config = valueAfter('--config', 'knip.jsonc');
const writeBaseline = args.includes('--write-baseline');
const knipBin = join(repoRoot, 'node_modules', 'knip', 'bin', 'knip.js');

const result = spawnSync(
  process.execPath,
  [knipBin, '--reporter', 'json', '--no-exit-code', '--config', config],
  {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  },
);

if (result.error) {
  console.error(`Dead-code analysis could not start: ${result.error.message}`);
  process.exit(2);
}
if (result.signal) {
  console.error(`Dead-code analysis was terminated by ${result.signal}`);
  process.exit(2);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  console.error(`Dead-code analysis exited with status ${result.status}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(result.stderr);
  console.error(`Dead-code analysis returned invalid JSON: ${error.message}`);
  process.exit(2);
}

const findings = [
  ...(report.files ?? []).map((file) => `file:${file}`),
  ...(report.issues ?? []).flatMap((issue) =>
    ['exports', 'types'].flatMap((category) =>
      (issue[category] ?? []).map((finding) => `${category}:${issue.file}:${finding.name}`),
    ),
  ),
].sort();

if (writeBaseline) {
  const baseline = {
    schemaVersion: 1,
    detector: 'knip',
    categories: ['files', 'exports', 'types'],
    findings,
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Wrote ${findings.length} existing findings to ${baselinePath}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (error) {
  console.error(`Could not read dead-code baseline ${baselinePath}: ${error.message}`);
  process.exit(2);
}

if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.findings)) {
  console.error(`Unsupported dead-code baseline format in ${baselinePath}`);
  process.exit(2);
}

const current = new Set(findings);
const existing = new Set(baseline.findings);
const introduced = findings.filter((finding) => !existing.has(finding));
const resolved = baseline.findings.filter((finding) => !current.has(finding));

if (introduced.length > 0 || resolved.length > 0) {
  if (introduced.length > 0) {
    console.error(`New dead-code findings (${introduced.length}):`);
    for (const finding of introduced) console.error(`  + ${finding}`);
  }
  if (resolved.length > 0) {
    console.error(`Resolved baseline findings (${resolved.length}); shrink the baseline:`);
    for (const finding of resolved) console.error(`  - ${finding}`);
  }
  console.error('Run `npm run dead-code:baseline` after reviewing the complete detector output.');
  process.exit(1);
}

console.log(`Dead-code baseline holds: ${findings.length} existing findings, 0 introduced.`);
