import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DaemonAttachment, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { AcpClient, type McpServerWire, type ToolCallEntry } from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  promptWithImages,
  type DeliveredAttachment,
} from './attachment-delivery.js';
import { stripAgentReplyPreamble } from './reply-sanitizer.js';
import { beelineAgentMcpServer } from './room-session.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE } from './response-directives.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

const execFileAsync = promisify(execFile);
const PULL_REQUEST_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;
const TOOL_ARGUMENT_MAX_BYTES = 1_200;
const TOOL_OUTPUT_MAX_BYTES = 3_200;
const TOOL_PATH_LIMIT = 12;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function serialized(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keep wire-visible tool detail useful without ever carrying credentials. */
function redactToolDetail(value: string): string {
  return value
    .replace(
      /\b(["']?)(api[_-]?key|token|secret|password|passwd|authorization|credential|cookie|private[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      '"$2": "[REDACTED]"',
    )
    .replace(
      /\b(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g,
      (assignment) => `${assignment.slice(0, assignment.indexOf('='))}=[REDACTED]`,
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,]+/gi, '$1[REDACTED]')
    .replace(
      /(--?(?:api[_-]?key|token|secret|password|authorization|credential|cookie)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]',
    );
}

function clampBytes(value: string, maxBytes: number): string {
  const clean = value.trim();
  if (Buffer.byteLength(clean) <= maxBytes) return clean;
  const suffix = '\n…[truncated]';
  const allowed = maxBytes - Buffer.byteLength(suffix);
  return `${Buffer.from(clean).subarray(0, Math.max(0, allowed)).toString('utf8')}${suffix}`;
}

function outputExcerpt(value: unknown): string | undefined {
  const redacted = redactToolDetail(serialized(value));
  if (!redacted.trim()) return undefined;
  if (/\b(?:git[- ]credential|credential[- ]helper)\b/i.test(redacted)) {
    return 'Credential-helper output omitted.';
  }
  const lines = redacted.split(/\r?\n/).map((line) => line.trimEnd());
  if (lines.length <= 8) return clampBytes(lines.join('\n'), TOOL_OUTPUT_MAX_BYTES);
  return clampBytes(
    [...lines.slice(0, 4), '…[output omitted]…', ...lines.slice(-4)].join('\n'),
    TOOL_OUTPUT_MAX_BYTES,
  );
}

function filePaths(value: unknown, worktreePath: string): string[] {
  const paths = new Set<string>();
  const visit = (candidate: unknown, key?: string) => {
    if (paths.size >= TOOL_PATH_LIMIT || candidate === null || candidate === undefined) return;
    if (typeof candidate === 'string') {
      if (key && /(?:^|_)(?:path|file|filename|target)$/i.test(key)) {
        const path = candidate.startsWith(`${worktreePath}/`)
          ? candidate.slice(worktreePath.length + 1)
          : candidate;
        if (path && path.length <= 512) paths.add(redactToolDetail(path));
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry));
      return;
    }
    const object = record(candidate);
    if (object) Object.entries(object).forEach(([entryKey, entry]) => visit(entry, entryKey));
  };
  visit(value);
  return [...paths];
}

function resultStatus(call: ToolCallEntry): string {
  const content =
    record(call.content) ??
    (typeof call.content === 'string'
      ? (() => {
          try {
            return record(JSON.parse(call.content));
          } catch {
            return undefined;
          }
        })()
      : undefined);
  const exitCode = content?.exitCode ?? content?.exit_code ?? content?.code;
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) return `exit ${exitCode}`;
  if (content?.ok === true || content?.success === true) return 'ok';
  if (content?.ok === false || content?.success === false) return 'error';
  return /(?:failed|error|denied)/i.test(call.status ?? '') ? 'error' : 'ok';
}

function toolArguments(call: ToolCallEntry): { command?: string; input?: string } {
  const raw = record(call.rawInput);
  const command =
    typeof call.rawInput === 'string'
      ? call.rawInput
      : typeof raw?.command === 'string'
        ? raw.command
        : typeof raw?.cmd === 'string'
          ? raw.cmd
          : undefined;
  if (command) return { command: clampBytes(redactToolDetail(command), TOOL_ARGUMENT_MAX_BYTES) };
  const input = serialized(call.rawInput);
  return input
    ? { input: clampBytes(redactToolDetail(input), TOOL_ARGUMENT_MAX_BYTES) }
    : {};
}

function toolCallKey(call: ToolCallEntry, index: number): string {
  return call.id ?? `tool-${index}`;
}

function toolCallSettled(call: ToolCallEntry): boolean {
  return /^(?:completed|complete|failed|error|succeeded|success|passed|done)$/i.test(
    call.status ?? '',
  );
}

function isSuccessfulCommit(call: ToolCallEntry): boolean {
  if (/failed|error|denied/i.test(call.status ?? '')) return false;
  return /\bgit\s+commit\b|\bcommit(?:ted)?\s+(?:changes|files?)\b/i.test(
    `${call.title ?? ''} ${serialized(call.rawInput)}`,
  );
}

/** Turn one physical ACP tool call into a bounded, redacted indexed ledger row. */
export async function cornerToolActivity(
  call: ToolCallEntry,
  worktreePath: string,
): Promise<DaemonActivity> {
  const operation = oneLine(call.kind ?? '') || 'tool';
  let title = oneLine(redactToolDetail(call.title ?? '')) || `${operation} tool`;
  if (isSuccessfulCommit(call)) {
    try {
      const shown = await execFileAsync(
        'git',
        ['-C', worktreePath, 'show', '--format=%s', '--name-only', '--no-renames', 'HEAD'],
        { maxBuffer: 1024 * 1024 },
      );
      const lines = shown.stdout.split(/\r?\n/);
      const subject = oneLine(lines.shift() ?? 'commit');
      const files = new Set(lines.map(oneLine).filter(Boolean));
      title = `committed ${files.size} files: ${subject}`;
    } catch {
      // The harness title remains a useful summary if the commit disappeared
      // between the ACP update and this read.
    }
  }
  const paths = filePaths([call.rawInput, call.content, call.locations], worktreePath);
  const argumentsSummary = toolArguments(call);
  const output = outputExcerpt(call.content);
  return {
    kind: 'tool',
    title: title.slice(0, 240),
    operation: operation.slice(0, 80),
    status: resultStatus(call),
    ...argumentsSummary,
    ...(output ? { output } : {}),
    ...(paths.length ? { files: paths.map((path) => ({ path })) } : {}),
  };
}

export interface MonolithCornerTurnOptions {
  cornerId: string;
  parentRoomId: string;
  workspaceId: string;
  objective: string;
  featureBranch: string;
  targetBranch: string;
  worktreePath: string;
  gitCommonDir: string;
  githubToken: string;
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: SessionScheduler;
  signal?: AbortSignal;
  pollMs?: number;
  onPoll(): void;
  onFailure(retryInMs: number): void;
  onCloseRequested(): Promise<void>;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  /** Attachment downloads (test seam). */
  fetchImpl?: typeof fetch;
}

/**
 * Close-request polling cadence: 12 s ± up to 3 s of jitter (10-15 s window).
 * The daemon API has no long-poll, so this keeps continuous request load off
 * the server while staying well inside the <15 s close-request latency budget.
 * Immediately after a turn completes the loop polls without the wait.
 */
export const CORNER_CLOSE_POLL_BASE_MS = 12_000;
export function cornerClosePollMs(random: () => number = Math.random): number {
  return CORNER_CLOSE_POLL_BASE_MS + Math.floor(random() * 3_000);
}

/** One write-enabled corner session, driven only by monolith transcript facts. */
export class MonolithCornerTurnLoop {
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private client?: AcpClient;
  private sessionId?: string;
  private turnIdentityInstructions = '';
  private busy = false;
  private forcedStop = false;
  private draftTail = Promise.resolve();
  private activityTail = Promise.resolve();
  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
  private attachmentDir?: string;

  constructor(private readonly options: MonolithCornerTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
  }

  isBusy(): boolean {
    return this.busy;
  }

  currentPrincipalCanDrive(_workspaceId: string, _principalId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  refreshPersonaForSoulUpdate(): Promise<void> {
    return this.options.scheduler.suspend(this.options.cornerId);
  }

  async prepareForForcedUpdateRestart(): Promise<void> {
    this.forcedStop = true;
  }

  async forceRecoverRoom(): Promise<void> {
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
    await this.options.scheduler.forceSuspend(this.options.cornerId);
  }

  private roster(): Promise<WorkspaceRoster> {
    return this.options.api.execute('getWorkspaceRoster', {
      agentId: this.agent.publicKey,
      workspaceId: this.options.workspaceId,
    });
  }

  private async activate(): Promise<string> {
    if (this.client?.isAlive && this.sessionId) return this.sessionId;
    const [configuration, roster] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.cornerId,
      }),
      this.roster(),
    ]);
    await mkdir(this.options.worktreePath, { recursive: true });
    const homeOverlay = this.options.config.agentHomeRoot
      ? await prepareRoomAgentHome({
          root: this.options.config.agentHomeRoot,
          sharedSkills: this.options.config.sharedSkills ?? [],
          ...(this.options.config.operatorHome
            ? { operatorHome: this.options.config.operatorHome }
            : {}),
        })
      : {};
    const command = this.options.config.agentCommand ?? this.options.config.agentBinary;
    const selection =
      configuration.model || configuration.effort
        ? { model: configuration.model, effort: configuration.effort }
        : this.options.config.modelSelection;
    const agentEnv: Record<string, string> = {
      ...this.options.config.agentEnv,
      ...homeOverlay,
      GH_TOKEN: this.options.githubToken,
      GITHUB_TOKEN: this.options.githubToken,
    };
    const agentArgs = agentArgsWithModelSelection(
      {
        kind: this.options.config.agentKind,
        command,
        args: this.options.config.agentArgs ?? [],
      },
      selection,
    );
    const operatorHome = this.options.config.operatorHome ?? homedir();
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    this.attachmentDir = tmpDir ? join(tmpDir, 'beeline-attachments') : undefined;
    const homeStateDirs = harnessHomeStateDirs(command, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    const spawnCommand = wrapAgentCommand({
      bwrapPath: this.options.config.bwrapPath,
      spec: {
        mode: 'edit',
        cwd: this.options.worktreePath,
        worktreePath: this.options.worktreePath,
        gitCommonDir: this.options.gitCommonDir,
        protectedPaths: [this.options.runtime.supervisorRoot],
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
        maskPaths: credentialMaskPaths(this.options.config.sandboxMaskPaths, operatorHome),
      },
      command,
      args: agentArgs,
    });
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      agentCommand: spawnCommand.command,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: this.options.worktreePath,
      agentLabel: command,
      autoApprovePermissions: true,
      permissionHandler: () => Promise.resolve('allow'),
    };
    this.client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await this.client.start();
    const servers: McpServerWire[] = [
      {
        name: 'buzz-dev-mcp',
        command: this.options.config.mcpBinary,
        args: [],
        // ACP hosts launch stdio MCP servers with an explicit, sanitized env.
        // This token is minted for this exact corner and is also the credential
        // helper's password source, so its shell commands need the same scope as
        // the corner harness without inheriting any host credentials.
        env: [
          { name: 'GH_TOKEN', value: this.options.githubToken },
          { name: 'GITHUB_TOKEN', value: this.options.githubToken },
        ],
      },
      beelineAgentMcpServer(this.options.config, this.options.api, {
        roomId: this.options.parentRoomId,
        workspaceId: this.options.workspaceId,
        cornerId: this.options.cornerId,
        attachRoot: this.options.worktreePath,
      }),
    ];
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const persona = configuration.soul ?? self?.soul;
    const identityInstructions = `Your Beeline identity is ${self?.name ?? this.agent.name}.`;
    const personaInstructions = persona?.instructions
      ? `Human-authored Workspace persona: ${persona.name}. ${persona.instructions}`
      : '';
    this.turnIdentityInstructions = harnessHonorsSessionSystemPrompt(command)
      ? ''
      : [identityInstructions, personaInstructions].filter(Boolean).join('\n\n');
    const opened = await this.client.sessionNew({
      cwd: this.options.worktreePath,
      mcpServers: servers,
      mode: 'edit',
      systemPrompt: [
        identityInstructions,
        personaInstructions,
        `You are in an isolated git worktree on ${this.options.featureBranch}, targeting ${this.options.targetBranch}.`,
        'Work normally with the full coding tools. Commit and push only this feature branch. Use gh to open its pull request.',
        'PR-opening turn rule: as soon as a pull request exists, print its full GitHub URL as your final response and end the turn immediately. Do not call pr_checks_status in that same turn and do not wait for checks inside it. Then stay idle until a later corner fact or human message starts another turn.',
        'Never merge because local tests pass or because gh reports passing checks. On a later turn triggered by a server-posted checks-passed note, call beeline-agent pr_checks_status. Merge only when it returns checks="passed", held=false, and approvalPending=false.',
        'Merge the PR yourself only after the checks-passed event shows every check green; if any check failed or is still running, say exactly which and stop - never merge red.',
        'If any human in this corner says hold or do not merge, do not merge until a later human explicitly resumes it.',
        'Do not tag the user when a corner turn finishes: the server posts the merge summary card and its push already cover completion. Tag a human only mid-turn, and only when you need a decision or input.',
        'A human approval in the app asks the server to merge. When approval is pending, wait for the server close request instead of racing it with gh. If checks passed, no hold exists, and no approval is pending, merge the pull request yourself with gh.',
        'Never push directly to the target branch. Never merge a different pull request.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.sessionId = opened.sessionId;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      await applyAgentModelSelection(this.client, opened.sessionId, options, selection);
    }
    return opened.sessionId;
  }

  private lifecycle(): SessionLifecycle {
    return {
      activate: () => this.activate(),
      suspend: async () => {
        const client = this.client;
        this.client = undefined;
        this.sessionId = undefined;
        if (client?.isAlive) await client.stop();
      },
    };
  }

  private async prompt(
    requestId: string,
    trigger: string,
    attachments: readonly DaemonAttachment[] = [],
  ): Promise<void> {
    const { api, cornerId } = this.options;
    await api.execute('postAgentTurnReceipt', {
      agentId: this.agent.publicKey,
      roomId: cornerId,
      requestId,
      status: 'working',
      generationId: `${this.agent.publicKey}:${cornerId}`,
    });
    try {
      await this.options.scheduler.run(
        cornerId,
        this.lifecycle(),
        async () => {
          if (this.forcedStop) throw new Error('corner turn stopped for daemon handoff');
          this.busy = true;
          const [conversation, roster, delivered] = await Promise.all([
            api.execute('getRoomConversation', { roomId: cornerId, limit: 200 }),
            this.roster(),
            this.attachmentDir && attachments.length
              ? deliverAttachments(
                  attachments,
                  join(this.attachmentDir, requestId.replace(/[^\w-]/g, '_')),
                  this.options.fetchImpl,
                )
              : Promise.resolve<DeliveredAttachment[]>([]),
          ]);
          const names = new Map(roster.members.map((member) => [member.identityId, member.name]));
          const transcript = conversation.items
            .slice(-120)
            .map(
              (message) =>
                `${names.get(message.authorId) ?? 'Beeline'} [${message.type}]: ${message.body}`,
            )
            .join('\n');
          const prompt = [
            this.turnIdentityInstructions,
            `Corner objective:\n${this.options.objective}`,
            transcript ? `Corner transcript:\n${transcript}` : '',
            [`Newest trigger:\n${trigger}`, ...attachmentPromptLines(attachments, delivered)].join(
              '\n',
            ),
            'Continue the objective. Obey the PR checks and human hold rules in your session instructions.',
            MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE,
          ]
            .filter(Boolean)
            .join('\n\n');
          const sessionId = this.sessionId!;
          // The draft lane's turn id must equal the turn's request id so the
          // durable final reconciles (and settles) the live draft, exactly as
          // in top-level Rooms; any other id leaves a ghost draft duplicating
          // the final message when the retract event is missed.
          const turnId = requestId;
          const publishedToolCalls = new Set<string>();
          // Colloquial corner ledger: each COMPLETED narration segment of the
          // turn is kept as a durable Room line (server-indexed like any
          // message), interleaved with the settled tool rows, instead of the
          // corner staying silent until the finish. Segments carry no request
          // id so they never settle the turn's receipt; the un-posted tail
          // becomes the durable final. Offsets index the RAW stream text;
          // a failed segment post reverts its offset so the text still lands
          // in the final.
          const NARRATION_MAX_SEGMENTS = 20;
          let narrationPostedChars = 0;
          let narrationSegments = 0;
          const postNarrationSegments = (full: string) => {
            if (narrationSegments >= NARRATION_MAX_SEGMENTS) return;
            const unposted = full.slice(narrationPostedChars);
            const boundaries = [...unposted.matchAll(/\n\n|[.!?](?=\s)/g)];
            if (!boundaries.length) return;
            const boundary = boundaries[boundaries.length - 1]!;
            const segmentEnd = narrationPostedChars + boundary.index! + boundary[0].length;
            const segment = stripAgentReplyPreamble(full.slice(narrationPostedChars, segmentEnd));
            const start = narrationPostedChars;
            narrationPostedChars = segmentEnd;
            narrationSegments += 1;
            const trimmed = segment.trim();
            if (!trimmed) return;
            this.activityTail = this.activityTail
              .catch(() => undefined)
              .then(async () => {
                await api.execute('postRoomMessage', {
                  roomId: cornerId,
                  text: trimmed,
                  presentation: 'message',
                });
              })
              .catch(() => {
                narrationPostedChars = start;
                narrationSegments -= 1;
              });
          };
          const publishToolCalls = (calls: readonly ToolCallEntry[], settledOnly: boolean) => {
            calls.forEach((call, index) => {
              const key = toolCallKey(call, index);
              if (publishedToolCalls.has(key) || (settledOnly && !toolCallSettled(call))) return;
              publishedToolCalls.add(key);
              this.activityTail = this.activityTail
                .catch(() => undefined)
                .then(async () => {
                  const activity = await cornerToolActivity(call, this.options.worktreePath);
                  await api.execute('postAgentActivity', {
                    agentId: this.agent.publicKey,
                    roomId: cornerId,
                    requestId,
                    activity: [activity],
                  });
                })
                .then(() => undefined)
                .catch((error) => {
                  publishedToolCalls.delete(key);
                  console.error(`[thin-core] corner ${cornerId} tool activity failed:`, error);
                });
            });
          };
          const result = await this.client!.sessionPrompt(
            sessionId,
            promptWithImages(
              prompt,
              attachmentImageBlocks(delivered, this.client!.canPromptWithImages()),
            ),
            120_000,
            (_delta, full) => {
              postNarrationSegments(full);
              this.draftTail = this.draftTail
                .catch(() => undefined)
                .then(() =>
                  api.execute('postAgentDraft', {
                    agentId: this.agent.publicKey,
                    roomId: cornerId,
                    turnId,
                    text: full,
                  }),
                )
                .then(() => undefined)
                .catch((error) =>
                  console.error(`[thin-core] corner ${cornerId} draft publish failed:`, error),
                );
            },
            undefined,
            (calls) => publishToolCalls(calls, true),
          );
          await this.activityTail;
          publishToolCalls(result.toolCalls, false);
          await this.activityTail;
          await this.draftTail;
          await this.activityTail;
          const reply = stripAgentReplyPreamble(result.agentText).trim();
          if (!reply) throw new Error('ACP corner turn produced no durable reply');
          // The durable final carries only the tail the narration segments did
          // not already keep; when narration covered the whole reply the turn
          // settles through its explicit receipt instead.
          const durableTail =
            narrationPostedChars > 0
              ? stripAgentReplyPreamble(result.agentText.slice(narrationPostedChars)).trim()
              : reply;
          if (durableTail) {
            await api.execute('postRoomMessage', {
              roomId: cornerId,
              requestId,
              text: durableTail,
              presentation: 'message',
            });
          }
          const pullRequest = reply.match(PULL_REQUEST_URL)?.[0];
          const alreadyReady = conversation.items.some((item) =>
            /\bPR ready for review\b/i.test(item.body),
          );
          if (pullRequest && !alreadyReady) {
            await api.execute('postRoomMessage', {
              roomId: cornerId,
              requestId,
              text: `PR ready for review\n${pullRequest}`,
              presentation: 'system',
            });
          }
          await api.execute('retractAgentLiveOutput', {
            agentId: this.agent.publicKey,
            roomId: cornerId,
            turnId,
            kind: 'draft',
          });
        },
        { priority: 'interactive', roomKey: cornerId },
      );
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: 'complete',
        generationId: `${this.agent.publicKey}:${cornerId}`,
      });
    } catch (error) {
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: 'failed',
        generationId: `${this.agent.publicKey}:${cornerId}`,
      });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async run(): Promise<void> {
    const { api, cornerId, signal } = this.options;
    let cursor = (await api.execute('getRoomInbox', { roomId: cornerId, startAtLatest: true }))
      .cursor;
    const history = await api.execute('getRoomConversation', { roomId: cornerId, limit: 200 });
    const durableAgentReplies = history.items.filter(
      (item) =>
        item.type === 'message' &&
        item.authorId === this.agent.publicKey &&
        item.body.trim() !== this.options.objective.trim(),
    );
    if (durableAgentReplies.length === 0) {
      await this.prompt(
        history.items.find((item) => item.requestId)?.requestId ?? cornerId.replaceAll('-', ''),
        this.options.objective,
      );
    }
    try {
      // A finished turn may have been the merge/close itself: re-check close
      // requests right away instead of waiting out the next full interval.
      let pollWithoutWait = false;
      while (!signal?.aborted) {
        try {
          const inbox = await api.execute('getCornerCloseRequests', {
            cornerId,
            ...(cursor ? { after: cursor } : {}),
          });
          if (inbox.closeRequested) {
            await this.options.onCloseRequested();
            return;
          }
          for (const item of inbox.items) {
            if (item.type === 'message') {
              if (item.authorId === this.agent.publicKey) continue;
              const authority = await api.execute('getRoomAuthority', {
                roomId: cornerId,
                principalId: item.authorId,
              });
              if (!authority.member || authority.principalKind !== 'human') continue;
              await this.prompt(item.id, item.body, item.attachments);
              pollWithoutWait = true;
              continue;
            }
            if (/\bchecks?\b/i.test(item.body)) {
              await this.prompt(item.id, item.body);
              pollWithoutWait = true;
            }
          }
          cursor = inbox.cursor ?? cursor;
          this.options.onPoll();
          await wait(
            pollWithoutWait ? 0 : (this.options.pollMs ?? cornerClosePollMs()),
            signal,
          );
          pollWithoutWait = false;
        } catch (error) {
          if (signal?.aborted) break;
          this.options.onFailure(1_000);
          console.error(`[thin-core] corner ${cornerId} turn loop failed:`, error);
          await wait(1_000, signal);
        }
      }
    } finally {
      await this.options.scheduler.suspend(cornerId);
    }
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveWait) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveWait();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
