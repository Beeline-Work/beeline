import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { type DaemonAttachment } from '@beeline/api-contract/daemon';
import { type CornerLifecycleView } from '@beeline/api-contract/phone';
import { assertScratchWriteBudget } from './scratch-lifecycle.js';
import { BoundedSizeError, FETCH_TIMEOUT_MS, MAX_ATTACHMENT_BYTES, attachmentId, fetchBoundedBytes, safeAttachmentNames } from './attachment-delivery.js';
import { JsonObject, cornerCallText, requiredEnv, daemonExecute, activeCommandContext, asObject, turnPromptSectionIds, stringArg, MAX_ATTACH_BYTES } from './read-only-mcp.js';

import { bindBriefFiles, withinRoot } from './read-only-mcp-download-attachment.js';



export async function openCorner(args: JsonObject, toolCallId: string): Promise<string> {
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
    ...(typeof args.sourceMessageId === 'string' ? { sourceMessageId: args.sourceMessageId } : {}),
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


export async function reviseCornerBrief(args: JsonObject): Promise<string> {
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


export async function readCornerBrief(args: JsonObject): Promise<string> {
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
export function targetCornerId(args: JsonObject): string {
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
export async function closeCorner(args: JsonObject): Promise<string> {
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


export const FETCH_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export type FetchImageMime = (typeof FETCH_IMAGE_MIMES)[number];


export interface FetchImageDeps {
  /** Same writable session area write_scratch_file and post_artifact use. */
  root: string;
  fetchImpl?: typeof fetch;
}


export function fetchImageDepsFromEnv(): FetchImageDeps {
  return { root: requiredEnv('BEELINE_ATTACH_SCRATCH_ROOT') };
}


export function parseImageUrl(input: string): URL {
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


export function sniffRasterImageMime(bytes: Buffer): FetchImageMime | undefined {
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


export function resolveFetchedImageMime(contentType: string, bytes: Buffer): FetchImageMime {
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


export function fetchedImageFileName(url: URL, mime: FetchImageMime): string {
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


export type AttachmentDownloadFailure = 'not_found' | 'forbidden' | 'too_large' | 'download_failed';


/** A refused download_attachment: the tool error text is `{"error":<reason>,"message":…}`. */
export class AttachmentDownloadError extends Error {
  readonly reason: AttachmentDownloadFailure;
  constructor(reason: AttachmentDownloadFailure, detail: string) {
    super(JSON.stringify({ error: reason, message: detail }));
    this.name = 'AttachmentDownloadError';
    this.reason = reason;
  }
}


export interface DownloadAttachmentDeps {
  /** Same writable session area write_scratch_file and fetch_image use. */
  root?: string;
  /** The daemon's authenticated server; media bytes are read from here, never a stored URL's host. */
  serverBaseUrl: string;
  readMessage: (messageId: string) => Promise<JsonObject>;
  readAttachment?: (objectId: string) => Promise<JsonObject>;
  /**
   * The active corner's brief attachment with this object id, or null when the
   * id is not pinned to a brief this agent may read. The server's reach check
   * is the one authority; no Room message is read for this path.
   */
  readBriefAttachment?: (objectId: string) => Promise<DaemonAttachment | null>;
  fetchImpl?: typeof fetch;
}


export function downloadAttachmentDepsFromEnv(): DownloadAttachmentDeps {
  const serverBaseUrl = requiredEnv('BEELINE_DAEMON_BASE_URL');
  return {
    root: process.env.BEELINE_ATTACH_SCRATCH_ROOT?.trim() || undefined,
    serverBaseUrl,
    readMessage: (messageId) =>
      daemonExecute('getRoomMessage', {
        roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'),
        messageId,
      }),
    readAttachment: (attachmentId) => daemonExecute('getRoomMessage', {
      roomId: requiredEnv('BEELINE_DAEMON_ROOM_ID'), messageId: '', attachmentId,
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
export function messageReadFailure(error: unknown): AttachmentDownloadError {
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
export interface DownloadCandidate {
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
export function candidateFromMessage(
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
 * object id, so consult the active brief first, then ask the server to locate
 * a readable message or brief carrying the object id. Existing server read
 * checks remain the authority for every candidate.
 */
export async function resolveDownloadAttachment(
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
  if (deps.readAttachment) {
    try {
      const message = await deps.readAttachment(wanted);
      const attachments = (Array.isArray(message.attachments) ? message.attachments : []) as DaemonAttachment[];
      const index = attachments.findIndex(item => attachmentId(item) === wanted);
      if (index >= 0) {
        const candidate = candidateFromMessage(String(message.messageId || wanted), attachments, index);
        if (candidate) return candidate;
      }
    } catch (error) {
      const failure = messageReadFailure(error);
      if (failure.reason === 'download_failed') throw failure;
      // An unreachable object and an absent object have the same result.
    }
  }
  if (messageError) throw messageReadFailure(messageError);
  throw new AttachmentDownloadError('not_found', 'no attachment with this id');
}
