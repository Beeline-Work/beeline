/**
 * Session sandbox policy — the fail-closed half of the Room/Corner boundary.
 *
 * `corner-isolation.ts` places a corner's worktree somewhere a harness's
 * "go to the project root" reflex cannot walk out of, and guards a persistent
 * `cd`. That constrains the *default directory*; it does not constrain
 * **absolute-path reach**. A harness's built-in write/exec tools can name any
 * path on the host, so the only daemon-side boundary left is the ACP
 * `session/request_permission` handler:
 *
 *   - A ROOM repository is read-only. Mutations are denied unless every named
 *     target is physically inside one explicit agent-private capability: its
 *     memory or ephemeral workbench. Shell payloads never qualify for that
 *     exception. A repository change still escalates into a separate corner.
 *   - A CORNER session is writable by default. Its bubblewrap mount table masks
 *     credentials and overlays only shared worktrees/checkouts and daemon-owned
 *     state read-only. This callback mirrors that denylist for adapters that
 *     still ask despite their full-autonomy mode; ordinary writes elsewhere
 *     are approved immediately.
 *
 * Path comparison is done on *physically resolved* paths (the deepest existing
 * ancestor is `realpath`'d and the not-yet-existing remainder appended), so a
 * symlink inside the worktree pointing at the operator's checkout does not
 * launder a write out of the sandbox.
 *
 * IMPORTANT — this is a permission-callback policy, so it only binds a harness
 * that actually asks. See `harness-capabilities.ts` for which harnesses do.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { isMutatingPermissionRequest, type AcpPermissionRequest } from './acp.js';
import { shellCommandFromRawInput } from './corner-isolation.js';

/**
 * Steering text for a Room denial. ACP's permission response carries only an
 * option id — there is no reason field on the wire, and every adapter
 * hard-codes its own denial text ("User refused permission to run tool") — so
 * this reaches the agent through the Room system prompt and the durable
 * conversation transcript rather than through the rejection itself.
 */
/**
 * What a Room denial tells the agent.
 *
 * A denial that names only the rule invites the model to look for a way
 * around it: refused `write` becomes `edit`, becomes `bash … > file`, becomes
 * a patch tool — each attempt a full turn of tokens, none of which can ever
 * succeed, because the boundary is on the ACTION and not on the tool that asks
 * for it. That retry ladder is a measurable share of the captain's burn and it
 * is entirely avoidable: the host knows no tool will work and can just say so.
 *
 * So the steer states the rule, states the ONE thing that does work, and
 * explicitly closes the search — stop, do not try another tool.
 */
export const ROOM_READ_ONLY_STEER =
  'this Room repository is read-only; open a corner yourself in one step to make repository changes. ' +
  'Only the explicitly named agent-private memory and workbench directories are writable here. ' +
  'To persist private memory, use buzz-readonly-mcp.write_memory; shell writes to memory are always denied. ' +
  'Shell commands and git state cannot be modified from a Room. ' +
  'Do not retry with a different tool — every write, edit, move, delete and shell ' +
  'command outside those capabilities is refused here, whichever tool asks. Stop trying to make ' +
  'the repository change here and continue only in the isolated corner the host opens.';

export type SandboxDenyCode =
  'room-read-only' | 'path-escape' | 'command-write-escape' | 'persistent-cd' | 'git-escape';

export type SandboxVerdict =
  { decision: 'allow' } | { decision: 'deny'; code: SandboxDenyCode; reason: string };

const ALLOW: SandboxVerdict = { decision: 'allow' };

/** Object keys whose string value names a filesystem path, across harnesses. */
const PATH_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'filepath',
  'file_path',
  'filename',
  'file_name',
  'abspath',
  'abs_path',
  'absolutepath',
  'absolute_path',
  'targetfile',
  'target_file',
  'notebookpath',
  'notebook_path',
  'oldpath',
  'old_path',
  'newpath',
  'new_path',
  'source',
  'destination',
  'dest',
  'dir',
  'directory',
  'cwd',
  'workdir',
  'working_directory',
]);

/** Bounds on the raw-input walk: a permission payload is never legitimately huge. */
const MAX_WALK_NODES = 500;
const MAX_WALK_DEPTH = 8;

/**
 * Every filesystem path named anywhere in a permission request — `rawInput`,
 * the tracked tool-call metadata, `locations`, diff `content`, and adapter
 * `_meta` (codex puts an apply-patch's `changes[].path` there and nowhere
 * else). Walked generically because each adapter names its paths differently
 * and a per-adapter list would silently miss the next one.
 */
