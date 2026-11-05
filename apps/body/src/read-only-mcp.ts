import { AsyncLocalStorage } from 'node:async_hooks';
import { REPOSITORY_ROUTES, agentToolsFor, repositoryTools } from './minimal-tool-surface.js';
/**
 * Deliberately narrow MCP server for repository and approved-skill inspection
 * in Room sessions.
 *
 * Security properties:
 *   - exposes no shell, generic process, or raw git-argument tool;
 *   - resolves every requested path through the configured repository root;
 *   - never follows a symlink outside that root and never exposes `.git`;
 *   - invokes only three fixed, local git read commands with optional locks,
 *     pagers, hooks, fsmonitor, external diff, and text conversion disabled.
 *
 * Repository writes remain the responsibility of buzz-dev-mcp in an isolated
 * edit-corner worktree after the signed human ALLOW flow.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { cornerTextRefusal, normalizeCornerText } from '@beeline/api-contract/daemon';
import { READ_ONLY_TOOL_NAMES } from './read-only-policy.js';
import { isNetworkFailure } from './network-failure.js';
import { handleLine } from './read-only-mcp-tool-call-id.js';
import { executeAgentTool, turnArtifacts } from './read-only-mcp-open-poll.js';






export type JsonObject = Record<string, unknown>;


export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}


export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}


export const MAX_READ_BYTES = 2 * 1024 * 1024;

export const MAX_GIT_BYTES = 2 * 1024 * 1024;

export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

export const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.expo',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);


export function memorySources(args: JsonObject): unknown[] {
  if (!Array.isArray(args.source_message_ids)) throw new Error('source_message_ids must be an array');
  return args.source_message_ids;
}


export const agentSurface = process.env.BEELINE_MCP_SURFACE === 'agent';

export const TOOLS = agentToolsFor(
  agentSurface,
  process.env.BEELINE_AGENT_DM === '1',
  Boolean(process.env.BEELINE_DAEMON_CORNER_ID),
  process.env.BEELINE_CORNER_REPOSITORY === '1',
  Boolean(process.env.BEELINE_GRANT_RUNNER_URL),
  true,
  process.env.BEELINE_NATIVE_IO_PROVEN === '1',
);


export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

// Nothing else ties TOOLS' names to READ_ONLY_TOOL_NAMES (the auto-allow
// permission check's canonical list) — assert they match so the two can't
// silently drift apart the way they did before this check existed.
{
  const declaredNames = new Set([...repositoryTools().map((tool) => tool.name), ...Object.values(REPOSITORY_ROUTES)]);
  const policyNames = new Set<string>(READ_ONLY_TOOL_NAMES);
  const mismatched =
    declaredNames.size !== policyNames.size ||
    [...declaredNames].some((name) => !policyNames.has(name));
  if (mismatched) {
    throw new Error(
      `read-only-mcp TOOLS [${[...declaredNames].join(', ')}] has drifted from ` +
        `read-only-policy.ts READ_ONLY_TOOL_NAMES [${READ_ONLY_TOOL_NAMES.join(', ')}]`,
    );
  }
}


export function configuredRoot(): string {
  const candidate = process.env.BEELINE_READONLY_ROOT?.trim() || process.cwd();
  return realpathSync(candidate);
}


/** Additional daemon-derived paths (e.g. corner worktrees) the read tools may
 *  access. Never model-supplied. Semicolon-separated absolute paths. */
export const EXTRA_ROOTS: string[] = (process.env.BEELINE_READONLY_EXTRA_ROOTS?.trim() ?? '')
  .split(';')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return '';
    }
  })
  .filter(Boolean);


export const repositoryRoot = configuredRoot();

export const approvedAgentRoots = Object.fromEntries(
  [['skills', process.env.BEELINE_READONLY_AGENT_SKILLS_ROOT]].flatMap(([area, value]) => {
    if (!value?.trim()) return [];
    try {
      const candidate = resolve(value);
      const details = lstatSync(candidate);
      const real = realpathSync(candidate);
      if (!details.isDirectory() || details.isSymbolicLink() || real !== candidate) return [];
      return [[area, real]];
    } catch {
      return [];
    }
  }),
) as Partial<Record<'skills', string>>;

export const gitBinary = ['/usr/bin/git', '/bin/git'].find((candidate) => existsSync(candidate));


export function asObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be an object');
  }
  return value as JsonObject;
}


