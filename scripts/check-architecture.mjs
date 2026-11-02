// Checks `architecture/invariants.json` against the tree. With `--base <ref>`
// it also refuses a relaxed rule (or a changed guard) unless Beeline holds the owner's yes on this
// exact PR head (ARCHITECTURE_PR, ARCHITECTURE_HEAD, GITHUB_REPOSITORY).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  INVARIANTS_PATH, invariantsAtRef, judgeTree, readInvariants, relaxations, validateRules,
} from './architecture-invariants.mjs';

/** The guard itself. CI runs the base copy, so a change to it is a relaxation. */
const RUNNER_FILES = ['scripts/check-architecture.mjs', 'scripts/architecture-invariants.mjs'];

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

const BEELINE_SERVER = process.env.BEELINE_SERVER ?? 'https://server.usebeeline.app';

/** The trusted record: the owner's yes on this exact head, kept by Beeline. */
export async function ownerApprovedRelaxation({ repository, pullRequest, head }, fetchImpl = fetch) {
  if (!repository || !pullRequest || !/^[0-9a-f]{40}$/.test(head ?? '')) return false;
  const url = new URL('/v1/public/architecture-approvals', BEELINE_SERVER);
  url.search = new URLSearchParams({ repository, pullRequest: String(pullRequest), head }).toString();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    return response.ok && (await response.json()).approved === true;
  } catch {
    return false;
  }
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
  if (!errors.length) errors.push(...judgeTree(root, head));
  const relaxed = base ? [
    ...relaxations(root, invariantsAtRef(root, base), head),
    ...changedRunnerFiles(root, base).map((file) => `the guard ${file} changed`),
  ] : [];
  const pr = { repository: process.env.GITHUB_REPOSITORY, pullRequest: process.env.ARCHITECTURE_PR, head: process.env.ARCHITECTURE_HEAD };
  if (relaxed.length && !(await ownerApprovedRelaxation(pr)))
    errors.push([
      `This change relaxes ${INVARIANTS_PATH}:`,
      ...relaxed.map((item) => `  - ${item}`),
      'Relaxing a rule needs the owner\'s yes on this exact PR head. Either undo the relaxation (fix the code instead),',
      `or ask the owner in a Beeline Room to approve PR #${pr.pullRequest ?? '?'} at head ${pr.head ?? '?'}; the agent that reply commands`,
      'then calls approve_architecture_relax, and this job is re-run. Tightening (a lower total, a new rule) never needs this.',
    ].join('\n'));
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(`Architecture check failed: ${errors.length} problem(s). See ${INVARIANTS_PATH} and architecture/README.md.`);
    process.exitCode = 1;
  } else console.log(`Architecture check passed (${head.rules.length} rules${relaxed.length ? ', relaxation approved by the owner' : ''}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
