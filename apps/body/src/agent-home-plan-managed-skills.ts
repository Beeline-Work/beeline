import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { PlannedSkill } from './agent-home-provision-agent-skills-and-mcp.js';
import { OPERATOR_SKILL_SOURCE_DIRS, isSharedSkillName, AgentHomeSecurityError } from './agent-home.js';
import { AGENT_PRIVATE_STATE_ENV } from './agent-private-state-env.js';



/**
 * Everything this activation would materialize, plus the exact manifest of the
 * tree it would produce.
 *
 * The plan is settled BEFORE anything is written, so the reuse test and the
 * rebuild are the same decision read twice — a share that fails validation is
 * skipped here (for an implicit share) or thrown here (for an explicit one),
 * and therefore never appears in a manifest that a materialized tree is asked
 * to match.
 */
export async function planManagedSkills(
  managedSkills: Array<{ name: string; content: string }>,
  sharedSkills: Array<{ name: string; source: string }>,
  optionalShares: boolean,
): Promise<{ entries: PlannedSkill[]; manifest: string }> {
  const entries: PlannedSkill[] = [];
  const lines: string[] = [];
  const names = new Set(managedSkills.map((skill) => skill.name));
  for (const skill of managedSkills) {
    entries.push({ kind: 'managed', name: skill.name, content: skill.content });
    lines.push(`d ${skill.name}`, `f ${skill.name}/SKILL.md 600 ${sha256(skill.content)}`);
  }
  for (const shared of sharedSkills) {
    if (names.has(shared.name)) {
      throw new Error(`shared skill collides with Beeline-owned skill: ${shared.name}`);
    }
    names.add(shared.name);
    try {
      const tree: string[] = [];
      await walkSafeSkillTree(shared.source, shared.source, {
        directory: async (rel) => void tree.push(`d ${join(shared.name, rel)}`),
        file: async (rel, realPath, mode) =>
          void tree.push(`f ${join(shared.name, rel)} ${mode.toString(8)} ${sha256(await readFile(realPath))}`),
      });
      entries.push({ kind: 'shared', name: shared.name, source: shared.source });
      lines.push(...tree);
    } catch (error) {
      // Default (implicit) shares degrade to fewer skills rather than
      // failing the Room; an explicitly named share still fails loudly.
      if (!optionalShares) throw error;
      console.warn(`[body] skipping shared skill ${shared.name}:`, error);
    }
  }
  return { entries, manifest: lines.sort().join('\n') };
}


/**
 * The manifest of a skills tree that already exists, or `undefined` when it
 * cannot be read as one. A symlink, a device node, or a file sharing its inode
 * with something outside the tree makes the whole tree unusable rather than
 * merely different: those are the shapes a writable home could use to keep a
 * mutable handle on what the harness reads, so a provision is never reused
 * over them.
 */
export async function materializedSkillManifest(target: string): Promise<string | undefined> {
  const stats = await lstat(target).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) return undefined;
  const lines: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<boolean> => {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry);
      const rel = prefix ? join(prefix, entry) : entry;
      const entryStats = await lstat(path);
      if (entryStats.isSymbolicLink()) return false;
      if (entryStats.isDirectory()) {
        lines.push(`d ${rel}`);
        if (!(await visit(path, rel))) return false;
        continue;
      }
      if (!entryStats.isFile() || entryStats.nlink !== 1) return false;
      lines.push(`f ${rel} ${(entryStats.mode & 0o7777).toString(8)} ${sha256(await readFile(path))}`);
    }
    return true;
  };
  try {
    if (!(await visit(target, ''))) return undefined;
  } catch {
    return undefined;
  }
  return lines.sort().join('\n');
}


export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}


/**
 * The skill shares for one activation. Non-empty explicit names narrow the
 * share per agent (the previous behavior, validated fail-closed). Otherwise
 * EVERY entry across the operator's skill directories is shared by default:
 * each entry is validated with the same boundary as an explicit share, but an
 * entry that cannot be validated safely is skipped with a warning, and a name
 * present in several directories resolves first-dir-wins instead of failing.
 */
