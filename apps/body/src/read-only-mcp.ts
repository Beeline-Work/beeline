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
import { createHash, randomBytes } from 'node:crypto';
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
import {
  CORNER_NAME_MAX_LENGTH,
  CORNER_NAME_MAX_WORDS,
  CORNER_OBJECTIVE_MAX_LENGTH,
  CORNER_OBJECTIVE_MAX_WORDS,
  cornerTextRefusal,
  normalizeCornerText,
} from '@beeline/api-contract/daemon';
import {
  AGENT_GRANT_KINDS,
  AGENT_GRANT_REASON_MAX_LENGTH,
  AGENT_GRANT_TARGET_MAX_LENGTH,
  AGENT_GRANT_VERBS,
  GRANT_SCRIPT_MAX_BYTES,
  GRANT_SCRIPT_MAX_LINES,
  formatGrantEscalationReason,
  grantScriptTooLongMessage,
  interpreterScriptArgument,
  isAgentGrantKind,
  parseCommandGrantTarget,
  type AgentGrantEscalation,
  type CommandGrantRule,
  type CommandGrantScript,
} from '@beeline/api-contract/agent-grants';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { checksVerdictFromLifecycle } from './corner-checks.js';
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

const READ_ONLY_TOOLS: ToolDefinition[] = [
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

const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'create_schedule',
    description:
      'Create a schedule that runs your prompt as a mention to you in this Room, on an interval (everyMinutes, minimum 1) or a 5-field cron. With maxRuns the schedule deletes itself after that many runs.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'cadence'],
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'The prompt delivered to you as a Room mention on every run.',
        },
        cadence: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['interval', 'cron'] },
            everyMinutes: {
              type: 'integer',
              minimum: 1,
              description: 'Interval cadence: run every N minutes (minimum 1).',
            },
            expression: {
              type: 'string',
              description: 'Cron cadence: a 5-field cron expression.',
            },
            timeZone: { type: 'string', description: 'Optional IANA time zone for cron.' },
          },
          additionalProperties: false,
        },
        maxRuns: {
          type: 'integer',
          minimum: 1,
          description: 'Delete the schedule automatically after this many runs.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_schedules',
    description: 'List the schedules you own in this Room, with their cadence and run counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delete_schedule',
    description:
      'Delete one of your own schedules in this Room. You can only delete schedules you created.',
    inputSchema: {
      type: 'object',
      required: ['scheduleId'],
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The scheduleId from create_schedule or list_schedules.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_corner',
    description:
      'Open one write-enabled repository corner. Give it a name of AT MOST THREE WORDS - that name titles the corner in the Room list, the corner header and every card - and a fixed objective of no more than 24 words stating the work. Line breaks and extra spaces in either are flattened for you; only a text that is genuinely too long is refused.',
    inputSchema: {
      type: 'object',
      required: ['name', 'objective'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: CORNER_NAME_MAX_LENGTH,
          description: `The corner's title: at most ${CORNER_NAME_MAX_WORDS} words, no line breaks.`,
        },
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: CORNER_OBJECTIVE_MAX_LENGTH,
          description: `One paragraph of at most ${CORNER_OBJECTIVE_MAX_WORDS} words stating the complete, fixed objective.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pr_checks_status',
    description:
      'Read the server-posted GitHub checks fact and current human hold state for this corner. Never infer passing checks from local git or gh output.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'attach_file',
    description:
      'Attach one file from your own checkout (Room read-only checkout or corner worktree) or anywhere in your writable session home (wherever a harness put a file it generated, not just where you asked it to) to your final reply in this Room or corner. Paths outside those are refused. The file is uploaded now and delivered with your next reply; describe it in your reply text.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file inside your checkout, worktree, or writable session home.',
          maxLength: 1024,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_grant',
    description:
      'Raise your hand for reach outside the sandbox: kind path|host|secret|device|budget|command with one target and the reason. Under yolo it is approved at once; otherwise a card goes to your owner and your turn pauses on it: tell the human what you are waiting for and end the turn, you are woken when they answer. A command target is the exact line you want to run, no shell metacharacters; name secrets with a `--with SECRET_NAME` suffix. Yolo is the scope gate: with it on, an approved command just runs. Exactly two shapes always wait for a person anyway, in a Room and in a corner alike: running a script nobody has read (the card carries the script in full and the approval is bound to those exact bytes — rewrite the file and the run is refused), and anything naming a credential or environment file.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'target', 'reason'],
      properties: {
        kind: { type: 'string', enum: [...AGENT_GRANT_KINDS] },
        target: {
          type: 'string',
          minLength: 1,
          maxLength: AGENT_GRANT_TARGET_MAX_LENGTH,
          description:
            'What you need: a path, a host, a secret name, a device, a budget, or the exact command line (with optional `--with SECRET_NAME` suffixes).',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: AGENT_GRANT_REASON_MAX_LENGTH,
          description: 'One sentence: what you will do with it.',
        },
        ttl: {
          type: 'integer',
          minimum: 60,
          description: 'Optional lifetime in seconds after which the grant expires.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_granted_command',
    description:
      'Run a command under an approved command grant, only when an approved grant is a word-for-word prefix of argv. In a top-level Room it runs on the SAME read-only filesystem the Room promises — you can read anything and write only your own scratch, so open a corner for work that changes files. A corner can do everything a Room can and more: its worktree is writable and a command there may act on the live host, next to the branch and the transcript that explain it. The named secrets are in its environment and never in the output. Ten-minute timeout, capped output, one ledger row per run.',
    inputSchema: {
      type: 'object',
      required: ['argv'],
      properties: {
        argv: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
          description: 'The command and its arguments as separate words.',
        },
      },
      additionalProperties: false,
    },
  },
];

const agentSurface = process.env.BEELINE_MCP_SURFACE === 'agent';

/** The bounded daemon-control tools for one surface. A direct message is
 *  strictly conversational: repository corners are never openable there. */
export function agentToolsFor(agentSurface: boolean, directMessage: boolean): ToolDefinition[] {
  if (!agentSurface) return READ_ONLY_TOOLS;
  if (directMessage) return AGENT_TOOLS.filter((tool) => tool.name !== 'open_corner');
  return AGENT_TOOLS;
}

const TOOLS = agentToolsFor(agentSurface, process.env.BEELINE_AGENT_DM === '1');

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
const ATTACH_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.zip': 'application/zip',
};

// Nothing else ties TOOLS' names to READ_ONLY_TOOL_NAMES (the auto-allow
// permission check's canonical list) — assert they match so the two can't
// silently drift apart the way they did before this check existed.
{
  const declaredNames = new Set(READ_ONLY_TOOLS.map((tool) => tool.name));
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`agent tool is missing host context: ${name}`);
  return value;
}

async function daemonExecute(name: string, input: JsonObject): Promise<JsonObject> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const response = await fetch(new URL(`/v1/daemon/operations/${name}`, `${baseUrl}/`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Never reflect a server body into the model-facing tool error.
    }
    throw new Error(`daemon operation ${name} failed (${response.status}: ${code})`);
  }
  return (await response.json()) as JsonObject;
}

/** The corner's two texts, flattened and judged. Anything that reads as a
 *  refusal is one plain sentence naming the limit and the actual count: a
 *  refused call the model cannot understand is a silent one (C90). */
export function cornerCallText(args: JsonObject): { name: string; objective: string } {
  const refusal =
    cornerTextRefusal('name', args.name) ?? cornerTextRefusal('objective', args.objective);
  if (refusal) throw new Error(refusal);
  return {
    name: normalizeCornerText(String(args.name)),
    objective: normalizeCornerText(String(args.objective)),
  };
}

async function openCorner(args: JsonObject): Promise<string> {
  if (process.env.BEELINE_DAEMON_CORNER_ID || process.env.BEELINE_AGENT_DM === '1') {
    throw new Error('open_corner is available only in a top-level Room');
  }
  const { name, objective } = cornerCallText(args);
  const roomId = requiredEnv('BEELINE_DAEMON_ROOM_ID');
  const repository = await daemonExecute('getRoomRepositoryState', { roomId });
  if (
    repository.resolution !== 'repository' ||
    typeof repository.key !== 'string' ||
    !repository.key
  ) {
    throw new Error('open_corner requires a verified repository-bound Room');
  }
  const requestId = randomBytes(32).toString('hex');
  const created = await daemonExecute('createCorner', {
    roomId,
    requestId,
    name,
    objective,
    repository: repository.key,
    ...(typeof repository.targetBranch === 'string'
      ? { targetBranch: repository.targetBranch }
      : {}),
  });
  if (typeof created.cornerId !== 'string' || !created.cornerId) {
    throw new Error('createCorner returned no corner id');
  }
  await daemonExecute('postRoomMessage', {
    roomId: created.cornerId,
    requestId,
    text: objective,
    presentation: 'message',
  });
  return JSON.stringify({
    cornerId: created.cornerId,
    name,
    objective,
    status: 'starting',
  });
}

async function prChecksStatus(): Promise<string> {
  const cornerId = requiredEnv('BEELINE_DAEMON_CORNER_ID');
  const workspaceId = requiredEnv('BEELINE_DAEMON_WORKSPACE_ID');
  const agentId = requiredEnv('BEELINE_DAEMON_AGENT_ID');
  const [restore, conversation, roster, authority] = await Promise.all([
    daemonExecute('getCornerRestoreState', { cornerId }),
    daemonExecute('getRoomConversation', { roomId: cornerId, limit: 200 }),
    daemonExecute('getWorkspaceRoster', { agentId, workspaceId }),
    daemonExecute('getRoomAuthority', { roomId: cornerId, principalId: agentId }),
  ]);
  const humans = new Set(
    Array.isArray(roster.members)
      ? roster.members.flatMap((member) => {
          if (!member || typeof member !== 'object' || Array.isArray(member)) return [];
          const record = member as Record<string, unknown>;
          return record.kind === 'human' && typeof record.identityId === 'string'
            ? [record.identityId]
            : [];
        })
      : [],
  );
  // The server's webhook-owned check state is the verdict; the transcript's
  // wording only stands in while the server carries none (never the agent's
  // own narration, which the corner loop now drops).
  const lifecycle = restore.lifecycle as CornerLifecycleView | undefined;
  const serverVerdict = checksVerdictFromLifecycle(lifecycle);
  let checks: 'passed' | 'failed' | 'pending' = serverVerdict ?? 'pending';
  let held = false;
  let approvalPending = false;
  let pullRequest: string | undefined = lifecycle?.pr?.url;
  const items = Array.isArray(conversation.items) ? conversation.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const body = typeof message.body === 'string' ? message.body : '';
    if (!serverVerdict) {
      if (/\b(?:all\s+)?checks?\s+(?:have\s+)?passed\b|\bpassed a check\b/i.test(body)) {
        checks = 'passed';
      }
      if (/\bchecks?\s+(?:have\s+)?failed\b|\bfailed a check\b/i.test(body)) checks = 'failed';
    }
    const url = body.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0];
    if (url && !lifecycle?.pr?.url) pullRequest = url;
    if (/\bapproval pending\b|\bmerge (?:approval )?requested\b/i.test(body)) {
      approvalPending = true;
    }
    if (/\bapproval (?:completed|failed|cancelled)\b|\bpull request merged\b/i.test(body)) {
      approvalPending = false;
    }
    if (typeof message.authorId === 'string' && humans.has(message.authorId)) {
      if (/\bhold\b|\bdo not merge\b|\bdon't merge\b/i.test(body)) held = true;
      if (/\bresume\b|\bproceed\b|\bgo ahead\b|\bmerge now\b/i.test(body)) held = false;
      if (/\bapprove(?:d)?\b|\bmerge (?:it|this|now)\b/i.test(body)) approvalPending = true;
    }
  }
  return JSON.stringify({
    checks,
    held,
    approvalPending,
    archived: authority.archived === true,
    ...(pullRequest ? { pullRequest } : {}),
    ...(!pullRequest
      ? {
          next: 'The PR URL is not yet durable in the corner. Print its full URL as your final response and end this turn now; do not call pr_checks_status again in this turn.',
        }
      : {}),
    rule: 'Merge only when checks is passed, held is false, and approvalPending is false. A local or gh checks result is not authorization; a pending server approval must finish without an agent race.',
  });
}

export interface AttachFileDeps {
  /** Legal attachment roots: the session checkout, and (when configured) the
   *  session's whole writable home overlay, wherever the harness put a file
   *  it generated. */
  roots: string[];
  baseUrl: string;
  token: string;
  roomId: string;
  upload: (bytes: Buffer, mimeType: string, name: string) => Promise<JsonObject>;
  queue: (attachment: JsonObject) => Promise<void>;
}

export function attachFileDepsFromEnv(): AttachFileDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  return {
    roots: [requiredEnv('BEELINE_ATTACH_ROOT'), ...(scratchRoot ? [scratchRoot] : [])],
    baseUrl: requiredEnv('BEELINE_DAEMON_BASE_URL'),
    token: requiredEnv('BEELINE_DAEMON_TOKEN'),
    roomId: process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID'),
    upload: (bytes, mimeType, name) => daemonUploadMedia(bytes, mimeType, name),
    queue: async (attachment) => {
      await daemonExecute('postAgentAttachment', {
        roomId:
          process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        attachment,
      });
    },
  };
}

function withinRoot(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve an attach_file path inside the session checkout or anywhere in
 *  the session's writable home overlay (wherever a harness put a file it
 *  generated), never following a symlink outside either root. Returns the
 *  real path of an existing regular file. A relative `input` is tried
 *  against each root in order, taking the first that exists; the escape
 *  check then requires the real path land inside at least one of the
 *  roots. */
export function resolveAttachPath(roots: string[], input: string): string {
  if (!input || input.includes('\0')) throw new Error('path must be a non-empty file path');
  if (!roots.length) throw new Error('no attachment roots are configured');
  const realRoots = roots.map((root) => realpathSync(root));
  const errorMessage = () =>
    `path resolves outside your checkout or writable session home (${realRoots.join(', ')})`;
  const resolveAgainst = (candidate: string): string => {
    const resolved = realpathSync(candidate);
    if (!realRoots.some((root) => withinRoot(root, resolved))) throw new Error(errorMessage());
    return resolved;
  };
  if (isAbsolute(input)) return finishResolvedAttachPath(resolveAgainst(input));
  let notFoundError: unknown;
  for (const root of realRoots) {
    const candidate = resolve(root, input);
    if (!existsSync(candidate)) {
      notFoundError ??= new Error(`no such file: ${input}`);
      continue;
    }
    return finishResolvedAttachPath(resolveAgainst(candidate));
  }
  throw notFoundError instanceof Error ? notFoundError : new Error(errorMessage());
}

function finishResolvedAttachPath(resolved: string): string {
  if (!statSync(resolved).isFile()) throw new Error('path is not a regular file');
  return resolved;
}

export async function attachFile(
  args: JsonObject,
  deps: AttachFileDeps = attachFileDepsFromEnv(),
): Promise<string> {
  if (args.caption !== undefined && typeof args.caption !== 'string') {
    throw new Error('caption must be a string');
  }
  const path = resolveAttachPath(deps.roots, stringArg(args, 'path') ?? '');
  const details = statSync(path);
  if (details.size > MAX_ATTACH_BYTES) {
    throw new Error(`file exceeds the ${MAX_ATTACH_BYTES}-byte attachment limit`);
  }
  const name = path.split(sep).pop() ?? 'attachment';
  const mimeType =
    ATTACH_MIME_BY_EXTENSION[name.slice(name.lastIndexOf('.')).toLowerCase()] ??
    'application/octet-stream';
  const uploaded = await deps.upload(readFileSync(path), mimeType, name);
  const attachment = {
    url: uploaded.url,
    name: typeof uploaded.name === 'string' && uploaded.name ? uploaded.name : name,
    mimeType: typeof uploaded.mimeType === 'string' ? uploaded.mimeType : mimeType,
    size: typeof uploaded.size === 'number' ? uploaded.size : details.size,
  };
  await deps.queue(attachment);
  return `Attached ${name} (${details.size} bytes); it will be delivered with your final reply.`;
}

function agentScheduleRoomId(): string {
  return process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID');
}

const MIN_SCHEDULE_MINUTES = 1;

function parseScheduleCadence(args: JsonObject): {
  cadence: JsonObject;
  floored: boolean;
  describe: () => string;
} {
  const cadence = asObject(args.cadence);
  const kind = stringArg(cadence, 'kind');
  if (kind === 'interval') {
    const requested = cadence.everyMinutes;
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
      throw new Error('everyMinutes must be a positive number of minutes');
    }
    const everyMinutes = Math.max(MIN_SCHEDULE_MINUTES, Math.round(requested));
    return {
      cadence: { kind: 'interval', everyMinutes },
      floored: everyMinutes !== requested,
      describe: () => `every ${everyMinutes} minute${everyMinutes === 1 ? '' : 's'}`,
    };
  }
  if (kind === 'cron') {
    const expression = stringArg(cadence, 'expression');
    if (!expression || expression.trim().split(/\s+/).length !== 5) {
      throw new Error('cron expression must have five fields');
    }
    const timeZone = stringArg(cadence, 'timeZone');
    return {
      cadence: { kind: 'cron', expression: expression.trim(), ...(timeZone ? { timeZone } : {}) },
      floored: false,
      describe: () => `cron '${expression.trim()}'`,
    };
  }
  throw new Error('cadence kind must be interval or cron');
}

export interface AgentScheduleDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
}

export function agentScheduleDepsFromEnv(): AgentScheduleDeps {
  return { roomId: agentScheduleRoomId(), execute: daemonExecute };
}

export async function createSchedule(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const prompt = stringArg(args, 'prompt')?.trim();
  if (!prompt) throw new Error('prompt must be a non-empty string');
  if (prompt.length > 2000) throw new Error('prompt exceeds 2000 characters');
  const { cadence, floored, describe } = parseScheduleCadence(args);
  const maxRuns = args.maxRuns;
  if (
    maxRuns !== undefined &&
    (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1)
  ) {
    throw new Error('maxRuns must be a positive integer');
  }
  const created = await deps.execute('createAgentSchedule', {
    roomId: deps.roomId,
    prompt,
    cadence,
    ...(maxRuns !== undefined ? { maxRuns } : {}),
  });
  const scheduleId = typeof created.scheduleId === 'string' ? created.scheduleId : 'unknown';
  const floorNote = floored
    ? ` The minimum cadence is ${MIN_SCHEDULE_MINUTES} minute; created every ${MIN_SCHEDULE_MINUTES} minute.`
    : '';
  return (
    `Schedule ${scheduleId} created: ${describe()}` +
    (maxRuns !== undefined ? `, ${maxRuns} run${maxRuns === 1 ? '' : 's'}` : '') +
    `; the prompt runs as a mention to you in this Room.` +
    floorNote +
    ' Use delete_schedule with this scheduleId to remove it.'
  );
}

export async function listSchedules(
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('listAgentSchedules', { roomId: deps.roomId });
  const schedules = Array.isArray(result.schedules) ? result.schedules : [];
  if (!schedules.length) return 'No schedules in this Room.';
  return schedules
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const schedule = entry as Record<string, unknown>;
      const cadence =
        schedule.cadence && typeof schedule.cadence === 'object'
          ? (schedule.cadence as Record<string, unknown>)
          : {};
      const cadenceText =
        cadence.kind === 'interval'
          ? `every ${String(cadence.everyMinutes)} minute(s)`
          : `cron '${String(cadence.expression)}'`;
      const runs =
        typeof schedule.maxRuns === 'number'
          ? ` (${String(schedule.runCount ?? 0)}/${String(schedule.maxRuns)} runs)`
          : ` (${String(schedule.runCount ?? 0)} runs)`;
      const nextRunAt =
        typeof schedule.nextRunAt === 'number'
          ? `, next run ${new Date(schedule.nextRunAt * 1_000).toISOString()}`
          : '';
      return [
        `${String(schedule.scheduleId)}: ${cadenceText}${runs}${nextRunAt} — ${String(schedule.prompt)}`,
      ];
    })
    .join('\n');
}

export async function deleteSchedule(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const scheduleId = stringArg(args, 'scheduleId')?.trim();
  if (!scheduleId) throw new Error('scheduleId must be a non-empty string');
  await deps.execute('deleteAgentSchedule', { roomId: deps.roomId, scheduleId });
  return `Schedule ${scheduleId} deleted.`;
}


export interface AgentGrantDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
  /** Where a script argument may be read from: the checkout, then the scratch. */
  scriptRoots?: string[];
  /** Test seam for reading those bytes. */
  readScript?: (path: string) => Buffer;
}

export function agentGrantDepsFromEnv(): AgentGrantDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  const attachRoot = process.env.BEELINE_ATTACH_ROOT?.trim();
  return {
    roomId: agentScheduleRoomId(),
    execute: daemonExecute,
    scriptRoots: [...(attachRoot ? [attachRoot] : []), ...(scratchRoot ? [scratchRoot] : [])],
  };
}

/**
 * The script an interpreter command will run, read so the approval card can
 * SHOW it (C94).
 *
 * `python3 fix.py` tells the person deciding nothing about what runs, so the
 * bytes travel with the ask and the approval is bound to their hash. A file too
 * long to read on a card is REFUSED, never truncated — an honest card is the
 * whole point, and a body that size belongs in a corner as a branch and a pull
 * request. A line with no script argument (`python3 -V`) has nothing to bind;
 * it still asks a human, because the interpreter class is never covered by yolo.
 */
export function readGrantScript(
  rule: CommandGrantRule,
  deps: AgentGrantDeps,
): CommandGrantScript | undefined {
  const argument = interpreterScriptArgument(rule.argv);
  if (!argument) return undefined;
  const roots = deps.scriptRoots ?? [];
  if (!roots.length) return undefined;
  let resolved: string;
  try {
    resolved = resolveAttachPath(roots, argument.path);
  } catch (error) {
    // A script that exists but sits outside the checkout and the scratch cannot
    // be put in front of a human, so it is not approvable from here.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('outside')) {
      throw new Error(
        `${argument.path} is outside your checkout and scratch directory, so its contents ` +
          'cannot be shown on the approval card. Move the script into your checkout or scratch, ' +
          'or open a corner with open_corner and make the change there.',
      );
    }
    return undefined;
  }
  const bytes = (deps.readScript ?? readFileSync)(resolved);
  const contents = bytes.toString('utf8');
  const lines = contents.split('\n').length;
  if (bytes.byteLength > GRANT_SCRIPT_MAX_BYTES || lines > GRANT_SCRIPT_MAX_LINES) {
    throw new Error(grantScriptTooLongMessage(argument.path, bytes.byteLength, lines));
  }
  if (!Buffer.from(contents, 'utf8').equals(bytes)) {
    throw new Error(
      `${argument.path} is not text, so nobody can read what it does on an approval card. ` +
        'Open a corner with open_corner and make the change there.',
    );
  }
  return {
    path: argument.path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    contents,
  };
}

/** request_grant: one ask, one kind, one target; the server decides yolo vs card. */
export async function requestGrant(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const kind = stringArg(args, 'kind');
  if (!isAgentGrantKind(kind)) {
    throw new Error(`kind must be one of ${AGENT_GRANT_KINDS.join(', ')}`);
  }
  const rawTarget = stringArg(args, 'target');
  const target = kind === 'command' ? (rawTarget ?? '') : (rawTarget ?? '').trim();
  if (!target) throw new Error('target must be a non-empty string');
  if (target.length > AGENT_GRANT_TARGET_MAX_LENGTH) throw new Error('target is too long');
  const rule = kind === 'command' ? parseCommandGrantTarget(target) : undefined;
  const script = rule ? readGrantScript(rule, deps) : undefined;
  const reason = stringArg(args, 'reason')?.trim();
  if (!reason) throw new Error('reason must be a non-empty string');
  if (reason.length > AGENT_GRANT_REASON_MAX_LENGTH) throw new Error('reason is too long');
  const ttl = args.ttl;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60)) {
    throw new Error('ttl must be an integer number of seconds, at least 60');
  }
  const result = await deps.execute('requestAgentGrant', {
    roomId: deps.roomId,
    kind,
    target,
    reason,
    ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
    ...(script ? { script } : {}),
  });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const ask = `${AGENT_GRANT_VERBS[kind]} ${target}`;
  if (result.auto === true) {
    return kind === 'command'
      ? `approved (yolo): ${ask} [grant ${grantId}]. Run it now with run_granted_command and the argv.`
      : `approved (yolo): ${ask} [grant ${grantId}]; applies at the agent's next session.`;
  }
  // Yolo covers most asks; these two shapes never do, and saying which one this
  // is stops the model retrying the same line expecting a different answer.
  const escalations = Array.isArray(result.escalations)
    ? (result.escalations as AgentGrantEscalation[])
    : [];
  const because = formatGrantEscalationReason(escalations);
  return (
    `pending, card posted: ${ask} [grant ${grantId}]. ` +
    (because ? `A human always answers this one because ${because}. ` : '') +
    (script ? `The card shows ${script.path} in full, and the approval is bound to those bytes. ` : '') +
    'Your owner must answer ALWAYS, ONCE, or NO in this Room; ' +
    'your turn is paused on this grant. Tell the human what you are waiting for and end your turn now; ' +
    'you will be woken with the answer.'
  );
}

export interface GrantRunDeps {
  roomId: string;
  run: (input: { roomId: string; argv: string[] }) => Promise<JsonObject>;
}

export function grantRunDepsFromEnv(): GrantRunDeps {
  return {
    roomId: agentScheduleRoomId(),
    run: async (input) => {
      const baseUrl = requiredEnv('BEELINE_GRANT_RUNNER_URL');
      const response = await fetch(new URL('/run', `${baseUrl}/`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${requiredEnv('BEELINE_GRANT_RUNNER_TOKEN')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      const body = (await response.json().catch(() => ({}))) as JsonObject;
      if (!response.ok) {
        throw new Error(
          typeof body.error === 'string' ? body.error : `grant runner failed (${response.status})`,
        );
      }
      return body;
    },
  };
}

/** run_granted_command: the daemon checks the rule and runs outside the sandbox. */
export async function runGrantedCommand(
  args: JsonObject,
  deps: GrantRunDeps = grantRunDepsFromEnv(),
): Promise<string> {
  const argv = args.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((word) => typeof word === 'string' && word)) {
    throw new Error('argv must be a non-empty array of words');
  }
  const result = await deps.run({ roomId: deps.roomId, argv: argv as string[] });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const verdict =
    result.timedOut === true
      ? 'timed out after 10 minutes'
      : typeof result.exitCode === 'number'
        ? `exit ${result.exitCode}`
        : `did not start${typeof result.signal === 'string' ? ` (${result.signal})` : ''}`;
  const output = typeof result.output === 'string' && result.output ? result.output : '(no output)';
  const refused =
    result.writeRefused === true
      ? '\nThis Room is read-only outside your scratch directory. Open a corner with open_corner to change files.'
      : '';
  return `ran under grant ${grantId}: ${verdict}\n${output}${refused}`;
}

async function daemonUploadMedia(
  bytes: Buffer,
  mimeType: string,
  name: string,
): Promise<JsonObject> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const response = await fetch(new URL('/v1/daemon/media', `${baseUrl}/`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
      'content-type': mimeType,
      'x-file-name': name,
    },
    body: bytes,
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Never reflect a server body into the model-facing tool error.
    }
    throw new Error(`daemon media upload failed (${response.status}: ${code})`);
  }
  return (await response.json()) as JsonObject;
}

async function callAgentTool(name: string, args: JsonObject): Promise<string> {
  switch (name) {
    case 'open_corner':
      return openCorner(args);
    case 'pr_checks_status':
      return prChecksStatus();
    case 'attach_file':
      return attachFile(args);
    case 'create_schedule':
      return createSchedule(args);
    case 'list_schedules':
      return listSchedules();
    case 'delete_schedule':
      return deleteSchedule(args);
    case 'request_grant':
      return requestGrant(args);
    case 'run_granted_command':
      return runGrantedCommand(args);
    default:
      throw new Error(`tool is not available on the agent surface: ${name}`);
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

async function handleLine(line: string): Promise<void> {
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
        serverInfo: {
          name: agentSurface ? 'beeline-agent' : 'beeline-readonly-mcp',
          version: '1.0.0',
        },
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
      // A tool that refuses answers with an MCP tool RESULT carrying isError,
      // not a JSON-RPC protocol error. A protocol error is a client bug in
      // every harness that reads the spec, and reaches the model - when it
      // reaches it at all - as "the call failed", with the sentence explaining
      // why buried in a transport frame (C90).
      let output: string;
      try {
        output = agentSurface
          ? await callAgentTool(params.name, asObject(params.arguments))
          : callTool(params.name, asObject(params.arguments));
      } catch (error) {
        success(request.id, {
          content: [
            { type: 'text', text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        });
        return;
      }
      success(request.id, { content: [{ type: 'text', text: output }] });
      return;
    }
    failure(request.id, -32601, `method not found: ${request.method ?? ''}`);
  } catch (error) {
    failure(request.id, -32602, error instanceof Error ? error.message : String(error));
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => void handleLine(line));
