// Checks `architecture/invariants.json` against the tree. With `--base <ref>`
// it reports relaxed rules and guard changes for weekly owner review.
// The candidate must still satisfy its declared invariants.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  INVARIANTS_PATH, invariantsAtRef, judgeTree, readInvariants, relaxations, strictRelaxations, validateRules,
} from './architecture-invariants.mjs';
import { judgeStorage, storageRelaxations } from './architecture-storage.mjs';

/** CI executes the candidate guard; changes remain visible in the weekly review. */
const RUNNER_FILES = ['scripts/check-architecture.mjs', 'scripts/architecture-invariants.mjs', 'scripts/architecture-storage.mjs'];

function changedRunnerFiles(root, base) {
  return RUNNER_FILES.filter((file) => {
    let before;
    try {
      before = execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return false; // not at base: this is the change that adds the guard
    }
    let after = '';
    try {
      after = readFileSync(path.join(root, file), 'utf8');
    } catch {}
    return before !== after;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const baseFlag = args.indexOf('--base');
  const base = baseFlag === -1 ? undefined : args[baseFlag + 1];
  if (baseFlag !== -1 && (!base || base.startsWith('-'))) throw new Error('--base requires a git ref');
  const rootFlag = args.indexOf('--root');
  const root = rootFlag === -1 ? path.resolve(fileURLToPath(new URL('..', import.meta.url))) : path.resolve(args[rootFlag + 1]);
  const head = readInvariants(root);
  const errors = validateRules(head);
  if (base) errors.push(...strictRelaxations(root, invariantsAtRef(root, base), head).map(item => `Strict architecture boundary: ${item}`));
  if (!errors.length) errors.push(...judgeTree(root, head), ...judgeStorage(root, head.storage));
  const relaxed = base ? [
    ...relaxations(root, invariantsAtRef(root, base), head),
    ...storageRelaxations(invariantsAtRef(root, base), head),
    ...changedRunnerFiles(root, base).map((file) => `guard ${file} changed`),
  ] : [];
  for (const item of relaxed)
    console.warn(`Weekly architecture review: ${item}.`);
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(`Architecture check failed: ${errors.length} problem(s). See ${INVARIANTS_PATH} and architecture/README.md.`);
    process.exitCode = 1;
  } else console.log(`Architecture check passed (${head.rules.length} rules).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