export async function resolveSharedSkillSources(
  operatorHome: string,
  names: string[],
): Promise<Array<{ name: string; source: string }>> {
  if (names.length > 0) return resolveExplicitSkillSources(operatorHome, names);
  const seen = new Set<string>();
  const resolved: Array<{ name: string; source: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const relativeRoot of OPERATOR_SKILL_SOURCE_DIRS) {
    const sourceRoot = resolve(operatorHome, relativeRoot);
    const rootStats = await lstat(sourceRoot).catch(() => undefined);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) continue;
    for (const entry of await readdir(sourceRoot)) {
      if (!isSharedSkillName(entry) || seen.has(entry)) continue;
      const candidate = resolve(sourceRoot, entry);
      try {
        const candidateStats = await lstat(candidate);
        if (candidateStats.isSymbolicLink()) {
          const reason = await realpath(candidate).then(
            () => 'symlinked directory',
            (error: unknown) =>
              isMissingPathError(error) ? 'dangling symlink' : 'symlinked directory',
          );
          skipped.push({
            path: candidate,
            reason,
          });
          continue;
        }
        if (!candidateStats.isDirectory()) {
          skipped.push({ path: candidate, reason: 'not an ordinary directory' });
          continue;
        }
        assertContained(sourceRoot, candidate);
        const skillMd = resolve(candidate, 'SKILL.md');
        const skillStats = await lstat(skillMd).catch((error: unknown) => {
          if (isMissingPathError(error)) {
            skipped.push({ path: candidate, reason: 'missing SKILL.md' });
            return undefined;
          }
          throw error;
        });
        if (!skillStats) continue;
        if (!skillStats.isFile() || skillStats.isSymbolicLink() || skillStats.nlink !== 1) {
          skipped.push({ path: candidate, reason: 'SKILL.md is not an ordinary file' });
          continue;
        }
        seen.add(entry);
        resolved.push({ name: entry, source: candidate });
      } catch (error) {
        if (isMissingPathError(error)) {
          skipped.push({ path: candidate, reason: 'missing during discovery' });
          continue;
        }
        // Unexpected filesystem errors remain loud: operators need their
        // stack traces to distinguish a bad skill from a broken home volume.
        console.warn(`[body] skipping operator skill ${entry}:`, error);
      }
    }
  }
  logSkippedOperatorSkills(skipped);
  return resolved;
}


export function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}


/**
 * Expected bad shapes in an operator's ambient skills directory are not daemon
 * failures. Keep each diagnosis to one journal line, then give repeated
 * reasons a per-activation total so a stale symlink farm does not hide real
 * warnings later in the same activation.
 */
export function logSkippedOperatorSkills(skipped: Array<{ path: string; reason: string }>): void {
  const totals = new Map<string, number>();
  for (const { path, reason } of skipped) {
    console.warn(`[body] skipping operator skill ${path}: ${reason}`);
    totals.set(reason, (totals.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of totals) {
    if (count > 1) console.warn(`[body] ${count} skill entries skipped: ${reason}`);
  }
}


export async function resolveExplicitSkillSources(
  operatorHome: string,
  names: string[],
): Promise<Array<{ name: string; source: string }>> {
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!isSharedSkillName(name)) throw new Error(`invalid shared skill name: ${name}`);
  }
  const resolved: Array<{ name: string; source: string }> = [];
  for (const name of unique) {
    const matches: string[] = [];
    for (const relativeRoot of OPERATOR_SKILL_SOURCE_DIRS) {
      const sourceRoot = resolve(operatorHome, relativeRoot);
      const candidate = resolve(sourceRoot, name);
      const rootStats = await lstat(sourceRoot).catch(() => undefined);
      const candidateStats = await lstat(candidate).catch(() => undefined);
      if (!candidateStats) continue;
      if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error(`shared skill source root is not an ordinary directory: ${sourceRoot}`);
      }
      if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
        throw new Error(`shared skill source is not an ordinary directory: ${candidate}`);
      }
      assertContained(sourceRoot, candidate);
      matches.push(candidate);
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `shared skill is unavailable: ${name}`
          : `shared skill source is ambiguous: ${name}`,
      );
    }
    const skillMd = resolve(matches[0]!, 'SKILL.md');
    const skillStats = await lstat(skillMd).catch(() => undefined);
    if (!skillStats?.isFile() || skillStats.isSymbolicLink() || skillStats.nlink !== 1) {
      throw new Error(`shared skill requires an ordinary SKILL.md: ${name}`);
    }
    resolved.push({ name, source: matches[0]! });
  }
  return resolved;
}


