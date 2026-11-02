// Checks `architecture/invariants.json` against the tree. With `--base <ref>`
// it also refuses a relaxed rule (or a changed guard) unless the repository owner approved this
// exact PR head in a GitHub review (ARCHITECTURE_PR, ARCHITECTURE_HEAD, GITHUB_REPOSITORY, GITHUB_TOKEN).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  INVARIANTS_PATH, invariantsAtRef, judgeTree, readInvariants, relaxations, validateRules,
} from './architecture-invariants.mjs';
import { judgeStorage, storageRelaxations } from './architecture-storage.mjs';

/** The guard itself. CI runs the base copy, so a change to it is a relaxation. */
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

const OWNER = 'lunchboxfortwo';

/** The trusted record: an APPROVED GitHub review by the owner on this exact head. */
export async function ownerApprovedRelaxation({ repository, pullRequest, head, token }, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(String(pullRequest ?? '')) || !/^[0-9a-f]{40}$/.test(head ?? '')) return false;
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  try {
    for (let page = 1; page <= 10; page += 1) {
      const url = `https://api.github.com/repos/${repository}/pulls/${pullRequest}/reviews?per_page=100&page=${page}`;
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return false;
      const reviews = await response.json();
      const yes = reviews.find((review) => review.state === 'APPROVED' && review.user?.login === OWNER && review.commit_id === head);
      if (yes) {
        console.log(`${OWNER} approved this head in review ${yes.id} at ${yes.submitted_at}.`);
        return true;
      }
      if (reviews.length < 100) return false;
    }
  } catch {}
  return false;
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
  if (!errors.length) errors.push(...judgeTree(root, head), ...judgeStorage(root, head.storage));
  const relaxed = base ? [
    ...relaxations(root, invariantsAtRef(root, base), head),
    ...storageRelaxations(invariantsAtRef(root, base), head),
    ...changedRunnerFiles(root, base).map((file) => `the guard ${file} changed`),
  ] : [];
  const pr = {
    repository: process.env.GITHUB_REPOSITORY, pullRequest: process.env.ARCHITECTURE_PR,
    head: process.env.ARCHITECTURE_HEAD, token: process.env.GITHUB_TOKEN,
  };
  if (relaxed.length && !(await ownerApprovedRelaxation(pr)))
    errors.push([
      `This change relaxes ${INVARIANTS_PATH}:`,
      ...relaxed.map((item) => `  - ${item}`),
      'Relaxing a rule needs the owner\'s yes on this exact PR head. Either undo the relaxation (fix the code instead),',
      `or ask ${OWNER} to approve PR #${pr.pullRequest ?? '?'} on GitHub at head ${pr.head ?? '?'}, then re-run this job.`,
      'A new commit needs a new approval. Tightening (a lower total, a new rule) never needs this.',
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