export function permissionTargetPaths(request: AcpPermissionRequest): string[] {
  const found: string[] = [];
  let nodes = 0;

  const visit = (value: unknown, keyIsPath: boolean, depth: number): void => {
    if (nodes >= MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
    nodes += 1;
    if (typeof value === 'string') {
      if (keyIsPath && value.trim()) found.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, keyIsPath, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, PATH_KEYS.has(key.toLowerCase()), depth + 1);
    }
  };

  visit(request.toolCall, false, 0);
  visit(request._meta, false, 0);
  return found;
}

/** Expand a leading `~` so a home-relative path is compared as an absolute one. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Physically resolve `path`: `realpath` the deepest existing ancestor and
 * re-append the not-yet-existing remainder. A plain `resolve` would compare
 * the *lexical* path, which a symlink inside the worktree defeats.
 */
export function physicalPath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const trailing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...trailing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Is `child` the same as, or nested under, `parent`? Both already physical. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Does `path` land outside `root`? A bare relative path resolves against the
 * root and therefore stays inside unless it climbs out with `..`.
 */
export function pathEscapesRoot(path: string, root: string): boolean {
  const expanded = expandHome(path);
  const rootReal = physicalPath(root);
  const target = physicalPath(isAbsolute(expanded) ? expanded : resolve(rootReal, expanded));
  return !isInside(rootReal, target);
}

/**
 * Command words that mutate a path named on their own argv. Deliberately short,
 * and only ever consulted as a segment's HEAD word (after env assignments and
 * forking wrappers): the guard fires only on an ABSOLUTE argument that resolves
 * outside the worktree, so an ordinary in-worktree `rm -rf dist`, a
 * `cat /etc/hostname`, or an `npm install` is untouched. Readers are absent on
 * purpose — this is a write guard, not an access-control list.
 */
const WRITING_COMMANDS = new Set([
  'cp',
  'mv',
  'rm',
  'rmdir',
  'mkdir',
  'touch',
  'tee',
  'dd',
  'truncate',
  'install',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'shred',
  'rsync',
  'patch',
]);

/** Wrappers that run the real command word next; a `cd` behind them is the cd-guard's job. */
const COMMAND_WRAPPERS = new Set([
  'sudo',
  'env',
  'xargs',
  'nohup',
  'timeout',
  'gtimeout',
  'time',
  'exec',
  'command',
  'builtin',
  'nice',
  'ionice',
  'stdbuf',
]);

/** Redirection sinks that are never a filesystem escape. */
const DISCARD_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** Shell-command targets that resolve into a protected write root. */
function pathInsideAnyRoot(path: string, worktree: string, roots: readonly string[]): boolean {
  const expanded = expandHome(path);
  const worktreeReal = physicalPath(worktree);
  const target = physicalPath(isAbsolute(expanded) ? expanded : resolve(worktreeReal, expanded));
  return roots.some((root) => isInside(physicalPath(root), target));
}

