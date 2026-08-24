/**
 * Corner worktree isolation — mirrors firstmate's treehouse/spawn isolation.
 *
 * A corner's edit session must run inside its own top-level git worktree, on
 * its own feature branch, and NEVER commit into the operator's shared primary
 * checkout (which sits on the protected `main`). Two things used to defeat that:
 *
 *   1. The corner worktree was created buried inside the primary checkout's own
 *      `.git` tree (`…/proj-buzzy/.git/beeline/agents/<pk>/rooms/<room>/`
 *      `.worktrees/<id>`) — a path no coding agent treats as its project root.
 *      A harness's "go to the project root" reflex therefore resolved back out
 *      to the enclosing ordinary checkout `/home/lunchbox/proj-buzzy` and every
 *      command ran there, so `git commit` landed on the shared `main`.
 *   2. Nothing asserted, before the edit session launched, that the session
 *      root was actually distinct from the primary checkout.
 *
 * This module provides the three pure pieces of firstmate's answer, adapted:
 *   - {@link cornerWorktreePath}: place the worktree at a clean, top-level path
 *     that is a *sibling* of the source checkout, never nested inside it or its
 *     `.git`, so the agent's cd-to-project reflex lands inside the worktree.
 *   - {@link assertCornerWorktreeIsolated}: the pre-launch, fail-closed
 *     assertion (mirrors `validate_spawn_worktree` in `bin/fm-spawn.sh`): the
 *     worktree's own `git rev-parse --show-toplevel` must equal the worktree
 *     path and must differ from the primary checkout, or we refuse to launch.
 *   - {@link classifyCornerCommand}: the cd-guard policy (mirrors
 *     `bin/fm-cd-command-policy.mjs`) — a backstop that denies a persistent
 *     `cd`/`pushd`/`popd` or a `git -C <outside>` that would escape the corner
 *     worktree into the shared checkout, for a harness that leaks past the
 *     isolation above.
 */
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { git, type GitResult } from '@beeline/gate';

/** Thrown when a corner cannot be isolated from the primary checkout. */
export class CornerIsolationError extends Error {
  override readonly name = 'CornerIsolationError';
}

/**
 * The directory name used to group corner worktrees as a hidden sibling of the
 * source checkout. `/home/lunchbox/proj-buzzy` → corners live under
 * `/home/lunchbox/.beeline-corners/proj-buzzy/<subchannelId>`.
 */
export const CORNERS_SIBLING_DIR = '.beeline-corners';

/** Legacy (pre-isolation) buried worktree location, retained only for restore. */
export function legacyCornerWorktreePath(workspaceRoot: string, subchannelId: string): string {
  return resolve(workspaceRoot, '.worktrees', subchannelId);
}

/**
 * Resolve the clean, top-level worktree path for a corner.
 *
 * Precedence:
 *   1. An explicit `cornersRoot` override (tests, future daemon plumbing).
 *   2. A hidden sibling of the source checkout (`sourceCheckout`,
 *      i.e. `boundRepo.localPath`) — the operator's shared checkout is the only
 *      thing a corner can tangle with, so anchoring off its parent guarantees a
 *      top-level path that is never nested inside it or its `.git`. This is the
 *      path that fixes the reported bug.
 *   3. The legacy `<workspaceRoot>/.worktrees/<id>` for a relay-origin or
 *      local-only corner — its "primary" is a bare clone with no working tree,
 *      so there is no shared human checkout to tangle with, and keeping the
 *      exact legacy path leaves that (already-isolated) case byte-for-byte
 *      unchanged.
 */
export function cornerWorktreePath(opts: {
  cornersRoot?: string;
  workspaceRoot: string;
  sourceCheckout?: string;
  subchannelId: string;
}): string {
  const base = cornersPoolRoot(opts);
  return resolve(base, opts.subchannelId);
}

/**
 * The directory that holds every corner worktree for a source checkout — the
 * parent of {@link cornerWorktreePath}. Exposed so a periodic prune can sweep
 * strays (worktrees no live corner or git registration still backs).
 */
export function cornersPoolRoot(opts: {
  cornersRoot?: string;
  workspaceRoot: string;
  sourceCheckout?: string;
}): string {
  if (opts.cornersRoot) return resolve(opts.cornersRoot);
  if (opts.sourceCheckout) {
    const checkout = resolve(opts.sourceCheckout);
    return resolve(checkout, '..', CORNERS_SIBLING_DIR, basename(checkout));
  }
  return resolve(opts.workspaceRoot, '.worktrees');
}

