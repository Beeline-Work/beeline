import { agentToolsFor, REPOSITORY_ROUTES, repositoryTools } from "./minimal-tool-surface.js";
import { realpathSync, lstatSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute, relative, sep, join, basename } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { isNetworkFailure } from "./network-failure.js";
import { cornerTextRefusal, normalizeCornerText, encodeArtifactTitleHeader } from "@beeline/api-contract/daemon";
import { fetchBoundedBytes, BoundedSizeError, MAX_ATTACHMENT_BYTES, FETCH_TIMEOUT_MS, EXPIRED_REASON } from "./attachment-delivery.js";
import { assertScratchWriteBudget } from "./scratch-lifecycle.js";
import { createHash } from "node:crypto";
import { describeTailscaleReach } from "./connector-tailscale.js";
import { readVault } from "./connector-squire.js";
import { squireReachCause } from "./squire-status.js";
import { createInterface } from "node:readline";
import { READ_ONLY_TOOL_NAMES } from "./read-only-policy.js";
import { listFiles, readAgentFile, searchText, gitLog, gitShow, gitDiff, gitStatus } from './read-only-mcp-read-tools.js';
import { FetchImageDeps, fetchImageDepsFromEnv, parseImageUrl, resolveFetchedImageMime, resolveWriteScratchPath, fetchedImageFileName, DownloadAttachmentDeps, downloadAttachmentDepsFromEnv, resolveDownloadAttachment, AttachmentDownloadError } from './read-only-mcp-open-corner.js';
import { ConnectorOfferDeps, squireShareFailure } from './read-only-mcp-agent-grant-deps.js';
import { agentScheduleRoomId, DaemonArtifactUploadResult } from './read-only-mcp-download-attachment.js';
import { GrantRunDeps, executeAgentTool, turnArtifacts } from './read-only-mcp-open-poll.js';
import { handleLine } from './read-only-mcp-tool-call-id.js';












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





/**
 * download_attachment: authorize through the same getRoomMessage read the
 * agent already has, or through a readable brief, then copy the bytes from the server into
 * `<scratch>/attachments/<key>/<safe-name>`. Nothing is downloaded while a
 * prompt is built; this is the only on-demand path for a transcript file.
 */
export async function downloadAttachment(
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
      signal: undefined,
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
      try {
        await readVault({ call: squireCall! });
      } catch (error) {
        // Task authorization and stale turns are not machine failures.
        if (/not authorized|active task|active server command|Squire relay HTTP 403/i.test(
          error instanceof Error ? error.message : ''))
          return { reachable: false, cause: 'Squire status probe was not authorized' };
        return { reachable: false, cause: squireReachCause(error) };
      }
      return { reachable: true };
    } : undefined,
  };
}




export async function squireShareEndpoint(sessionId: string): Promise<{ url: string; expiresAt: number }> {
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
      signal: undefined,
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




/** The small-object pass-through: the server validates and streams the
 *  bytes to storage in one step and answers with the stored artifact url. */
export async function daemonUploadArtifact(
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




/** Keep concurrent calls isolated; footer metadata rides on their existing operation responses. */
export async function withToolOwedContext(work: () => Promise<string>) {
  return toolOwedStorage.run({}, async () => {
    let output: string;
    let isError = false;
    try { output = await work(); }
    catch (error) {
      isError = true;
      output = error instanceof Error ? error.message : String(error);
      // Validation may refuse before dispatch. Read fresh authenticated context
      // without adding an operation to the command/operation log.
      if (!toolOwedStorage.getStore()?.owedMentions) {
        try {
          const response = await fetch(new URL('/v1/daemon/owed-mentions', requiredEnv('BEELINE_DAEMON_BASE_URL')), {
            signal: undefined,
            headers: { authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}` },
          });
          if (response.ok) {
            const context = await response.json() as { owedMentions?: unknown[] };
            if (Array.isArray(context.owedMentions)) toolOwedStorage.getStore()!.owedMentions = context.owedMentions;
          }
        } catch { /* Optional context must never mask the original refusal. */ }
      }
    }
    const owedMentions = toolOwedStorage.getStore()?.owedMentions;
    return { ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: output },
      ...(owedMentions ? [{ type: 'text' as const, text: JSON.stringify({ owedMentions }) }] : [])] };
  });
}




export const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });



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
export { workbenchStatus } from './read-only-mcp-agent-grant-deps.js';
export { offerConnector } from './read-only-mcp-agent-grant-deps.js';
export { askChoice } from './read-only-mcp-agent-grant-deps.js';
export { openPoll } from './read-only-mcp-open-poll.js';
export type { GrantRunDeps } from './read-only-mcp-open-poll.js';
export { runGrantedCommand } from './read-only-mcp-open-poll.js';
export { callAgentTool } from './read-only-mcp-open-poll.js';
