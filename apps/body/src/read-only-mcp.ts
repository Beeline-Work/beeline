#!/usr/bin/env node
import { resolveGrantCommand, isNativeGrantExecutable, resolveGrantScriptExecutable } from './grant-script.js';
import { beelineManagedSkills, runningBeelineReleaseId } from './beeline-skill.js';
import { builtinBeelineApp } from '@beeline/api-contract/workbench';
import { Check, Errors } from 'typebox/value';
import { CAPABILITY_ROUTES, REPOSITORY_ROUTES, SCRATCH_ROUTES, minimalTools, placeBeelineApps, repositoryTools, scratchTools, CAPABILITY_TOOLS, RUNNER_TOOL, SILENT_TOOL } from './minimal-tool-surface.js';
import { squireReachCause } from './squire-status.js';
import { nonhumanSilentWake } from './silent-wake.js';
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
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  cornerTextRefusal,
  normalizeCornerText,
  wakeBatchMinutes,
  ARTIFACT_MIME_BY_EXTENSION,
  ARTIFACT_MIME_TYPES,
  INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS,
  encodeArtifactTitleHeader,
  type ArtifactMimeType,
  type CornerRestoreResult,
  type ConnectResult,
  type RoomConversationResult,
  type DaemonAttachment,
} from '@beeline/api-contract/daemon';
import {
  REQUESTABLE_AGENT_GRANT_KINDS,
  AGENT_GRANT_REASON_MAX_LENGTH,
  AGENT_GRANT_TARGET_MAX_LENGTH,
  AGENT_GRANT_VERBS,
  COMMAND_SECRET_NAME,
  GRANT_SCRIPT_MAX_BYTES,
  GRANT_SCRIPT_MAX_LINES,
  formatGrantEscalationReason,
  grantScriptTooLongMessage,
  interpreterScriptArgument,
  isRequestableAgentGrantKind,
  isSharedAssetCategory,
  SHARED_ASSET_CATEGORIES,
  parseCommandGrantTarget,
  type AgentGrantEscalation,
  type CommandGrantRule,
  type CommandGrantScript,
} from '@beeline/api-contract/agent-grants';
import { operatorSecretResolver, storeOperatorSecret, type SecretResolver } from './grant-runner.js';
import {
  CONNECTOR_OFFER_REASON_MAX_LENGTH,
  OFFERABLE_CONNECTOR_KINDS,
  isOfferableConnectorKind,
} from '@beeline/api-contract/connector-offers';
import {
  MAX_EVENT_CONSEQUENCE_LENGTH,
  AGENT_EVENT_SLUG_MAX_LENGTH,
  MAX_MENTIONS_PER_EVENT,
  SUBSCRIBABLE_EVENT_KINDS,
  perItemSubscriptionRefusal,
  isAgentKind,
  isPerItemEventKind,
  isServerEventKind,
  isSubscribableEventKind,
  MESSAGE_REACTION_EMOJIS,
  type CornerLifecycleView,
  type MessageReactionEmoji,
} from '@beeline/api-contract/phone';
import { normalizeAppContinuation } from '@beeline/api-contract/app-connections';
import { squireSessionSignedIn } from './squire-sign-in.js';
import { REPOSITORY_SUBSCRIPTION_EVENTS, readAgentUsage, usageIsOld, usageSummary } from '@beeline/api-contract/daemon';
import { READ_ONLY_TOOL_NAMES } from './read-only-policy.js';
import { findChromiumPage } from './browser-share.js';
import { startHostedBrowserShare } from './browser-share-host.js';
import { allocatedDirectoryBytes, assertScratchWriteBudget, scratchBudgetMessage } from './scratch-lifecycle.js';
import { validateArtifact } from './artifact-validation.js';
import {
  BoundedSizeError,
  EXPIRED_REASON,
  FETCH_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  attachmentId,
  fetchBoundedBytes,
  deliverAttachments,
  safeAttachmentNames,
  withoutImageData,
} from './attachment-delivery.js';
import { describeTailscaleReach } from './connector-tailscale.js';
import { readVault } from './connector-squire.js';
import { sandboxDevicePath } from './bwrap-sandbox.js';
import { isNetworkFailure } from './network-failure.js';

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

function memorySources(args: JsonObject): unknown[] {
  if (!Array.isArray(args.source_message_ids)) throw new Error('source_message_ids must be an array');
  return args.source_message_ids;
}

const agentSurface = process.env.BEELINE_MCP_SURFACE === 'agent';
/** The ordinary surface is stable across warm turns; optional schemas are read through app_tool. */
export function agentToolsFor(
  agentSurface: boolean,
  _directMessage: boolean,
  cornerTurn = false,
  repositoryCorner = false,
  commandRunnerAvailable = true,
  institutionalMemoryEnabled = true,
  nativeIoProven = false,
): ToolDefinition[] {
  if (!agentSurface) return repositoryTools();
  const tools = minimalTools(cornerTurn).filter(tool =>
    institutionalMemoryEnabled || !['search', 'remember'].includes(tool.name));
  if (commandRunnerAvailable) tools.push(RUNNER_TOOL);
  // no_reply_needed mounts on every harness: it is the only silence path, so a
  // nonhuman wake must always be able to end without posting prose. The tool
  // itself refuses human wakes.
  tools.push(SILENT_TOOL);
  if (!nativeIoProven) tools.push(...scratchTools(cornerTurn && !repositoryCorner));
  return tools;
}

const TOOLS = agentToolsFor(
  agentSurface,
  process.env.BEELINE_AGENT_DM === '1',
  Boolean(process.env.BEELINE_DAEMON_CORNER_ID),
  process.env.BEELINE_CORNER_REPOSITORY === '1',
  Boolean(process.env.BEELINE_GRANT_RUNNER_URL),
  true,
  process.env.BEELINE_NATIVE_IO_PROVEN === '1',
);

const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
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
    /^(?:HEAD(?:~[0-9]{1,4})?|[0-9a-fA-F]{4,64}|(?:refs\/(?:heads|tags)\/|(?:refs\/remotes\/)?origin\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,240})$/.test(
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`agent tool is missing host context: ${name}`);
  return value;
}

async function activeCommandContext(): Promise<{
  roomId: string;
  requestId: string;
  generationId: string;
}> {
  const { promptSectionIds: _sections, commandReason: _reason, startedAt: _startedAt, ...value } = await readTurnContextFile();
  if (!value.roomId || !value.requestId || !value.generationId)
    throw new Error('no active server command');
  return value as { roomId: string; requestId: string; generationId: string };
}

async function readTurnContextFile(): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(requiredEnv('BEELINE_TURN_CONTEXT_FILE'), 'utf8'));
}

/** This turn's assembled prompt section ids, written by the Body; never the agent's. */
async function turnPromptSectionIds(): Promise<string[]> {
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
const SAFE_TO_REPEAT_DAEMON_OPERATIONS: ReadonlySet<string> = new Set([
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

const DAEMON_NETWORK_RETRY_LIMIT = 2;
const DAEMON_NETWORK_RETRY_BASE_MS = 200;

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

function daemonRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, DAEMON_NETWORK_RETRY_BASE_MS * 2 ** attempt));
}