export function stringArg(args: JsonObject, name: string, fallback?: string): string | undefined {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}


export function booleanArg(args: JsonObject, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}


export function integerArg(
  args: JsonObject,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}


export function assertRelativePath(input: string): string {
  if (!input || input.includes('\0') || isAbsolute(input)) {
    throw new Error('path must be a non-empty repository-relative path');
  }
  const normalized = input.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..') || segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error('path escapes the repository inspection boundary');
  }
  return normalized;
}


export function withinRepository(realPath: string): boolean {
  const rel = relative(repositoryRoot, realPath);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return true;
  // Also allow paths under any daemon-derived extra root (e.g. corner worktrees).
  return EXTRA_ROOTS.some((extra) => realPath.startsWith(extra + sep) || realPath === extra);
}


export function existingPath(input: string, expected: 'file' | 'directory' | 'either'): string {
  const relativePath = assertRelativePath(input);
  const candidate = resolve(repositoryRoot, relativePath);
  const resolved = realpathSync(candidate);
  if (!withinRepository(resolved)) {
    throw new Error('path resolves outside the repository inspection boundary');
  }
  const details = statSync(resolved);
  if (expected === 'file' && !details.isFile()) throw new Error('path is not a regular file');
  if (expected === 'directory' && !details.isDirectory())
    throw new Error('path is not a directory');
  return resolved;
}


export function displayPath(path: string): string {
  const shown = relative(repositoryRoot, path).replaceAll('\\', '/');
  return shown || '.';
}


export function shouldSkipDirectory(name: string): boolean {
  return DEFAULT_IGNORED_DIRECTORIES.has(name);
}


export function listFiles(args: JsonObject): string {
  const start = existingPath(stringArg(args, 'path', '.')!, 'directory');
  const maxDepth = integerArg(args, 'max_depth', 3, 1, 8);
  const limit = integerArg(args, 'limit', 500, 1, 2000);
  const output: string[] = [];

  const visit = (directory: string, depth: number) => {
    if (output.length >= limit || depth > maxDepth) return;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (output.length >= limit) break;
      if (entry.name.toLowerCase() === '.git') continue;
      const path = resolve(directory, entry.name);
      const shown = displayPath(path);
      if (entry.isSymbolicLink()) {
        output.push(`${shown}@`);
        continue;
      }
      if (entry.isDirectory()) {
        output.push(`${shown}/`);
        if (!shouldSkipDirectory(entry.name)) visit(path, depth + 1);
        continue;
      }
      if (entry.isFile()) output.push(shown);
    }
  };

  visit(start, 1);
  return `${output.join('\n')}${output.length >= limit ? `\n[truncated at ${limit} entries]` : ''}`;
}


export function readTextFile(path: string, maximumBytes = MAX_READ_BYTES): string {
  const details = statSync(path);
  if (details.size > maximumBytes) {
    throw new Error(`file exceeds the ${maximumBytes}-byte inspection limit`);
  }
  const bytes = readFileSync(path);
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) {
    throw new Error('binary files are not exposed by the read-only text tools');
  }
  return bytes.toString('utf8');
}


export function readFile(args: JsonObject): string {
  const path = existingPath(stringArg(args, 'path') ?? '', 'file');
  const text = readTextFile(path);
  const lines = text.split(/\r?\n/);
  const startLine = integerArg(args, 'start_line', 1, 1, Math.max(1, lines.length));
  const requestedEnd = integerArg(
    args,
    'end_line',
    Math.min(lines.length, startLine + 999),
    startLine,
    Math.max(startLine, lines.length),
  );
  const endLine = Math.min(requestedEnd, startLine + 999);
  const body = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
  return `${displayPath(path)} (${lines.length} lines)\n${body}${requestedEnd > endLine ? '\n[truncated at 1000 lines]' : ''}`;
}


