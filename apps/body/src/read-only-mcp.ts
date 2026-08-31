#!/usr/bin/env node
/**
 * Deliberately narrow MCP server for repository inspection and private-memory
 * persistence in Room sessions.
 *
 * Security properties:
 *   - exposes exactly one mutation: replacing this agent's daemon-pinned
 *     Workspace MEMORY.md through a bounded, non-symlink file descriptor;
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
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { READ_ONLY_TOOL_NAMES } from './read-only-policy.js';

type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024;
const MAX_GIT_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.expo',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description:
      'List files under the repository without changing them. Symlinks are listed but never followed during traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative directory; defaults to .' },
        max_depth: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read a bounded line range from one text file inside the repository. Paths outside the repository and .git are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative file path.' },
        start_line: { type: 'integer', minimum: 1, default: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_agent_file',
    description:
      "Read one text file from this agent's approved materialized skills or Workspace memory. It cannot access harness config, credentials, repositories, other agents, or execute content.",
    inputSchema: {
      type: 'object',
      required: ['area', 'path'],
      properties: {
        area: { type: 'string', enum: ['skills', 'memory'] },
        path: { type: 'string', description: 'Path relative to the selected approved area.' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'write_memory',
    description:
      "Replace this agent's private Workspace MEMORY.md. This is the only supported memory-write path in a read-only Room; shell writes to memory are always denied.",
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'The complete new UTF-8 contents of MEMORY.md.',
          maxLength: MAX_MEMORY_BYTES,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description:
      'Search for a literal text string in bounded repository text files. This is a safe grep-like search, not a shell or regex evaluator.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        path: {
          type: 'string',
          description: 'Repository-relative file or directory; defaults to .',
        },
        case_sensitive: { type: 'boolean', default: false },
        max_results: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_log',
    description:
      'Read bounded local commit history, optionally scoped to one repository path. It cannot contact remotes or change git state.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        path: { type: 'string', description: 'Optional repository-relative path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_show',
    description:
      'Read one local commit and its patch with external diff and text conversion disabled. Revision syntax is intentionally restricted.',
    inputSchema: {
      type: 'object',
      properties: {
        revision: {
          type: 'string',
          description: 'HEAD, HEAD~N, a commit hash, or refs/heads|tags/...; defaults to HEAD.',
        },
        path: { type: 'string', description: 'Optional repository-relative path filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_diff',
    description:
      'Read a local commit-to-commit diff. Working-tree and staged diffs are intentionally unavailable because repository filters can execute commands.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Restricted local revision; defaults to HEAD~1.' },
        to: { type: 'string', description: 'Restricted local revision; defaults to HEAD.' },
        path: { type: 'string', description: 'Optional repository-relative path filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_status',
    description:
      'Read the working-tree state. Does not invoke textconv or external diff, so the security concerns that exclude git_diff for working-tree content do not apply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional repository-relative path filter.' },
      },
      additionalProperties: false,
    },
  },
];

// Nothing else ties TOOLS' names to READ_ONLY_TOOL_NAMES (the auto-allow
// permission check's canonical list) — assert they match so the two can't
// silently drift apart the way they did before this check existed.
{
  const declaredNames = new Set(TOOLS.map((tool) => tool.name));
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

function configuredRoot(): string {
  const candidate = process.env.BEELINE_READONLY_ROOT?.trim() || process.cwd();
  return realpathSync(candidate);
}

/** Additional daemon-derived paths (e.g. corner worktrees) the read tools may
 *  access. Never model-supplied. Semicolon-separated absolute paths. */
const EXTRA_ROOTS: string[] = (process.env.BEELINE_READONLY_EXTRA_ROOTS?.trim() ?? '')
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

const repositoryRoot = configuredRoot();
const approvedAgentRoots = Object.fromEntries(
  [
    ['skills', process.env.BEELINE_READONLY_AGENT_SKILLS_ROOT],
    ['memory', process.env.BEELINE_READONLY_AGENT_MEMORY_ROOT],
  ].flatMap(([area, value]) => {
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
) as Partial<Record<'skills' | 'memory', string>>;
const gitBinary = ['/usr/bin/git', '/bin/git'].find((candidate) => existsSync(candidate));

function asObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be an object');
  }
  return value as JsonObject;
}

