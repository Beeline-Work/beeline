import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const manifestName = '.beeline-ci-build.json';

function outputs(root) {
  const files = {};
  function walk(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Compiled output must be a regular file: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[path] = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    }
  }
  for (const parent of ['apps', 'packages']) {
    if (!existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = `${parent}/${entry.name}/dist`;
      if (entry.isDirectory() && existsSync(join(root, directory))) walk(directory);
    }
  }
  assert.ok(Object.keys(files).length > 0, 'No compiled workspace outputs');
  return files;
}

export function provenance(mode, sha, root = process.cwd()) {
  assert.ok(['write', 'verify'].includes(mode), 'Expected write or verify');
  assert.match(sha ?? '', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Expected the exact checkout SHA');
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(checkout, sha, 'Build provenance must match the checked-out commit');
  const current = { version: 1, sha, nodeMajor: process.versions.node.split('.')[0], files: outputs(root) };
  const path = join(root, manifestName);
  if (mode === 'write') writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
  else assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), current,
    'Compiled workspace outputs or provenance differ from this checkout');
  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = provenance(process.argv[2], process.argv[3]);
  console.log(`Verified ${Object.keys(result.files).length} compiled files for ${result.sha}`);
}
