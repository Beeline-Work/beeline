import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import type { DaemonAttachment, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { AcpClient, type McpServerWire, type PromptResult, type ToolCallEntry } from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  promptWithImages,
  type DeliveredAttachment,
} from './attachment-delivery.js';
import { isCornerStatusRestatement } from './reply-sanitizer.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { toolCallFailureLine } from './tool-call-failure.js';
import { distillTurnFailureReason, redactToolDetail } from './turn-failure-reason.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { beelineAgentMcpServer } from './room-session.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  explainEmptyAgentTurn,
  isAccountOrProviderRefusal,
  nextPinnedProvider,
  shouldRetryEmptyTurn,
  turnFailureReasonWithProvider,
  type EmptyTurnExplanation,
} from './empty-turn.js';
import {
  checksStateFromLifecycle,
  completedCheckNote,
  isCheckStartNote,
  type CornerChecksState,
} from './corner-checks.js';
import type { GrantCommandRunner, GrantRunnerEndpoint } from './grant-runner.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE, SOUL_HOUSE_RULE } from './response-directives.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
import { WarmTranscript } from './warm-transcript.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';
import { TurnTrace, TurnTraceFile, type TurnTraceSink } from './turn-trace.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

const execFileAsync = promisify(execFile);
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
  return input ? { input: clampBytes(redactToolDetail(input), TOOL_ARGUMENT_MAX_BYTES) } : {};
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
  requestedBy?: { pubkey: string; name?: string },
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
    ...(requestedBy ? { requestedBy } : {}),
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
  /** The daemon's command-grant runner; this corner registers its worktree and current turn. */
  grantRunner?: GrantCommandRunner;
  grantRunnerEndpoint?: GrantRunnerEndpoint;
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
  /** The configuration the live session baked in; a change invalidates it. */
  private sessionFingerprint?: string;
  /** What this exact ACP session has already been prompted with (`warm-transcript.ts`). */
  private readonly warmTranscript = new WarmTranscript();
  /** The live session's environment, read back for pi's own turn record. */
  private agentEnv: Record<string, string> = {};
  /** OpenRouter providers this activation pinned, in order (C92). */
  private pinnedProviders: string[] = [];
  /** Whether the pinned model takes images; `undefined` when the pin did not say. */
  private modelTakesImages?: boolean;
  /** The one provider re-pinned after an empty completion, until the session ends. */
  private pinnedProviderOverride?: string;
  private turnIdentityInstructions = '';
  private busy = false;
  private forcedStop = false;
  private activityTail = Promise.resolve();
  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
  private attachmentDir?: string;
  /** The session's TMPDIR, where a granted command's script argument may also live. */
  private sessionScratchDir?: string;
  /** The turn in flight and who asked for it, for ledger rows and the grant runner. */
  private currentTurn?: { requestId: string; requester?: { pubkey: string; name?: string } };
  /** Operator-local turn traces; built once when the daemon configured a directory. */
  private turnTraceSink?: TurnTraceSink;
  private memberNames = new Map<string, string>();
  /** The last server check state that started a turn; the same state never starts another. */
  private lastChecksState?: CornerChecksState;

  constructor(private readonly options: MonolithCornerTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
    options.grantRunner?.register(options.cornerId, {
      workspaceId: options.workspaceId,
      cwd: options.worktreePath,
      // A corner is the surface with `run-host-command`: its worktree becomes a
      // branch and a pull request, and host work belongs here, next to the
      // transcript that explains it. A granted command runs unwrapped (C94).
      writePolicy: () => ({
        surface: 'corner',
        ...(this.sessionScratchDir ? { scratch: this.sessionScratchDir } : {}),
      }),
      turn: () => this.currentTurn,
    });
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

  private async roster(): Promise<WorkspaceRoster> {
    const roster = await this.options.api.execute('getWorkspaceRoster', {
      agentId: this.agent.publicKey,
      workspaceId: this.options.workspaceId,
    });
    this.memberNames = new Map(roster.members.map((member) => [member.identityId, member.name]));
    return roster;
  }

  /**
   * Drop this corner's live harness process. The next activation starts cold.
   * A rotation is a fact about one live session, so the pin goes with it.
   */
  private async discardSession(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.sessionFingerprint = undefined;
    this.pinnedProviderOverride = undefined;
    if (client?.isAlive) await client.stop();
  }

  /** See `MonolithRoomTurnLoop.sessionIsCurrent`: retention never keeps a
   *  session whose persona or model pin the operator has since changed. */
  private async sessionIsCurrent(): Promise<boolean> {
    return (await this.currentSessionFingerprint()) === this.sessionFingerprint;
  }

  private async currentSessionFingerprint(): Promise<string> {
    const [configuration, roster] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.cornerId,
      }),
      this.roster(),
    ]);
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    return sessionConfigFingerprint({
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
    });
  }

  private async activate(trace?: TurnTrace): Promise<string> {
    if (this.client?.isAlive && this.sessionId) return this.sessionId;
    trace?.noteActivation('cold');
    const [configuration, roster] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.cornerId,
      }),
      this.roster(),
    ]);
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const fingerprint = sessionConfigFingerprint({
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
    });
    await mkdir(this.options.worktreePath, { recursive: true });
    const selection =
      configuration.model || configuration.effort
        ? { model: configuration.model, effort: configuration.effort }
        : this.options.config.modelSelection;
    const homeOverlay = this.options.config.agentHomeRoot
      ? await prepareRoomAgentHome({
          root: this.options.config.agentHomeRoot,
          sharedSkills: this.options.config.sharedSkills ?? [],
          ...(this.options.config.agentKind ? { agentKind: this.options.config.agentKind } : {}),
          ...(this.options.config.operatorHome
            ? { operatorHome: this.options.config.operatorHome }
            : {}),
          ...openRouterRoutingInput(this.options.config, selection, this.options.fetchImpl, {
            ...(this.pinnedProviderOverride
              ? { providerOverride: this.pinnedProviderOverride }
              : {}),
            onDecision: (routing) => {
              if (!this.pinnedProviderOverride) this.pinnedProviders = [...routing.providers];
              // See `MonolithRoomTurnLoop.acceptsImages` (C87).
              this.modelTakesImages = routing.input ? routing.input.includes('image') : undefined;
            },
          }),
        })
      : {};
    const command = this.options.config.agentCommand ?? this.options.config.agentBinary;
    const agentEnv: Record<string, string> = {
      ...this.options.config.agentEnv,
      ...homeOverlay,
      GH_TOKEN: this.options.githubToken,
      GITHUB_TOKEN: this.options.githubToken,
    };
    this.agentEnv = agentEnv;
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
    this.sessionScratchDir = tmpDir;
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
        // The whole per-session overlay, not an enumerated subset: see
        // `monolith-room-turn.ts`'s matching comment.
        attachScratchRoot: this.options.config.agentHomeRoot ?? tmpDir,
        ...(this.options.grantRunnerEndpoint
          ? { grantRunner: this.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    const persona = configuration.soul ?? self?.soul;
    const identityInstructions = `Your Beeline identity is ${self?.name ?? this.agent.name}.`;
    // The house rule stands whether or not a soul does: a Workspace that has
    // switched seeded souls off still runs its agents under it.
    const personaInstructions = [
      ...(persona?.instructions
        ? [`Human-authored Workspace persona: ${persona.name}. ${persona.instructions}`]
        : []),
      SOUL_HOUSE_RULE,
    ].join('\n');
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
        'GitHub check and merge notes are server lines already in the corner: never restate them (no "checks passed", "CI is green", "PR ready for review"). On a checks turn, say nothing unless you act - a merge or a pushed fix - and then one short line about that.',
        'A human approval in the app asks the server to merge. When approval is pending, wait for the server close request instead of racing it with gh. If checks passed, no hold exists, and no approval is pending, merge the pull request yourself with gh.',
        'Never push directly to the target branch. Never merge a different pull request.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.sessionId = opened.sessionId;
    this.sessionFingerprint = fingerprint;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      await applyAgentModelSelection(this.client, opened.sessionId, options, selection);
    }
    return opened.sessionId;
  }

  /** The scheduler seam: `queue-wait` closes when a slot buys a session. */
  private lifecycle(trace?: TurnTrace): SessionLifecycle {
    return {
      activate: async () => {
        trace?.end('queue-wait');
        // `cold` is noted inside activate(): see MonolithRoomTurnLoop.
        return trace ? trace.measure('activation', () => this.activate(trace)) : this.activate();
      },
      isCurrent: () => {
        trace?.end('queue-wait');
        const check = () => this.sessionIsCurrent();
        return trace ? trace.measure('activation', check) : check();
      },
      onStateChange: (state) => {
        if (state === 'waiting-for-slot') trace?.noteCapacityWait();
      },
      suspend: () => this.discardSession(),
    };
  }

  /** A picture reaches the model only if the harness AND the model take one (C87). */
  private acceptsImages(): boolean {
    if (!(this.client?.canPromptWithImages() ?? false)) return false;
    return this.modelTakesImages ?? true;
  }

  /** The pinned providers a failure reason should name for this session. */
  private servingProviders(): string[] {
    return this.pinnedProviderOverride ? [this.pinnedProviderOverride] : this.pinnedProviders;
  }

  /** Why a turn carried no answer text, or undefined when it did. */
  private async explainEmpty(result: PromptResult): Promise<EmptyTurnExplanation | undefined> {
    if (durableReplyText(result.agentText)) return undefined;
    return explainEmptyAgentTurn({
      agentLabel: this.options.config.agentCommand ?? this.options.config.agentBinary,
      agentEnv: this.agentEnv,
      sessionId: this.sessionId!,
      result,
    });
  }

  /**
   * Re-pin the session to the next provider in the OpenRouter order and open a
   * fresh session on it, so the retry of an empty completion is served — and
   * named — by exactly one provider (C92).
   */
  private async repinNextProvider(
    trace?: TurnTrace,
    reason?: string,
  ): Promise<string | undefined> {
    const next = nextPinnedProvider(this.pinnedProviders, this.pinnedProviderOverride);
    if (!next) return undefined;
    // The retry is its own timeline, fresh ACP handshake included.
    trace?.retry({ provider: next, ...(reason ? { reason } : {}) });
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.sessionFingerprint = undefined;
    if (client?.isAlive) await client.stop();
    this.pinnedProviderOverride = next;
    await (trace ? trace.measure('activation', () => this.activate(trace)) : this.activate());
    return next;
  }

  /** One turn's stopwatch; writes only when the daemon configured a trace directory. */
  private beginTurnTrace(requestId: string): TurnTrace {
    const directory = this.options.config.turnTraceDir;
    if (directory) this.turnTraceSink ??= new TurnTraceFile(directory);
    return new TurnTrace({
      surface: 'corner',
      agentId: this.agent.publicKey,
      roomId: this.options.cornerId,
      requestId,
      ...(this.turnTraceSink ? { sink: this.turnTraceSink } : {}),
    });
  }

  private async prompt(
    requestId: string,
    trigger: string,
    attachments: readonly DaemonAttachment[] = [],
    requestedById?: string,
    /** Server system lines this turn answers; a reply that only restates them is dropped. */
    restates?: readonly string[],
  ): Promise<void> {
    const { api, cornerId } = this.options;
    const spoken = (text: string): string =>
      restates && isCornerStatusRestatement(text, restates) ? '' : text;
    const requester = requestedById
      ? {
          pubkey: requestedById,
          ...(this.memberNames.get(requestedById)
            ? { name: this.memberNames.get(requestedById)! }
            : {}),
        }
      : undefined;
    this.currentTurn = { requestId, ...(requester ? { requester } : {}) };
    const trace = this.beginTurnTrace(requestId);
    try {
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: this.agent.publicKey,
          roomId: cornerId,
          requestId,
          generationId: `${this.agent.publicKey}:${cornerId}`,
        },
        () => {
          trace.noteScheduler('queue', this.options.scheduler.snapshot());
          trace.start('queue-wait');
          return this.options.scheduler.run(
            cornerId,
            this.lifecycle(trace),
            async () => {
              // Belt and braces: `activate`/`isCurrent` already closed the
              // queue wait, and `end` on a closed phase is a no-op.
              trace.end('queue-wait');
              trace.noteScheduler('admission', this.options.scheduler.snapshot());
              if (this.forcedStop) throw new Error('corner turn stopped for daemon handoff');
              this.busy = true;
              const [conversation, roster, delivered] = await trace.measure('context-fetch', () =>
                Promise.all([
                  api.execute('getRoomConversation', { roomId: cornerId, limit: 200 }),
                  this.roster(),
                  this.attachmentDir && attachments.length
                    ? deliverAttachments(
                        attachments,
                        join(this.attachmentDir, requestId.replace(/[^\w-]/g, '_')),
                        this.options.fetchImpl,
                      )
                    : Promise.resolve<DeliveredAttachment[]>([]),
                ]),
              );
              const names = new Map(
                roster.members.map((member) => [member.identityId, member.name]),
              );
              const requestedBy =
                requester && !requester.name && names.get(requester.pubkey)
                  ? { ...requester, name: names.get(requester.pubkey)! }
                  : requester;
              if (requestedBy) this.currentTurn = { requestId, requester: requestedBy };
              const transcriptRows = conversation.items.slice(-120).map((message) => ({
                id: message.id,
                line: `${names.get(message.authorId) ?? 'Beeline'} [${message.type}]: ${message.body}`,
              }));
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // transcript. The objective is outside the window and always
              // renders, warm session or not.
              const buildPrompt = (): string => [
                this.turnIdentityInstructions,
                `Corner objective:\n${this.options.objective}`,
                WarmTranscript.render(
                  this.warmTranscript.select(this.sessionId, transcriptRows),
                  'Corner transcript:',
                  'New in the corner since your last turn (the earlier transcript is already in this session):',
                ),
                [
                  `Newest trigger:\n${trigger}`,
                  ...attachmentPromptLines(attachments, delivered, this.acceptsImages()),
                ].join('\n'),
                'Continue the objective. Obey the PR checks and human hold rules in your session instructions.',
                MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE,
              ]
                .filter(Boolean)
                .join('\n\n');
              // Rooms and corners stream through ONE presentation (C100): the
              // provisional draft lane, the request-id handoff, and the single
              // durable reply that dissolves it all live in `turn-stream.ts`.
              const stream = new AgentTurnStream({
                api,
                agentId: this.agent.publicKey,
                roomId: cornerId,
                requestId,
                label: `corner ${cornerId}`,
              });
              const publishedToolCalls = new Set<string>();
              const publishToolCalls = (calls: readonly ToolCallEntry[], settledOnly: boolean) => {
                calls.forEach((call, index) => {
                  const key = toolCallKey(call, index);
                  if (publishedToolCalls.has(key) || (settledOnly && !toolCallSettled(call)))
                    return;
                  publishedToolCalls.add(key);
                  this.activityTail = this.activityTail
                    .catch(() => undefined)
                    .then(async () => {
                      const activity = await cornerToolActivity(
                        call,
                        this.options.worktreePath,
                        requestedBy,
                      );
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
              // One prompt run. It is a closure because an empty completion
              // re-pins the session to another provider and runs it again
              // (C92) — against the NEW client and session id.
              const runPrompt = async (): Promise<PromptResult> => {
                stream.beginRun();
                trace.promptSent();
                return this.client!.sessionPrompt(
                  this.sessionId!,
                  promptWithImages(
                    buildPrompt(),
                    attachmentImageBlocks(delivered, this.acceptsImages()),
                  ),
                  120_000,
                  (delta, full) => {
                    trace.firstModelOutput();
                    stream.onChunk(delta, full);
                  },
                  undefined,
                  (calls) => {
                    trace.toolCalls(calls);
                    publishToolCalls(calls, true);
                  },
                );
              };
              let result = await runPrompt();
              trace.promptSettled();
              let explained = await this.explainEmpty(result);
              // A checks turn is told to say nothing when nothing changed; its
              // silence is not a routing failure and must not buy a retry.
              if (explained && !restates && shouldRetryEmptyTurn(explained)) {
                const silent = this.servingProviders();
                const next = await this.repinNextProvider(trace, explained.reason);
                if (next) {
                  console.warn(
                    `[thin-core] corner ${cornerId} turn ${requestId}: ` +
                      `${turnFailureReasonWithProvider(explained.reason, silent)}; retrying on ${next}`,
                  );
                  result = await runPrompt();
                  trace.promptSettled();
                  explained = await this.explainEmpty(result);
                }
              }
              await this.activityTail;
              publishToolCalls(result.toolCalls, false);
              // A refusal the operator cannot read is a refusal that happens twice.
              for (const call of result.toolCalls) {
                const failure = toolCallFailureLine(call);
                if (failure) console.warn(`[thin-core] corner ${cornerId} ${failure}`);
              }
              await this.activityTail;
              // Close the draft lane before the answer is published: the finished
              // reply must never queue behind a draft nobody will read.
              stream.close();
              let reply = durableReplyText(result.agentText);
              if (!reply && explained) {
                reply = explained.recoveredText ? durableReplyText(explained.recoveredText) : '';
                // A checks turn is told to say nothing when nothing changed; only a
                // provider refusal makes that silence a failure.
                if (!reply && !(restates && !isAccountOrProviderRefusal(explained.record))) {
                  throw new Error(
                    turnFailureReasonWithProvider(explained.reason, this.servingProviders()),
                  );
                }
                console.warn(
                  `[thin-core] corner ${cornerId} turn ${requestId}: ${explained.reason}`,
                );
              }
              // The reply is posted WHOLE, never a slice: a corner that narrated
              // before a tool call still lands its closing message. A reply that
              // only restates the server's own check notes says nothing new, and
              // that turn settles through its receipt instead.
              await trace.measure('publish', () => stream.settle(spoken(reply)));
            },
            { priority: 'interactive', roomKey: cornerId },
          );
        },
        (error) => console.error(`[thin-core] corner ${cornerId} receipt heartbeat failed:`, error),
      );
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: 'complete',
        generationId: `${this.agent.publicKey}:${cornerId}`,
      });
      // After the receipt: an operator artifact never delays the answer, and
      // never becomes one — the trace has no way to post a Room row.
      await trace.finish('complete');
    } catch (error) {
      const reason = distillTurnFailureReason(error);
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: 'failed',
        generationId: `${this.agent.publicKey}:${cornerId}`,
        reason,
      });
      await trace.finish('failed', reason);
      throw error;
    } finally {
      this.busy = false;
      this.currentTurn = undefined;
    }
  }

  /** The server's check state for this head, or the notes' own verdict when the server carries none. */
  private async checksState(
    notes: readonly { readonly type: string; readonly body: string }[],
  ): Promise<CornerChecksState | undefined> {
    try {
      const restore = await this.options.api.execute('getCornerRestoreState', {
        cornerId: this.options.cornerId,
      });
      const fromServer = checksStateFromLifecycle(restore.lifecycle);
      if (fromServer) return fromServer;
    } catch (error) {
      console.error(`[thin-core] corner ${this.options.cornerId} check state read failed:`, error);
    }
    return notes.some((note) => completedCheckNote(note) === 'failed') ? 'failing' : 'passing';
  }

  async run(): Promise<void> {
    const { api, cornerId, signal } = this.options;
    let cursor = (await api.execute('getRoomInbox', { roomId: cornerId, startAtLatest: true }))
      .cursor;
    // Newest page: "has this corner already answered?" is a question about the
    // work as it stands now. On a corner past one page the oldest rows say
    // nothing about whether the objective still needs kicking off.
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
          // Server check notes arrive one per GitHub run; a poll's worth of them
          // is one fact, and only a changed server check state starts a turn.
          const checkNotes: (typeof inbox.items)[number][] = [];
          for (const item of inbox.items) {
            if (item.type === 'message') {
              if (item.authorId === this.agent.publicKey) continue;
              const authority = await api.execute('getRoomAuthority', {
                roomId: cornerId,
                principalId: item.authorId,
              });
              if (!authority.member || authority.principalKind !== 'human') continue;
              await this.prompt(item.id, item.body, item.attachments, item.authorId);
              pollWithoutWait = true;
              continue;
            }
            // The owner's grant decision (server-gated, mentioning this agent)
            // resumes the paused work; the server's checks note starts a turn.
            const grantDecision =
              item.type === 'system' &&
              item.mentionIds.includes(this.agent.publicKey) &&
              parseGrantDecisionLine(item.body) !== undefined;
            if (grantDecision) {
              await this.prompt(
                item.id,
                `${item.body}\nThis answers your grant request; resume the paused work. If approved and it is a command grant, run it with run_granted_command and the exact argv; if declined, try another way or say what you cannot do.`,
                [],
                item.authorId,
              );
              pollWithoutWait = true;
              continue;
            }
            if (isCheckStartNote(item)) {
              // A new head is being checked: its verdict is a fresh fact.
              this.lastChecksState = undefined;
              continue;
            }
            if (completedCheckNote(item)) checkNotes.push(item);
          }
          if (checkNotes.length) {
            const state = await this.checksState(checkNotes);
            if (state && state !== 'pending' && state !== this.lastChecksState) {
              this.lastChecksState = state;
              const lines = checkNotes.map((note) => note.body);
              await this.prompt(
                checkNotes[checkNotes.length - 1]!.id,
                lines.join('\n'),
                [],
                undefined,
                lines,
              );
              pollWithoutWait = true;
            }
          }
          cursor = inbox.cursor ?? cursor;
          this.options.onPoll();
          await wait(pollWithoutWait ? 0 : (this.options.pollMs ?? cornerClosePollMs()), signal);
          pollWithoutWait = false;
        } catch (error) {
          if (signal?.aborted) break;
          this.options.onFailure(1_000);
          console.error(`[thin-core] corner ${cornerId} turn loop failed:`, error);
          await wait(1_000, signal);
        }
      }
    } finally {
      this.options.grantRunner?.unregister(cornerId);
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