export function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== resolve(candidate)) {
    throw new Error(`path escapes the agent skill boundary: ${candidate}`);
  }
}


export async function assertRealContainedDirectory(path: string, root: string): Promise<void> {
  assertContained(root, path);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AgentHomeSecurityError(
      `agent skill destination is not an ordinary directory: ${path}`,
    );
  }
}


export const BLOCKED_SHARED_FILENAMES =
  /^(?:\.env(?:\..*)?|auth\.json|\.credentials\.json|config\.toml|settings(?:\.local)?\.json|\.mcp\.json|credentials?|secrets?|plugins?|\.codex-plugin|\.claude-plugin|memory(?:\.md)?|\.netrc|\.git-credentials|.*\.(?:pem|key))$/i;


export interface SkillTreeVisitor {
  /** A directory the copy would create, by its path relative to the skill root. */
  directory(rel: string): Promise<void>;
  /** An ordinary file the copy would carry, with the real path to read it from. */
  file(rel: string, realPath: string, mode: number): Promise<void>;
}


/**
 * Walk one shared skill under its whole safety boundary, once.
 *
 * Copying and hashing are the same walk with different visitors deliberately:
 * the reuse test only means anything while the manifest it compares against is
 * produced by exactly the rules the copy obeys, and a second walker written
 * beside this one would drift out of that agreement silently.
 */
export async function walkSafeSkillTree(
  source: string,
  sourceRoot: string,
  visitor: SkillTreeVisitor,
  rel = '',
): Promise<void> {
  assertContained(sourceRoot, source);
  const resolvedSource = await realpath(source);
  if (resolvedSource !== resolve(source)) {
    throw new Error(`shared skill path resolves through a link: ${source}`);
  }
  assertContained(sourceRoot, resolvedSource);
  const stats = await lstat(resolvedSource);
  if (stats.isSymbolicLink()) throw new Error(`shared skill contains a symlink: ${source}`);
  if (BLOCKED_SHARED_FILENAMES.test(basename(source))) {
    throw new Error(`shared skill contains credential or configuration material: ${source}`);
  }
  if (stats.isDirectory()) {
    await visitor.directory(rel);
    for (const entry of await readdir(resolvedSource)) {
      if (entry === '.' || entry === '..') throw new Error('invalid shared skill entry');
      await walkSafeSkillTree(
        resolve(source, entry),
        sourceRoot,
        visitor,
        rel ? join(rel, entry) : entry,
      );
    }
    return;
  }
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`shared skill contains a nonordinary file: ${source}`);
  }
  // Keep files private and discard special bits and group/other permissions.
  await visitor.file(rel, resolvedSource, 0o600 | (stats.mode & 0o100));
}


export async function copySafeSkillTree(
  source: string,
  target: string,
  sourceRoot: string,
): Promise<void> {
  await walkSafeSkillTree(source, sourceRoot, {
    directory: async (rel) => {
      await mkdir(resolve(target, rel), { mode: 0o700 });
    },
    file: async (rel, realPath, mode) => {
      const destination = resolve(target, rel);
      await copyFile(realPath, destination);
      await chmod(destination, mode);
    },
  });
}