export function readAgentFile(args: JsonObject): string {
  const area = stringArg(args, 'area');
  if (area !== 'skills') throw new Error('area must be skills');
  const root = approvedAgentRoots[area];
  if (!root) throw new Error(`approved ${area} material is unavailable`);
  const input = stringArg(args, 'path') ?? '';
  if (!input || input.includes('\0') || isAbsolute(input)) {
    throw new Error('path must be relative to the approved agent area');
  }
  const normalized = input.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) throw new Error('path escapes the approved agent area');
  let component = root;
  for (const segment of segments) {
    component = resolve(component, segment);
    if (lstatSync(component).isSymbolicLink()) {
      throw new Error('approved agent reads do not follow symbolic links');
    }
  }
  const candidate = resolve(root, normalized);
  const resolved = realpathSync(candidate);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('path resolves outside the approved agent area');
  }
  const linkStats = lstatSync(candidate);
  const details = statSync(resolved);
  if (linkStats.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
    throw new Error('approved agent reads require an ordinary file');
  }
  const text = readTextFile(resolved);
  const lines = text.split(/\r?\n/);
  const startLine = integerArg(args, 'start_line', 1, 1, Math.max(1, lines.length));
  const requestedEnd = integerArg(
    args,
    'end_line',
    Math.min(lines.length, startLine + 999),
    startLine,
    Math.max(startLine, lines.length),
  );
  const endLine = Math.min(requestedEnd, startLine + 999);
  return `${area}/${normalized} (${lines.length} lines)\n${lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n')}${requestedEnd > endLine ? '\n[truncated at 1000 lines]' : ''}`;
}


export function searchableFiles(start: string): string[] {
  const details = statSync(start);
  if (details.isFile()) return [start];
  const files: string[] = [];
  const visit = (directory: string) => {
    const entries: Dirent[] = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(start);
  return files.sort();
}


export function searchText(args: JsonObject): string {
  const query = stringArg(args, 'query') ?? '';
  if (!query || query.length > 256) throw new Error('query must contain 1 to 256 characters');
  const start = existingPath(stringArg(args, 'path', '.')!, 'either');
  const caseSensitive = booleanArg(args, 'case_sensitive', false);
  const maxResults = integerArg(args, 'max_results', 50, 1, 200);
  const needle = caseSensitive ? query : query.toLocaleLowerCase('en-US');
  const matches: string[] = [];
  let inspectedBytes = 0;

  for (const path of searchableFiles(start)) {
    if (matches.length >= maxResults || inspectedBytes >= MAX_SEARCH_TOTAL_BYTES) break;
    const details = lstatSync(path);
    if (!details.isFile() || details.size > MAX_SEARCH_FILE_BYTES) continue;
    inspectedBytes += details.size;
    let text: string;
    try {
      text = readTextFile(path, MAX_SEARCH_FILE_BYTES);
    } catch {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const haystack = caseSensitive ? line : line.toLocaleLowerCase('en-US');
      if (!haystack.includes(needle)) continue;
      matches.push(`${displayPath(path)}:${index + 1}:${line.slice(0, 500)}`);
      if (matches.length >= maxResults) break;
    }
  }

  if (!matches.length) return 'No matches.';
  const truncated = matches.length >= maxResults || inspectedBytes >= MAX_SEARCH_TOTAL_BYTES;
  return `${matches.join('\n')}${truncated ? `\n[truncated at ${matches.length} matches]` : ''}`;
}


export function revisionArg(args: JsonObject, name: string, fallback: string): string {
  const revision = stringArg(args, name, fallback)!;
  const valid =
    /^(?:HEAD(?:~[0-9]{1,4})?|[0-9a-fA-F]{4,64}|(?:refs\/(?:heads|tags)\/|(?:refs\/remotes\/)?origin\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,240})$/.test(
      revision,
    ) && !revision.includes('..');
  if (!valid) throw new Error(`${name} is not an allowed local revision`);
  return revision;
}


export function optionalPath(args: JsonObject): string | undefined {
  const input = stringArg(args, 'path');
  if (input === undefined) return undefined;
  const path = existingPath(input, 'either');
  return displayPath(path);
}


export function runGit(args: string[]): string {
  if (!gitBinary) throw new Error('trusted system git is unavailable');
  try {
    return execFileSync(
      gitBinary,
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.attributesFile=/dev/null',
        '--no-pager',
        '-C',
        repositoryRoot,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: MAX_GIT_BYTES,
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_EXTERNAL_DIFF: '',
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
          PAGER: 'cat',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trimEnd();
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '').trim()
        : '';
    throw new Error(stderr || 'git inspection command failed');
  }
}


export function gitLog(args: JsonObject): string {
  const limit = integerArg(args, 'limit', 20, 1, 100);
  const revision = revisionArg(args, 'revision', 'HEAD');
  const path = optionalPath(args);
  return runGit([
    'log',
    '--no-show-signature',
    `--max-count=${limit}`,
    '--date=iso-strict',
    '--format=%H%x09%ad%x09%an%x09%s',
    revision,
    ...(path ? ['--', path] : []),
  ]);
}


export function gitShow(args: JsonObject): string {
  const revision = revisionArg(args, 'revision', 'HEAD');
  const path = optionalPath(args);
  return runGit([
    'show',
    '--no-ext-diff',
    '--no-textconv',
    '--no-show-signature',
    '--format=fuller',
    '--stat',
    '--patch',
    '--max-count=1',
    revision,
    ...(path ? ['--', path] : []),
  ]);
}


export function gitDiff(args: JsonObject): string {
  const from = revisionArg(args, 'from', 'HEAD~1');
  const to = revisionArg(args, 'to', 'HEAD');
  const path = optionalPath(args);
  return runGit([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--stat',
    '--patch',
    from,
    to,
    ...(path ? ['--', path] : []),
  ]);
}


export function gitStatus(args: JsonObject): string {
  const path = optionalPath(args);
  return runGit(['status', '--porcelain=v2', '--no-ahead-behind', ...(path ? ['--', path] : [])]);
}


export function callTool(name: string, args: JsonObject): string {
  if (name === 'repository_io') {
    const operation = REPOSITORY_ROUTES[String(args.action)];
    if (!operation) throw new Error('unknown repository_io action');
    return callTool(operation, args);
  }
  switch (name) {
    case 'list_files':
      return listFiles(args);
    case 'read_file':
      return readFile(args);
    case 'read_agent_file':
      return readAgentFile(args);
    case 'search_text':
      return searchText(args);
    case 'git_log':
      return gitLog(args);
    case 'git_show':
      return gitShow(args);
    case 'git_diff':
      return gitDiff(args);
    case 'git_status':
      return gitStatus(args);
    default:
      throw new Error(`tool is not available in read-only mode: ${name}`);
  }
}


export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`agent tool is missing host context: ${name}`);
  return value;
}


