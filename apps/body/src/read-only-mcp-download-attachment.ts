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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_MIME_BY_EXTENSION, ARTIFACT_MIME_TYPES, type ArtifactMimeType } from '@beeline/api-contract/daemon';
import { MAX_EVENT_CONSEQUENCE_LENGTH, AGENT_EVENT_SLUG_MAX_LENGTH, MAX_MENTIONS_PER_EVENT, SUBSCRIBABLE_EVENT_KINDS, perItemSubscriptionRefusal, isAgentKind, isPerItemEventKind, isServerEventKind, isSubscribableEventKind, MESSAGE_REACTION_EMOJIS, type MessageReactionEmoji } from '@beeline/api-contract/phone';
import { validateArtifact } from './artifact-validation.js';
import { BoundedSizeError, EXPIRED_REASON, MAX_ATTACHMENT_BYTES, fetchBoundedBytes } from './attachment-delivery.js';
import { JsonObject, requiredEnv, daemonExecute, stringArg, MAX_ATTACH_BYTES, gitBinary, asObject } from './read-only-mcp.js';
import { DownloadAttachmentDeps, downloadAttachmentDepsFromEnv, resolveDownloadAttachment, AttachmentDownloadError, resolveWriteScratchPath } from './read-only-mcp-open-corner.js';
import { daemonUploadArtifact } from './read-only-mcp-open-poll.js';



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


export function withinRoot(root: string, resolved: string): boolean {
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
  // Match the shell's home shortcut before applying the existing real-path boundary.
  if (input.startsWith('~/')) input = join(homedir(), input.slice(2));
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


export function finishResolvedAttachPath(resolved: string): string {
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


export const POSTED_MEDIA_ID =
  /\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[?#])/i;


export function isArtifactMime(value: unknown): value is ArtifactMimeType {
  return typeof value === 'string' && (ARTIFACT_MIME_TYPES as readonly string[]).includes(value);
}


/** The viewer cannot open `application/octet-stream`, so content that falls
 *  through to it (inline `html`/`bytes`, or an unknown or missing extension)
 *  is sniffed for a format the viewer renders. Unrecognized content keeps
 *  the octet-stream type. */
export function sniffArtifactMime(bytes: Buffer, fromHtml: boolean): ArtifactMimeType {
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
export function attachRootsFromEnv(): string[] {
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
    `final reply, or on the existing post or a file-only message if you end silently.${objectId ? ` Object ${objectId} will be included automatically if this turn opens or revises a corner brief.` : ''} Ask for feedback here in the Room.`
  );
}


/** Rendered formats are validated as self-contained mocks; a working file
 *  such as a game template or a build page is source, so it travels inert. */
export const BRIEF_FILE_INERT_MIMES = new Set(['text/html', 'image/svg+xml', 'application/vnd.beeline.game+html']);


/** File citations, including Markdown links, file URLs and key=value text. */
export const NAMED_PATH = /(?:^|[\s(<[=:])(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(file:\/\/[^\s`'"()<>\]]+|[^\s`'"()<>\]=:]+))/g;


/** Recognize private paths even when missing or unreadable for delivery advice. */
export function namedPrivateFiles(roots: string[], text: string, includeRelative = false): { named: string; resolved: string }[] {
  const home = process.env.HOME?.trim();
  const found: { named: string; resolved: string }[] = [];
  for (const match of text.matchAll(NAMED_PATH)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const named = quoted ?? match[4]!.replace(/[.,;:!?*]+$/, '');
    let path = named;
    if (path.startsWith('file://')) {
      try { path = fileURLToPath(path); } catch { continue; }
    }
    if (!isAbsolute(path) && !path.startsWith('~/')) {
      // Source citations travel with the repository. Generated proof files do
      // not: only existing relative files inside this session are candidates.
      if (!includeRelative || !/^(?:\.{1,2}\/)?[\w@ .-]+(?:\/[\w@ .-]+)*\.[a-zA-Z0-9]{1,12}$/.test(path)) continue;
      let resolved: string;
      try { resolved = resolveAttachPath(roots, path); } catch { continue; }
      const checkout = roots[0];
      if (checkout && gitBinary && withinRoot(realpathSync(checkout), resolved)) {
        try {
          execFileSync(gitBinary, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
            '--literal-pathspecs', '-C', checkout, 'ls-files', '--error-unmatch', '--', relative(realpathSync(checkout), resolved)],
          { stdio: 'ignore', timeout: 1000, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
          continue;
        } catch { /* Untracked files (or unavailable index evidence) need attachments. */ }
      }
      if (!found.some(file => file.resolved === resolved)) found.push({ named, resolved });
      continue;
    }
    const absolute = path.startsWith('~/') ? (home ? join(home, path.slice(2)) : '') : path;
    if (!absolute) continue;
    let resolved = resolve(absolute);
    const inRoots = roots.some((root) => withinRoot(resolve(root), resolved));
    try {
      resolved = resolveAttachPath(roots, absolute);
    } catch {
      // A named private path still needs advice if it cannot be read.
      if (!inRoots && !/^(?:~\/|\/(?:tmp|var\/tmp|home|Users|root|private\/var)\/)/.test(path)) continue;
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


export function agentScheduleRoomId(): string {
  return process.env.BEELINE_DAEMON_CORNER_ID?.trim() || requiredEnv('BEELINE_DAEMON_ROOM_ID');
}


export const MIN_SCHEDULE_MINUTES = 1;


export function parseScheduleCadence(args: JsonObject): {
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
  const created = await deps.execute('createAgentSchedule', {
    roomId: deps.roomId,
    prompt,
    cadence,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(stringArg(args, 'workflowName') ? { workflowName: stringArg(args, 'workflowName')! } : {}),
  });
  const scheduleId = typeof created.scheduleId === 'string' ? created.scheduleId : 'unknown';
  const floorNote = floored
    ? ` The minimum cadence is ${MIN_SCHEDULE_MINUTES} minute; created every ${MIN_SCHEDULE_MINUTES} minute.`
    : '';
  return (
    `Schedule ${scheduleId} created: ${describe()}` +
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


export async function listEventSubscriptions(
  deps: AgentScheduleDeps = agentScheduleDepsFromEnv(),
): Promise<string> {
  const result = await deps.execute('listEventSubscriptions', { roomId: deps.roomId });
  return describeSubscriptions(result, 'You react to');
}


export function describeSubscriptions(result: JsonObject, lead: string): string {
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
  if (prompt === undefined && parsed === undefined && args.title === undefined && !stringArg(args, 'workflowName'))
    throw new Error('give a prompt, cadence, title, or workflowName to change');
  const updated = await deps.execute('updateAgentSchedule', {
    roomId: deps.roomId,
    scheduleId,
    ...(deps.selfOnly ? { selfOnly: true } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(stringArg(args, 'workflowName') ? { workflowName: stringArg(args, 'workflowName')! } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(parsed ? { cadence: parsed.cadence } : {}),
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