/** Physically resolve a path (mirrors firstmate's `pwd -P`); raw path on failure. */
function realPathOrRaw(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Fail-closed pre-launch isolation assertion (mirrors `validate_spawn_worktree`).
 *
 * The worktree must resolve to a real top-level git worktree
 * (`git rev-parse --show-toplevel` === the worktree path) AND that top-level
 * must differ from the primary checkout. Anything else — the worktree does not
 * exist, is not a git toplevel, or *is* the primary checkout — throws, so the
 * corner is refused rather than silently opened onto the shared checkout.
 *
 * `runGit` is injectable for tests; it defaults to the real git runner.
 */
export function assertCornerWorktreeIsolated(
  worktreePath: string,
  primaryCheckout?: string,
  runGit: (cwd: string, args: string[]) => Promise<GitResult> = git,
): Promise<void> {
  return assertCornerWorktreeIsolatedAsync(worktreePath, primaryCheckout, runGit);
}

async function assertCornerWorktreeIsolatedAsync(
  worktreePath: string,
  primaryCheckout: string | undefined,
  runGit: (cwd: string, args: string[]) => Promise<GitResult>,
): Promise<void> {
  const worktreeReal = realPathOrRaw(worktreePath);
  const toplevel = await runGit(worktreePath, ['rev-parse', '--show-toplevel']);
  const toplevelReal = toplevel.ok ? realPathOrRaw(toplevel.stdout.trim()) : '';
  const primaryReal = primaryCheckout ? realPathOrRaw(primaryCheckout) : undefined;

  if (!toplevel.ok || !toplevelReal) {
    throw new CornerIsolationError(
      `corner worktree ${worktreePath} is not a git worktree ` +
        `(git rev-parse --show-toplevel failed: ${toplevel.stderr.trim() || 'no output'}); ` +
        `refusing to launch onto an unisolated root`,
    );
  }
  if (toplevelReal !== worktreeReal) {
    throw new CornerIsolationError(
      `corner worktree ${worktreePath} did not yield an isolated worktree ` +
        `(worktree root '${toplevelReal}' != '${worktreeReal}'); refusing to launch`,
    );
  }
  if (primaryReal && toplevelReal === primaryReal) {
    throw new CornerIsolationError(
      `corner worktree ${worktreePath} resolved to the shared primary checkout ` +
        `'${primaryReal}'; refusing to launch to avoid tangling the protected branch`,
    );
  }
}

// ── cd-guard policy ────────────────────────────────────────────────────────

export type CornerCommandCode = 'persistent-cd' | 'git-escape';

export type CornerCommandVerdict =
  { decision: 'allow' } | { decision: 'deny'; code: CornerCommandCode; reason: string };

const ALLOW: CornerCommandVerdict = { decision: 'allow' };

const CD_BUILTINS = new Set(['cd', 'pushd', 'popd']);
/** Wrappers that fork/exec a child, so a `cd` behind them never persists. */
const FORKING_WRAPPERS = new Set(['env', 'sudo', 'nohup', 'timeout', 'gtimeout', 'exec']);

/**
 * Does a shell command persistently move the corner session out of its
 * worktree, or drive git against a checkout outside it?
 *
 * Threat model, exactly like firstmate's cd-guard: agent *mistakes* — a stray
 * `cd /home/lunchbox/proj-buzzy && git commit`, not a deliberately obfuscated
 * bypass. It classifies lexical command positions only; it never evaluates,
 * expands, or runs any byte of the command, and it fails OPEN (allow) on any
 * shape it cannot confidently classify, so a false block can never wedge a
 * legitimate corner turn.
 *
 * Denies:
 *   - a top-level, parent-shell `cd`/`pushd`/`popd` (any argument — the corner's
 *     steady state is "always in the worktree", so a return-to-worktree cd is
 *     redundant and any cd is a potential escape), and
 *   - a `git -C <dir>` / `git --git-dir=<dir>` / `git --work-tree=<dir>` whose
 *     directory escapes the worktree (an absolute path outside it, or a relative
 *     path that climbs out with `..`).
 */
export function classifyCornerCommand(
  command: string,
  worktreePath: string,
  primaryCheckout?: string,
): CornerCommandVerdict {
  try {
    return classify(command, resolve(worktreePath), primaryCheckout && resolve(primaryCheckout));
  } catch {
    return ALLOW; // fail open on anything we cannot parse
  }
}

function classify(
  command: string,
  worktreeReal: string,
  primaryReal: string | undefined,
): CornerCommandVerdict {
  for (const segment of topLevelSegments(command)) {
    const words = tokenize(segment.text);
    if (!words.length) continue;

    // Strip leading `VAR=val` assignments and forking/exec wrappers; a cd behind
    // a forking wrapper runs in a child and never persists to the parent shell.
    let i = 0;
    let forked = false;
    while (i < words.length) {
      const w = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i += 1;
        continue;
      }
      if (FORKING_WRAPPERS.has(w)) {
        forked = true;
        i += 1;
        continue;
      }
      break;
    }
    // `builtin cd` / `command cd` still run the builtin in the current shell.
    while (words[i] === 'builtin' || words[i] === 'command') i += 1;
    const head = words[i];
    if (!head) continue;

    if (CD_BUILTINS.has(head)) {
      // A `cd` in a pipeline stage, a backgrounded segment, or a subshell runs
      // in a child shell and does not persist to the corner session's shell.
      if (forked || segment.piped || segment.backgrounded || segment.subshell) continue;
      return {
        decision: 'deny',
        code: 'persistent-cd',
        reason:
          `a persistent '${head}' would move the corner session out of its isolated worktree ` +
          `into a shared checkout. Reach the target without moving the shell — use ` +
          `git -C <dir>, an absolute path on the command itself, or a subshell (cd <dir> && …).`,
      };
    }

    if (head === 'git') {
      const escape = gitDirectoryEscape(words.slice(i + 1), worktreeReal, primaryReal);
      if (escape) {
        return {
          decision: 'deny',
          code: 'git-escape',
          reason:
            `a 'git ${escape.flag} ${escape.dir}' would operate on a checkout outside the ` +
            `corner's isolated worktree. Run git inside the worktree instead.`,
        };
      }
    }
  }
  return ALLOW;
}