export const commandRequest = new AsyncLocalStorage<string | undefined>();


export async function activeCommandContext(): Promise<{
  roomId: string;
  requestId: string;
  generationId: string;
  taskId?: string;
}> {
  const value = await readTurnContextFile();
  const requestId = commandRequest.getStore() ?? value.requestId;
  const commands = value.commands as {requestId:string;commandReason:string;taskId:string}[] | undefined;
  if (!value.roomId || !requestId || !value.generationId ||
      (commands?.length && !commands.some(command => command.requestId === requestId)))
    throw new Error('no active server command for requestId');
  const taskId = commands?.find(command => command.requestId === requestId)?.taskId ?? value.taskId;
  return {roomId:String(value.roomId),requestId:String(requestId),generationId:String(value.generationId),
    ...(typeof taskId === 'string' ? {taskId} : {})};
}


export async function readTurnContextFile(): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(requiredEnv('BEELINE_TURN_CONTEXT_FILE'), 'utf8'));
}


/** This turn's assembled prompt section ids, written by the Body; never the agent's. */
export async function turnPromptSectionIds(): Promise<string[]> {
  if (!process.env.BEELINE_TURN_CONTEXT_FILE) return [];
  try {
    const ids = (await readTurnContextFile()).promptSectionIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}


/**
 * Daemon operations this helper may safely send again after a network-level
 * failure. A read has no side effect. Everything else is treated as an
 * ordinary write whose retry could duplicate work (a post, an attachment, a payment), so it is
 * sent once and its failure says the call may not have run. An operation
 * that carries an idempotency key is safe whatever its name.
 */
export const SAFE_TO_REPEAT_DAEMON_OPERATIONS: ReadonlySet<string> = new Set([
  'getAgentAvatar',
  'getAgentUsage',
  'getCornerRestoreState',
  'getPrChecksStatus',
  'getRoomAuthority',
  'getRoomConversation',
  'getRoomMessage',
  'getRoomRepositoryState',
  'getWalletToolBalance',
  'getWalletToolChains',
  'getWalletToolHistory',
  'getWalletToolQuote',
  'getWalletToolState',
  'getWorkflowRun',
  'listAppTools',
  'listCornerBriefRevisions',
  'listRooms',
  'listRoomCorners',
  'listAgentSubscriptions',
  'loadWorkspaceSkill',
  'retrieveLinkSpendRequest',
  'searchInstitutionalHistory',
  'searchInstitutionalMemory',
]);


/** Whether a failed daemon call may be sent again: a read, or any call
 *  that carries its own idempotency key. */
export function daemonOperationIsSafeToRepeat(name: string, input: JsonObject): boolean {
  if (SAFE_TO_REPEAT_DAEMON_OPERATIONS.has(name)) return true;
  return typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0;
}


/** A rejected fetch whose request never produced a response is retryable.
 *  A bare `TypeError: fetch failed` is undici's wrapper for exactly that and
 *  carries no code in its cause chain on some platforms, so it is
 *  network-level too. A response the server actually sent never reaches here. */
export function isDaemonNetworkFailure(error: unknown): boolean {
  if (isNetworkFailure(error)) return true;
  return error instanceof TypeError && /^fetch failed/i.test(error.message);
}


export const toolOwedStorage = new AsyncLocalStorage<{ owedMentions?: unknown[] }>();


// This sandboxed stdio process has no machine registration. Its HTTP ingress
// keeps command authorization in DaemonService without replacing the parent socket.
export async function daemonExecute(name: string, input: JsonObject): Promise<JsonObject> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const body = JSON.stringify({
    ...input,
    ...(process.env.BEELINE_TURN_CONTEXT_FILE &&
    ((!name.startsWith('get') || name.startsWith('getWallet') || name === 'getRoomMessage') &&
      !name.startsWith('list'))
      ? await activeCommandContext()
      : {}),
  });
  try {
      const response = await fetch(new URL(`/v1/daemon/operations/${name}`, `${baseUrl}/`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
          'content-type': 'application/json',
          'x-beeline-helper-version': process.env.BEELINE_HELPER_VERSION || 'v0.0.0',
          ...(toolOwedStorage.getStore() ? { 'x-beeline-tool-result': '1' } : {}),
        },
        body,
      });
      if (!response.ok) {
        let code = 'request_failed';
        try {
          const parsed = (await response.json()) as { error?: unknown };
          if (typeof parsed.error === 'string') code = parsed.error;
        } catch {
          // Never reflect a server body into the model-facing tool error.
        }
        throw new Error(`daemon operation ${name} failed (${response.status}: ${code})`);
      }
      const result = await response.json() as JsonObject | null;
      const toolContext = toolOwedStorage.getStore();
      if (toolContext) {
        toolContext.owedMentions = Array.isArray(result?._beelineOwedMentions) ? result._beelineOwedMentions : undefined;
        if (result && typeof result === 'object' && '_beelineToolResult' in result) return result._beelineToolResult as JsonObject;
      }
      return result as JsonObject;
  } catch(error){
    if(!isDaemonNetworkFailure(error))throw error;
    throw new Error(`daemon operation ${name} failed before the server answered; await a new action or recovery boundary${daemonOperationIsSafeToRepeat(name,input)?'':'; the write outcome is unknown'}`);
  }
}