async function daemonExecute(name: string, input: JsonObject): Promise<JsonObject> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const body = JSON.stringify({
    ...input,
    ...(process.env.BEELINE_TURN_CONTEXT_FILE &&
    ((!name.startsWith('get') || name.startsWith('getWallet') || name === 'getRoomMessage') &&
      !name.startsWith('list'))
      ? await activeCommandContext()
      : {}),
  });
  const safeToRepeat = daemonOperationIsSafeToRepeat(name, input);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(new URL(`/v1/daemon/operations/${name}`, `${baseUrl}/`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
          'content-type': 'application/json',
          'x-beeline-helper-version': process.env.BEELINE_HELPER_VERSION || 'v0.0.0',
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
      return (await response.json()) as JsonObject;
    } catch (error) {
      if (!isDaemonNetworkFailure(error)) throw error;
      if (!safeToRepeat) {
        throw new Error(
          `daemon operation ${name} failed with a network error before the server answered; the call may not have run`,
        );
      }
      if (attempt >= DAEMON_NETWORK_RETRY_LIMIT) {
        throw new Error(
          `daemon operation ${name} failed with a network error after ${attempt + 1} attempts`,
        );
      }
      await daemonRetryDelay(attempt);
    }
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

async function openCorner(args: JsonObject, toolCallId: string): Promise<string> {
  const spec = (args.brief as { spec?: unknown } | undefined)?.spec;
  const words = typeof spec === 'string' ? spec.match(/[a-zA-Z0-9]+/g) ?? [] : [];
  const { name, objective } = cornerCallText({ ...args,
    name: args.name ?? (words.slice(0, 3).join('-') || 'Work'),
    objective: args.objective ?? (words.slice(0, 24).join(' ') || 'Carry out the brief'),
  });
  // In a corner turn this is the parent Room, where the new corner opens.
  const roomId = typeof args.room === 'string' ? args.room : requiredEnv('BEELINE_DAEMON_ROOM_ID');
  const repository = await daemonExecute('getRoomRepositoryState', { roomId });
  if (repository.resolution === 'unverified') {
    throw new Error('open_corner is waiting for the Room repository state to resolve');
  }
  if (repository.resolution === 'repository' && (!repository.key || !repository.remote)) {
    throw new Error('open_corner requires a complete verified repository binding');
  }
  const requestId = (await activeCommandContext()).requestId;
  const brief = args.brief ? await bindBriefFiles(asObject(args.brief)) : undefined;
  const idempotencyKey = createHash('sha256')
    .update(`open_corner\0${requestId}\0${toolCallId}`)
    .digest('hex');
  const created = await daemonExecute('createCorner', {
    roomId: (await activeCommandContext()).roomId,
    targetRoomId: roomId,
    requestId,
    idempotencyKey,
    name,
    objective,
    ...(args.implementer !== undefined ? { implementer: args.implementer as string } : {}),
    ...(args.reviewer !== undefined ? { reviewer: args.reviewer as string } : {}),
    ...(brief
      ? { brief: brief as unknown as import('@beeline/api-contract/daemon').CornerBriefDraft }
      : {}),
    ...(args.hold === true ? { hold: true } : {}),
    ...(repository.resolution === 'repository'
      ? {
          repository: repository.key,
          ...(typeof repository.targetBranch === 'string'
            ? { targetBranch: repository.targetBranch }
            : {}),
        }
      : {}),
  });
  if (typeof created.cornerId !== 'string' || !created.cornerId) {
    throw new Error('createCorner returned no corner id');
  }
  return JSON.stringify({
    address: created.cornerId,
    name,
    objective,
    ...(args.brief ? { briefRevision: 1 } : {}),
    ...(created.watch ? { watch: created.watch } : {}),
    ...(Array.isArray(created.warnings) ? { warnings: created.warnings } : {}),
    status: 'starting',
  });
}

async function reviseCornerBrief(args: JsonObject): Promise<string> {
  const cornerId = typeof args.cornerId === 'string' ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID');
  const requestId = (await activeCommandContext()).requestId;
  const bound = await bindBriefFiles({ spec: args.spec, attachments: args.attachments } as JsonObject);
  return JSON.stringify(
    await daemonExecute('reviseCornerBrief', {
      cornerId,
      roomId: (await activeCommandContext()).roomId,
      requestId,
      expectedRevision: args.expectedRevision as number,
      reviewer: args.reviewer as string | undefined,
      brief: {
        spec: args.spec as string,
        repositoryWork: args.repositoryWork as boolean | undefined,
        approval: args.approval as import('@beeline/api-contract/daemon').CornerBriefDraft['approval'],
        change: args.change as string | undefined,
        attachments:
          bound.attachments as import('@beeline/api-contract/daemon').CornerBriefDraft['attachments'],
      },
    }),
  );
}

async function readCornerBrief(args: JsonObject): Promise<string> {
  const cornerId =
    typeof args.cornerId === 'string' ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID');
  return JSON.stringify(
    await daemonExecute('listCornerBriefRevisions', {
      cornerId,
      ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
      ...(Number.isInteger(args.beforeRevision)
        ? { beforeRevision: args.beforeRevision as number }
        : {}),
    }),
  );
}

/** The corner a tool acts on: the named `cornerId`, else the active corner. */
function targetCornerId(args: JsonObject): string {
  if (typeof args.cornerId === 'string' && args.cornerId) return args.cornerId;
  const active = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
  if (!active) throw new Error('cornerId is required outside a corner');
  return active;
}

/**
 * Close a corner, chat-only or repository-backed.
 *
 * There is no surface-side check: any agent in the corner or its parent Room
 * may archive it, and the server's reach check (`DaemonService.reach`) is the
 * one authority on who that is.
 */
async function closeCorner(args: JsonObject): Promise<string> {
  const cornerId = targetCornerId(args);
  await daemonExecute('archiveCorner', { cornerId });
  return JSON.stringify({ cornerId, status: 'closed' });
}

/**
 * `report_feedback`. A report is never worth failing the turn over: any
 * refusal (cap, a secret-shaped value, the store) comes back as a plain
 * result. The turn's prompt sections ride along from the context file.
 */
export async function reportFeedback(args: JsonObject = {}): Promise<string> {
  try {
    const reported = await daemonExecute('reportFeedback', {
      roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
      category: String(args.category ?? ''),
      summary: String(args.summary ?? ''),
      ...(typeof args.detail === 'string' ? { detail: args.detail } : {}),
      ...(typeof args.tool_name === 'string' ? { toolName: args.tool_name } : {}),
      ...(typeof args.error_excerpt === 'string' ? { errorExcerpt: args.error_excerpt } : {}),
      promptSectionIds: await turnPromptSectionIds(),
    });
    return JSON.stringify(
      reported.duplicate
        ? { itemId: reported.itemId, note: 'already reported; nothing new was stored' }
        : { itemId: reported.itemId },
    );
  } catch (error) {
    return JSON.stringify({
      reported: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function prChecksStatus(args: JsonObject = {}): Promise<string> {
  const cornerId = targetCornerId(args);
  const agentId = requiredEnv('BEELINE_DAEMON_AGENT_ID');
  const [restore, conversation, authority] = await Promise.all([
    daemonExecute('getCornerRestoreState', { cornerId }),
    // Newest page: a PR link is a question about where the corner stands NOW,
    // and this scan is last-write-wins over the page.
    daemonExecute('getRoomConversation', { roomId: cornerId, limit: 200 }),
    daemonExecute('getRoomAuthority', { roomId: cornerId, principalId: agentId }),
  ]);
  const lifecycle = restore.lifecycle as CornerLifecycleView | undefined;
  let pullRequest: unknown = args.pullRequest ?? lifecycle?.pr?.url;
  // An objective URL is a target hint only, never a check verdict.
  if (pullRequest === undefined && typeof restore.objective === 'string')
    pullRequest = restore.objective.match(
      /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/,
    )?.[0];
  const items = Array.isArray(conversation.items) ? conversation.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const body = typeof message.body === 'string' ? message.body : '';
    const url = body.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0];
    if (url && args.pullRequest === undefined && !lifecycle?.pr?.url) pullRequest = url;
  }
  const verdict =
    pullRequest !== undefined
      ? await daemonExecute('getPrChecksStatus', { cornerId, pullRequest })
      : undefined;
  if (verdict) pullRequest = verdict.pullRequest;
  const checks =
    verdict?.checks === 'passed' || verdict?.checks === 'failed' || verdict?.checks === 'pending'
      ? verdict.checks
      : 'unknown';
  const headSha = typeof verdict?.headSha === 'string' ? verdict.headSha : lifecycle?.pr?.headSha;
  const pullRequestNumber =
    typeof pullRequest === 'number'
      ? pullRequest
      : typeof pullRequest === 'string'
        ? Number(pullRequest.match(/(?:pull\/)?(\d+)(?:\D*)$/)?.[1]) || lifecycle?.pr?.number
        : lifecycle?.pr?.number;
  const checkCount = typeof verdict?.checkCount === 'number' ? verdict.checkCount : undefined;
  const checkStates =
    verdict?.checkStates && typeof verdict.checkStates === 'object'
      ? (verdict.checkStates as {
          passed: number;
          pending: number;
          failed: number;
          unlisted: number;
          pendingNames: string[];
          failedNames: string[];
        })
      : undefined;
  const named = (count: number, names: string[]) =>
    names.length
      ? ` (${names.join(', ')}${count > names.length ? `, and ${count - names.length} more` : ''})`
      : '';
  const tally =
    checkCount !== undefined && checkStates
      ? checkCount === 0
        ? `no checks have reported for head ${headSha ?? 'unknown'} yet`
        : `${checkStates.passed} of ${checkCount} checks passed, ${checkStates.pending} pending${named(checkStates.pending, checkStates.pendingNames)}, ${checkStates.failed} failed${named(checkStates.failed, checkStates.failedNames)}${checkStates.unlisted ? `; ${checkStates.unlisted} more not listed` : ''}`
      : undefined;
  const reason =
    checks === 'unknown'
      ? pullRequestNumber
        ? `no checks are recorded for PR #${pullRequestNumber} (head ${headSha ?? 'unknown'}); the PR may have been opened from a branch that is not this corner's, or checks have not reported yet`
        : 'no pull request or checks are recorded for this corner'
      : checks === 'passed'
        ? 'all recorded checks passed'
        : checks === 'failed'
          ? (tally ?? 'one or more recorded checks failed')
          : checkCount !== 0 && checkStates?.pending === 0
            ? `Checks are still pending for this head, including any queued or running workflows or suites${tally ? `; ${tally}` : ''}`
            : (tally ?? 'recorded checks are still pending');
  const reviewer = typeof verdict?.reviewer === 'string' ? verdict.reviewer : null;
  const reviewerWake =
    verdict?.reviewerWake && typeof verdict.reviewerWake === 'object'
      ? verdict.reviewerWake
      : undefined;
  // The merge gate is the server's: mergeAllowed = checks passed, approved
  // (a yes said on this head), and not held.
  return JSON.stringify({
    ...(typeof verdict?.stage === 'string' ? { stage: verdict.stage } : {}),
    checks,
    reason,
    ...(checkCount !== undefined ? { checkCount } : {}),
    ...(checkStates ? { checkStates } : {}),
    ...(headSha ? { headSha } : {}),
    approved: verdict?.approved === true,
    held: verdict?.held === true,
    ...(verdict?.holds ? { holds: verdict.holds } : {}),
    mergeAllowed: verdict?.mergeAllowed === true,
    ...(typeof verdict?.blockedReason === 'string' ? { blockedReason: verdict.blockedReason } : {}),
    reviewer,
    reviewerExists: verdict?.reviewerExists === true,
    ...(reviewerWake ? { reviewerWake } : {}),
    archived: authority.archived === true,
    ...(pullRequest ? { pullRequest } : {}),
    ...(!pullRequest
      ? {
          next: 'No PR is recorded for this corner yet. Continue the assigned work; when it is ready, push the corner branch and open a PR. If you already opened one, print its actual full URL as your final response so it can be recorded, then end the turn. Do not invent a PR URL or reread checks before a PR exists.',
        }
      : {}),
  });
}

export async function approveMerge(args: JsonObject = {}): Promise<string> {
  const cornerId = targetCornerId(args);
  const headSha = typeof args.headSha === 'string' ? args.headSha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('headSha must be a full 40-character SHA');
  return JSON.stringify(await daemonExecute('approveCornerMerge', { cornerId, headSha }));
}

export interface WriteScratchFileDeps {
  /** The agent's own writable session area - the same scratch root
   *  post_artifact treats as a second legal root, never the checkout/worktree. */
  root: string;
}

export function writeScratchFileDepsFromEnv(): WriteScratchFileDeps {
  return { root: requiredEnv('BEELINE_ATTACH_SCRATCH_ROOT') };
}

/** Resolve a write_scratch_file target strictly inside `root`: relative
 *  input only, no absolute paths, no traversal, and no symlink escape
 *  through an existing ancestor directory. The file need not exist yet, so
 *  (unlike resolveAttachPath) this walks up to the deepest existing
 *  ancestor to real-path-check it, then creates any missing directories
 *  beneath that point - which, freshly created, cannot themselves be
 *  symlinks. */
export function resolveWriteScratchPath(root: string, input: string): string {
  if (!input || input.includes('\0'))
    throw new Error('path must be a non-empty relative file path');
  const realRoot = realpathSync(root);
  const errorMessage = () => `path resolves outside your writable session area (${realRoot})`;
  if (isAbsolute(input)) throw new Error(errorMessage());
  const candidate = resolve(realRoot, input);
  if (!withinRoot(realRoot, candidate)) throw new Error(errorMessage());
  let existingAncestor = dirname(candidate);
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(errorMessage());
    existingAncestor = parent;
  }
  const realAncestor = realpathSync(existingAncestor);
  if (realAncestor !== realRoot && !withinRoot(realRoot, realAncestor)) {
    throw new Error(errorMessage());
  }
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink (${realRoot})`);
  }
  mkdirSync(dirname(candidate), { recursive: true });
  return candidate;
}

export async function writeScratchFile(
  args: JsonObject,
  deps: WriteScratchFileDeps = writeScratchFileDepsFromEnv(),
): Promise<string> {
  const path = stringArg(args, 'path');
  if (!path) throw new Error('path must be a non-empty relative file path');
  const content = args.content;
  if (typeof content !== 'string') throw new Error('content must be a string');
  const encoding = args.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    throw new Error('encoding must be "utf8" or "base64"');
  }
  const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
  if (bytes.length > MAX_ATTACH_BYTES) {
    throw new Error(`content exceeds the ${MAX_ATTACH_BYTES}-byte attachment limit`);
  }
  const resolved = resolveWriteScratchPath(deps.root, path);
  if (process.env.BEELINE_CORNER_SCRATCH_ROOT)
    await assertScratchWriteBudget(process.env.BEELINE_CORNER_SCRATCH_ROOT, bytes.length);
  writeFileSync(resolved, bytes);
  return `Wrote ${bytes.length} bytes to ${resolved}; post_artifact with this path sends it.`;
}

const FETCH_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type FetchImageMime = (typeof FETCH_IMAGE_MIMES)[number];

export interface FetchImageDeps {
  /** Same writable session area write_scratch_file and post_artifact use. */
  root: string;
  fetchImpl?: typeof fetch;
}

export function fetchImageDepsFromEnv(): FetchImageDeps {
  return { root: requiredEnv('BEELINE_ATTACH_SCRATCH_ROOT') };
}

function parseImageUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('url must be an http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be an http(s) URL');
  }
  return parsed;
}

function sniffRasterImageMime(bytes: Buffer): FetchImageMime | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function resolveFetchedImageMime(contentType: string, bytes: Buffer): FetchImageMime {
  if (contentType === 'image/svg+xml' || contentType.startsWith('image/svg')) {
    throw new Error('fetch_image is for photographs, not SVG; embed a JPEG or PNG as a data: URL');
  }
  if ((FETCH_IMAGE_MIMES as readonly string[]).includes(contentType)) {
    return contentType as FetchImageMime;
  }
  if (!contentType || contentType === 'application/octet-stream') {
    const sniffed = sniffRasterImageMime(bytes);
    if (sniffed) return sniffed;
  }
  throw new Error(
    `response is not a photograph (${contentType || 'unknown type'}); fetch_image accepts JPEG, PNG, GIF, and WebP`,
  );
}

function fetchedImageFileName(url: URL, mime: FetchImageMime): string {
  const ext =
    mime === 'image/jpeg'
      ? '.jpg'
      : mime === 'image/png'
        ? '.png'
        : mime === 'image/gif'
          ? '.gif'
          : '.webp';
  const raw = basename(url.pathname)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  if (raw && /\.(jpe?g|png|gif|webp)$/i.test(raw)) return raw;
  if (raw) return raw.toLowerCase().endsWith(ext) ? raw : `${raw}${ext}`;
  return `photo${ext}`;
}

/** fetch_image: daemon-side photograph download into session scratch. */
export async function fetchImage(
  args: JsonObject,
  deps: FetchImageDeps = fetchImageDepsFromEnv(),
): Promise<string> {
  const url = stringArg(args, 'url')?.trim();
  if (!url) throw new Error('url must be a non-empty http(s) URL');
  const parsed = parseImageUrl(url);
  let fetched;
  try {
    fetched = await fetchBoundedBytes(parsed.href, deps.fetchImpl ?? fetch);
  } catch (error) {
    if (error instanceof BoundedSizeError) {
      throw new Error(
        `image exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit (${error.bytes} bytes)`,
      );
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`image fetch timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!fetched.ok) {
    throw new Error(`image fetch failed: HTTP ${fetched.status}`);
  }
  if (fetched.bytes.length === 0) throw new Error('image fetch returned no bytes');
  const mime = resolveFetchedImageMime(fetched.mimeType, fetched.bytes);
  const resolved = resolveWriteScratchPath(
    deps.root,
    join('fetched-images', fetchedImageFileName(parsed, mime)),
  );
  if (process.env.BEELINE_CORNER_SCRATCH_ROOT)
    await assertScratchWriteBudget(process.env.BEELINE_CORNER_SCRATCH_ROOT, fetched.bytes.length);
  writeFileSync(resolved, fetched.bytes);
  return JSON.stringify({ path: resolved, mime, size: fetched.bytes.length });
}

type AttachmentDownloadFailure = 'not_found' | 'forbidden' | 'too_large' | 'download_failed';

/** A refused download_attachment: the tool error text is `{"error":<reason>,"message":…}`. */
class AttachmentDownloadError extends Error {
  readonly reason: AttachmentDownloadFailure;
  constructor(reason: AttachmentDownloadFailure, detail: string) {
    super(JSON.stringify({ error: reason, message: detail }));
    this.name = 'AttachmentDownloadError';
    this.reason = reason;
  }
}

interface DownloadAttachmentDeps {
  /** Same writable session area write_scratch_file and fetch_image use. */
  root?: string;
  /** The daemon's authenticated server; media bytes are read from here, never a stored URL's host. */
  serverBaseUrl: string;
  readMessage: (messageId: string) => Promise<JsonObject>;
  /**
   * The active corner's brief attachment with this object id, or null when the
   * id is not pinned to a brief this agent may read. The server's reach check
   * is the one authority; no Room message is read for this path.
   */
  readBriefAttachment?: (objectId: string) => Promise<DaemonAttachment | null>;
  fetchImpl?: typeof fetch;
}

function downloadAttachmentDepsFromEnv(): DownloadAttachmentDeps {
  const serverBaseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  return {
    root: process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim() || undefined,
    serverBaseUrl,
    readMessage: (messageId) =>
      daemonExecute('getRoomMessage', {
        roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        messageId,
      }),
    readBriefAttachment: async (objectId) => {
      const cornerId = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
      if (!cornerId) return null;
      const { revisions } = (await daemonExecute('listCornerBriefRevisions', {
        cornerId,
        limit: 1,
      })) as {
        revisions?: readonly {
          attachments?: readonly {
            objectId: string;
            title: string;
            mime: string;
            size: number;
            sha256: string;
          }[];
        }[];
      };
      const file = revisions?.[0]?.attachments?.find(
        (attachment) => attachment.objectId.toLowerCase() === objectId,
      );
      if (!file) return null;
      return {
        url: `${serverBaseUrl}/v1/media/${file.objectId}`,
        name: file.title,
        mimeType: file.mime,
        size: file.size,
        sha256: file.sha256,
      };
    },
  };
}

/** The status in a `daemon operation … failed (<status>: …)` error, mapped to a reason. */
function messageReadFailure(error: unknown): AttachmentDownloadError {
  const text = error instanceof Error ? error.message : String(error);
  const status = Number(/\((\d{3}):/.exec(text)?.[1]);
  if (status === 403)
    return new AttachmentDownloadError('forbidden', 'you cannot read that message from this Room');
  if (status === 404 || status === 400)
    return new AttachmentDownloadError('not_found', 'no such message');
  return new AttachmentDownloadError('download_failed', `could not read the message (${text})`);
}

/** One file to download: the media id its bytes live under, plus the metadata
 *  the caller is allowed to see (a Room message attachment or a corner brief
 *  attachment). */
interface DownloadCandidate {
  /** Scratch directory segment: the message id, or the brief object id. */
  readonly key: string;
  readonly mediaId: string;
  /** Sanitized, collision-free file name safe to join under `key`. */
  readonly safeName: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly expired?: boolean;
}

/**
 * The download candidate for the attachment at `index` of a full message
 * attachment list. The name comes from the whole list so two attachments whose
 * names sanitize identically keep distinct filenames, exactly as delivery does.
 */
function candidateFromMessage(
  messageId: string,
  attachments: readonly DaemonAttachment[],
  index: number,
): DownloadCandidate | null {
  const attachment = attachments[index];
  if (!attachment) return null;
  const mediaId = attachmentId(attachment);
  if (!mediaId) return null;
  return {
    key: messageId,
    mediaId,
    safeName: safeAttachmentNames(attachments)[index]!,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
    ...(attachment.expired ? { expired: true } : {}),
  };
}

/**
 * Resolve the file to download. A `messageId` authorizes through the same
 * getRoomMessage read as before. A brief manifest exposes only the attachment
 * object id, so when the id is not on that message the active corner's brief
 * is consulted; the server's reach check decides who may read it, and no
 * parent Room message is read for this path.
 */
async function resolveDownloadAttachment(
  args: JsonObject,
  deps: DownloadAttachmentDeps,
): Promise<DownloadCandidate> {
  const wanted = stringArg(args, 'attachmentId')?.trim().toLowerCase();
  if (!wanted) throw new AttachmentDownloadError('not_found', 'attachmentId is required');
  const messageId = stringArg(args, 'messageId')?.trim();
  let messageError: unknown;
  if (messageId) {
    try {
      const message = await deps.readMessage(messageId);
      const attachments = (
        Array.isArray(message.attachments) ? message.attachments : []
      ) as DaemonAttachment[];
      const index = attachments.findIndex((item) => attachmentId(item) === wanted);
      if (index >= 0) {
        const candidate = candidateFromMessage(messageId, attachments, index);
        if (candidate) return candidate;
      }
    } catch (error) {
      messageError = error;
    }
  }
  let brief: DaemonAttachment | null = null;
  if (deps.readBriefAttachment) {
    try {
      brief = await deps.readBriefAttachment(wanted);
    } catch {
      // No reach to the corner (or its brief is gone): the id stays unknown.
      brief = null;
    }
  }
  if (brief) {
    return {
      key: wanted,
      mediaId: attachmentId(brief) ?? wanted,
      safeName: safeAttachmentNames([brief])[0]!,
      ...(brief.mimeType ? { mimeType: brief.mimeType } : {}),
      ...(brief.size !== undefined ? { size: brief.size } : {}),
      ...(brief.sha256 ? { sha256: brief.sha256 } : {}),
      ...(brief.expired ? { expired: true } : {}),
    };
  }
  if (messageError) throw messageReadFailure(messageError);
  throw new AttachmentDownloadError('not_found', 'no attachment with this id');
}

/**
 * download_attachment: authorize through the same getRoomMessage read the
 * agent already has, or through the active corner's brief when the manifest's
 * object id names a brief attachment, then copy the bytes from the server into
 * `<scratch>/attachments/<key>/<safe-name>`. Nothing is downloaded while a
 * prompt is built; this is the only on-demand path for a transcript file.
 */
async function downloadAttachment(
  args: JsonObject,
  deps: DownloadAttachmentDeps = downloadAttachmentDepsFromEnv(),
): Promise<string> {
  const attachment = await resolveDownloadAttachment(args, deps);
  const tooLarge = (bytes: number) =>
    new AttachmentDownloadError(
      'too_large',
      `${bytes} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`,
    );
  if (attachment.expired) throw new AttachmentDownloadError('not_found', EXPIRED_REASON);
  if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES) throw tooLarge(attachment.size);
  if (!deps.root)
    throw new AttachmentDownloadError(
      'download_failed',
      'this session has no writable scratch directory',
    );
  let path: string;
  try {
    path = resolveWriteScratchPath(
      deps.root,
      join(
        'attachments',
        attachment.key.replace(/[^\w-]/g, '_'),
        attachment.safeName,
      ),
    );
  } catch (error) {
    throw new AttachmentDownloadError(
      'download_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  if (attachment.sha256 && existsSync(path)) {
    const held = readFileSync(path);
    if (digest(held) === attachment.sha256) {
      return JSON.stringify({
        path,
        mimeType: attachment.mimeType || 'application/octet-stream',
        size: held.length,
      });
    }
  }
  let fetched;
  try {
    fetched = await fetchBoundedBytes(
      new URL(`/v1/media/${attachment.mediaId}`, `${deps.serverBaseUrl}/`).toString(),
      deps.fetchImpl ?? fetch,
    );
  } catch (error) {
    if (error instanceof BoundedSizeError) throw tooLarge(error.bytes);
    throw new AttachmentDownloadError(
      'download_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (fetched.status === 410) throw new AttachmentDownloadError('not_found', EXPIRED_REASON);
  if (fetched.status === 404)
    throw new AttachmentDownloadError('not_found', 'the file is no longer stored');
  if (!fetched.ok) throw new AttachmentDownloadError('download_failed', `HTTP ${fetched.status}`);
  if (attachment.sha256 && digest(fetched.bytes) !== attachment.sha256) {
    throw new AttachmentDownloadError(
      'download_failed',
      'downloaded bytes do not match the stored sha256',
    );
  }
  writeFileSync(path, fetched.bytes);
  return JSON.stringify({
    path,
    mimeType: attachment.mimeType || fetched.mimeType || 'application/octet-stream',
    size: fetched.bytes.length,
  });
}

function withinRoot(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve a post_artifact `path` inside the session checkout or anywhere in
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

/** The daemon-facing artifacts pass-through's response: `postArtifact` only
 *  reads `url`, the rest of `UploadArtifactResult`
 *  (`apps/server/src/object-service.ts`) rides along unused. */
export interface DaemonArtifactUploadResult {
  url: string;
  mimeType?: string;
  size?: number;
  title?: string;
}

export interface PostArtifactDeps {
  roomId: string;
  /** Legal source roots for the `path` argument: the session checkout and
   *  (when configured) the session's whole writable home overlay, wherever
   *  the harness put a file it generated. */
  roots: string[];
  upload: (bytes: Buffer, mime: string, title: string) => Promise<DaemonArtifactUploadResult>;
  queue: (attachment: JsonObject) => Promise<void>;
}

const POSTED_MEDIA_ID =
  /\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[?#])/i;

function isArtifactMime(value: unknown): value is ArtifactMimeType {
  return typeof value === 'string' && (ARTIFACT_MIME_TYPES as readonly string[]).includes(value);
}

/** The viewer cannot open `application/octet-stream`, so content that falls
 *  through to it (inline `html`/`bytes`, or an unknown or missing extension)
 *  is sniffed for a format the viewer renders. Unrecognized content keeps
 *  the octet-stream type. */
function sniffArtifactMime(bytes: Buffer, fromHtml: boolean): ArtifactMimeType {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  const head = bytes
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  const prolog = head.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^(<!--[\s\S]*?-->\s*)+/, '');
  if (prolog.startsWith('<svg') || /^<!doctype\s+svg[\s>]/.test(prolog)) return 'image/svg+xml';
  if (fromHtml || /^<(!doctype html|html)[\s>]/.test(prolog)) return 'text/html';
  return 'application/octet-stream';
}

/** The caller's checkout and writable home, where only it can open files. */
function attachRootsFromEnv(): string[] {
  return [process.env.BEELINE_ATTACH_ROOT?.trim(), process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim()]
    .filter((root): root is string => Boolean(root));
}

export function postArtifactDepsFromEnv(): PostArtifactDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  return {
    roomId: agentScheduleRoomId(),
    roots: [requiredEnv('BEELINE_ATTACH_ROOT'), ...(scratchRoot ? [scratchRoot] : [])],
    upload: (bytes, mime, title) => daemonUploadArtifact(bytes, mime, title),
    queue: async (attachment) => {
      await daemonExecute('postAgentAttachment', { roomId: agentScheduleRoomId(), attachment });
    },
  };
}

/** post_artifact: validate, upload through the artifacts pass-through, then
 *  queue the attachment on this turn's final reply. Content comes either
 *  from `path` (a file in the session checkout or writable home, with title
 *  and mime defaulted) or from `html`/`bytes` inline. The server refuses the
 *  attachment outside an active turn (postAgentAttachment is turn-authority
 *  bound), so there is no separate surface-side turn check here. */
export async function postArtifact(
  args: JsonObject,
  deps: PostArtifactDeps = postArtifactDepsFromEnv(),
): Promise<string> {
  const pathArg = stringArg(args, 'path');
  const html = args.html;
  const encoded = args.bytes;
  const contentArgs = (html !== undefined ? 1 : 0) + (encoded !== undefined ? 1 : 0);
  if (pathArg !== undefined && contentArgs > 0) {
    throw new Error(
      'pass either path (a file already in your session) or html/bytes content, not both',
    );
  }
  if (contentArgs > 1) {
    throw new Error('pass html (the document as text) or bytes (base64), not both');
  }
  if (pathArg === undefined && contentArgs === 0) {
    throw new Error(
      'pass a file path, or exactly one of html (the document as text) or bytes (base64)',
    );
  }
  let bytes: Buffer;
  let fileName: string;
  if (pathArg !== undefined) {
    const resolved = resolveAttachPath(deps.roots, pathArg);
    const details = statSync(resolved);
    if (details.size > MAX_ATTACH_BYTES) {
      throw new Error(`file exceeds the ${MAX_ATTACH_BYTES}-byte artifact limit`);
    }
    bytes = readFileSync(resolved);
    fileName = resolved.split(sep).pop() ?? 'artifact';
  } else {
    if (html !== undefined) {
      if (typeof html !== 'string') throw new Error('html must be a string');
      bytes = Buffer.from(html, 'utf8');
    } else {
      if (typeof encoded !== 'string') throw new Error('bytes must be a base64 string');
      bytes = Buffer.from(encoded, 'base64');
    }
    fileName = 'artifact';
  }
  let mime = stringArg(args, 'mime');
  if (mime === undefined) {
    const extension = fileName.includes('.')
      ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
      : '';
    mime = ARTIFACT_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
  }
  if (mime === 'application/octet-stream') mime = sniffArtifactMime(bytes, html !== undefined);
  if (!isArtifactMime(mime)) {
    throw new Error(`mime must be one of ${ARTIFACT_MIME_TYPES.join(', ')}`);
  }
  let title = stringArg(args, 'title')?.trim();
  if (!title) {
    if (pathArg === undefined) {
      throw new Error(
        'title must be a non-empty string (or post by path to default it to the file name)',
      );
    }
    title = fileName;
  }
  if (title.length > 200) throw new Error('title must be at most 200 characters');
  validateArtifact(mime, bytes, title);
  const uploaded = await deps.upload(bytes, mime, title);
  if (!uploaded.url) throw new Error('the artifact upload returned no url');
  await deps.queue({ url: uploaded.url, name: title, mimeType: mime, size: bytes.length });
  const objectId = POSTED_MEDIA_ID.exec(uploaded.url)?.[1];
  return (
    `Posted artifact "${title}" (${bytes.length} bytes, ${mime}); it is delivered with your ` +
    `final reply.${objectId ? ` Object ${objectId} will be included automatically if this turn opens or revises a corner brief.` : ''} Ask for feedback here in the Room.`
  );
}

/** Rendered formats are validated as self-contained mocks; a working file
 *  such as a game template or a build page is source, so it travels inert. */
const BRIEF_FILE_INERT_MIMES = new Set(['text/html', 'image/svg+xml', 'application/vnd.beeline.game+html']);

/** Absolute or `~/` paths written in brief or order text. */
const NAMED_PATH = /(?:^|[\s(<[])(?:"((?:~\/|\/)[^"\n]+)"|'((?:~\/|\/)[^'\n]+)'|`((?:~\/|\/)[^`\n]+)`|((?:~\/|\/)[^\s`'"()<>\]]+))/g;

/** Recognize private paths even when missing or unreadable, so delivery fails
 *  explicitly rather than handing the worker an inaccessible filename. */
export function namedPrivateFiles(roots: string[], text: string): { named: string; resolved: string }[] {
  const home = process.env.HOME?.trim();
  const found: { named: string; resolved: string }[] = [];
  for (const match of text.matchAll(NAMED_PATH)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const named = quoted ?? match[4]!.replace(/[.,;:!?*]+$/, '');
    const absolute = named.startsWith('~/') ? (home ? join(home, named.slice(2)) : '') : named;
    if (!absolute) continue;
    let resolved = resolve(absolute);
    const inRoots = roots.some((root) => withinRoot(resolve(root), resolved));
    try {
      resolved = resolveAttachPath(roots, absolute);
    } catch {
      // A named path in our roots still needs a refusal if it cannot be read.
      if (!inRoots) continue;
    }
    if (!found.some((file) => file.resolved === resolved)) found.push({ named, resolved });
  }
  return found;
}

/**
 * A brief attachment may name a working file by `path` instead of an object
 * id. The file is uploaded and queued like post_artifact, so it reaches the
 * caller's own place, and the brief carries its object id; the server then
 * binds it to the corner and the worker downloads and checks the same bytes.
 * A file that cannot be read refuses the call by name. A private file the
 * spec names but does not attach also refuses, because the worker cannot
 * open it.
 */
export async function bindBriefFiles(brief: JsonObject, given?: PostArtifactDeps): Promise<JsonObject> {
  const roots = given?.roots ?? attachRootsFromEnv();
  const attachments = Array.isArray(brief.attachments) ? (brief.attachments as JsonObject[]) : [];
  const attached = new Set<string>();
  const bound: JsonObject[] = [];
  for (const item of attachments) {
    const path = item?.path;
    if (path === undefined) {
      bound.push(item);
      continue;
    }
    if (typeof path !== 'string' || item.objectId !== undefined)
      throw new Error('a brief attachment names either objectId or path, not both');
    const deps = given ?? postArtifactDepsFromEnv();
    let resolved: string;
    let bytes: Buffer;
    try {
      resolved = resolveAttachPath(deps.roots, path);
      if (statSync(resolved).size > MAX_ATTACH_BYTES)
        throw new Error(`file exceeds the ${MAX_ATTACH_BYTES}-byte limit`);
      bytes = readFileSync(resolved);
      if (!bytes.length) throw new Error('file is empty');
    } catch (error) {
      throw new Error(
        `brief attachment ${path} cannot be delivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const fileName = basename(resolved);
    const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
    const known = ARTIFACT_MIME_BY_EXTENSION[extension];
    const mime = known && !BRIEF_FILE_INERT_MIMES.has(known) ? known : known ? 'text/plain' : 'application/octet-stream';
    validateArtifact(mime, bytes, fileName);
    const uploaded = await deps.upload(bytes, mime, fileName);
    const objectId = uploaded.url ? POSTED_MEDIA_ID.exec(uploaded.url)?.[1] : undefined;
    if (!objectId) throw new Error(`brief attachment ${path} cannot be delivered: the upload returned no object`);
    await deps.queue({ url: uploaded.url, name: fileName, mimeType: mime, size: bytes.length });
    attached.add(resolved);
    const { path: _path, ...rest } = item;
    bound.push({ ...rest, objectId });
  }
  const unattached = namedPrivateFiles(roots, typeof brief.spec === 'string' ? brief.spec : '')
    .filter((file) => !attached.has(file.resolved));
  if (unattached.length)
    throw new Error(
      `the brief names ${unattached.map((file) => file.named).join(', ')}, which only you can open; ` +
        `attach each with brief.attachments [{path, purpose, required}] so the worker receives it, ` +
        `or name a repository file by its repository-relative path`,
    );
  return attachments.length ? { ...brief, attachments: bound } : brief;
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
  selfOnly?: boolean;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
}

export function agentScheduleDepsFromEnv(): AgentScheduleDeps {
  return { roomId: agentScheduleRoomId(), execute: daemonExecute };
}

export async function reactToMessage(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const messageId = stringArg(args, 'messageId')?.trim();
  if (!messageId) throw new Error('messageId must be a non-empty string');
  const emoji = stringArg(args, 'emoji');
  if (!emoji || !(MESSAGE_REACTION_EMOJIS as readonly string[]).includes(emoji)) {
    throw new Error(`emoji must be one of ${MESSAGE_REACTION_EMOJIS.join(' ')}`);
  }
  await deps.execute('reactToRoomMessage', {
    roomId: deps.roomId,
    messageId,
    emoji: emoji as MessageReactionEmoji,
  });
  return `Reacted ${emoji} to message ${messageId}.`;
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
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(stringArg(args, 'workflowName') ? { workflowName: stringArg(args, 'workflowName')! } : {}),
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
    ' Use wake(action:delete, scheduleId) to remove it.'
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
        `${String(schedule.scheduleId)} (${typeof schedule.agentHandle === 'string' ? `@${schedule.agentHandle}` : `agent ${String(schedule.agentId)}`}): ${cadenceText}${runs}${nextRunAt} — ${String(schedule.prompt)}` +
          (schedule.workflowName ? ` · Workflow ${String(schedule.workflowName)}` : '') +
          (Array.isArray(schedule.activeRunIds) ? ` · Active run IDs: ${schedule.activeRunIds.join(', ') || 'none'}` : ''),
      ];
    })
    .join('\n');
}

/**
 * The agent's own event subscriptions, written by the agent.
 *
 * A subscription is per Room and belongs to the agent's own membership row, so
 * the tool sends kinds and nothing else: the daemon token names the agent and
 * the environment names the Room. The reply always states the COMPLETE
 * resulting list, because the write replaces rather than adds and a model that
 * subscribed to one more kind must be able to see what it stopped reacting to.
 */
export async function subscribeEvents(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const requested = args.kinds;
  if (!Array.isArray(requested))
    throw new Error(`kinds must be an array of event kinds: ${SUBSCRIBABLE_EVENT_KINDS.join(', ')}`);
  const perItem = requested.filter(isPerItemEventKind);
  if (perItem.length) throw new Error(perItemSubscriptionRefusal(String(perItem[0])));
  const unknown = requested.filter((kind) => !isSubscribableEventKind(kind));
  if (unknown.length) {
    throw new Error(
      `not an event kind you can subscribe to: ${unknown.map(String).join(', ')}. ` +
        `The kinds are ${SUBSCRIBABLE_EVENT_KINDS.join(', ')}.`,
    );
  }
  const result = await deps.execute('setEventSubscriptions', {
    roomId: deps.roomId,
    kinds: requested as string[],
  });
  return describeSubscriptions(result, 'You now react to');
}

export async function setWakeDelivery(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  wakeBatchMinutes(args.delivery);
  const result = await deps.execute('setWakeDelivery', { roomId: deps.roomId, delivery: args.delivery });
  return `Your whole wake inbox is ${String(result.delivery)}; human messages arrive immediately. Digests stay within each Room or corner.`;
}

export async function listEventSubscriptions(
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('listEventSubscriptions', { roomId: deps.roomId });
  return describeSubscriptions(result, 'You react to');
}

function describeSubscriptions(result: JsonObject, lead: string): string {
  const kinds = (Array.isArray(result.kinds) ? result.kinds : []).map(String);
  return kinds.length
    ? `${lead} ${kinds.join(', ')} in this Room; each one wakes you for a turn.`
    : 'You react to no events in this Room; only a message that mentions you wakes you.';
}

/**
 * One event this agent emits into the Room it is answering in.
 *
 * The tool sends no cause: the server reads this agent's live turn receipt and
 * derives the chain from it. A refusal — too deep, or a chain that has woken
 * too many turns — comes back as this tool's error, which is the only way the
 * emitting model learns that nothing was posted.
 */
export async function emitEvent(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const kind = stringArg(args, 'kind')?.trim();
  if (!kind) throw new Error('kind must be a non-empty string');
  if (isServerEventKind(kind)) {
    throw new Error(
      `${kind} is a fact the server states, not one you emit. Use an agent:<slug> kind of your own.`,
    );
  }
  if (!isAgentKind(kind)) {
    throw new Error(
      `kind must be agent:<slug>, lower-case letters, digits and hyphens, slug at most ${AGENT_EVENT_SLUG_MAX_LENGTH} characters`,
    );
  }
  const consequence = stringArg(args, 'consequence')?.trim();
  if (!consequence) throw new Error('consequence must say in one sentence what happened');
  if (consequence.length > MAX_EVENT_CONSEQUENCE_LENGTH)
    throw new Error(`consequence must be at most ${MAX_EVENT_CONSEQUENCE_LENGTH} characters`);
  const mentions = args.mentionAgentIds;
  if (mentions !== undefined && !Array.isArray(mentions))
    throw new Error('mentionAgentIds must be an array of agent ids or handles');
  const mentionAgentIds = (mentions ?? []).map(String);
  if (mentionAgentIds.length > MAX_MENTIONS_PER_EVENT)
    throw new Error(`an event may wake at most ${MAX_MENTIONS_PER_EVENT} agents`);
  await deps.execute('postRoomEvent', {
    roomId: deps.roomId,
    kind,
    consequence,
    ...(mentionAgentIds.length ? { mentionAgentIds } : {}),
  });
  return mentionAgentIds.length
    ? `Posted ${kind} in this Room and woke ${mentionAgentIds.length} agent(s).`
    : `Posted ${kind} in this Room.`;
}

export async function updateSchedule(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const scheduleId = stringArg(args, 'scheduleId')?.trim();
  if (!scheduleId) throw new Error('scheduleId must be a non-empty string');
  const prompt = args.prompt === undefined ? undefined : stringArg(args, 'prompt')?.trim();
  if (args.prompt !== undefined && !prompt) throw new Error('prompt must be a non-empty string');
  if (prompt && prompt.length > 2000) throw new Error('prompt exceeds 2000 characters');
  const parsed = args.cadence === undefined ? undefined : parseScheduleCadence(args);
  const maxRuns = args.maxRuns;
  if (
    maxRuns !== undefined &&
    (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1)
  ) {
    throw new Error('maxRuns must be a positive integer');
  }
  if (prompt === undefined && parsed === undefined && maxRuns === undefined && args.title === undefined && !stringArg(args, 'workflowName'))
    throw new Error('give a prompt, cadence, or maxRuns to change');
  const updated = await deps.execute('updateAgentSchedule', {
    roomId: deps.roomId,
    scheduleId,
    ...(deps.selfOnly ? { selfOnly: true } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(stringArg(args, 'workflowName') ? { workflowName: stringArg(args, 'workflowName')! } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(parsed ? { cadence: parsed.cadence } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
  });
  const nextRunAt =
    typeof updated.nextRunAt === 'number'
      ? ` Next run ${new Date(updated.nextRunAt * 1_000).toISOString()}.`
      : '';
  return `Schedule ${scheduleId} updated.${nextRunAt}`;
}

export async function deleteSchedule(
  args: JsonObject,
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const scheduleId = stringArg(args, 'scheduleId')?.trim();
  if (!scheduleId) throw new Error('scheduleId must be a non-empty string');
  await deps.execute('deleteAgentSchedule', { roomId: deps.roomId, scheduleId, ...(deps.selfOnly ? { selfOnly: true } : {}) });
  return `Schedule ${scheduleId} deleted.`;
}

export interface AgentGrantDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
  /** Where a script argument may be read from: the checkout, then the scratch. */
  scriptRoots?: string[];
  /** Execution environment used to resolve bare executable names. */
  scriptEnv?: NodeJS.ProcessEnv;
  /** Test seam for reading those bytes. */
  readScript?: (path: string) => Buffer;
  /**
   * Where a command grant's named secrets resolve from, at ask time and for
   * `list_grants`. Defaults to the operator key store, secrets.json, then the
   * daemon environment.
   */
  resolveSecret?: SecretResolver;
  /** Where `store_secret` writes; defaults to the daemon's secrets.json. */
  storeSecret?: (name: string, value: string) => Promise<void>;
}

export function agentGrantDepsFromEnv(): AgentGrantDeps {
  const scratchRoot = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
  const attachRoot = process.env.BEELINE_ATTACH_ROOT?.trim();
  return {
    roomId: agentScheduleRoomId(),
    execute: daemonExecute,
    scriptRoots: [...(attachRoot ? [attachRoot] : []), ...(scratchRoot ? [scratchRoot] : [])],
    resolveSecret: operatorSecretResolver(process.env),
    storeSecret: (name, value) => storeOperatorSecret(name, value, process.env),
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
  const roots = deps.scriptRoots ?? [];
  if (!roots.length) return undefined;
  const context = resolveGrantCommand(rule.argv, roots[0]!, deps.scriptEnv ?? process.env);
  const argument = interpreterScriptArgument(context.argv, true);
  if (!argument) return undefined;
  const candidatePath = resolveGrantScriptExecutable(argument, context.cwd, context.env);
  const executable = argument.direct ? candidatePath : undefined;
  if (argument.direct && !executable) return undefined;
  if (argument.direct) {
    // Native executable paths do not need a script card, including binaries
    // outside the attachment roots. Script paths still meet the root check below.
    let candidate: Buffer;
    try {
      candidate = (deps.readScript ?? readFileSync)(executable!);
    } catch { return undefined; }
    if (isNativeGrantExecutable(candidate)) return undefined;
  }
  let resolved: string;
  try {
    resolved = resolveAttachPath(roots, candidatePath ?? argument.path);
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
  // Direct native executables retain ordinary command grant behavior.
  if (argument.direct && isNativeGrantExecutable(bytes)) return undefined;
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
  const purpose = stringArg(args, 'purpose')?.trim();
  if (!purpose || purpose.length > 240) throw new Error('purpose is required: explain what you want to do and why in 1–240 characters');
  const kind = stringArg(args, 'kind');
  if (kind === 'shared_asset') {
    if (args.ttl !== undefined) throw new Error('shared asset isolation must be standing');
    return requestSharedAssetIsolation({ category: args.target, reason: args.reason, purpose: args.purpose, touches: args.touches, capabilities: args.capabilities }, deps);
  }
  if (!isRequestableAgentGrantKind(kind)) {
    throw new Error(`kind must be one of ${REQUESTABLE_AGENT_GRANT_KINDS.join(', ')}`);
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
  // Reject at ask time a command grant whose named secrets cannot resolve: an
  // approved grant that fails at run time is the failure this whole fix removes.
  // Resolvable means the operator key store, secrets.json, or the daemon's own
  // environment has a value for the name, now.
  if (kind === 'command' && rule && rule.secrets.length) {
    const resolveSecret = deps.resolveSecret ?? operatorSecretResolver(process.env);
    const missing: string[] = [];
    for (const name of rule.secrets) {
      if (!(await resolveSecret(name))) missing.push(name);
    }
    if (missing.length) {
      throw new Error(
        `secret ${missing.join(', ')} is not in the operator key store or the daemon environment, so this command grant could never run. ` +
          'Have the operator initialize the named secret securely, or drop the --with suffix.',
      );
    }
  }
  const result = await deps.execute('requestAgentGrant', {
    roomId: deps.roomId,
    kind,
    target,
    reason,
    purpose,
    ...(args.touches !== undefined ? { touches: stringArg(args, 'touches') } : {}),
    ...(args.capabilities !== undefined ? { capabilities: stringArg(args, 'capabilities') } : {}),
    ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
    ...(script ? { script } : {}),
  });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const ask = `${AGENT_GRANT_VERBS[kind]} ${target}`;
  if (result.auto === true) {
    if (kind === 'command')
      return `approved: ${ask} [grant ${grantId}]. Run it now with run_granted_command and the argv.`;
    if (kind === 'device') {
      // bwrap fixes /dev when a session starts, so the turn loop continues
      // this same turn in a fresh session that has it (`approvedDeviceGrant`).
      return sandboxDevicePath(target)
        ? `approved: ${ask} [grant ${grantId}]. A running session cannot add a device, so end your turn now with one short line; this same turn continues straight away in a session that has ${target}. Do not ask anyone to restart.`
        : `approved: ${ask} [grant ${grantId}], but only device nodes under /dev/ are added to your session, so nothing was added.`;
    }
    return `approved: ${ask} [grant ${grantId}]; applies at the agent's next session.`;
  }
  // Yolo covers most asks; these two shapes never do, and saying which one this
  // is stops the model retrying the same line expecting a different answer.
  const escalations = Array.isArray(result.escalations)
    ? (result.escalations as AgentGrantEscalation[])
    : [];
  const because = formatGrantEscalationReason(escalations);
  const approval = asObject(result.approval);
  const authority =
    approval.authority === 'workspace-manager'
      ? 'A Workspace owner or admin'
      : approval.authority === 'resource-owner'
        ? 'The resource owner'
        : 'An authorized person';
  const destination =
    approval.destination === 'room'
      ? 'on the card in this Room'
      : approval.destination === 'trusty-squire-dm'
        ? "in the resource owner's private Trusty Squire DM"
        : approval.destination === 'wallet-dm'
          ? "in the resource owner's private Wallet DM"
          : approval.destination === 'system-dm'
            ? "in the resource owner's private @system DM"
            : 'on the approval card';
  return (
    `pending, card posted: ${ask} [grant ${grantId}]. ` +
    (because ? `A human always answers this one because ${because}. ` : '') +
    (script
      ? `The card shows ${script.path} in full, and the approval is bound to those bytes. `
      : '') +
    `${authority} must answer ALWAYS, ONCE, or NO ${destination}; ` +
    'your turn is paused on this grant. Tell the human what you are waiting for and end your turn now; ' +
    (kind === 'mcp'
      ? 'the approval wake starts the fresh session with that route mounted, so use it immediately without restarting or scheduling another turn.'
      : 'you will be woken with the answer.')
  );
}

export async function requestSharedAssetIsolation(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const purpose = stringArg(args, 'purpose')?.trim();
  if (!purpose || purpose.length > 240) throw new Error('purpose is required: explain what you want to do and why in 1–240 characters');
  const category = stringArg(args, 'category');
  if (!isSharedAssetCategory(category))
    throw new Error(`category must be one of ${SHARED_ASSET_CATEGORIES.join(', ')}`);
  const reason = stringArg(args, 'reason')?.trim();
  if (!reason || reason.length > AGENT_GRANT_REASON_MAX_LENGTH)
    throw new Error('reason must explain the failure in at most 1000 characters');
  const result = await deps.execute('requestAgentGrant', {
    roomId: deps.roomId, kind: 'shared_asset', target: category, reason, purpose,
    ...(args.touches !== undefined ? { touches: stringArg(args, 'touches') } : {}),
    ...(args.capabilities !== undefined ? { capabilities: stringArg(args, 'capabilities') } : {}),
  });
  if (result.status !== 'pending' || result.auto !== false)
    throw new Error('shared asset isolation did not open a human approval');
  return `pending, card posted: isolate ${category} [grant ${String(result.grantId)}]. A Workspace owner, admin, or this agent's owner must answer ALWAYS or NO on the card in this Room. Your turn is paused; end it now. If approved, the category becomes private from your next session.`;
}

/**
 * list_grants: every grant this agent raised — pending, approved, and once —
 * with status, target, reason, and, for a command grant, whether each named
 * secret currently resolves. This is inspection, never authority: it changes
 * no state. Corner reviewers may also inspect that corner implementer's rows.
 */
export async function listGrants(
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const result = (await deps.execute('listAgentGrantRequests', {
    roomId: deps.roomId,
  })) as { grants?: Array<Record<string, unknown>> };
  const grants = Array.isArray(result.grants) ? result.grants : [];
  if (!grants.length) {
    return 'no grants right now: nothing pending an answer, approved, or spent-once';
  }
  const resolveSecret = deps.resolveSecret ?? operatorSecretResolver(process.env);
  const lines: string[] = [];
  for (const entry of grants) {
    const grantId = typeof entry.grantId === 'string' ? entry.grantId : 'unknown';
    const kind = typeof entry.kind === 'string' ? entry.kind : 'unknown';
    const status = typeof entry.status === 'string' ? entry.status : 'unknown';
    const target = typeof entry.target === 'string' ? entry.target : '';
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    let secretsNote = '';
    if (kind === 'command') {
      try {
        const rule = parseCommandGrantTarget(target);
        if (rule.secrets.length) {
          const missing = (
            await Promise.all(
              rule.secrets.map(async (name) => ((await resolveSecret(name)) ? null : name)),
            )
          ).filter((name): name is string => name !== null);
          secretsNote = missing.length
            ? ` · secrets ${missing.join(', ')} NOT resolvable (operator secret setup is required before asking again)`
            : ` · secrets present`;
        }
      } catch {
        // A target that no longer parses is shown plainly; nothing else to say.
      }
    }
    lines.push(`- ${status} ${kind} ${target} [${grantId}]${typeof entry.agentId === 'string' ? ` · agent ${entry.agentId}` : ''}${reason ? ` · ${reason}` : ''}${secretsNote}`);
  }
  return ['grants:', ...lines].join('\n');
}

/**
 * store_secret: write one operator secret by name so a command grant's
 * `--with NAME` resolves at run time. The value goes into the daemon's
 * secrets.json (mode 0600) and is never echoed, never sent to the server, and
 * never shown on a ledger row.
 */
export async function storeSecret(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const name = stringArg(args, 'name')?.trim();
  const value = args.value;
  if (!name || !COMMAND_SECRET_NAME.test(name)) {
    throw new Error('name must be one UPPER_CASE secret name (A-Z, 0-9, underscore, max 64 chars)');
  }
  if (typeof value !== 'string' || !value) {
    throw new Error('value must be a non-empty string');
  }
  if (value.length > 8192) {
    throw new Error('value is too long: secrets are capped at 8192 characters');
  }
  await (deps.storeSecret ?? ((n, v) => storeOperatorSecret(n, v)))(name, value);
  return `stored secret ${name} in the operator key store; it now resolves for --with ${name}. The value was never echoed.`;
}

export interface ConnectorOfferDeps {
  roomId: string;
  execute: (name: string, input: JsonObject) => Promise<JsonObject>;
  /** Live Tailscale reachability; `enabled` is true when this helper already has it. */
  tailscaleReach?: (enabled: boolean) => Promise<string>;
  squireReach?: () => Promise<{ reachable: boolean; cause?: string } | undefined>;
  /** One Squire tool call through this agent's task relay; returns the parsed text result. */
  squireCall?: (tool: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export function connectorOfferDepsFromEnv(): ConnectorOfferDeps {
  const relayUrl = process.env.BEELINE_SQUIRE_RELAY_URL;
  const relayToken = process.env.BEELINE_SQUIRE_RELAY_TOKEN;
  const squireCall = relayUrl && relayToken ? async (tool: string, args: Record<string, unknown> = {}) => {
    const context = await activeCommandContext();
    const response = await fetch(new URL('/mcp', relayUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...context, method: 'tools/call',
        params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch((error) => {
      if (!response.ok) throw new Error(`Squire relay HTTP ${response.status}`);
      throw error;
    }) as { error?: string; result?: {
      isError?: boolean; content?: Array<{ type: string; text?: string }>;
    } };
    if (!response.ok) throw new Error(body.error ?? `Squire relay HTTP ${response.status}`);
    const result = body.result;
    const text = result?.content?.find((entry) => entry.type === 'text')?.text;
    if (result?.isError) throw new Error(text ?? 'Squire MCP tool error');
    if (text) return JSON.parse(text);
    throw new Error(`Squire MCP returned no result for ${tool}`);
  } : undefined;
  return {
    squireCall,
    roomId: agentScheduleRoomId(),
    execute: daemonExecute,
    tailscaleReach: (enabled) => describeTailscaleReach({ enabled, installIfMissing: enabled }),
    // This task relay reaches only the broker on this agent's own machine.
    squireReach: relayUrl && relayToken ? async () => {
      let connections: Awaited<ReturnType<typeof readVault>>;
      try {
        connections = await readVault({ call: squireCall! });
      } catch (error) {
        // Task authorization and stale turns are not machine failures.
        if (/not authorized|active task|active server command|Squire relay HTTP 403/i.test(
          error instanceof Error ? error.message : ''))
          return { reachable: false, cause: 'Squire status probe was not authorized' };
        const cause = squireReachCause(error);
        try {
          await daemonExecute('postConnectorVault', { connections: [], errorMessage: cause });
        } catch { /* The live verdict remains useful when its report fails. */ }
        return { reachable: false, cause };
      }
      try {
        await daemonExecute('postConnectorVault', { connections });
      } catch { /* A failed metadata sync does not change MCP reachability. */ }
      return { reachable: true };
    } : undefined,
  };
}

/**
 * Squire error codes with a known recovery. Codes come from Squire's
 * `errorContent` ({ error: { code, message } }): `stale_lease` and
 * `unknown_session` mean the session is gone or not this connection's, and the
 * Beeline task relay reuses `stale_lease` for the same case.
 */
const SQUIRE_SHARE_CAUSES: Record<string, string> = {
  stale_lease: 'the Squire browser session is gone or no longer owned by this conversation; call operate_start for a fresh session, then share it',
  unknown_session: 'the Squire browser session is gone; call operate_start for a fresh session, then share it',
  session_busy: 'cancelled work still holds this Squire session; wait for it to settle or call operate_finish',
  server_unavailable: 'the Squire browser service is unavailable; do not restart it, try again later',
};

/** Messages the Beeline task relay writes itself, so they hold no provider text. */
const SQUIRE_RELAY_REFUSALS = new Set([
  'Squire MCP connection died and its browser session is gone; call operate_start',
  'Squire browser session is no longer owned by this conversation; call operate_start',
  'Squire MCP connection died; call operate_start for a fresh browser session',
  'Squire call is not authorized for this task',
  'Squire requires the current active task',
  'Squire task ended while the call was running',
]);

/** Only known causes reach the agent; provider payloads may hold secrets. */
function squireShareFailure(status: number, body: unknown): Error {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (typeof record.error === 'string' && SQUIRE_RELAY_REFUSALS.has(record.error))
    return new Error(`Squire could not share this browser session: ${record.error}`);
  const result = record.result as { content?: Array<{ type?: string; text?: unknown }> } | undefined;
  const text = Array.isArray(result?.content)
    ? result.content.find((entry) => entry?.type === 'text')?.text : undefined;
  let code: unknown;
  try { code = (JSON.parse(typeof text === 'string' ? text : '') as { error?: { code?: unknown } }).error?.code; }
  catch { /* Unstructured text stays private. */ }
  if (typeof code === 'string' && Object.hasOwn(SQUIRE_SHARE_CAUSES, code))
    return new Error(`Squire could not share this browser session: ${SQUIRE_SHARE_CAUSES[code]} (${code})`);
  const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? `, code ${code}` : '';
  return new Error(`Squire share failed (HTTP ${status}${safeCode})`);
}

async function squireShareEndpoint(sessionId: string): Promise<{ url: string; expiresAt: number }> {
  const relayUrl = requiredEnv('BEELINE_SQUIRE_RELAY_URL');
  const relayToken = requiredEnv('BEELINE_SQUIRE_RELAY_TOKEN');
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(new URL('/mcp', relayUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...await activeCommandContext(), method: 'tools/call',
        params: { name: 'operate_share', arguments: { session_id: sessionId } } }),
      signal: AbortSignal.timeout(30_000),
    });
    // Only an unparseable body is tolerated; a timeout while reading it is not.
    body = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new Error('Squire share timed out after 30 seconds');
    throw error;
  }
  if (response.status === 403 && body === undefined)
    throw new Error('Squire relay refused authorization (HTTP 403); this turn may have ended');
  if (!response.ok) throw squireShareFailure(response.status, body);
  const result = (body as { result?: { isError?: unknown; content?: unknown } } | undefined)?.result;
  if (result?.isError) throw squireShareFailure(response.status, body);
  const text = Array.isArray(result?.content)
    ? (result.content as Array<{ type?: unknown; text?: unknown }>)
      .find((entry) => entry?.type === 'text')?.text : undefined;
  let shared: Record<string, unknown> | undefined;
  try { shared = typeof text === 'string' ? JSON.parse(text) as Record<string, unknown> : undefined; } catch { /* Reported below. */ }
  if (!shared || typeof shared !== 'object') throw new Error('Squire share returned a malformed response');
  const endpoint = shared.url;
  if (typeof endpoint !== 'string' || !/^https?:\/\/[^/]+\/s\/[A-Za-z0-9_-]{43}\/$/.test(endpoint))
    throw new Error('Squire share returned no valid live page URL');
  const expiresAt = typeof shared.expires_at === 'string' ? Date.parse(shared.expires_at) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error('Squire share returned no valid expiry');
  return { url: endpoint, expiresAt };
}

async function shareBrowser(args: JsonObject): Promise<string> {
  const startedAt = Date.now();
  console.error(`[computer-share] tool started source=${String(args.source ?? 'unknown')} at=${new Date(startedAt).toISOString()}`);
  const context = await activeCommandContext();
  const title = typeof args.title === 'string' ? args.title : 'Browser';
  if (args.source === 'squire') {
    if (typeof args.sessionId !== 'string' || !args.sessionId.trim())
      throw new Error('An existing Squire operate session id is required');
    const { url: upstreamUrl, expiresAt } = await squireShareEndpoint(args.sessionId);
    console.error(`[computer-share] Squire operate_share completed ms=${Date.now() - startedAt}`);
    const result = await daemonExecute('postComputerSession', {
      roomId: context.roomId, sessionId: args.sessionId, upstreamUrl, title, expiresAt,
    });
    console.error(`[computer-share] card published ms=${Date.now() - startedAt}`);
    return JSON.stringify({ cardId: result.messageId, shareId: result.id, message: 'The live browser card is posted in this place. Ask the person to open the card.', sessionId: args.sessionId, status: 'live' });
  }
  if (args.source !== 'chromium') throw new Error('Choose an open Squire or Chromium browser');
  const debugUrl = typeof args.debugUrl === 'string' ? args.debugUrl : 'http://127.0.0.1:9222';
  const target = typeof args.target === 'string' ? args.target : undefined;
  const page = await findChromiumPage(debugUrl, target);
  const result = await daemonExecute('postComputerSession', {
    roomId: context.roomId, sessionId: page.id, upstreamUrl: 'body:', title: args.title ?? page.title ?? 'Browser',
  });
  console.error(`[computer-share] card published ms=${Date.now() - startedAt}`);
  try {
    await startHostedBrowserShare(requiredEnv('BEELINE_BROWSER_SHARE_HOST_SOCKET'), {
      page, shareId: String(result.id), roomId: context.roomId,
      serverBaseUrl: requiredEnv('BEELINE_DAEMON_BASE_URL'),
      daemonToken: requiredEnv('BEELINE_DAEMON_TOKEN'),
    });
  } catch (error) {
    await daemonExecute('endComputerSession', { roomId: context.roomId, sessionId: page.id });
    throw error;
  }
  return JSON.stringify({ cardId: result.messageId, shareId: result.id, message: 'The live browser card is posted in this place. Ask the person to open the card.', sessionId: page.id, status: 'live' });
}


/**
 * workbench_status: the Workbench of the machine and owner this helper
 * actually runs on, rendered as text the model reads line by line — a tool
 * it may offer, a tool already paired (and where), a connection by name.
 */
export async function workbenchStatus(
  deps: ConnectorOfferDeps = connectorOfferDepsFromEnv(),
): Promise<string> {
  const view = (await deps.execute('readAgentWorkbench', { roomId: deps.roomId })) as {
    addressee?: { name?: string; handle?: string };
    owner?: { name?: string; handle?: string };
    catalog?: Array<{
      connectorType: string;
      name: string;
      purpose: string;
      available: boolean;
      offerable: boolean;
      paired?: { status: string; helperName: string; onThisMachine: boolean;
        errorMessage?: string };
    }>;
    connections?: Array<{
      connectorType: string;
      service: string | null;
      label: string;
      state: string;
    }>;
    apps?: Array<{ appId: string; appKey: string; name: string; transport: string; connectionReference?: string;
      status: string; errorMessage?: string }>;
    firstPartyIntegrations?: Array<{ key: string; name: string; status: string }>;
    machine?: { machineId: string; name: string;
      squire?: { status: 'connected' | 'error' | 'not-added'; errorMessage?: string } };
  };
  const who = view.owner?.handle
    ? `@${view.owner.handle}`
    : (view.owner?.name ??
      (view.addressee?.handle
        ? `@${view.addressee.handle}`
        : (view.addressee?.name ?? 'the owner of this machine')));
  const machine = view.machine?.name ?? 'this machine';
  const lines = [
    `Connectors for ${who} on ${machine} (this is the machine you run on; an accepted offer installs here).`,
    '',
    'Catalog:',
  ];
  const machineReport = view.machine?.squire;
  const squireReach = deps.squireReach
    ? await deps.squireReach()
    : machineReport && machineReport.status !== 'not-added'
      ? { reachable: machineReport.status === 'connected', cause: machineReport.errorMessage }
      : undefined;
  for (const entry of view.catalog ?? []) {
    const localReach = entry.connectorType === 'trusty-squire'
      ? squireReach : undefined;
    if (entry.connectorType === 'trusty-squire') {
      const state = localReach
        ? `${localReach.reachable ? 'connected' : 'error'} on ${machine} (your machine)${localReach.cause ? ` — ${localReach.cause}` : ''}`
        : 'not added';
      lines.push(`- ${entry.connectorType} (${entry.name}): ${state}. ${entry.purpose}`);
      continue;
    }
    const status = entry.paired?.status;
    const cause = status === 'error'
      ? entry.paired?.errorMessage ?? 'Connection failed'
      : undefined;
    const state = entry.paired
      ? `${status} on ${entry.paired.helperName}${entry.paired.onThisMachine ? ' (your machine)' : ''}${cause ? ` — ${cause}` : ''}`
      : !entry.available
        ? 'not available yet'
        : 'not added — call connect';
    lines.push(`- ${entry.connectorType} (${entry.name}): ${state}. ${entry.purpose}`);
  }
  lines.push('', 'Connections (keys already provisioned, by name only):');
  const connections = view.connections ?? [];
  if (!connections.length) lines.push('- none');
  for (const connection of connections)
    lines.push(
      `- ${connection.label}${connection.service ? ` (${connection.service})` : ''} via ${connection.connectorType}${connection.state === 'error' ? ' — in error' : ''}`,
    );
  lines.push('', 'Apps (connect; each use is authorized as app:<key>):');
  for (const integration of view.firstPartyIntegrations ?? [])
    lines.push(`- ${integration.name} (${integration.key}) via Beeline: ${integration.status}`);
  const apps = view.apps ?? [];
  if (!apps.length) lines.push('- none');
  for (const app of apps)
    lines.push(`- ${app.name} (app:${app.appKey}, id ${app.appId}) via ${app.transport}: ${app.status}${app.transport === 'squire-api' && app.connectionReference ? `; use_credential(reference:${JSON.stringify(app.connectionReference)})` : ''}${app.status === 'error' && app.errorMessage ? ` — ${app.errorMessage}` : ''}`);
  const github = apps.find(app => app.appKey === 'github' && app.status !== 'disconnected');
  if (github) {
    const route = github.transport === 'squire-api'
      ? `call Squire use_credential (${github.connectionReference ? `reference ${JSON.stringify(github.connectionReference)}` : 'service "github"'})`
      : `use app_tool(app:"${github.appId}")`;
    lines.push('', `GitHub operation identity: in Room, corner and DM sessions, use the Beeline GitHub App for linked-repository code, branch and PR writes, including Git Data API pushes, even when personal GitHub is connected. Without an App checkout, use a corner of the linked Room. This owner's personal GitHub connection (app ${github.appId}, ${github.transport}) serves general lookups, repositories without App access and person-scoped actions; ${route}. Report denials with the exact error and route. Never fall back from App to personal for linked-repository writes or retry person-scoped actions as the App. A mistaken personal-route denial on a linked-repository write does not prevent using the authorized App route. Consult beeline-connecting-services for checkout and merge boundaries.`);
  }
  if (deps.tailscaleReach) {
    const enabled = Boolean(
      view.catalog?.some(
        (entry) =>
          entry.connectorType === 'tailscale' &&
          entry.paired &&
          entry.paired.onThisMachine &&
          entry.paired.status !== 'disconnected',
      ),
    );
    lines.push('', await deps.tailscaleReach(enabled));
  }
  return lines.join('\n');
}

/**
 * offer_connector: one card, one tool, the turn paused on it. The server
 * owns the card's consequence line; the agent supplies only its reason.
 */
export async function offerConnector(
  args: JsonObject,
  deps: ConnectorOfferDeps = connectorOfferDepsFromEnv(),
): Promise<string> {
  const connectorType = stringArg(args, 'connectorType');
  if (!isOfferableConnectorKind(connectorType)) {
    throw new Error(
      `connectorType must be one of ${OFFERABLE_CONNECTOR_KINDS.join(', ')} (see connectors_status)`,
    );
  }
  const reason = stringArg(args, 'reason')?.trim().replace(/\s+/g, ' ');
  if (!reason) throw new Error('reason must be a non-empty string');
  if (reason.length > CONNECTOR_OFFER_REASON_MAX_LENGTH) throw new Error('reason is too long');
  const intent = stringArg(args, 'intent');
  if (intent !== undefined && intent !== 'switch') throw new Error('intent must be "switch" when given');
  const result = await deps.execute('offerConnector', {
    roomId: deps.roomId,
    connectorType,
    reason,
    ...(intent ? { intent } : {}),
  });
  const offerId = typeof result.offerId === 'string' ? result.offerId : 'unknown';
  const joined = result.joined === true;
  if (intent === 'switch')
    return (
      `${joined ? 'already offered, card still open' : 'pending, card posted'}: switch ${connectorType} account [offer ${offerId}]. ` +
      'Tapping it opens a fresh Google sign-in that replaces the account it uses now; your turn is paused on this card. ' +
      'In prose, say that you are waiting for them to sign in with the account they want, then end your turn now; you will be woken once the new sign-in is connected.'
    );
  return (
    `${joined ? 'already offered, card still open' : 'pending, card posted'}: add ${connectorType} [offer ${offerId}]. ` +
    'The person you addressed, or a Workspace admin, can accept it with the one action on the card; ' +
    'your turn is paused on this offer. In prose, say what you learned about the tool and that you are waiting for them to add it, then end your turn now; ' +
    'you will be woken when it is added. Do not ask them to open Settings or the Connectors page — the card is the whole ask.'
  );
}

function choiceOptionArgs(args: JsonObject): Array<{
  label: string;
  consequence: string;
  costly?: boolean;
}> {
  if (!Array.isArray(args.options)) throw new Error('options must be an array');
  return args.options.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('choice option is invalid');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.label !== 'string' || !entry.label.trim()) {
      throw new Error('choice option label is required');
    }
    if (typeof entry.consequence !== 'string' || !entry.consequence.trim()) {
      throw new Error('choice option consequence is required');
    }
    return {
      label: entry.label,
      consequence: entry.consequence,
      ...(entry.costly === true ? { costly: true } : {}),
    };
  });
}

/** ask_choice: optional lettered question; the turn is not paused. */
export async function askChoice(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('askRoomChoice', {
    roomId: deps.roomId,
    ...(typeof args.ask === 'string' ? { ask: args.ask } : {}),
    prompt: args.prompt,
    ...(typeof args.constraint === 'string' ? { constraint: args.constraint } : {}),
    options: choiceOptionArgs(args),
    ...(typeof args.ttl === 'number' ? { ttlSeconds: args.ttl } : {}),
  });
  const choiceId = typeof result.choiceId === 'string' ? result.choiceId : 'unknown';
  return (
    `posted [${choiceId}] · not paused · Skip or an option will wake you if you end this turn waiting. ` +
    'You may continue without the answer. A pick is a preference, never sandbox, spend, merge, or branch authority.'
  );
}

/** open_poll: Room/corner only; a plurality is a fact, never a mandate. */
export async function openPoll(
  args: JsonObject,
  deps: AgentGrantDeps = agentGrantDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('openRoomPoll', {
    roomId: deps.roomId,
    prompt: args.prompt,
    ...(typeof args.constraint === 'string' ? { constraint: args.constraint } : {}),
    options: choiceOptionArgs(args),
    ttlSeconds: args.ttl,
  });
  const choiceId = typeof result.choiceId === 'string' ? result.choiceId : 'unknown';
  const electorate =
    typeof result.electorateCount === 'number' ? result.electorateCount : undefined;
  const closesAt =
    typeof result.closesAt === 'number'
      ? new Date(result.closesAt * 1000).toISOString()
      : undefined;
  return (
    `posted [${choiceId}] · electorate ${electorate ?? 'n'} · closes at ${closesAt ?? 'deadline'}. ` +
    'Not paused. A plurality is a preference fact: it does not grant sandbox reach, spend, merge, or branch-target authority. ' +
    'A tie or no votes means do not pick.'
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
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((word) => typeof word === 'string' && word)
  ) {
    throw new Error('argv must be a non-empty array of words');
  }
  const result = await deps.run({ roomId: deps.roomId, argv: argv as string[] });
  const grantId = typeof result.grantId === 'string' ? result.grantId : 'unknown';
  const verdict =
    result.sandboxFailure === true
      ? 'sandbox failed before command start'
      : result.timedOut === true
        ? 'timed out after 10 minutes'
        : typeof result.exitCode === 'number'
          ? `exit ${result.exitCode}`
          : `did not start${typeof result.signal === 'string' ? ` (${result.signal})` : ''}`;
  const output = typeof result.output === 'string' && result.output ? result.output : '(no output)';
  const refused =
    result.writeRefused === true
      ? '\nThis Room is read-only outside your scratch directory. Open a corner with open_corner to change files; for host work there, ask with request_grant(kind:command, target, reason, purpose), then use run_granted_command.'
      : '';
  const recovery = result.sandboxFailure === true
    ? '\nFor host work, open a corner and ask with request_grant(kind:command, target, reason, purpose), then use run_granted_command.'
    : '';
  return `ran under grant ${grantId}: ${verdict}\n${output}${refused}${recovery}`;
}

/** The small-object pass-through: the server validates and streams the
 *  bytes to storage in one step and answers with the stored artifact url. */
async function daemonUploadArtifact(
  bytes: Buffer,
  mime: string,
  title: string,
): Promise<DaemonArtifactUploadResult> {
  const baseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  const response = await fetch(new URL('/v1/daemon/artifacts', `${baseUrl}/`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}`,
      'content-type': mime,
      'x-artifact-title': encodeArtifactTitleHeader(title),
      'x-beeline-helper-version': process.env.BEELINE_HELPER_VERSION || 'v0.0.0',
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
    throw new Error(`artifact upload failed (${response.status}: ${code})`);
  }
  const body = (await response.json()) as JsonObject;
  return {
    url: typeof body.url === 'string' ? body.url : '',
    mimeType: typeof body.mimeType === 'string' ? body.mimeType : mime,
    size: typeof body.size === 'number' ? body.size : bytes.length,
    title: typeof body.title === 'string' ? body.title : title,
  };
}

function advertisedAgentTool(name: string): ToolDefinition {
  const tool = agentToolsFor(true, process.env.BEELINE_AGENT_DM === '1', Boolean(process.env.BEELINE_DAEMON_CORNER_ID), process.env.BEELINE_CORNER_REPOSITORY === '1', Boolean(process.env.BEELINE_GRANT_RUNNER_URL), true, process.env.BEELINE_NATIVE_IO_PROVEN === '1').find(tool => tool.name === name);
  if (!tool) throw new Error(`unknown or unavailable tool: ${name}; use only advertised tools`);
  return tool;
}
function validateToolInput(tool: ToolDefinition, args: JsonObject): void {
  const requestedAction = args.action;
  if (tool.name === 'search' && typeof args.query === 'string'
    && [...args.query].length > INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS) {
    throw new Error(`search: query: at most ${INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS} characters`);
  }
  if (!Check(tool.inputSchema, args)) {
    if (tool.name === 'search') {
      const properties = asObject(tool.inputSchema.properties);
      const required = new Set(tool.inputSchema.required as string[] | undefined);
      const details = Object.entries(properties).flatMap(([field, rawSchema]) => {
        if (args[field] === undefined) return required.has(field) ? [`${field}: required`] : [];
        const rule = asObject(rawSchema);
        if (Check(rule, args[field])) return [];
        if (Array.isArray(rule.enum)) return [`${field}: expected one of ${(rule.enum as string[]).join(', ')}`];
        if (field === 'query') return [`${field}: expected a non-whitespace string of 1–500 characters without NUL`];
        if (field === 'limit') return [`${field}: expected an integer from ${rule.minimum} to ${rule.maximum}`];
        return [`${field}: invalid value`];
      });
      const extra = Object.keys(args).filter(field => !Object.hasOwn(properties, field));
      if (extra.length) details.push(`unknown fields: ${extra.join(', ')}; allowed fields: ${Object.keys(properties).join(', ')}`);
      throw new Error(`search: invalid arguments; ${details.join('; ')}; follow the advertised schema`);
    }
    if (tool.name === 'request_grant') {
      const properties = asObject(tool.inputSchema.properties);
      const branches = tool.inputSchema.anyOf as JsonObject[];
      const branch = branches.find(schema => Check(asObject(asObject(schema.properties).action), requestedAction ?? 'request'));
      const required = new Set([
        ...(tool.inputSchema.required as string[]),
        ...((branch?.required as string[] | undefined) ?? []),
      ]);
      // Build diagnostics from the advertised schema only, never request values.
      const details = Object.entries(properties).flatMap(([field, schema]) => {
        if (args[field] === undefined && !required.has(field)) return [];
        const rule = asObject(schema);
        if (Check(rule, args[field])) return [];
        const expectation = [
          rule.enum ? `one of ${(rule.enum as string[]).join(', ')}` : rule.type,
          rule.minLength !== undefined ? `at least ${rule.minLength} characters` : undefined,
          rule.maxLength !== undefined ? `at most ${rule.maxLength} characters` : undefined,
          rule.minimum !== undefined ? `at least ${rule.minimum}` : undefined,
        ].filter(Boolean).join(', ');
        return [`${field}: expected ${expectation}`];
      });
      if (Object.keys(args).some(field => !Object.hasOwn(properties, field)))
        details.push('input: expected only advertised fields');
      throw new Error(`${tool.name}: invalid arguments; ${details.join('; ')}; follow the advertised schema`);
    }
    const required = tool.inputSchema.required as string[] | undefined;
    const missing = required?.filter(field => args[field] === undefined);
    const extra = Object.keys(args).filter(field => !(field in asObject(tool.inputSchema.properties)));
    const branches = tool.name === 'revise_corner'
      ? (tool.inputSchema.allOf as JsonObject[])[0]!.anyOf
      : tool.inputSchema.anyOf;
    const diagnosticSchema = tool.name === 'wake' || tool.name === 'revise_corner'
      ? { ...tool.inputSchema, allOf: undefined, anyOf: (branches as JsonObject[]).filter(schema => {
        const action = asObject(schema.properties).action;
        return !action || Check(action, requestedAction);
      }) }
      : tool.inputSchema;
    const details = tool.name === 'wake' || tool.name === 'revise_corner' || tool.name === 'search'
      ? Errors(diagnosticSchema, args).filter(error => error.keyword !== 'anyOf')
        .map(error => `${error.instancePath || 'input'}: ${error.message}`).join('; ')
      : '';
    throw new Error(`${tool.name}: invalid arguments${details ? `; ${details}` : ''}${missing?.length ? `; required: ${missing.join(', ')}` : ''}${extra.length ? `; unknown fields: ${extra.join(', ')}` : ''}; follow the advertised schema`);
  }
}

// MCP requests may run concurrently. Register artifact work before the first
// await so an immediately following report cannot overtake its upload/queue.
let turnArtifacts: { key: string; uploads: Promise<string>[] } | undefined;

export async function callAgentTool(name: string, args: JsonObject, toolCallId: string): Promise<string> {
  if (name !== 'post_artifact' && name !== 'report') return executeAgentTool(name, args, toolCallId);
  const contextFile = process.env.BEELINE_TURN_CONTEXT_FILE;
  const context = contextFile ? JSON.parse(readFileSync(contextFile, 'utf8')) as Record<string, unknown> : {};
  const key = JSON.stringify([process.env.BEELINE_DAEMON_BASE_URL, process.env.BEELINE_DAEMON_ROOM_ID,
    context.roomId, context.requestId, context.generationId]);
  if (turnArtifacts?.key !== key) turnArtifacts = { key, uploads: [] };
  const artifacts = turnArtifacts;
  if (name === 'post_artifact') {
    const upload = executeAgentTool(name, args, toolCallId);
    artifacts.uploads.push(upload);
    // Keep failures for report even when the caller has already observed them.
    void upload.catch(() => {});
    return upload;
  }
  await Promise.all(artifacts.uploads);
  return executeAgentTool(name, args, toolCallId);
}

/** Execute only the advertised vocabulary; internal operations retain server authority. */
async function executeAgentTool(name: string, args: JsonObject, toolCallId: string): Promise<string> {
  if (process.env.BEELINE_TURN_CONTEXT_FILE && (await readTurnContextFile()).terminalReason)
    throw new Error('turn has ended; further tool calls are refused');
  if (name === 'read' && args.cursor !== undefined &&
      (!args.cursor || typeof args.cursor !== 'object' || Array.isArray(args.cursor)))
    throw new Error('read: pass the returned next object unchanged as cursor');
  validateToolInput(advertisedAgentTool(name), args);
  const addressed = { ...args, ...(typeof args.address === 'string' ? { cornerId: args.address } : {}) };
  const execute = (operation: string, input = args) => executeAgentOperation(operation, input, toolCallId);
  switch (name) {
    case 'read': {
      const facet = args.facet;
      const requiredField = facet === 'message' ? 'messageId' : facet === 'attachment' ? 'attachmentId' : facet === 'procedure' ? 'slug' : undefined;
      if (requiredField && !args[requiredField]) throw new Error(`read: ${requiredField} is required for facet ${facet}`);
      const address = args.address ?? (process.env.BEELINE_DAEMON_CORNER_ID?.trim() || process.env.BEELINE_DAEMON_ROOM_ID);
      const input = { ...args, ...asObject(args.cursor), address, cornerId: address };
      switch (facet) {
        case 'addresses': return execute('list_rooms', input);
        case 'corners': return execute('list_corners', input);
        case 'members': return execute('list_room_members', input);
        case 'messages':
          // Every message read uses the same bounded cursor contract.
          return execute('inspect_corner', { ...input, from: args.from ?? (asObject(args.cursor).before ? 'newest' : undefined), mode: 'transcript' });
        case 'message': return execute('get_room_message', { ...input, messageId: args.messageId });
        case 'attachment': return execute('download_attachment', input);
        case 'brief': return execute('read_corner_brief', input);
        case 'status': return execute('inspect_corner', { ...input, mode: 'status' });
        case 'checks': return execute('pr_checks_status', input);
        case 'pr': return execute('read_pull_request', input);
        case 'procedure': return execute('load_workspace_skill', { ...input, slug: args.slug });
        case 'usage': return execute('read_agent_usage', {});
        default: throw new Error('unknown read facet');
      }
    }
    case 'search': {
      if (args.scope !== 'history' && args.scope !== 'memory') throw new Error('scope must be history or memory');
      return execute(args.scope === 'history' ? 'search_history' : 'search_memory');
    }
    case 'remember': {
      const routes: Record<string, Record<string, string>> = {
        fact: { save: 'save_memory', update: 'update_memory', delete: 'delete_memory', used: 'report_memory_used' },
        procedure: { save: 'save_skill', delete: 'delete_skill' },
      };
      const operation = routes[String(args.kind)]?.[String(args.action)];
      if (!operation) throw new Error('unknown remember kind/action');
      return execute(operation);
    }
    case 'revise_corner': {
      if (args.action === 'metadata' || args.action === 'install_brief') return execute('rename_corner', addressed);
      if (args.action !== 'brief') throw new Error('action must be metadata or brief');
      const input = { ...addressed, ...asObject(args.brief) };
      return execute('revise_corner_brief', input);
    }
    case 'report':
    case 'report_feedback':
    case 'notify_feedback_fixed':
    case 'send_operator_system_dm':
    case 'read_operator_system_dm': return execute(name);
    case 'dispatch_release': return execute(name);
    case 'approve_merge':
    case 'merge_corner':
    case 'set_corner_hold':
    case 'post':
    case 'close_corner': return execute(name, addressed);
    case 'record_merge_yes': return execute('order_corner_merge', addressed);
    case 'close_corner_pr': return execute('close_pull_request', addressed);
    case 'request_grant':
      if (args.action === 'list') return execute('list_grants');
      if (args.action !== undefined && args.action !== 'request') throw new Error('action must be request or list');
      return execute(name);
    case 'connect': {
      const builtin = builtinBeelineApp(String(args.service ?? args.query ?? ''),
        `${args.reason ?? ''} ${args.continuation ?? ''}`);
      const capabilities = builtin || args.mode === 'discover' || args.mode === 'status'
        ? await availableCapabilities(!builtin || builtin === 'beeline:onboarding') : [];
      if (builtin === 'beeline:onboarding' && !capabilities.includes(builtin))
        return JSON.stringify({ status: 'unavailable', app: builtin, next: 'Repository cards are unavailable on this surface. Use an active Room with current members and retry the repository card.' });
      if (builtin && capabilities.includes(builtin) && (args.mode === undefined || ['status', 'ensure', 'discover'].includes(String(args.mode))))
        return JSON.stringify({ status: 'ready', app: builtin,
          next: `Use app_tool(app:${builtin}) to discover its tools. Existing tool permissions still apply.` });
      if (builtin && !capabilities.includes(builtin))
        return JSON.stringify({ status: 'unavailable', app: builtin, next: placeRefusal(builtin) });
      if (args.mode === 'status') return JSON.stringify({ readiness: await execute('connectors_status'), capabilities });
      if (args.mode === 'discover') return JSON.stringify({ integrations: args.query ? JSON.parse(await execute('find_connectors')) : [], capabilities });
      if (args.mode !== undefined && args.mode !== 'ensure') throw new Error('mode must be discover, status or ensure');
      return execute(name);
    }
    case 'app_tool': {
      const app = String(args.app ?? '');
      if (app.startsWith('beeline:')) {
        const capability = app.slice('beeline:'.length);
        if (!(await availableCapabilities(app === 'beeline:onboarding')).includes(app)) throw new Error(placeRefusal(app));
        const routes = CAPABILITY_ROUTES[capability]!;
        if (args.tool === undefined) return JSON.stringify({ app, tools: Object.entries(routes).map(([action]) => {
          const definition = CAPABILITY_TOOLS[capability]![action]!;
          return { ...definition, name: action, description: definition.description };
        }) });
        const operation = routes[String(args.tool)];
        if (!operation) throw new Error('unknown capability operation; discover its schema first');
        const input = { ...asObject(args.args) };
        const definition = CAPABILITY_TOOLS[capability]![String(args.tool)]!;
        validateToolInput(definition, input);
        if (capability === 'workflow' && args.tool === 'rebind') { input.agentId = input.agent; delete input.agent; }
        return execute(operation, input);
      }
      return args.tool === undefined
        ? execute('list_app_tools', { appId: app, query: args.query })
        : execute('execute_app_tool', { appId: app, tool: args.tool, arguments: args.args });
    }
    case 'scratch_io': {
      if (process.env.BEELINE_NATIVE_IO_PROVEN === '1') throw new Error('native IO is available');
      const operation = SCRATCH_ROUTES[String(args.action)];
      if (!operation) throw new Error('unknown scratch_io action');
      return execute(operation);
    }
    case 'wake': {
      if (args.action === 'delete' && args.trigger === undefined && args.scheduleId !== undefined)
        args = { ...args, trigger: 'schedule' };
      // Explicit allowlist: no payload can select an arbitrary daemon operation or recipient.
      const allowed = new Set(['action', 'trigger', 'address', 'scheduleId', 'subscriptionId', 'prompt', 'cadence', 'maxRuns', 'title', 'when', 'workflowName', 'source', 'event', 'repository', 'channelId', 'channelName', 'kinds']);
      if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('wake only manages this agent’s own wake sources');
      if (args.trigger !== 'lifecycle' && args.address !== undefined) throw new Error('address is only supported for lifecycle wakes; schedules and events belong to this place');
      if (args.trigger === 'lifecycle' && !args.address) throw new Error('lifecycle wake requires address');
      const roomId = agentScheduleRoomId();
      const deps = { ...agentScheduleDepsFromEnv(), selfOnly: true };
      if (args.action === 'list') {
        const [schedules, subscriptions, watches, events] = await Promise.all([
          daemonExecute('listAgentSchedules', { roomId, selfOnly: true }),
          daemonExecute('listAgentSubscriptions', { roomId }),
          daemonExecute('listAgentWatches', { roomId }),
          daemonExecute('listEventSubscriptions', { roomId }),
        ]);
        return JSON.stringify({ ...schedules, subscriptions, ...watches, events });
      }
      if (args.action === 'events') return JSON.stringify({ room: SUBSCRIBABLE_EVENT_KINDS,
        repository: REPOSITORY_SUBSCRIPTION_EVENTS,
        service: await daemonExecute('listServiceSubscriptionEvents', { roomId }) });
      if (args.action === 'replace_events') return subscribeEvents(args, deps);
      if (args.trigger === 'schedule') {
        if (args.action === 'create') return createSchedule(args, deps);
        if (args.action === 'update') return updateSchedule(args, deps);
        if (args.action === 'delete') return deleteSchedule(args, deps);
      }
      if (args.trigger === 'event') {
        if (args.action === 'create') return execute('create_subscription');
        if (args.action === 'delete') return execute('delete_subscription');
      }
      if (args.trigger === 'lifecycle') {
        if (args.action === 'create') return execute('watch');
        if (args.action === 'delete') return JSON.stringify(await daemonExecute('watchCorner', { roomId, cornerId: args.address, kinds: [] }));
      }
      throw new Error('unknown wake action/trigger');
    }
    case 'order':
    case 'open_corner':
    case 'post_artifact':
    case 'react_to_message':
    case 'run_granted_command':
    case 'no_reply_needed': return execute(name);
    default: throw new Error(`unknown tool: ${name}; use only tools/list names`);
  }
}

async function availableCapabilities(checkOnboarding = true): Promise<string[]> {
  let onboarding = false;
  try {
    if (checkOnboarding) {
      const state = await daemonExecute('getRoomRepositoryState', { roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID') });
      onboarding = state.repositoryOnboarding === true;
    }
  } catch { /* Missing server eligibility always leaves the feature dark. */ }

  return placeBeelineApps(Boolean(process.env.BEELINE_DAEMON_CORNER_ID), onboarding);
}

/** The refusal for a Beeline app that does not work here names the apps that do. */
function placeRefusal(app: string): string {
  const here = placeBeelineApps(Boolean(process.env.BEELINE_DAEMON_CORNER_ID)).join(', ');
  return app === 'beeline:corner_app'
    ? `${app} works only in a corner; use it there. Beeline apps here: ${here}.`
    : `${app} ${app.slice('beeline:'.length) in CAPABILITY_ROUTES ? 'is unavailable in this place' : 'is not a Beeline app'}. Beeline apps here: ${here}.`;
}

async function executeAgentOperation(
  name: string, args: JsonObject, toolCallId: string,
): Promise<string> {
  if (process.env.BEELINE_TURN_CONTEXT_FILE && (await readTurnContextFile()).terminalReason)
    throw new Error('turn has ended; further tool calls are refused');
  switch (name) {
    case 'get_room_message': {
      const message = await daemonExecute('getRoomMessage', {
        roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        messageId: args.messageId,
        ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
      });
      const attachments = (message.attachments ?? []) as DaemonAttachment[];
      if (!attachments.length) return JSON.stringify(message);
      const scratch = process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim();
      const delivered = scratch
        ? withoutImageData(
            await deliverAttachments(
              attachments,
              join(
                scratch,
                'beeline-attachments',
                createHash('sha256').update(String(message.messageId)).digest('hex'),
              ),
            ),
          )
        : attachments.map((attachment) => ({
            attachment,
            reason: 'download failed: no session scratch directory',
          }));
      return JSON.stringify({
        ...message,
        attachments: delivered.map(({ attachment, ...local }) => ({
          ...attachment,
          ...(attachmentId(attachment) ? { id: attachmentId(attachment) } : {}),
          ...local,
        })),
      });
    }
    case 'download_attachment':
      return downloadAttachment(args);
    case 'load_workspace_skill': {
      // Workspace procedures retain precedence over shipped skills with the same slug.
      try {
        return JSON.stringify(await daemonExecute('loadWorkspaceSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
        }));
      } catch (error) {
        // Only a missing procedure falls back; authorization and service failures stay visible.
        if (!(error instanceof Error) || !error.message.startsWith('daemon operation loadWorkspaceSkill failed (404:'))
          throw error;
        const skill = beelineManagedSkills(runningBeelineReleaseId(), { isReviewer: true })
          .find((candidate) => candidate.name === args.slug);
        if (!skill) throw error;
        return JSON.stringify({ slug: skill.name, markdown: skill.content, source: 'built-in' });
      }
    }
    case 'save_skill':
      return JSON.stringify(
        await daemonExecute('saveSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
          description: args.description,
          markdown: args.markdown,
        }),
      );
    case 'delete_skill':
      return JSON.stringify(
        await daemonExecute('deleteSkill', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          slug: args.slug,
          version: args.version,
          sourceMessageIds: memorySources(args),
        }),
      );
    case 'save_workflow':
      return JSON.stringify(
        await daemonExecute('saveWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          contract: args.contract,
        }),
      );
    case 'start_workflow':
      return JSON.stringify(
        await daemonExecute('startWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          name: args.name,
          roleBindings: args.roleBindings,
        }),
      );
    case 'get_workflow_run':
      return JSON.stringify(await daemonExecute('getWorkflowRun', {
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        roomId: agentScheduleRoomId(),
        runId: args.runId,
      }));
    case 'cancel_workflow_run':
      return JSON.stringify(await daemonExecute('cancelWorkflowRun', {
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        roomId: agentScheduleRoomId(),
        runId: args.runId,
        reason: args.reason,
      }));
    case 'handoff':
      return JSON.stringify(
        await daemonExecute('handoff', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          runId: args.runId,
          outcome: args.outcome,
          contents: args.contents,
          ...(args.receipt !== undefined ? { receipt: args.receipt } : {}),
          ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
        }),
      );
    case 'archive_workflow':
      return JSON.stringify(
        await daemonExecute('archiveWorkflow', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          name: args.name,
        }),
      );
    case 'assign_workflow_role':
      return JSON.stringify(
        await daemonExecute('assignWorkflowRole', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          runId: args.runId,
          role: args.role,
          targetAgentId: args.agentId,
        }),
      );
    case 'search_history':
      return JSON.stringify(
        await daemonExecute('searchInstitutionalHistory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          query: args.query,
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'search_memory':
      return JSON.stringify(
        await daemonExecute('searchInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          query: args.query,
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'report_feedback':
      return reportFeedback(args);
    case 'notify_feedback_fixed':
      return JSON.stringify(
        await daemonExecute('notifyFeedbackFixed', {
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemIds: Array.isArray(args.item_ids) ? args.item_ids : [],
          title: String(args.title ?? ''),
          prUrl: String(args.pr_url ?? ''),
          ...(typeof args.notify === 'boolean' ? { notify: args.notify } : {}),
        }),
      );
    case 'save_memory':
      return JSON.stringify(
        await daemonExecute('saveInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          memoryKind: args.subject_is_requester ? 'human_profile_fact' : 'workspace_fact',
          canonicalKey: args.canonical_key,
          body: args.body,
          keywords: Array.isArray(args.keywords) ? args.keywords : [],
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
          confidence: args.confidence,
        }),
      );
    case 'update_memory':
      return JSON.stringify(
        await daemonExecute('updateInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemId: args.item_id,
          version: args.version,
          body: args.body,
          ...(Array.isArray(args.keywords) ? { keywords: args.keywords } : {}),
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
        }),
      );
    case 'delete_memory':
      return JSON.stringify(
        await daemonExecute('deleteInstitutionalMemory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemId: args.item_id,
          version: args.version,
          reason: args.reason,
          sourceMessageIds: memorySources(args),
          personAsked: args.person_asked,
        }),
      );
    case 'report_memory_used':
      return JSON.stringify(
        await daemonExecute('reportInstitutionalMemoryUsed', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          itemIds: Array.isArray(args.item_ids) ? args.item_ids : [],
          snapshotItems: Array.isArray(args.snapshot_items) ? args.snapshot_items : [],
        }),
      );
    case 'wallet_address':
      return JSON.stringify(
        await daemonExecute('getWalletToolState', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_balance':
      return JSON.stringify(
        await daemonExecute('getWalletToolBalance', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_chains':
      return JSON.stringify(
        await daemonExecute('getWalletToolChains', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
        }),
      );
    case 'wallet_history':
      return JSON.stringify(
        await daemonExecute('getWalletToolHistory', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.limit === 'number' ? { limit: Math.floor(args.limit) } : {}),
        }),
      );
    case 'wallet_quote':
      return JSON.stringify(
        await daemonExecute('getWalletToolQuote', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_pay':
      return JSON.stringify(
        await daemonExecute('walletPay', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          asset: String(args.asset ?? 'usdc'),
          amount: String(args.amount ?? ''),
          to: String(args.to ?? ''),
        }),
      );
    case 'wallet_swap':
      return JSON.stringify(
        await daemonExecute('walletSwap', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          ...(typeof args.chain === 'string' ? { chain: args.chain } : {}),
          fromAsset: String(args.fromAsset ?? 'usdc'),
          toAsset: String(args.toAsset ?? 'eth'),
          amount: String(args.amount ?? ''),
        }),
      );
    case 'wallet_contract_call': {
      const approve = args.approve as JsonObject | undefined;
      return JSON.stringify(
        await daemonExecute('walletContractCall', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          chain: String(args.chain ?? ''),
          contract: String(args.contract ?? ''),
          data: String(args.data ?? ''),
          ...(typeof args.value === 'string' ? { value: args.value } : {}),
          ...(approve && typeof approve === 'object'
            ? { approve: { asset: String(approve.asset ?? ''), amount: String(approve.amount ?? '') } }
            : {}),
        }),
      );
    }
    case 'wallet_sign_typed_data':
      return JSON.stringify(
        await daemonExecute('walletSignTypedData', {
          agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
          roomId: agentScheduleRoomId(),
          domain: args.domain,
          types: args.types,
          primaryType: args.primaryType,
          message: args.message,
        }),
      );
    case 'set_corner_hold':
      return JSON.stringify(
        await daemonExecute('setCornerHold', {
          ...await activeCommandContext(),
          cornerId: typeof args.cornerId === 'string'
            ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID'),
          ...(args.releaseHoldId !== undefined ? { releaseHoldId: args.releaseHoldId } : {}),
        }),
      );
    case 'send_operator_system_dm':
      return JSON.stringify(await daemonExecute('sendOperatorSystemDm', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        recipients: args.recipients as string | string[], text: String(args.text ?? ''),
      }));
    case 'read_operator_system_dm':
      return JSON.stringify(await daemonExecute('readOperatorSystemDm', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'), sendId: String(args.sendId ?? ''),
      }));
    case 'order_corner_merge':
      return JSON.stringify(
        await daemonExecute('orderCornerMerge', {
          ...await activeCommandContext(),
          cornerId: typeof args.cornerId === 'string'
            ? args.cornerId : requiredEnv('BEELINE_DAEMON_CORNER_ID'),
        }),
      );
    case 'open_corner':
      return openCorner(args, toolCallId);
    case 'revise_corner_brief':
      return reviseCornerBrief(args);
    case 'read_corner_brief':
      return readCornerBrief(args);
    case 'read_agent_usage': {
      // The server answers only for the token's own agent; no provider is called here.
      const usage = readAgentUsage(
        await daemonExecute('getAgentUsage', { agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID') }),
      );
      return JSON.stringify({
        summary: usageSummary(usage),
        ...(usage ? { usage, old: usageIsOld(usage) } : {}),
      });
    }
    case 'order': {
      const named = namedPrivateFiles(attachRootsFromEnv(), String(args.text ?? ''));
      if (named.length)
        throw new Error(
          `the order names ${named.map((file) => file.named).join(', ')}, which only you can open; ` +
            `attach each to the corner brief with revise_corner brief.attachments [{path, purpose, required}], ` +
            `or name a repository file by its repository-relative path`,
        );
      const result = await daemonExecute('order', { address: args.address as string, text: args.text as string, agent: args.agent as string | undefined });
      return JSON.stringify(result);
    }
    case 'no_reply_needed': {
      await activeCommandContext();
      const { commandReason } = await readTurnContextFile();
      if (!nonhumanSilentWake(commandReason)) throw new Error('no_reply_needed requires a nonhuman report, order, lifecycle, scheduler or system wake');
      await daemonExecute('markAgentTurnSilent', {});
      // The helper drains in-flight activity and drafts before its terminal receipt.
      // Completing here revokes authority while those writes are still running.
      const path = requiredEnv('BEELINE_TURN_CONTEXT_FILE');
      const context = await readTurnContextFile();
      writeFileSync(path, JSON.stringify({ ...context, terminalReason: 'no-reply' }), { mode: 0o600 });
      return JSON.stringify({ acknowledged: true });
    }
    case 'report':
      return JSON.stringify(await daemonExecute('report', { status: args.status as import('@beeline/api-contract/daemon').AgentReportStatus, text: args.text as string, ask: args.ask as string | undefined }));
    case 'read':
      return JSON.stringify(await daemonExecute('read', { address: args.address as string, limit: args.limit as number | undefined }));
    case 'inspect_corner': {
      if (typeof args.cornerId !== 'string' || !args.cornerId)
        throw new Error('cornerId is required');
      if (args.after !== undefined && (typeof args.after !== 'string' || !args.after))
        throw new Error('after must be a nonempty cursor');
      if (args.mode !== undefined && args.mode !== 'status' && args.mode !== 'transcript')
        throw new Error('mode must be status or transcript');
      if (args.after && args.mode !== 'transcript')
        throw new Error('after requires transcript mode');
      if (args.from !== undefined && args.from !== 'oldest' && args.from !== 'newest')
        throw new Error('from must be oldest or newest');
      if (args.from !== undefined && args.mode !== 'transcript')
        throw new Error('from requires transcript mode');
      if (args.before !== undefined && (typeof args.before !== 'string' || !args.before))
        throw new Error('before must be a nonempty cursor');
      if (args.before && args.from !== 'newest') throw new Error('before requires from newest');
      if (args.from === 'newest' && (args.after || args.offset !== undefined))
        throw new Error('from newest pages with before, not after or offset');
      if (
        args.offset !== undefined &&
        (!Number.isSafeInteger(args.offset) ||
          (args.offset as number) < 0 ||
          args.mode !== 'transcript')
      )
        throw new Error('offset requires transcript mode and a nonnegative safe integer');
      // The server authorizes each read against the target corner: a member of
      // the corner or of its parent Room reaches it; anyone else is refused.
      if (args.mode === 'transcript' && args.from === 'newest') {
        const page = (await daemonExecute('getRoomConversation', {
          roomId: args.cornerId,
          limit: 9,
          window: 'recent',
          ...(args.before ? { before: args.before } : {}),
        })) as unknown as RoomConversationResult;
        // Walk back from the newest message; return the kept rows in transcript order.
        const items: Record<string, unknown>[] = [];
        for (const item of page.items.slice(-8).reverse()) {
          let body = item.body.slice(0, 1000);
          const row = {
            id: item.id,
            cursor: item.cursor,
            authorId: item.authorId,
            createdAt: item.createdAt,
            type: item.type,
            ...(item.attachments.length ? { attachmentCount: item.attachments.length } : {}),
          };
          while (body && JSON.stringify([...items, { ...row, body }]).length > 11000)
            body = body.slice(0, Math.floor(body.length / 2));
          if (!body && item.body) break;
          items.unshift({
            ...row,
            body,
            ...(body.length < item.body.length ? { bodyContinues: true } : {}),
          });
        }
        const oldest = items[0]?.cursor as string | undefined;
        return JSON.stringify({
          cornerId: args.cornerId,
          items,
          ...(oldest && page.items.length > items.length ? { next: { before: oldest } } : {}),
          limits: { items: 8, bodyChars: 1000, responseChars: 12000 },
        });
      }
      if (args.mode === 'transcript') {
        const page = (await daemonExecute('getRoomConversation', {
          roomId: args.cornerId,
          limit: 9,
          ...(args.after ? { after: args.after } : { window: 'earliest' }),
        })) as unknown as RoomConversationResult;
        const items: Record<string, unknown>[] = [];
        let nextAfter = args.after as string | undefined;
        let nextOffset = args.offset as number | undefined;
        let hasMore = false;
        for (const item of page.items.slice(0, 8)) {
          const offset = nextOffset ?? 0;
          if (offset > item.body.length) throw new Error('offset exceeds message body');
          let body = item.body.slice(offset, offset + 1000);
          const row = {
            id: item.id,
            cursor: item.cursor,
            authorId: item.authorId,
            createdAt: item.createdAt,
            type: item.type,
            ...(offset ? { bodyOffset: offset } : {}),
            ...(item.attachments.length ? { attachmentCount: item.attachments.length } : {}),
          };
          // Escaped control characters can occupy six JSON characters each.
          while (body && JSON.stringify([...items, { ...row, body }]).length > 11000)
            body = body.slice(0, Math.floor(body.length / 2));
          if (!body && item.body.length > offset) {
            hasMore = true;
            break;
          }
          items.push({
            ...row,
            body,
            ...(offset + body.length < item.body.length ? { bodyContinues: true } : {}),
          });
          if (offset + body.length < item.body.length) {
            nextOffset = offset + body.length;
            hasMore = true;
            break;
          }
          nextAfter = item.cursor;
          nextOffset = undefined;
        }
        if (!hasMore) hasMore = page.items.length > items.length;
        return JSON.stringify({
          cornerId: args.cornerId,
          items,
          ...(hasMore
            ? {
                next: {
                  ...(nextAfter ? { after: nextAfter } : {}),
                  ...(nextOffset ? { offset: nextOffset } : {}),
                },
              }
            : {}),
          limits: { items: 8, bodyChars: 1000, responseChars: 12000 },
        });
      }
      const status = (await daemonExecute('getCornerRestoreState', {
        cornerId: args.cornerId,
      })) as unknown as CornerRestoreResult;
      const pr = status.lifecycle?.pr;
      // GitHub can be unavailable while the server-owned lifecycle remains readable.
      const verdict = pr
        ? await daemonExecute('getPrChecksStatus', {
            cornerId: args.cornerId,
            pullRequest: pr.number,
          }).catch(() => undefined)
        : undefined;
      return JSON.stringify({
        cornerId: args.cornerId,
        state: status.state ?? 'unknown',
        lifecycle: status.lifecycle?.lifecycle ?? 'unknown',
        activity: status.activity ?? 'unknown',
        ...(status.awaiting ? { awaiting: status.awaiting } : {}),
        ...(status.lastMessage ? { lastMessage: status.lastMessage } : {}),
        ...(pr ? { pr: { number: pr.number, url: pr.url, title: pr.title } } : {}),
        ...(verdict?.headSha || pr?.headSha ? { headSha: verdict?.headSha ?? pr?.headSha } : {}),
        checks: verdict?.checks ?? status.lifecycle?.checks ?? 'unknown',
        verdict: verdict
          ? {
              stage: verdict.stage,
              approved: verdict.approved,
              held: verdict.held,
              holds: verdict.holds,
              mergeAllowed: verdict.mergeAllowed,
              ...(verdict.blockedReason ? { blockedReason: verdict.blockedReason } : {}),
              reviewer: verdict.reviewer,
              reviewerExists: verdict.reviewerExists,
              reviewerWake: verdict.reviewerWake,
            }
          : { mergeAllowed: false, status: 'unavailable', held: status.held === true, holds: status.holds ?? [] },
        merge: {
          mergeability: pr?.mergeability ?? 'unknown',
          ...(pr?.mergedAt ? { mergedAt: pr.mergedAt } : {}),
        },
      });
    }
    case 'react_to_message':
      return reactToMessage(args);
    case 'close_corner':
      return closeCorner(args);
    case 'pr_checks_status':
      return prChecksStatus(args);
    case 'approve_merge':
      return approveMerge(args);
    case 'dispatch_release':
      return JSON.stringify(await daemonExecute('dispatchRoomWorkflow', {
        ...await activeCommandContext(),
        ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
      }));
    case 'merge_corner':
      return JSON.stringify(
        await daemonExecute('mergeCorner', { cornerId: targetCornerId(args) }),
      );
    case 'close_pull_request':
      return JSON.stringify(
        await daemonExecute('closeCornerPullRequest', { cornerId: targetCornerId(args) }),
      );
    case 'list_rooms':
      return JSON.stringify(await daemonExecute('listRooms', { roomId: agentScheduleRoomId() }));
    case 'list_corners':
      return JSON.stringify(
        await daemonExecute('listReachableCorners', {
          roomId: typeof args.address === 'string' ? args.address : requiredEnv('BEELINE_DAEMON_ROOM_ID'),
          ...(typeof args.activeOnly === 'boolean' ? { activeOnly: args.activeOnly } : {}),
        }),
      );
    case 'list_room_members':
      return JSON.stringify(
        await daemonExecute('listRoomMembers', {
          roomId:
            typeof args.address === 'string' ? args.address : typeof args.cornerId === 'string' && args.cornerId
              ? args.cornerId
              : process.env.BEELINE_DAEMON_CORNER_ID?.trim() ||
                requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        }),
      );
    case 'read_pull_request':
      return JSON.stringify(
        await daemonExecute('readCornerPullRequest', { cornerId: targetCornerId(args) }),
      );
    case 'post': {
      const cornerId = typeof args.cornerId === 'string' && args.cornerId
        ? args.cornerId : process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID');
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000)
        throw new Error('text must contain 1 to 16000 characters');
      return JSON.stringify(
        await daemonExecute('postCornerMessage', { cornerId, text: args.text }),
      );
    }
    case 'write_scratch_file':
      return writeScratchFile(args);
    case 'scratch_status': {
      const root = requiredEnv('BEELINE_CORNER_SCRATCH_ROOT');
      return scratchBudgetMessage(await allocatedDirectoryBytes(root));
    }
    case 'get_avatar':
      return JSON.stringify(
        await daemonExecute('getAgentAvatar', { roomId: agentScheduleRoomId() }),
      );
    case 'set_avatar':
      return JSON.stringify(
        await daemonExecute('postAgentAvatar', {
          roomId: agentScheduleRoomId(),
          drawing: args.drawing,
        }),
      );
    case 'fetch_image':
      return fetchImage(args);
    case 'post_artifact':
      return postArtifact(args);
    case 'share_browser':
      return shareBrowser(args);
    case 'end_browser_share': {
      if (typeof args.sessionId !== 'string' || !args.sessionId.trim())
        throw new Error('A shared browser sessionId is required');
      await daemonExecute('endComputerSession', { roomId: agentScheduleRoomId(), sessionId: args.sessionId });
      return 'Browser share ended';
    }
    case 'publish_corner_app': {
      const cornerId = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
      if (!cornerId) throw new Error('publish_corner_app requires a corner turn');
      const result = await daemonExecute('putCornerApp', {
        cornerId,
        definition: {
          version: 1,
          slug: args.slug,
          title: args.title,
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          command: args.command,
          blocks: args.blocks,
        },
      });
      return `published /${String(args.command)} at revision ${String(result.revision ?? '?')}`;
    }
    case 'open_corner_app': {
      const cornerId = process.env.BEELINE_DAEMON_CORNER_ID?.trim();
      if (!cornerId) throw new Error('open_corner_app requires a corner turn');
      const context = await activeCommandContext();
      const result = await daemonExecute('requestCornerAppOpen', {
        cornerId,
        slug: args.slug,
        requestId: context.requestId,
      });
      return `posted app ${String(result.slug ?? args.slug)} at revision ${String(result.revision ?? '?')}`;
    }
    case 'rename_corner': {
      const cornerId = targetCornerId(args);
      const refusal = args.name === undefined && args.reviewer !== undefined ? null : cornerTextRefusal('name', args.name);
      if (refusal) throw new Error(refusal);
      const result = await daemonExecute('renameCorner', {
        cornerId,
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.reviewer !== undefined ? { reviewer: args.reviewer as string } : {}),
        ...(args.objective !== undefined ? { objective: args.objective } : {}),
        ...(args.brief !== undefined ? { brief: await bindBriefFiles(asObject(args.brief)) } : {}),
      });
      return args.name === undefined ? 'updated the corner reviewer' : `renamed the corner to ${String(result.name)}`;
    }
    case 'create_schedule':
      return createSchedule(args);
    case 'create_subscription': {
      const source = stringArg(args, 'source');
      const event = stringArg(args, 'event');
      const prompt = stringArg(args, 'prompt');
      if (source !== 'room' && source !== 'repository' && source !== 'service' && source !== 'webhook')
        throw new Error('source must be room, repository, service, or webhook');
      if (!event) throw new Error('event is required');
      if (!prompt) throw new Error('prompt is required');
      const result = await daemonExecute('createAgentSubscription', {
        roomId: agentScheduleRoomId(), source, event, prompt,
        title: args.title, when: args.when,
        ...(typeof args.repository === 'string' ? { repository: args.repository } : {}),
        ...(typeof args.channelId === 'string' ? { channelId: args.channelId } : {}),
        ...(typeof args.channelName === 'string' ? { channelName: args.channelName } : {}),
        ...(typeof args.workflowName === 'string' ? { workflowName: args.workflowName } : {}),
      });
      return result.registrationStatus === 'registering'
        ? `Subscription ${String(result.id)} created for ${source} ${event}. The connected helper is registering its webhook; it runs your action once registration completes.`
        : `Subscription ${String(result.id)} created for ${source} ${event}. It runs your action when the event arrives.`;
    }
    case 'list_subscriptions':
      return JSON.stringify(await daemonExecute('listAgentSubscriptions', { roomId: agentScheduleRoomId() }));
    case 'list_subscription_events': {
      const result = await daemonExecute('listServiceSubscriptionEvents', { roomId: agentScheduleRoomId() });
      return JSON.stringify(result);
    }
    case 'delete_subscription': {
      const subscriptionId = stringArg(args, 'subscriptionId');
      if (!subscriptionId) throw new Error('subscriptionId is required');
      await daemonExecute('deleteAgentSubscription', { roomId: agentScheduleRoomId(), subscriptionId });
      return `Subscription ${subscriptionId} stopped.`;
    }
    case 'subscribe_events':
      return subscribeEvents(args);
    case 'set_wake_delivery':
      return setWakeDelivery(args);
    case 'get_wake_delivery':
      return JSON.stringify(await daemonExecute('getWakeDelivery', { roomId: agentScheduleRoomId() }));
    case 'watch': {
      const deps = agentScheduleDepsFromEnv();
      const result = await deps.execute('watchCorner', {
        roomId: deps.roomId,
        cornerId: args.address,
        kinds: ['opened', 'merged'],
      });
      const kinds = (result.kinds as string[]).join(', ');
      const headline =
        result.state === 'merged'
          ? `Corner already merged${result.woken ? '; one merged wake queued now' : '; no new wake (already delivered)'}`
          : result.state === 'closed'
            ? 'Corner closed without merging; nothing to watch'
            : kinds
              ? `Watching for ${kinds}`
              : 'Watch removed';
      return `${headline}\n${JSON.stringify(result.snapshot, null, 2)}`;
    }
    case 'list_event_subscriptions':
      return listEventSubscriptions();
    case 'emit_event':
      return emitEvent(args);
    case 'list_schedules':
      return listSchedules();
    case 'update_schedule':
      return updateSchedule(args);
    case 'delete_schedule':
      return deleteSchedule(args);
    case 'request_grant':
      return requestGrant(args);
    case 'request_shared_asset_isolation':
      return requestSharedAssetIsolation(args);
    case 'list_grants':
      return listGrants();
    case 'store_secret':
      return storeSecret(args);
    case 'connectors_status':
    case 'workbench_status':
      return workbenchStatus();
    case 'create_link_spend_request': {
      const context = await activeCommandContext();
      const merchant = stringArg(args, 'merchant')?.trim();
      const merchantUrl = stringArg(args, 'merchantUrl')?.trim();
      const description = stringArg(args, 'description')?.trim();
      const amount = args.amount;
      if (!merchant || (args.credentialType !== 'shared_payment_token' && !merchantUrl)
        || !description || typeof amount !== 'number'
        || !Number.isSafeInteger(amount) || amount <= 0)
        throw new Error('merchant, merchantUrl, positive amount in cents, and description are required');
      const idempotencyKey = createHash('sha256').update(
        `link:${context.requestId}:${context.generationId}:${toolCallId || randomUUID()}`).digest('hex');
      return JSON.stringify(await daemonExecute('createLinkSpendRequest', {
        ...context, agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        merchant, ...(merchantUrl ? { merchantUrl } : {}), amount, description, idempotencyKey,
        ...(args.test === true ? { test: true } : {}),
        ...(args.credentialType === 'shared_payment_token'
          ? { credentialType: 'shared_payment_token', networkId: stringArg(args, 'networkId') }
          : {}),
      }));
    }
    case 'wait_link_spend_request': {
      const id = stringArg(args, 'id')?.trim();
      if (!id || !/^lsrq_[A-Za-z0-9]+$/.test(id)) throw new Error('valid Link request ID required');
      const context = await activeCommandContext();
      for (let attempt = 0; attempt < 20; attempt++) {
        const result = await daemonExecute('retrieveLinkSpendRequest', {
          ...context, agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'), id });
        if (result.status !== 'pending_approval' && result.status !== 'created')
          return JSON.stringify(result);
        if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      return JSON.stringify({ id, status: 'pending_approval' });
    }
    case 'connect': {
      const service = stringArg(args, 'service')?.trim();
      const reason = stringArg(args, 'reason')?.trim();
      if (!service || !reason) throw new Error('service and reason are required');
      const continuation = normalizeAppContinuation(args.continuation);
      const signedInUrl = stringArg(args, 'signedInUrl')?.trim();
      const { squireReach: reach, squireCall } = connectorOfferDepsFromEnv();
      // Refresh vault metadata before the server decides whether this app is ready.
      const squireAvailable = reach ? (await reach())?.reachable === true : false;
      const input = {
        ...await activeCommandContext(), service, reason,
        squireAvailable,
        ...(continuation ? { continuation } : {}),
        ...(args.reconnect === true ? { reconnect: true } : {}),
        ...(args.noApi === true ? { noApi: true } : {}),
        ...(args.switchGoogleAccount === true ? { switchGoogleAccount: true } : {}),
        ...(signedInUrl ? { signedInUrl } : {}),
      };
      const result = await daemonExecute('connect', input) as unknown as ConnectResult;
      // A browser app signed in through OAuth or SSO has no login to save:
      // the agent's own signed-in Squire session is what makes it ready.
      if (result.status === 'needs_squire' && result.transport === 'squire-browser' && result.appKey &&
          signedInUrl && squireCall && await squireSessionSignedIn(squireCall, signedInUrl, result.appKey))
        return JSON.stringify(await daemonExecute('connect', { ...input, squireSignedIn: true }));
      return JSON.stringify(result);
    }
    case 'find_connectors': {
      const query = stringArg(args, 'query')?.trim();
      if (!query) throw new Error('query is required');
      return JSON.stringify(await daemonExecute('findConnectors', { roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'), query }));
    }
    case 'connect_app': {
      const app = stringArg(args, 'app')?.trim();
      const reason = stringArg(args, 'reason')?.trim();
      if (!app || !reason) throw new Error('app and reason are required');
      const continuation = normalizeAppContinuation(args.continuation);
      const context = await activeCommandContext();
      return JSON.stringify(
        await daemonExecute('connectApp', {
          ...context,
          app,
          reason,
          ...(continuation ? { continuation } : {}),
          ...(args.reconnect === true ? { reconnect: true } : {}),
          ...(args.noApi === true ? { noApi: true } : {}),
        }),
      );
    }
    case 'list_app_tools': {
      const appId = stringArg(args, 'appId');
      if (!appId) throw new Error('appId is required');
      return JSON.stringify(await daemonExecute('listAppTools', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        appId,
        ...(typeof args.query === 'string' ? { query: args.query } : {}),
      }));
    }
    case 'execute_app_tool': {
      const appId = stringArg(args, 'appId');
      const tool = stringArg(args, 'tool');
      if (!appId || !tool || !args.arguments || typeof args.arguments !== 'object' ||
        Array.isArray(args.arguments)) throw new Error('appId, tool, and arguments are required');
      return JSON.stringify(await daemonExecute('executeAppTool', {
        ...await activeCommandContext(),
        agentId: requiredEnv('BEELINE_DAEMON_AGENT_ID'),
        appId, tool, arguments: args.arguments,
      }));
    }
    case 'offer_connector':
      return offerConnector(args);
    case 'post_starter_video_preview':
      return JSON.stringify(await daemonExecute('postStarterVideoPreview', { ...await activeCommandContext(), videoObjectId: args.videoObjectId, frameObjectId: args.frameObjectId, title: args.title, description: args.description, visibility: args.visibility }));
    case 'post_starter_welcome':
      return JSON.stringify(await daemonExecute('postStarterWelcome', { ...await activeCommandContext() }));
    case 'post_room_invite':
      return JSON.stringify(await daemonExecute('postRoomInvite', { ...await activeCommandContext() }));
    case 'post_repository_card':
    case 'post_starters_card':
      return JSON.stringify(await daemonExecute('postRepositoryOnboarding', {
        ...await activeCommandContext(), kind: name === 'post_repository_card' ? 'repository' : 'starters',
      }));
    case 'ask_choice':
      return askChoice(args);
    case 'open_poll':
      return openPoll(args);
    case 'run_granted_command':
      return runGrantedCommand(args);
    default:
      throw new Error(`tool is not available on the agent surface: ${name}`);
  }
}

function toolCallId(params: JsonObject, requestId: JsonRpcRequest['id']): string {
  const metadata = asObject(params._meta);
  const candidate = metadata.beelineToolCallId ?? metadata.progressToken ?? requestId;
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
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
        if (process.env.BEELINE_TURN_CONTEXT_FILE && (await readTurnContextFile()).terminalReason)
          throw new Error('turn has ended; further tool calls are refused');
        const definition = TOOLS.find(tool => tool.name === params.name);
        if (!definition) throw new Error(`unknown or unavailable tool: ${params.name}`);
        if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) throw new Error('tool arguments must be an object');
        validateToolInput(definition, asObject(params.arguments));
        output = agentSurface
          ? await callAgentTool(params.name, asObject(params.arguments), toolCallId(params, request.id))
          : await callTool(params.name, asObject(params.arguments));
      } catch (error) {
        success(request.id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
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
