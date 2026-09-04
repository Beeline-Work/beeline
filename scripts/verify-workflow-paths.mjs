#!/usr/bin/env node
// Nothing type-checks a `run:` line, so a workflow keeps naming a test file
// long after the file is deleted: STATE-UPGRADE pointed at
// apps/body/src/durable-state.test.ts, removed with the daemon durable-state
// feature, and anyone dispatching that lane got vitest's "no test files found"
// instead of a verdict.
//
// This is an existence check, nothing more: collect the *.test.* / *.spec.*
// paths the workflows and composite actions name — in `run:` commands and path
// filters alike — and fail on any that matches no tracked file. A reference is
// resolved against the repository root and against every workspace directory,
// because workflows spell the same file both ways (`-w @beeline/push-gateway
// -- --run src/…test.ts` and `apps/push-gateway/src/…test.ts` in a filter).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Directories, then a name ending .test.<ext>/.spec.<ext>. Requiring a `/`
// keeps prose that merely mentions a test by filename out of the check; a
// token carrying `$` or `{` is runner-expanded, not a repository path.
const TEST_PATH = /(?:[\w.@${}()[\]*+-]+\/)+[\w.@${}()[\]*+-]*\.(?:test|spec)\.(?:ts|tsx|mjs|cjs|js|jsx)\b/g;

const yamlFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const roots = ['', ...['apps', 'packages'].flatMap((parent) =>
  readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`),
)];

const missing = [];
let checked = 0;
for (const file of [...yamlFiles('.github/workflows'), ...yamlFiles('.github/actions')]) {
  for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    for (const [reference] of line.matchAll(TEST_PATH)) {
      if (/[${}]/.test(reference)) continue;
      const named = reference.replace(/^\(+/, '');
      checked += 1;
      // `*` matches within a path segment, `**` across segments, so a glob a
      // path filter uses passes while it still selects at least one file.
      const matcher = new RegExp(`^(${roots.map((root) => (root ? `${root}/` : '')).join('|')})${
        named.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*')
      }$`);
      if (!tracked.some((candidate) => matcher.test(candidate))) missing.push(`  ${file}:${index + 1}  ${named}`);
    }
  }
}

if (missing.length > 0) {
  console.error(`Workflows name test paths that no tracked file matches:\n\n${missing.join('\n')}\n`);
  console.error('Point the job at the test that survives, or remove the reference.');
  console.error('A deleted test is not permission to restore the feature it covered.');
  process.exit(1);
}
console.log(`Workflow test paths: ${checked} reference(s) checked, all resolve.`);