/** The corner's two texts, flattened and judged. Anything that reads as a
 *  refusal is one plain sentence naming the limit and the actual count: a
 *  refused call the model cannot understand is a silent one (C90). */
export function cornerCallText(args: JsonObject): { name: string; objective: string } {
  const refusal =
    cornerTextRefusal('name', args.name) ?? cornerTextRefusal('objective', args.objective);
  if (refusal) throw new Error(refusal);
  return {
    name: String(args.name),
    objective: normalizeCornerText(String(args.objective)),
  };
}


// MCP requests may run concurrently. Register artifact work before the first
// await so an immediately following report cannot overtake its upload/queue.
export let artifactGeneration: unknown;

export async function callCommandTool(name: string, args: JsonObject, toolCallId: string): Promise<string> {
  if (name !== 'post_artifact' && name !== 'report' && name !== 'post') return executeAgentTool(name, args, toolCallId);
  const contextFile = process.env.BEELINE_TURN_CONTEXT_FILE;
  const context = contextFile ? JSON.parse(readFileSync(contextFile, 'utf8')) as Record<string, unknown> : {};
  const key = JSON.stringify([process.env.BEELINE_DAEMON_BASE_URL, process.env.BEELINE_DAEMON_ROOM_ID,
    context.roomId, commandRequest.getStore() ?? context.requestId, context.generationId]);
  if (artifactGeneration !== context.generationId) { turnArtifacts.clear(); artifactGeneration = context.generationId; }
  const artifacts = turnArtifacts.get(key) ?? {uploads: []};
  turnArtifacts.set(key, artifacts);
  if (name === 'post_artifact') {
    const upload = executeAgentTool(name, args, toolCallId);
    const artifactName = typeof args.title === 'string' && args.title.trim()
      ? args.title.trim() : typeof args.path === 'string' ? basename(args.path) : '';
    artifacts.uploads.push({ name: artifactName, result: upload });
    // Retain failures until a later upload has successfully queued a replacement.
    void upload.catch(() => {});
    return upload;
  }
  const uploads = [...artifacts.uploads];
  const results = await Promise.allSettled(uploads.map(upload => upload.result));
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue;
    const replaced = results.some((later, laterIndex) => laterIndex > index &&
      later.status === 'fulfilled' && uploads[laterIndex]!.name === uploads[index]!.name);
    if (!replaced) throw result.reason;
  }
  return executeAgentTool(name, args, toolCallId, uploads.filter((_, index) => results[index]?.status === 'fulfilled').map(upload => upload.name));
}


