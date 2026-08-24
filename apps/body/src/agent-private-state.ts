import { appendFile, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { git } from '@beeline/gate';

/** Session env var naming the durable state a persona owns outside the repository. */
export const AGENT_PRIVATE_STATE_ENV = 'BUZZY_AGENT_PRIVATE_DIR';

export interface CornerAgentPrivateState {
  /** Durable per-Room state outside every checked-out repository. */
  root: string;
  /** Body-created pointer inside this corner, convenient for cwd-relative tools. */
  worktreePath: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function pointsTo(path: string, target: string): Promise<boolean> {
  try {
    return (
      (await lstat(path)).isSymbolicLink() && (await realpath(path)) === (await realpath(target))
    );
  } catch {
    return false;
  }
}

/**
 * Keep an ordinary `git add .` from staging the private-state pointer. The
 * pattern is root-anchored and channel-specific, and is written only after
 * Body has created or re-verified that exact symlink. Merge readiness still
 * verifies the link independently in case this best-effort exclude fails.
 */
async function excludeBodyOwnedLink(worktreePath: string, name: string): Promise<void> {
  const resolved = await git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
  if (!resolved.ok) return;
  const rawExcludePath = resolved.stdout.trim();
  if (!rawExcludePath) return;
  const excludePath = isAbsolute(rawExcludePath)
    ? rawExcludePath
    : resolve(worktreePath, rawExcludePath);
  const pattern = `/${name}`;
  const existing = await readFile(excludePath, 'utf8').catch(() => '');
  if (existing.split(/\r?\n/).includes(pattern)) return;
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

/**
 * Give a corner one provenance-bearing path for persona memory, lessons and scratch.
 *
 * The exact channel-specific link is excluded from ordinary Git adds after
 * Body creates it. Merge readiness still ignores a visible fallback entry only
 * after re-verifying that it is this exact Body-owned symlink. A project file
 * with the same name, or an arbitrary `memory/` path, therefore remains
 * ordinary uncommitted project work.
 */
export async function prepareCornerAgentPrivateState(input: {
  root: string;
  worktreePath: string;
  channelId: string;
}): Promise<CornerAgentPrivateState> {
  const root = resolve(input.root);
  const worktree = resolve(input.worktreePath);
  if (isInside(worktree, root)) {
    throw new Error(`agent-private state must live outside the corner worktree: ${root}`);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });

  const suffix = input.channelId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'corner';
  const candidates = [`.beeline-agent-private-${suffix}`];
  for (let attempt = 2; attempt < 100; attempt += 1) {
    candidates.push(`.beeline-agent-private-${suffix}-${attempt}`);
  }

  for (const name of candidates) {
    const worktreePath = resolve(worktree, name);
    if (await pointsTo(worktreePath, root)) {
      await excludeBodyOwnedLink(worktree, name).catch(() => undefined);
      return { root, worktreePath };
    }
    try {
      await lstat(worktreePath);
      continue;
    } catch {
      await symlink(root, worktreePath, 'dir');
      await excludeBodyOwnedLink(worktree, name).catch(() => undefined);
      return { root, worktreePath };
    }
  }
  throw new Error(`no private-state link name available in ${worktree}`);
}

/** Re-verify provenance at review time; never trust the stored path alone. */
export function isBodyOwnedPrivateStateLink(
  worktreePath: string,
  state: CornerAgentPrivateState | undefined,
): boolean {
  if (!state) return false;
  const worktree = resolve(worktreePath);
  const link = resolve(state.worktreePath);
  if (dirname(link) !== worktree || basename(link) === '') return false;
  try {
    return lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(state.root);
  } catch {
    return false;
  }
}

/** Return only porcelain entries that represent real project dirt. */
export function projectDirtyStatus(
  worktreePath: string,
  porcelainV1Z: string,
  state: CornerAgentPrivateState | undefined,
): string[] {
  const entries = porcelainV1Z.split('\0').filter(Boolean);
  let filtered = entries;
  if (state && isBodyOwnedPrivateStateLink(worktreePath, state)) {
    const relativeLink = relative(resolve(worktreePath), resolve(state.worktreePath)).replaceAll(
      '\\',
      '/',
    );
    filtered = filtered.filter((entry) => entry !== `?? ${relativeLink}`);
  }
  return filtered.filter((entry) => !isSeededToolchainLink(worktreePath, entry));
}

/**
 * Body seeds a corner's dependency tree by linking the source checkout's
 * `node_modules` directories into the worktree (`corner-toolchain.ts`). In a
 * repository that does not ignore `node_modules` those links show up as
 * untracked paths and would otherwise block merge readiness forever. Only ever
 * ignore an entry that is verifiably a SYMLINK named node_modules — a real
 * project-owned node_modules directory still reads as dirt, same contract as
 * the private-state link above.
 */
function isSeededToolchainLink(worktreePath: string, entry: string): boolean {
  if (!entry.startsWith('?? ')) return false;
  const path = entry.slice('?? '.length);
  if (path !== 'node_modules' && !path.endsWith('/node_modules')) return false;
  if (path.includes('*') || path.includes('"')) return false;
  try {
    return lstatSync(resolve(worktreePath, path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export function agentPrivateStateInstructions(state: CornerAgentPrivateState | undefined): string {
  if (!state) return '';
  return [
    `Your agent-private state directory is ${state.worktreePath} (also $${AGENT_PRIVATE_STATE_ENV}).`,
    'Put persona memory, episodic notes, lessons, journals, and scratch you author for yourself there, never in repository paths.',
    'This overrides any persona/soul wording that names a repo-relative memory or lessons path: preserve the intent, but route the bookkeeping into your private state directory.',
    'A project-owned memory/, lessons/, or similarly named path is still project content. Change it only when the human task requires it, and commit that project change normally.',
    'Before finishing, move any accidental private bookkeeping out of the repository and restore tracked project files changed only for bookkeeping. Never commit the private-state link.',
  ].join('\n');
}