/** A `git -C <dir>` / `--git-dir` / `--work-tree` pointing outside the worktree. */
function gitDirectoryEscape(
  args: string[],
  worktreeReal: string,
  primaryReal: string | undefined,
): { flag: string; dir: string } | undefined {
  for (let j = 0; j < args.length; j += 1) {
    const arg = args[j]!;
    let flag: string | undefined;
    let dir: string | undefined;
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
      flag = arg;
      dir = args[j + 1];
      j += 1;
    } else if (arg.startsWith('--git-dir=')) {
      flag = '--git-dir';
      dir = arg.slice('--git-dir='.length);
    } else if (arg.startsWith('--work-tree=')) {
      flag = '--work-tree';
      dir = arg.slice('--work-tree='.length);
    }
    if (!flag || dir === undefined || dir === '') continue;
    if (directoryEscapesWorktree(dir, worktreeReal, primaryReal)) return { flag, dir };
  }
  return undefined;
}

function directoryEscapesWorktree(
  dir: string,
  worktreeReal: string,
  primaryReal: string | undefined,
): boolean {
  const target = isAbsolute(dir) ? resolve(dir) : resolve(worktreeReal, dir);
  if (primaryReal && (target === primaryReal || isInside(primaryReal, target))) return true;
  return target !== worktreeReal && !isInside(worktreeReal, target);
}

/** Is `child` the same as, or nested under, `parent`? */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface Segment {
  text: string;
  piped: boolean;
  backgrounded: boolean;
  subshell: boolean;
}

/**
 * Split a command into top-level segments on `;`, `&&`, `||`, `|`, `&`, and
 * newlines, ignoring separators inside single/double quotes or `(…)` groups.
 * Each segment records whether it ran as a pipeline stage, backgrounded, or
 * wholly inside a subshell — all three run the segment in a child shell, so a
 * `cd` there never persists to the parent.
 */
function topLevelSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let depth = 0; // paren nesting
  let pipedPrev = false;
  const push = (sep: string): void => {
    const trimmed = buf.trim();
    const subshell = trimmed.startsWith('(');
    segments.push({
      text: trimmed,
      piped: pipedPrev || sep === '|',
      backgrounded: sep === '&',
      subshell,
    });
    pipedPrev = sep === '|';
    buf = '';
  };
  for (let k = 0; k < command.length; k += 1) {
    const c = command[k]!;
    const next = command[k + 1];
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '(') {
      depth += 1;
      buf += c;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth -= 1;
      buf += c;
      continue;
    }
    if (depth > 0) {
      buf += c;
      continue;
    }
    if (c === '\n' || c === ';') {
      push(';');
      continue;
    }
    if (c === '&' && next === '&') {
      push('&&');
      k += 1;
      continue;
    }
    if (c === '|' && next === '|') {
      push('||');
      k += 1;
      continue;
    }
    if (c === '|') {
      push('|');
      continue;
    }
    if (c === '&') {
      push('&');
      continue;
    }
    buf += c;
  }
  if (buf.trim()) push(';');
  return segments;
}

/**
 * Split a single segment into words on unquoted whitespace, dropping surrounding
 * quotes from each word. Coarse but sufficient for identifying a command word
 * and its flag arguments in the agent-mistake threat model.
 */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let had = false;
  for (let k = 0; k < segment.length; k += 1) {
    const c = segment[k]!;
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      had = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (had || buf) words.push(buf);
      buf = '';
      had = false;
      continue;
    }
    buf += c;
    had = true;
  }
  if (had || buf) words.push(buf);
  return words;
}

/** Extract a shell command from an ACP execute/shell permission request, if any. */
export function shellCommandFromRawInput(
  kind: string | undefined,
  rawInput: unknown,
): string | undefined {
  const raw = rawInput as Record<string, unknown> | undefined;
  const candidate =
    (raw && typeof raw.command === 'string' && raw.command) ||
    (raw && typeof raw.cmd === 'string' && raw.cmd) ||
    undefined;
  if (candidate) return candidate;
  // Only treat a bare string rawInput as a command for execute-shaped tools.
  if (typeof rawInput === 'string' && kind && ['execute', 'shell'].includes(kind.toLowerCase())) {
    return rawInput;
  }
  return undefined;
}