export const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => void handleLine(line));
export { agentToolsFor } from './minimal-tool-surface.js';
export { reportFeedback } from './read-only-mcp-open-corner.js';
export { prChecksStatus } from './read-only-mcp-open-corner.js';
export { approveMerge } from './read-only-mcp-open-corner.js';
export type { WriteScratchFileDeps } from './read-only-mcp-open-corner.js';
export { writeScratchFileDepsFromEnv } from './read-only-mcp-open-corner.js';
export { resolveWriteScratchPath } from './read-only-mcp-open-corner.js';
export { writeScratchFile } from './read-only-mcp-open-corner.js';
export type { FetchImageDeps } from './read-only-mcp-open-corner.js';
export { fetchImageDepsFromEnv } from './read-only-mcp-open-corner.js';
export { fetchImage } from './read-only-mcp-open-corner.js';
export { resolveAttachPath } from './read-only-mcp-download-attachment.js';
export type { DaemonArtifactUploadResult } from './read-only-mcp-download-attachment.js';
export type { PostArtifactDeps } from './read-only-mcp-download-attachment.js';
export { postArtifactDepsFromEnv } from './read-only-mcp-download-attachment.js';
export { postArtifact } from './read-only-mcp-download-attachment.js';
export { namedPrivateFiles } from './read-only-mcp-download-attachment.js';
export { bindBriefFiles } from './read-only-mcp-download-attachment.js';
export type { AgentScheduleDeps } from './read-only-mcp-download-attachment.js';
export { agentScheduleDepsFromEnv } from './read-only-mcp-download-attachment.js';
export { reactToMessage } from './read-only-mcp-download-attachment.js';
export { createSchedule } from './read-only-mcp-download-attachment.js';
export { listSchedules } from './read-only-mcp-download-attachment.js';
export { subscribeEvents } from './read-only-mcp-download-attachment.js';
export { listEventSubscriptions } from './read-only-mcp-download-attachment.js';
export { emitEvent } from './read-only-mcp-download-attachment.js';
export { updateSchedule } from './read-only-mcp-download-attachment.js';
export { deleteSchedule } from './read-only-mcp-download-attachment.js';
export type { AgentGrantDeps } from './read-only-mcp-agent-grant-deps.js';
export { agentGrantDepsFromEnv } from './read-only-mcp-agent-grant-deps.js';
export { readGrantScript } from './read-only-mcp-agent-grant-deps.js';
export { requestGrant } from './read-only-mcp-agent-grant-deps.js';
export { requestSharedAssetIsolation } from './read-only-mcp-agent-grant-deps.js';
export { listGrants } from './read-only-mcp-agent-grant-deps.js';
export { storeSecret } from './read-only-mcp-agent-grant-deps.js';
export type { ConnectorOfferDeps } from './read-only-mcp-agent-grant-deps.js';
export { connectorOfferDepsFromEnv } from './read-only-mcp-agent-grant-deps.js';
export { workbenchStatus } from './read-only-mcp-agent-grant-deps.js';
export { offerConnector } from './read-only-mcp-agent-grant-deps.js';
export { askChoice } from './read-only-mcp-agent-grant-deps.js';
export { openPoll } from './read-only-mcp-open-poll.js';
export type { GrantRunDeps } from './read-only-mcp-open-poll.js';
export { grantRunDepsFromEnv } from './read-only-mcp-open-poll.js';
export { runGrantedCommand } from './read-only-mcp-open-poll.js';
export { callAgentTool } from './read-only-mcp-open-poll.js';
export { withToolOwedContext } from './read-only-mcp-tool-call-id.js';