/**
 * Replace one generated harness file without ever following a symlink already
 * occupying the target. A session can write its isolated state directory, so
 * plain `writeFile(target)` would let a stale/malicious symlink redirect the
 * daemon's next regeneration into another file. The temporary file is private
 * from creation and `rename` replaces the directory entry itself.
 */
export async function writeIsolatedHarnessFile(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`isolated harness parent is not a real directory: ${parent}`);
  }
  const temporary = resolve(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}


/**
 * The short, per-session temp path a session's `TMPDIR` points at.
 *
 * A room's agent home lives under the daemon's state root and is easily longer
 * than the ~108-byte `sun_path` a Unix socket address allows; `tsx` (and any
 * other tool that binds an IPC socket under `os.tmpdir()`) then fails with
 * `listen EINVAL`. The real scratch directory stays `<root>/tmp` — so
 * `helper-storage.ts` and the OS sandbox keep seeing it — and this path is a
 * symlink to it, named by a hash of the home so it is stable per session and
 * comfortably inside the socket limit. `prepareRoomAgentHome` creates the
 * symlink; `bwrap-sandbox.ts` binds its resolved directory over the sandbox's
 * private `/tmp`.
 */
export function roomSessionTmpDir(root: string, base: string = '/tmp'): string {
  const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  return join(base, `beeline-${hash}`);
}


/**
 * The env overlay alone, without touching the filesystem. `TMPDIR` is the
 * short {@link roomSessionTmpDir} symlink; every other path is under `root`.
 */
export function roomAgentHomeEnv(root: string): Record<string, string> {
  const resolved = resolve(root);
  return {
    HOME: resolve(resolved, 'user'),
    CLAUDE_CONFIG_DIR: resolve(resolved, 'claude'),
    CODEX_HOME: resolve(resolved, 'codex'),
    GOOSE_PATH_ROOT: resolve(resolved, 'goose'),
    GROK_HOME: resolve(resolved, 'grok'),
    CURSOR_HOME: resolve(resolved, 'cursor'),
    OPENCODE_CONFIG_DIR: resolve(resolved, 'opencode'),
    PI_CODING_AGENT_DIR: resolve(resolved, 'pi'),
    XDG_CONFIG_HOME: resolve(resolved, 'user/.config'),
    XDG_DATA_HOME: resolve(resolved, 'user/.local/share'),
    XDG_STATE_HOME: resolve(resolved, 'state'),
    XDG_CACHE_HOME: resolve(resolved, 'cache'),
    TMPDIR: roomSessionTmpDir(resolved),
  };
}


/**
 * Harness state/credential directories in a prepared env, and the temp
 * directory, split apart because the OS sandbox treats them differently: a
 * Room keeps the state dirs read-only but still needs a writable temp
 * (`bwrap-sandbox.ts`). Reads whatever the env actually carries, so it is
 * correct both for a Room with its own agent home and for one still on the
 * daemon's ambient state.
 */
export const HARNESS_STATE_ENV_VARS = [
  'CLAUDE_CONFIG_DIR',
  // The operator's shared Claude login store; Claude writes its login and
  // refresh lock there (`sharedClaudeLoginEnv`).
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CODEX_HOME',
  'GOOSE_PATH_ROOT',
  'GROK_HOME',
  'CURSOR_HOME',
  'OPENCODE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  AGENT_PRIVATE_STATE_ENV,
] as const;


export function harnessStateDirsFromEnv(env: Record<string, string | undefined>): {
  stateDirs: string[];
  tmpDir?: string;
} {
  const stateDirs: string[] = [];
  for (const name of HARNESS_STATE_ENV_VARS) {
    const value = env[name];
    if (value) stateDirs.push(resolve(value));
  }
  const tmp = env.TMPDIR;
  return { stateDirs, ...(tmp ? { tmpDir: resolve(tmp) } : {}) };
}