function commandWriteEscape(
  command: string,
  worktree: string,
  protectedWriteRoots: readonly string[],
  allowedWriteRoots: readonly string[],
): string | undefined {
  const escapes = (token: string): boolean => {
    if (DISCARD_SINKS.has(token)) return false;
    const allowed = [worktree, ...allowedWriteRoots];
    return (
      pathInsideAnyRoot(token, worktree, protectedWriteRoots) &&
      !pathInsideAnyRoot(token, worktree, allowed)
    );
  };

  // Output redirection to an absolute path: `… > /home/op/proj/file.ts`.
  // `2>/dev/null` never matches: the char before `>` must not be a word char.
  for (const match of command.matchAll(/(?:^|[^\w>])>>?\s*("?)((?:[~/]|\.\.?\/)[^\s"'|;&)]*)\1/g)) {
    const target = match[2];
    if (target && escapes(target)) return target;
  }

  for (const segment of command.split(/&&|\|\||[;|&\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const word = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || COMMAND_WRAPPERS.has(word)) {
        i += 1;
        continue;
      }
      break;
    }
    const word = words[i];
    if (!word) continue;
    const head = word.includes('/') ? basename(word) : word;
    const rest = words.slice(i + 1);
    if (!WRITING_COMMANDS.has(head) && !(head === 'sed' && rest.some(inPlaceSedFlag))) continue;
    for (const arg of rest) {
      if (arg.startsWith('-')) continue;
      if (escapes(arg)) return arg;
    }
  }
  return undefined;
}

function inPlaceSedFlag(word: string): boolean {
  return word === '-i' || /^-i\S*$/.test(word) || word.startsWith('--in-place');
}

/**
 * Room policy: deny every mutating request outright.
 *
 * Fail-closed by construction — the caller admits only an exact inspection
 * MCP match or Body's own action-tool MCP transport before consulting this.
 * The latter still reaches `authorize-or-request` for its actual verdict; a
 * request this function cannot classify is denied by the Room handler. This
 * verdict carries the steering reason and makes the denial explicit rather
 * than a fall-through.
 */
export function classifyRoomPermission(request: AcpPermissionRequest): SandboxVerdict {
  if (!isMutatingPermissionRequest(request)) return ALLOW;
  return { decision: 'deny', code: 'room-read-only', reason: ROOM_READ_ONLY_STEER };
}

/**
 * Is this mutating request exactly a write INTO the agent's own memory
 * directory (`agent-memory.ts`)? Memory is agent-private state, not the
 * repository, so a Room session may write it despite the read-only repo —
 * and the Room handler must therefore ALLOW such a request ahead of the
 * read-only denial instead of parking it behind a human corner card.
 *
 * Fail-closed by construction, same discipline as `isReadOnlyMcpPermissionRequest`:
 *
 *  - A request carrying a SHELL payload is never resolved by its text —
 *    `bash … > memory/MEMORY.md && rm -rf /repo` must not pass because one
 *    token names the memory dir. Shell writes to memory stay denied; the
 *    prompt tells the agent to use buzz-readonly-mcp.write_memory.
 *  - EVERY filesystem path named anywhere in the request must resolve inside
 *    the memory dir (physically resolved, so a symlink cannot launder the
 *    target out), and at least one path must be named. A mutating request
 *    this function cannot pin to the memory dir falls through to the
 *    ordinary read-only flow.
 */
export function isAgentMemoryWritePermissionRequest(
  request: AcpPermissionRequest,
  memoryDir: string,
): boolean {
  if (!isMutatingPermissionRequest(request)) return false;
  const kind = request.toolCall?.kind?.toLowerCase();
  if (kind === 'execute') return false;
  if (shellCommandFromRawInput(request.toolCall?.kind, request.toolCall?.rawInput)) return false;
  const targets = permissionTargetPaths(request);
  if (targets.length === 0) return false;
  return targets.every((path) => !pathEscapesRoot(path, memoryDir));
}

/**
 * The workbench twin of the memory capability above. Workbench paths must be
 * absolute as well as physically confined: a relative `report.html` resolves
 * against the ACP session cwd (the read-only repository), not the workbench.
 */
export function isAgentWorkbenchWritePermissionRequest(
  request: AcpPermissionRequest,
  workbenchDir: string,
): boolean {
  if (!isMutatingPermissionRequest(request)) return false;
  const kind = request.toolCall?.kind?.toLowerCase();
  if (kind === 'execute') return false;
  if (shellCommandFromRawInput(request.toolCall?.kind, request.toolCall?.rawInput)) return false;
  const targets = permissionTargetPaths(request);
  if (targets.length === 0) return false;
  return targets.every((path) => isAbsolute(path) && !pathEscapesRoot(path, workbenchDir));
}

/**
 * Corner fallback policy: allow mutations everywhere except the hygiene
 * denylist. Explicit writable roots win over protected parents (the current
 * worktree inside the corners pool, its git common dir inside the canonical
 * checkout, and selected Body-owned capabilities). Reads are untouched.
 */
export function classifyCornerPermission(
  request: AcpPermissionRequest,
  worktreePath: string,
  protectedWriteRoots: readonly string[] = [],
  allowedWriteRoots: readonly string[] = [],
): SandboxVerdict {
  const command = shellCommandFromRawInput(request.toolCall?.kind, request.toolCall?.rawInput);
  if (!isMutatingPermissionRequest(request)) return ALLOW;

  if (command) {
    const escape = commandWriteEscape(
      command,
      worktreePath,
      protectedWriteRoots,
      allowedWriteRoots,
    );
    if (escape) {
      return {
        decision: 'deny',
        code: 'command-write-escape',
        reason:
          `this command would write to protected path '${escape}'. ` +
          `The corner is autonomous elsewhere, but shared checkouts, sibling corners, ` +
          `daemon state and credential stores stay read-only.`,
      };
    }
  }

  for (const path of permissionTargetPaths(request)) {
    if (
      pathInsideAnyRoot(path, worktreePath, protectedWriteRoots) &&
      !pathInsideAnyRoot(path, worktreePath, [worktreePath, ...allowedWriteRoots])
    ) {
      return {
        decision: 'deny',
        code: 'path-escape',
        reason:
          `'${path}' resolves into a protected shared or daemon-owned path. ` +
          `The corner is writable by default everywhere else.`,
      };
    }
  }

  return ALLOW;
}