function stringArg(args: JsonObject, name: string, fallback?: string): string | undefined {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function booleanArg(args: JsonObject, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function integerArg(
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

function assertRelativePath(input: string): string {
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

function withinRepository(realPath: string): boolean {
  const rel = relative(repositoryRoot, realPath);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return true;
  // Also allow paths under any daemon-derived extra root (e.g. corner worktrees).
  return EXTRA_ROOTS.some((extra) => realPath.startsWith(extra + sep) || realPath === extra);
}

function existingPath(input: string, expected: 'file' | 'directory' | 'either'): string {
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

function displayPath(path: string): string {
  const shown = relative(repositoryRoot, path).replaceAll('\\', '/');
  return shown || '.';
}

function shouldSkipDirectory(name: string): boolean {
  return DEFAULT_IGNORED_DIRECTORIES.has(name);
}

function listFiles(args: JsonObject): string {
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

function readTextFile(path: string, maximumBytes = MAX_READ_BYTES): string {
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

function readFile(args: JsonObject): string {
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

function readAgentFile(args: JsonObject): string {
  const area = stringArg(args, 'area');
  if (area !== 'skills' && area !== 'memory') throw new Error('area must be skills or memory');
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

function writeMemory(args: JsonObject): string {
  if (Object.keys(args).some((key) => key !== 'content')) {
    throw new Error('write_memory accepts only content');
  }
  const content = stringArg(args, 'content');
  if (content === undefined) throw new Error('content must be a string');
  if (content.includes('\0')) throw new Error('memory content must be UTF-8 text');
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) {
    throw new Error(`memory content exceeds the ${MAX_MEMORY_BYTES}-byte limit`);
  }
  const root = approvedAgentRoots.memory;
  if (!root) throw new Error('approved memory material is unavailable');
  const candidate = resolve(root, 'MEMORY.md');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, constants.O_WRONLY | constants.O_NOFOLLOW);
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.nlink !== 1) {
      throw new Error('memory writes require an ordinary private MEMORY.md');
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return `memory/MEMORY.md updated (${Buffer.byteLength(content, 'utf8')} bytes)`;
}

function searchableFiles(start: string): string[] {
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

function searchText(args: JsonObject): string {
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

function revisionArg(args: JsonObject, name: string, fallback: string): string {
  const revision = stringArg(args, name, fallback)!;
  const valid =
    /^(?:HEAD(?:~[0-9]{1,4})?|[0-9a-fA-F]{4,64}|refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240})$/.test(
      revision,
    ) && !revision.includes('..');
  if (!valid) throw new Error(`${name} is not an allowed local revision`);
  return revision;
}

function optionalPath(args: JsonObject): string | undefined {
  const input = stringArg(args, 'path');
  if (input === undefined) return undefined;
  const path = existingPath(input, 'either');
  return displayPath(path);
}

function runGit(args: string[]): string {
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

function gitLog(args: JsonObject): string {
  const limit = integerArg(args, 'limit', 20, 1, 100);
  const path = optionalPath(args);
  return runGit([
    'log',
    '--no-show-signature',
    `--max-count=${limit}`,
    '--date=iso-strict',
    '--format=%H%x09%ad%x09%an%x09%s',
    ...(path ? ['--', path] : []),
  ]);
}

function gitShow(args: JsonObject): string {
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

function gitDiff(args: JsonObject): string {
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

function gitStatus(args: JsonObject): string {
  const path = optionalPath(args);
  return runGit(['status', '--porcelain=v2', '--no-ahead-behind', ...(path ? ['--', path] : [])]);
}

function callTool(name: string, args: JsonObject): string {
  switch (name) {
    case 'list_files':
      return listFiles(args);
    case 'read_file':
      return readFile(args);
    case 'read_agent_file':
      return readAgentFile(args);
    case 'write_memory':
      return writeMemory(args);
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

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function failure(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    failure(null, -32700, 'invalid JSON');
    return;
  }
  if (request.id === undefined) return;
  try {
    if (request.method === 'initialize') {
      const params = asObject(request.params);
      success(request.id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'beeline-readonly-mcp', version: '1.0.0' },
      });
      return;
    }
    if (request.method === 'ping') {
      success(request.id, {});
      return;
    }
    if (request.method === 'tools/list') {
      success(request.id, { tools: TOOLS });
      return;
    }
    if (request.method === 'tools/call') {
      const params = asObject(request.params);
      if (typeof params.name !== 'string') throw new Error('tool name must be a string');
      const output = callTool(params.name, asObject(params.arguments));
      success(request.id, { content: [{ type: 'text', text: output }] });
      return;
    }
    failure(request.id, -32601, `method not found: ${request.method ?? ''}`);
  } catch (error) {
    failure(request.id, -32602, error instanceof Error ? error.message : String(error));
  }
});
