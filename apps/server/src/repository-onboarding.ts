import { randomBytes } from 'node:crypto';
import type { RepositoryOnboardingCard, RepositoryStarter } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { GitHubOperations } from './github-operations.js';
import { systemLine } from './system-line.js';

export type RepositorySignals = {
  commits: readonly { sha: string; message: string; files: readonly string[] }[];
  failingChecks: readonly string[];
  issues: readonly { number: number; title: string; bug: boolean }[];
  branches: readonly string[];
  files: readonly string[];
};

/** Suggestions name observed evidence; fallback tasks make no claims about unseen code. */
export function repositoryStarters(signals: RepositorySignals): RepositoryStarter[] {
  const starters: RepositoryStarter[] = [];
  if (signals.failingChecks.length) starters.push({ id: 'ci', title: 'Fix the red CI',
    evidence: `Failing: ${signals.failingChecks.join(', ')}`,
    task: `Reproduce and fix the failing checks: ${signals.failingChecks.join(', ')}. Keep the fix narrow.` });
  const bug = signals.issues.find(issue => issue.bug);
  if (bug) starters.push({ id: `issue-${bug.number}`, title: `Fix issue #${bug.number}`,
    evidence: bug.title, task: `Read issue #${bug.number}: ${bug.title}. Reproduce it and implement the smallest fix.` });
  const frequency = new Map<string, number>();
  for (const commit of signals.commits) for (const path of new Set(commit.files)) {
    if (/\.(?:[cm]?[jt]sx?|py|rs|go)$/.test(path) && !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(path))
      frequency.set(path, (frequency.get(path) ?? 0) + 1);
  }
  const hot = [...frequency].sort((a, b) => b[1] - a[1]).find(([path]) => {
    const stem = path.replace(/\.[^.]+$/, '').split('/').at(-1)!;
    return !signals.files.some(file => file !== path && (file.includes(`${stem}.test.`) || file.includes(`${stem}.spec.`) || file.endsWith(`/test_${stem}.py`)));
  });
  if (hot) starters.push({ id: 'tests', title: `Add tests for ${hot[0]}`,
    evidence: `Changed in ${hot[1]} sampled commits; no matching test filename found`,
    task: `Inspect ${hot[0]} and the existing test setup. Find coverage gaps and add useful tests; a filename search is not proof of missing coverage.` });
  const wip = signals.branches.find(branch => /(?:wip|draft|work-in-progress)/i.test(branch));
  if (wip) starters.push({ id: 'wip', title: `Finish ${wip}`, evidence: `Open branch: ${wip}`,
    task: `Inspect branch ${wip}, its commits and any open PR. Finish the smallest clearly intended unfinished change without overwriting existing work.` });
  const fallback: RepositoryStarter[] = [
    { id: 'readme', title: 'Make the README useful', evidence: signals.commits.length ? 'Based on the current repository and its recent changes' : 'A starting task for a repository with no commits', task: 'Inspect the repository and improve or create its README with accurate setup and usage instructions. Do not invent features.' },
    { id: 'test-setup', title: 'Add a useful smoke test', evidence: 'Inspect the existing test setup before choosing a test', task: 'Inspect the repository, choose its smallest meaningful user path and add a runnable smoke test. For an empty repository, create a minimal runnable project with a smoke test.' },
    { id: 'ci-setup', title: 'Check the project in CI', evidence: 'Use existing build and test commands where available', task: 'Inspect existing workflows, then add or improve a minimal GitHub Actions check for the project. For an empty repository, start with a minimal documented project and a matching check.' },
  ];
  for (const starter of fallback) if (starters.length < 3) starters.push(starter);
  return starters.slice(0, 4);
}

export async function postRepositoryOnboarding(database: SqlDatabase, github: GitHubOperations | undefined,
  input: { roomId: string; agentId: string; requesterId: string; kind: 'repository' | 'starters' }): Promise<RepositoryOnboardingCard> {
  const room = (await database.query<{ repository_name: string | null; name: string }>(
    `SELECT r.repository_name,i.name FROM rooms r
     JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
     JOIN memberships w ON w.workspace_id=r.workspace_id AND w.room_id IS NULL AND w.identity_id=$3 AND w.removed_at IS NULL
     JOIN identities i ON i.id=$2
     WHERE r.id=$1 AND r.parent_id IS NULL AND r.archived_at IS NULL`,
    [input.roomId, input.agentId, input.requesterId])).rows[0];
  if (!room) throw new Error('repository cards require an active top-level Room and current members');
  const repositories = (await database.query<{ repository_id: string; full_name: string; installation_id: string; default_branch: string }>(
    `SELECT r.* FROM github_repositories r JOIN github_installations i USING(installation_id)
     WHERE i.owner_id=$1 AND i.status='active' AND r.active ORDER BY lower(r.full_name)`, [input.requesterId])).rows;
  const installation = (await database.query<{ installation_id: string }>(
    `SELECT installation_id FROM github_installations WHERE owner_id=$1 AND status='active'
     AND account_type='User' AND repository_selection='all' ORDER BY installation_id LIMIT 1`, [input.requesterId])).rows[0];
  const id = randomBytes(32).toString('hex');
  const kind = input.kind === 'starters' && room.repository_name ? 'starters' : 'repository';
  if (kind === 'starters' && !github) throw new Error('GitHub is not configured');
  const card: RepositoryOnboardingCard = {
    id, ...input, kind, status: 'open',
    state: room.repository_name ? 'repo_linked' : installation ? 'no_repo_linked' : 'install_missing',
    ...(room.repository_name ? { repository: room.repository_name } : {}),
    defaultName: `new-project-${id.slice(0, 6)}`,
    ...(installation ? { installationId: Number(installation.installation_id) } : {}),
    repositories: repositories.map(r => ({ id: Number(r.repository_id), fullName: r.full_name,
      installationId: Number(r.installation_id), defaultBranch: r.default_branch, current: r.full_name === room.repository_name })),
    starters: kind === 'starters' ? repositoryStarters(await github!.onboardingSignals(input.roomId)) : [],
  };
  // Repeated agent calls replace an unanswered card rather than leaving stale actions live.
  await database.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"settled"')
    WHERE room_id=$1 AND author_id=$2 AND card_type='repository-onboarding' AND card->>'kind'=$3 AND card->>'status'='open'`,
    [input.roomId, input.agentId, kind]);
  await systemLine(database, { id, roomId: input.roomId, authorId: input.agentId,
    subject: { id: input.agentId, kind: 'agent', name: room.name },
    verb: kind === 'starters' ? 'suggested work' : 'offered a repository',
    object: room.repository_name ?? 'Choose or create a repository', presentation: 'card',
    cardType: 'repository-onboarding', card: card as unknown as Record<string, unknown> });
  return card;
}
