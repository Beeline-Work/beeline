import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DaemonAttachment, DaemonOperationMap } from '@beeline/api-contract/daemon';
import {
  AcpClient,
  isPureRetryNarration,
  type McpServerWire,
  type PromptResult,
  type ToolCallEntry,
} from './acp.js';
import {
  expectedMountedImportedMcpServerNames,
  grantedSquireHostBindPaths,
  harnessStateDirsFromEnv,
  hostImportedMcpDeclarations,
  prepareRoomAgentHome,
} from './agent-home.js';
import { claimGrantedHostRoutes, grantedHostRouteWires } from './host-mcp-route.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { agentCommandCatalogPublisher } from './agent-command-catalog.js';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  promptWithImages,
  type DeliveredAttachment,
} from './attachment-delivery.js';
import { isCornerStatusRestatement, isDeliberateCornerNoReply } from './reply-sanitizer.js';
import { TurnStoppedError } from './turn-stop.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { toolCallFailureLine } from './tool-call-failure.js';
import { captureConnectionUsage, ConnectorUsageRecorder } from './connector-runner.js';
import { distillTurnFailureReason, redactToolDetail } from './turn-failure-reason.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { syncCornerBranch } from './corner-branch-sync.js';
import { beelineAgentMcpServer, youtubeMcpServer } from './room-session.js';
import {
  codegraphFingerprintServers,
  codegraphMcpServer,
  prepareCodegraphIndex,
} from './codegraph.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import { harnessIdentityLabel } from './cursor-acp-bridge.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import type { BodyConfig } from './config.js';
import { type DaemonApiClient } from './daemon-api-client.js';
import {
  explainEmptyAgentTurn,
  isAccountOrProviderRefusal,
  nextPinnedProvider,
  shouldRetryEmptyTurn,
  turnFailureReasonWithProvider,
  type EmptyTurnExplanation,
} from './empty-turn.js';
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
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { isConfiguredReviewer } from './beeline-skill.js';
import {
  harvestWarmNodeModules,
  sharedNpmCacheDir,
  warmNodeModulesStoreDir,
} from './warm-node-modules.js';
import { roomMentionDirectory } from './monolith-room-turn.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];
type ReviewerInstructionInput = Parameters<typeof cornerReviewerInstruction>[0];

const execFileAsync = promisify(execFile);
const TOOL_ARGUMENT_MAX_BYTES = 1_200;
const TOOL_OUTPUT_MAX_BYTES = 3_200;
const TOOL_PATH_LIMIT = 12;

export function cornerMergeInstruction(yoloMode: boolean, reviewerHandle?: string): string {
  if (reviewerHandle)
    return `Commit, push, open the PR, and reply with the URL; do not merge until @${reviewerHandle} has reviewed — you are woken when that review ends, whether or not it tags you — then call pr_checks_status and merge with gh pr merge --squash --match-head-commit <sha> only if the complete gate passes.`;
  return yoloMode
    ? 'Yolo is on: when the gate passes, merge this pull request with gh.'
    : 'Yolo is off: never merge; wait for a human owner to turn yolo on or merge the pull request themselves.';
}

export function cornerReviewerInstruction(input: {
  reviewerHandle?: string;
  agentHandle?: string;
  authorHandle?: string;
  openedByAgent: boolean;
  pullRequestNumber?: number;
  headSha?: string;
}): string | undefined {
  if (
    !input.reviewerHandle ||
    !input.agentHandle ||
    input.openedByAgent ||
    input.agentHandle.replace(/^@/, '') !== input.reviewerHandle.replace(/^@/, '')
  )
    return undefined;
  const author = input.authorHandle?.replace(/^@/, '') || 'author';
  const number = input.pullRequestNumber ?? 'N';
  const headSha = input.headSha ?? '<head sha>';
  return `Checks are green on PR #${number} at ${headSha}. Review it now with the beeline-review skill against that exact head. FAIL: reply \`@${author}\` with the confirmed findings to fix. PASS: call the approve_merge tool for ${headSha}, then reply \`@${author} approved ${headSha}, merge\`. Never merge yourself. Never say you are holding or waiting for checks.`;
}

export const CORNER_REVIEWER_SESSION_INSTRUCTION =
  "You are this Room's configured reviewer. The active turn prompt names the latest stable green PR head. Review and approve only that exact head; if no stable green head is named, end the turn without a verdict. Never merge yourself.";

export const CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION =
  'There is no stable green PR head for this active reviewer turn. Do not review or call approve_merge. End this turn without a verdict; the next green transition will wake you.';

/**
 * A Room's sole configured reviewer who also opens its own corner has no
 * other reviewer to wait on: `cornerReviewerInstruction` never fires for an
 * opener, so without this the ordinary author instructions would tell this
 * agent to wait for `@<its own handle>` to tag it, a permanent deadlock.
 */
export function cornerSelfReviewerInstruction(input: {
  reviewerHandle?: string;
  agentHandle?: string;
  openedByAgent: boolean;
}): string | undefined {
  if (
    !input.reviewerHandle ||
    !input.agentHandle ||
    !input.openedByAgent ||
    input.agentHandle.replace(/^@/, '') !== input.reviewerHandle.replace(/^@/, '')
  )
    return undefined;
  return "You are this Room's reviewer, so your own pull request needs no review: do not request one, do not tag any agent for review, and merge yourself with gh once checks pass and no hold exists.";
}

export const CORNER_AUTHOR_CONTRACT = `The objective text is the user's ask. Keep it verbatim in your head and do not reinterpret it.
Before any code, write its end-user story in one sentence: "a person who does X sees Y".
Follow the beeline-triage skill's bugfix execution contract when the objective reports a defect.
Attempt to reproduce it as triage isolated it, using every tool the host offers: emulator, Playwright, browser, test runner. Record what was tried and what was observed. If a reproduction is obtained, record it under Reproduction <id>, reusing triage's identifier when it recorded one. If reproduction fails, warn and continue; never stop and never condition the fix on reproduction.
Narrow the fix to the reported behavior. When a reproduction exists, change only what removes it.
Before opening the pull request, produce Y against the built change: run the app or affected service from your branch and perform X.
If no interactive surface is reachable, run the narrowest test or script that exercises the exact user path and prints the observable Y.
A unit test of an inner function, a log line, or reading the code is not a demonstration.
The pull request body MUST contain two sections with exactly these headings: ## Reproduced and ## Demonstrated.
Under ## Reproduced, name Reproduction <id> and give the steps or command and what was observed; write "not obtained" when reproduction failed, or "not a defect report" for feature work.
Under ## Demonstrated, cite the same identifier and show that reproduction now passing when one exists; when none was obtained, state that plainly and show the regression instead.
A pull request without both sections is not deliverable and the Room's reviewer will fail it.
Change only what the objective asks. No unrequested features, flags, compatibility shims, or refactors.`;

export const CORNER_DELIVERY_NUDGE =
  'Before ending this turn, inspect the repository state and finish delivering the work: commit and push the intended changes and open the pull request if one does not exist. Decide yourself whether any remaining dirty work belongs to the objective; do not discard it merely to make the worktree clean. The pull request body must carry ## Reproduced and ## Demonstrated; if they are missing, add them before ending the turn.';

export const CORNER_YOLO_MERGE_NUDGE =
  'Yolo is on. Check the server merge gate with pr_checks_status now and, if checks="passed", held=false, and approvalPending=false, merge this pull request with gh. If checks="unknown", reply in this corner with the tool reason and stop instead of retrying. Otherwise stop without merging.';

function isCornerChecksTurn(trigger: string, restates?: readonly string[]): boolean {
  return Boolean(restates) || /\b(?:passed|failed) a check\b/i.test(trigger);
}

export async function cornerHasUndeliveredRepositoryWork(
  worktreePath: string,
  featureBranch?: string,
  targetBranch?: string,
): Promise<boolean> {
  return Boolean(await cornerUndeliveredRepositoryState(worktreePath, featureBranch, targetBranch));
}

async function cornerUndeliveredRepositoryState(
  worktreePath: string,
  featureBranch?: string,
  targetBranch?: string,
): Promise<string | undefined> {
  try {
    const [{ stdout: status }, ahead] = await Promise.all([
      execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain=v1']),
      featureBranch
        ? firstResolvedRemoteRef(worktreePath, [featureBranch, targetBranch])
            .then((remoteRef) =>
              remoteRef
                ? execFileAsync('git', [
                    '-C',
                    worktreePath,
                    'rev-list',
                    '--count',
                    `${remoteRef}..HEAD`,
                  ]).then(({ stdout }) => Number.parseInt(stdout.trim(), 10) || 0)
                : 0,
            )
            .catch(() => 0)
        : Promise.resolve(0),
    ]);
    const dirty = status.trimEnd();
    return dirty || ahead > 0 ? `${dirty}\nahead:${ahead}` : undefined;
  } catch {
    return undefined;
  }
}

async function firstResolvedRemoteRef(
  worktreePath: string,
  branches: readonly (string | undefined)[],
): Promise<string | undefined> {
  for (const branch of branches) {
    if (!branch) continue;
    const ref = `refs/remotes/origin/${branch}`;
    const resolved = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--verify', ref])
      .then(() => true)
      .catch(() => false);
    if (resolved) return ref;
  }
  return undefined;
}

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
  return call.id ? `id-${createHash('sha256').update(call.id).digest('hex')}` : `tool-${index}`;
}

function toolCallSettled(call: ToolCallEntry): boolean {
  if (call.resultReceived) return true;
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
  /**
   * The agent that opened the corner. History and the initial lifecycle
   * carrier only; command dispatch is selected by the server.
   */
  openedBy?: string;
  objective: string;
  worktreePath: string;
  /** The human who commissioned the corner, as a bare handle. Who a no-code corner reports back to. */
  requesterHandle?: string;
  /** Present only when the parent Room is bound to a repository AND the corner is on the code lane. */
  repository?: {
    featureBranch: string;
    targetBranch: string;
    gitCommonDir: string;
    githubToken: string;
  };
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: SessionScheduler;
  signal?: AbortSignal;
  pollMs?: number;
  /** Close-request recovery interval (test seam); defaults to the jittered 10 min. */
  closePollMs?: number;
  onPoll(): void;
  onFailure(retryInMs: number): void;
  onCloseRequested(): Promise<void>;
  onRestartRequested?: () => void;
  canStartTurn?: () => boolean;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  /** Attachment downloads (test seam). */
  fetchImpl?: typeof fetch;
  /** The daemon's command-grant runner; this corner registers its worktree and current turn. */
  grantRunner?: GrantCommandRunner;
  grantRunnerEndpoint?: GrantRunnerEndpoint;
  /** Connection usage capture: batched per turn into one postConnectionUsage. */
  connectorUsage?: ConnectorUsageRecorder;
  /** Local YouTube MCP — only when this helper already holds the Google grant. */
  youtubeAccessToken?: string;
}

/**
 * Close-request recovery poll: 10 min ± up to 3 s of jitter.
 * `corner-complete` on the live socket closes immediately via `requestClose`.
 * The GET is the dropped-socket net: once at intake start, once after a turn
 * (a close during that turn must not wait the idle interval), then only every
 * 10 min while idle.
 */
export const CORNER_CLOSE_POLL_BASE_MS = 10 * 60_000;
export function cornerClosePollMs(random: () => number = Math.random): number {
  return CORNER_CLOSE_POLL_BASE_MS + Math.floor(random() * 3_000);
}

/** One write-enabled corner session, driven only by monolith transcript facts. */
export class MonolithCornerTurnLoop {
  private readonly commandContext: CommandExecutionContext;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private wakeIntake?: () => void;

  /**
   * Called by the daemon's one slow workspace reconciliation sweep, and by the
   * fast reconcile a socket reconnect arms. A `corner-complete` published while
   * that socket was down is never replayed, so the sweep clears the close
   * throttle too: the durable read is what recovers the frame nobody heard.
   *
   * The wake is the intake loop's own stable notify and is handed back exactly
   * once, so it is kept: clearing it here left `requestClose` waking nothing
   * after the first sweep, and a pushed `corner-complete` then waited out the
   * idle timer. Intake clears it itself when it exits.
   */
  requestReconciliation(): void {
    this.lastCloseCheck = 0;
    this.wakeIntake?.();
  }
  private client?: AcpClient;
  private sessionId?: string;
  /** The configuration the live session baked in; a change invalidates it. */
  private sessionFingerprint?: string;
  /** Whether CodeGraph preparation succeeded for the live session. */
  private sessionCodegraphReady = false;
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
  /** The merge authority baked into the current session. */
  private yoloMode = false;
  /** The live parent-Room reviewer baked into the current session. */
  private reviewerHandle?: string;
  /** Identity-only reviewer context; the exact PR head is refreshed inside each active turn. */
  private reviewerInstructionInput?: ReviewerInstructionInput;
  /** The role-specific second-chance instruction for this session. */
  private cornerTurnEndNudge = CORNER_DELIVERY_NUDGE;
  /** Repository state already given a delivery reminder, until that state changes. */
  private lastDeliveryNudgeState?: string;
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
  /** Agent identities in this Workspace, so a mention can be told from a human's. */
  /** Per-sender continuity, shared in shape with top-level Room intake. */
  /** The member agent that owns corner-wide lifecycle facts such as checks. */
  /** The last server check state that started a turn; the same state never starts another. */
  /**
   * Request ids the requester has stopped. A corner's intake is blocked while
   * its turn runs, so a stop is recorded from the live-push callback and read
   * back here; ids that never matched a running turn are harmless and bounded
   * by the same replay window the inbox already de-duplicates over.
   */
  private readonly stoppedTurns = new Set<string>();
  /** Live corner-complete: close now, do not wait for the recovery GET. */
  private closePushed = false;
  /** Last durable close read; 0 means the first check still runs. */
  private lastCloseCheck = 0;
  /** This corner's own jittered recovery interval, drawn once. */
  private readonly closePollMs: number;

  /** In-flight warm-store harvest, awaited at shutdown and never by a turn. */
  private harvest: Promise<void> | undefined;

  constructor(private readonly options: MonolithCornerTurnOptions) {
    this.closePollMs = options.closePollMs ?? cornerClosePollMs();
    this.agent = runtimeIdentity(options.runtime.agent);
    this.commandContext = new CommandExecutionContext(options.config.agentHomeRoot);
    this.options = { ...options, api: this.commandContext.bind(options.api) };
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
      turn: () =>
        this.currentTurn
          ? { ...this.currentTurn, generationId: this.commandContext.generationId }
          : undefined,
    });
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** corner-complete on the wire: wake intake so `closed()` reaps now. */
  requestClose(): void {
    this.closePushed = true;
    this.wakeIntake?.();
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

  /**
   * Obey a stop the requester already made a fact.
   *
   * The id is remembered whether or not it names the turn in flight: a stop for
   * work not yet started must still keep that work from starting, and one for a
   * turn that has already ended is simply never read again. Only the session
   * actually running the stopped turn is cancelled.
   */
  private stopTurn(requestId: string): void {
    this.stoppedTurns.add(requestId);
    while (this.stoppedTurns.size > 500)
      this.stoppedTurns.delete(this.stoppedTurns.values().next().value!);
    if (this.currentTurn?.requestId !== requestId) return;
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
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
    this.sessionCodegraphReady = false;
    this.pinnedProviderOverride = undefined;
    if (client?.isAlive) await client.stop();
  }

  /** See `MonolithRoomTurnLoop.sessionIsCurrent`: retention never keeps a
   *  session whose persona, model pin, or mounted MCP set the operator has
   *  since changed. */
  private async sessionIsCurrent(): Promise<boolean> {
    return (await this.currentSessionFingerprint()) === this.sessionFingerprint;
  }

  private async currentSessionFingerprint(): Promise<string> {
    const [configuration, roster, grantedHostRoutes] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.cornerId,
      }),
      this.roster(),
      this.grantedHostRoutes(),
    ]);
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    return sessionConfigFingerprint({
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
      yoloMode: configuration.yoloMode,
      mcpServers: codegraphFingerprintServers(
        this.options.config,
        expectedMountedImportedMcpServerNames({
          operatorHome: this.options.config.operatorHome,
          agentKind: this.options.config.agentKind,
          grantedHostRoutes,
        }),
        this.sessionCodegraphReady,
      ),
      reviewerHandle: configuration.reviewerHandle,
    });
  }

  private async grantedHostRoutes(): Promise<string[]> {
    try {
      return claimGrantedHostRoutes(
        await this.options.api.execute('listAgentGrants', {
          agentId: this.agent.publicKey,
          roomId: this.options.cornerId,
        }),
        (grantId) => this.options.api.execute('consumeAgentGrant', { grantId }),
      );
    } catch {
      return [];
    }
  }

  private async activate(trace?: TurnTrace): Promise<string> {
    if (this.client?.isAlive && this.sessionId) return this.sessionId;
    trace?.noteActivation('cold');
    const [configuration, roster, grantedHostRoutes] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.cornerId,
      }),
      this.roster(),
      this.grantedHostRoutes(),
    ]);
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    this.yoloMode = configuration.yoloMode;
    this.reviewerHandle = configuration.reviewerHandle;
    const opener = this.options.openedBy
      ? roster.members.find((member) => member.identityId === this.options.openedBy)
      : undefined;
    const reviewerInput = {
      reviewerHandle: configuration.reviewerHandle,
      agentHandle: self?.handle,
      authorHandle: opener?.handle,
      openedByAgent: !this.options.openedBy || this.options.openedBy === this.agent.publicKey,
    };
    const reviewerInstruction = cornerReviewerInstruction(reviewerInput)
      ? CORNER_REVIEWER_SESSION_INSTRUCTION
      : undefined;
    this.reviewerInstructionInput = reviewerInstruction ? reviewerInput : undefined;
    const selfReviewerInstruction = cornerSelfReviewerInstruction(reviewerInput);
    this.cornerTurnEndNudge =
      reviewerInstruction ??
      selfReviewerInstruction ??
      cornerMergeInstruction(configuration.yoloMode, configuration.reviewerHandle);
    await mkdir(this.options.worktreePath, { recursive: true });
    const selection =
      configuration.model || configuration.effort
        ? { model: configuration.model, effort: configuration.effort }
        : this.options.config.modelSelection;
    const homeOverlay = this.options.config.agentHomeRoot
      ? await prepareRoomAgentHome({
          root: this.options.config.agentHomeRoot,
          sharedSkills: this.options.config.sharedSkills ?? [],
          isReviewer: isConfiguredReviewer(self?.handle, configuration.reviewerHandle),
          grantedHostRoutes,
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
    const harnessLabel = harnessIdentityLabel({
      kind: this.options.config.agentKind,
      command,
    });
    const repository = this.options.repository;
    let githubEnv: Record<string, string> = repository
      ? { GH_TOKEN: repository.githubToken, GITHUB_TOKEN: repository.githubToken }
      : {};
    if (repository && this.options.config.runtimeConfigPath && this.options.config.agentHomeRoot) {
      const gitBinary = (await execFileAsync('which', ['git'])).stdout.trim();
      const ghBinary = await execFileAsync('which', ['gh'])
        .then((result) => result.stdout.trim())
        .catch(() => undefined);
      githubEnv = await installCornerGitHubWrappers({
        root: this.options.config.agentHomeRoot,
        runtimeConfigPath: this.options.config.runtimeConfigPath,
        roomId: this.options.parentRoomId,
        cliEntrypoint: process.argv[1]!,
        gitBinary,
        featureBranch: repository.featureBranch,
        targetBranch: repository.targetBranch,
        ...(ghBinary ? { ghBinary } : {}),
        inheritedPath: this.options.config.agentEnv.PATH ?? process.env.PATH,
      });
    }
    // One npm cache for every corner on this host. `agent-home.ts` gives each
    // corner its own `$HOME`, so npm's default `$HOME/.npm` is per-corner and
    // every corner re-downloads the same tarballs; this points them all at the
    // shared cache instead. It lives under the supervisor root the sandbox
    // protects, so it also needs the explicit writable re-bind below.
    const npmCacheDir = sharedNpmCacheDir(this.options.runtime.supervisorRoot);
    await mkdir(npmCacheDir, { recursive: true, mode: 0o700 });
    const agentEnv: Record<string, string> = {
      ...this.options.config.agentEnv,
      ...homeOverlay,
      ...githubEnv,
      npm_config_cache: npmCacheDir,
    };
    const operatorHome = this.options.config.operatorHome ?? homedir();
    this.agentEnv = agentEnv;
    const agentArgs = agentArgsWithModelSelection(
      {
        kind: this.options.config.agentKind,
        command,
        args: this.options.config.agentArgs ?? [],
      },
      selection,
    );
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
    this.attachmentDir = tmpDir ? join(tmpDir, 'beeline-attachments') : undefined;
    this.sessionScratchDir = tmpDir;
    const homeStateDirs = harnessHomeStateDirs(harnessLabel, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    // The same path handed to the MCP server as BEELINE_ATTACH_SCRATCH_ROOT
    // (below): post_artifact can only post what write_scratch_file could write,
    // so the sandbox must leave this writable too. It sits under the
    // protected supervisorRoot above, so it needs its own re-bind.
    const attachScratchRoot = this.options.config.agentHomeRoot ?? tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    const spawnCommand = wrapAgentCommand({
      bwrapPath: this.options.config.bwrapPath,
      spec: {
        mode: 'edit',
        cwd: this.options.worktreePath,
        worktreePath: this.options.worktreePath,
        ...(repository ? { gitCommonDir: repository.gitCommonDir } : {}),
        protectedPaths: [this.options.runtime.supervisorRoot],
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
        additionalWritablePaths: [
          ...(attachScratchRoot ? [attachScratchRoot] : []),
          // The shared npm cache. npm writes to its cache on every install,
          // and this one is deliberately outside the per-corner home so the
          // download is paid once per host rather than once per corner.
          npmCacheDir,
          ...grantedSquireHostBindPaths({
            operatorHome,
            agentKind: this.options.config.agentKind,
            grantedHostRoutes,
          }),
        ],
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
      agentLabel: harnessLabel,
      autoApprovePermissions: true,
      permissionHandler: () => Promise.resolve('allow'),
      onCommands: agentCommandCatalogPublisher({
        api: this.options.api,
        agentId: this.agent.publicKey,
        workspaceId: this.options.workspaceId,
      }),
    };
    this.client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await this.client.start();
    const codegraphReady = await prepareCodegraphIndex(
      this.options.config,
      this.options.worktreePath,
    );
    const fingerprint = sessionConfigFingerprint({
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
      yoloMode: configuration.yoloMode,
      mcpServers: codegraphFingerprintServers(
        this.options.config,
        expectedMountedImportedMcpServerNames({
          operatorHome: this.options.config.operatorHome,
          agentKind: this.options.config.agentKind,
          grantedHostRoutes,
        }),
        codegraphReady,
      ),
      reviewerHandle: configuration.reviewerHandle,
    });
    const servers: McpServerWire[] = [
      ...(repository
        ? [
            {
              name: 'buzz-dev-mcp',
              command: this.options.config.mcpBinary,
              args: [],
              // ACP hosts launch stdio MCP servers with an explicit, sanitized env.
              // This token is minted for this exact corner and is also the credential
              // helper's password source, so its shell commands need the same scope as
              // the corner harness without inheriting any host credentials.
              env: [
                { name: 'GH_TOKEN', value: repository.githubToken },
                { name: 'GITHUB_TOKEN', value: repository.githubToken },
                // Its shell tool runs the same installs the harness does, and
                // a sanitized env would otherwise send them to npm's default
                // per-corner cache.
                { name: 'npm_config_cache', value: npmCacheDir },
              ],
            },
          ]
        : []),
      beelineAgentMcpServer(this.options.config, this.options.api, {
        roomId: this.options.parentRoomId,
        workspaceId: this.options.workspaceId,
        cornerId: this.options.cornerId,
        agentMayCloseCorner: Boolean(repository),
        reviewer: Boolean(reviewerInstruction),
        attachRoot: this.options.worktreePath,
        // The whole per-session overlay, not an enumerated subset: see
        // `monolith-room-turn.ts`'s matching comment.
        attachScratchRoot,
        turnContextPath: this.commandContext.path,
        ...(this.options.grantRunnerEndpoint
          ? { grantRunner: this.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    if (codegraphReady) {
      const codegraph = codegraphMcpServer(this.options.config, this.options.worktreePath, {
        readonly: false,
      });
      if (codegraph) servers.push(codegraph);
    }
    const youtube = youtubeMcpServer(this.options.config, this.options.youtubeAccessToken);
    if (youtube) servers.push(youtube);
    const grantedRouteServers = grantedHostRouteWires(
      grantedHostRoutes,
      operatorHome,
      hostImportedMcpDeclarations({
        operatorHome,
        agentKind: this.options.config.agentKind,
      }),
    );
    // See `pi-mcp-bridge.ts`: pi-acp 0.0.33 still drops `session/new`
    // `mcpServers`, so a corner on pi would have no `pr_checks_status` and
    // no `post_artifact` either. Granted host routes also ride this
    // bridge: isolated homes write them into `mcp.json`, but pi 0.85.1
    // itself does not read that file and the optional adapter is not
    // loaded (settings.json stays out).
    await installPiMcpBridge({
      agentCommand: harnessLabel,
      piHome: agentEnv.PI_CODING_AGENT_DIR,
      servers: [...servers, ...grantedRouteServers],
    });
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
        ...(repository
          ? [
              `You are in an isolated git worktree on ${repository.featureBranch}, targeting ${repository.targetBranch}.`,
              `Commit and push only ${repository.featureBranch}; never force-push or write to ${repository.targetBranch}. Before pushing, rebase on origin/${repository.featureBranch}; resolve conflicts autonomously, realigning to that remote branch and redoing the objective if needed, then rerun affected tests. Open the pull request with gh.`,
              ...(reviewerInstruction
                ? [reviewerInstruction]
                : [
                    configuration.reviewerHandle
                      ? `Once the pull request exists, reply with its full URL and end the turn; do not tag the reviewer, check, or wait for CI.`
                      : 'Once the pull request exists, reply only with its full URL and end the turn; do not check or wait for CI. On a later checks turn, call pr_checks_status. Merge only when checks="passed", held=false, and approvalPending=false; if checks="unknown", reply in this corner with the tool reason and stop instead of retrying. Only a later explicit human resume clears a hold.',
                    CORNER_AUTHOR_CONTRACT,
                    selfReviewerInstruction ??
                      cornerMergeInstruction(configuration.yoloMode, configuration.reviewerHandle),
                  ]),
              'Do not tag the user when a corner turn finishes: the server posts the merge summary card and its push already cover completion. Tag a human only mid-turn, and only when you need a decision or input.',
              'Never restate server check or merge notes. On a checks turn, say nothing unless you merge or push a fix, then use one short line. When asked whether the reviewer was woken, call pr_checks_status and report reviewerWake; do not invent a cause. Never merge while approvalPending is true. When approval is pending, wait to be woken. Never merge another pull request. Never create a schedule to poll pr_checks_status or the merge gate: the green transition wakes the reviewer and the end of that review wakes you, tag or no tag, and tagging any agent other than the configured reviewer cannot clear the gate. If a schedule wakes you in this corner anyway, follow the same rule as a checks turn: say nothing unless you merge, push a fix, or report a genuinely new blocker.',
            ]
          : [
              'This is a no-code corner with no repository checkout and no GitHub workflow.',
              "Work in this corner's writable workspace. Use write_scratch_file or ordinary tools to create files, then post_artifact with the path to send them back to the corner.",
              'Do not initialize a repository, create a branch, commit, push, open a pull request, or wait for GitHub checks.',
              // This lane has no pull request URL and no merge card, so its
              // attached final reply reports delivery to the requester. The
              // corner remains open until a human explicitly closes it.
              this.options.requesterHandle
                ? `Deliver the result as artifacts: post_artifact everything the objective asked for. Finish the turn by replying with @${this.options.requesterHandle} and one line on what you posted. The corner stays open until a human explicitly closes it.`
                : `Deliver the result as artifacts: post_artifact everything the objective asked for. Finish the turn by replying with one line on what you posted. The corner stays open until a human explicitly closes it.`,
            ]),
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.sessionId = opened.sessionId;
    this.sessionFingerprint = fingerprint;
    this.sessionCodegraphReady = codegraphReady;
    if (selection) {
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, selection.model),
      );
      await applyAgentModelSelection(this.client, opened.sessionId, options, selection);
    }
    return opened.sessionId;
  }

  /**
   * Resolve the review target at prompt time, not session activation time.
   *
   * A push can land after a reviewer session starts but before its first
   * prompt, or while that prompt is running. The active prompt and its bounded
   * second pass therefore each read the current green lifecycle head. The
   * server still compares approve_merge's SHA with the current head, so a push
   * after this read fails closed too.
   */
  private async activeReviewerInstruction(): Promise<string | undefined> {
    const input = this.reviewerInstructionInput;
    if (!input) return undefined;
    try {
      const [restore, localHead] = await Promise.all([
        this.options.api.execute('getCornerRestoreState', {
          cornerId: this.options.cornerId,
        }),
        execFileAsync('git', ['-C', this.options.worktreePath, 'rev-parse', 'HEAD']).then(
          ({ stdout }) => stdout.trim(),
        ),
      ]);
      const pr = restore.lifecycle?.pr;
      if (
        restore.lifecycle?.checks !== 'passing' ||
        !pr?.number ||
        !pr.headSha ||
        pr.headSha !== localHead
      )
        return CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION;
      return [
        'Current stable reviewer target for this active turn; it supersedes any older head in the trigger or transcript:',
        cornerReviewerInstruction({
          ...input,
          pullRequestNumber: pr.number,
          headSha: pr.headSha,
        }),
      ].join('\n');
    } catch {
      return CORNER_REVIEWER_UNSTABLE_HEAD_INSTRUCTION;
    }
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
      agentLabel: harnessIdentityLabel({
        kind: this.options.config.agentKind,
        command: this.options.config.agentCommand ?? this.options.config.agentBinary,
      }),
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
  private async repinNextProvider(trace?: TurnTrace, reason?: string): Promise<string | undefined> {
    const next = nextPinnedProvider(this.pinnedProviders, this.pinnedProviderOverride);
    if (!next) return undefined;
    // The retry is its own timeline, fresh ACP handshake included.
    trace?.retry({ provider: next, ...(reason ? { reason } : {}) });
    const client = this.client;
    this.client = undefined;
    this.sessionId = undefined;
    this.sessionFingerprint = undefined;
    this.sessionCodegraphReady = false;
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
    sourceMessageId?: string,
  ): Promise<void> {
    const { api, cornerId } = this.options;
    // Work the requester has already withdrawn is never started. A stop can
    // land between the message being read and the session becoming free.
    if (this.stoppedTurns.has(requestId)) return;
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
    let deliberateNoReply = false;
    try {
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: this.agent.publicKey,
          roomId: cornerId,
          requestId,
          generationId: this.commandContext.generationId,
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
              await this.syncBranch();
              const [conversation, roster, delivered, activeReviewerInstruction] =
                await trace.measure('context-fetch', () =>
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
                    this.activeReviewerInstruction(),
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
                line: [
                  ...(message.type === 'message' ? [`[message id: ${message.id}]`] : []),
                  `${names.get(message.authorId) ?? 'Beeline'} [${message.type}]: ${message.body}`,
                ].join('\n'),
              }));
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // transcript. The objective is outside the window and always
              // renders, warm session or not.
              const buildPrompt = (): string =>
                [
                  this.turnIdentityInstructions,
                  `Corner objective:\n${this.options.objective}`,
                  WarmTranscript.render(
                    this.warmTranscript.select(this.sessionId, transcriptRows),
                    'Corner transcript:',
                    'New in the corner since your last turn (the earlier transcript is already in this session):',
                  ),
                  roomMentionDirectory(roster, this.agent.publicKey),
                  activeReviewerInstruction,
                  [
                    ...(sourceMessageId ? [`Reaction target message id: ${sourceMessageId}`] : []),
                    `Newest trigger:\n${trigger}`,
                    ...attachmentPromptLines(attachments, delivered, this.acceptsImages()),
                  ].join('\n'),
                  this.options.repository
                    ? 'Continue the objective. Obey the PR checks and human hold rules in your session instructions.'
                    : 'Continue the objective. Attach completed files; only a human can close this corner.',
                  MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE,
                ]
                  .filter(Boolean)
                  .join('\n\n');
              // Rooms and corners share the provisional draft lane, request-id
              // handoff, and single durable final reply in `turn-stream.ts`.
              // The corner-only work ledger below is independent of that lane.
              const stream = new AgentTurnStream({
                api,
                agentId: this.agent.publicKey,
                roomId: cornerId,
                requestId,
                label: `corner ${cornerId}`,
              });
              let currentNarrationRun = '';
              let completedNarrationRuns: string[] = [];
              let narrationRunBoundary = 0;
              const takeInterimNarration = (): string => {
                const narration = spoken(
                  [...completedNarrationRuns, currentNarrationRun]
                    .map((run) => spoken(durableReplyText(run)))
                    .filter((run) => run && !isPureRetryNarration(run))
                    .join('\n\n'),
                );
                narrationRunBoundary += completedNarrationRuns.length;
                completedNarrationRuns = [];
                currentNarrationRun = '';
                return narration;
              };
              const publishedToolCalls = new Set<string>();
              const observedToolCalls = new Set<string>();
              const pendingToolNarrations = new Map<string, string>();
              /**
               * The stream snapshot each pending narration was taken at. It
               * becomes this turn's persisted offset only once that narration
               * reaches the ledger, so a tool call that never settles — or a
               * narration the final-reply dedupe drops — never moves it and
               * the text stays in the draft and the reply.
               */
              const pendingToolOffsets = new Map<string, string>();
              const pendingToolActivities = new Map<string, DaemonActivity[]>();
              let lastNarratedToolCall: string | undefined;
              let activityAttempt = 0;
              const publishToolCalls = (
                calls: readonly ToolCallEntry[],
                settledOnly: boolean,
                /**
                 * A live (mid-turn) publish must never finalize the ONE row
                 * `flushToolCalls` may still rewrite: the most recently
                 * narrated call's row is skipped here whenever it could still
                 * turn out to hold the same text as the turn's eventual
                 * durable reply (see the dedupe at the top of `flushToolCalls`).
                 * Every earlier, already-superseded call streams immediately.
                 */
                exceptKey?: string,
              ) => {
                calls.forEach((call, index) => {
                  const key = `${activityAttempt}:${toolCallKey(call, index)}`;
                  if (settledOnly && !observedToolCalls.has(key)) {
                    observedToolCalls.add(key);
                    // The ledger consumes the stream up to its current end, so
                    // the snapshot the offset would move to is simply what the
                    // lane has seen at the moment of the take.
                    const at = stream.streamedText;
                    const narration = takeInterimNarration();
                    pendingToolNarrations.set(key, narration);
                    pendingToolOffsets.set(key, at);
                    if (narration) lastNarratedToolCall = key;
                  }
                  if (
                    settledOnly ||
                    publishedToolCalls.has(key) ||
                    !toolCallSettled(call) ||
                    key === exceptKey
                  )
                    return;
                  publishedToolCalls.add(key);
                  const narration = pendingToolNarrations.get(key) ?? '';
                  this.activityTail = this.activityTail
                    .catch(() => undefined)
                    .then(async () => {
                      let activity = pendingToolActivities.get(key);
                      if (!activity) {
                        const toolActivity = await cornerToolActivity(
                          call,
                          this.options.worktreePath,
                          requestedBy,
                        );
                        activity = [
                          ...(narration
                            ? [
                                {
                                  kind: 'output' as const,
                                  title: 'Update',
                                  text: narration,
                                  ...(requestedBy ? { requestedBy } : {}),
                                },
                              ]
                            : []),
                          toolActivity,
                        ];
                        pendingToolActivities.set(key, activity);
                      }
                      await api.execute('postAgentActivity', {
                        agentId: this.agent.publicKey,
                        roomId: cornerId,
                        requestId,
                        cornerActivityKey: key,
                        activity,
                      });
                      // Only now is that prose somewhere a reader can scroll
                      // to, so only now does the draft stop showing it and the
                      // reply stop carrying it.
                      const at = pendingToolOffsets.get(key);
                      if (narration && at !== undefined) stream.markPersisted(at);
                      pendingToolNarrations.delete(key);
                      pendingToolOffsets.delete(key);
                      pendingToolActivities.delete(key);
                    })
                    .then(() => undefined)
                    .catch((error) => {
                      publishedToolCalls.delete(key);
                      console.error(`[thin-core] corner ${cornerId} tool activity failed:`, error);
                    });
                });
              };
              const flushToolCalls = async (
                calls: readonly ToolCallEntry[],
                finalReply: string,
                final = false,
              ): Promise<void> => {
                await this.activityTail;
                if (
                  lastNarratedToolCall &&
                  pendingToolNarrations.get(lastNarratedToolCall) === finalReply
                )
                  pendingToolNarrations.delete(lastNarratedToolCall);
                publishToolCalls(calls, false);
                await this.activityTail;
                if (this.options.connectorUsage) {
                  captureConnectionUsage(
                    this.options.connectorUsage,
                    { requestId, agentId: this.agent.publicKey, cornerId },
                    calls,
                  );
                  if (final) await this.options.connectorUsage.flush(api, requestId);
                }
                await this.activityTail;
                publishToolCalls(calls, false);
                await this.activityTail;
              };
              // One prompt run. It is a closure because an empty completion
              // re-pins the session to another provider and runs it again
              // (C92) — against the NEW client and session id.
              const runPrompt = async (prompt = buildPrompt()): Promise<PromptResult> => {
                activityAttempt += 1;
                publishedToolCalls.clear();
                observedToolCalls.clear();
                pendingToolNarrations.clear();
                pendingToolOffsets.clear();
                pendingToolActivities.clear();
                lastNarratedToolCall = undefined;
                stream.beginRun();
                completedNarrationRuns = [];
                narrationRunBoundary = 0;
                currentNarrationRun = '';
                trace.promptSent();
                return this.client!.sessionPrompt(
                  this.sessionId!,
                  promptWithImages(prompt, attachmentImageBlocks(delivered, this.acceptsImages())),
                  120_000,
                  (delta, full, currentRun, runs) => {
                    trace.firstModelOutput();
                    if (runs) {
                      completedNarrationRuns = runs.slice(narrationRunBoundary);
                      currentNarrationRun = '';
                    } else if (currentRun === undefined) currentNarrationRun += delta;
                    else {
                      if (
                        currentNarrationRun &&
                        currentNarrationRun !== currentRun &&
                        !currentRun.startsWith(currentNarrationRun)
                      )
                        completedNarrationRuns.push(currentNarrationRun);
                      currentNarrationRun = currentRun;
                    }
                    stream.onChunk(delta, full, currentRun);
                  },
                  undefined,
                  (calls) => {
                    trace.toolCalls(calls);
                    // Observe (snapshot the narration that preceded each newly
                    // seen call) THEN publish: a human watching a corner sees a
                    // tool's row the moment it settles, not batched at the
                    // turn's end behind a still-running sibling call. The
                    // current tail (`lastNarratedToolCall`) is held back:
                    // `flushToolCalls` may still need to drop its narration if
                    // it turns out to duplicate the turn's final reply.
                    publishToolCalls(calls, true);
                    publishToolCalls(calls, false, lastNarratedToolCall);
                  },
                );
              };
              let result = await runPrompt();
              trace.promptSettled();
              let explained = await this.explainEmpty(result);
              // A checks turn is told to say nothing when nothing changed; its
              // silence is not a routing failure and must not buy a retry.
              if (explained && !restates && shouldRetryEmptyTurn(explained)) {
                await flushToolCalls(result.toolCalls, '');
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
              // One bounded second chance to deliver repository work. Check
              // turns get the narrower merge reminder instead: repeating the
              // broad delivery instruction there could invite unrelated branch
              // cleanup. The model remains the authority over whether dirty
              // work belongs to the objective and whether to retain or dispose
              // of it; the daemon never rewrites the worktree after a turn.
              const checksTurn = isCornerChecksTurn(trigger, restates);
              const deliveryState =
                !checksTurn && this.options.repository
                  ? await cornerUndeliveredRepositoryState(
                      this.options.worktreePath,
                      this.options.repository.featureBranch,
                      this.options.repository.targetBranch,
                    )
                  : undefined;
              const needsDeliveryNudge =
                deliveryState !== undefined && deliveryState !== this.lastDeliveryNudgeState;
              let replyBeforeNudge = '';
              if (
                !explained &&
                (needsDeliveryNudge ||
                  (checksTurn && (this.yoloMode || Boolean(this.reviewerHandle))))
              ) {
                if (needsDeliveryNudge) this.lastDeliveryNudgeState = deliveryState;
                // The flush comes first: it is what puts this run's narration
                // in the ledger, so the offset it leaves behind is the one
                // this half of the reply has to be measured against. The next
                // prompt's `beginRun` then clears it for a fresh stream.
                await flushToolCalls(result.toolCalls, '');
                replyBeforeNudge = durableReplyText(stream.remainderOf(result.agentText));
                // This is the same warm session: identity, soul and merge
                // authority remain in its system prompt and need not be
                // repeated in this focused follow-up.
                if (this.reviewerInstructionInput) await this.syncBranch();
                result = await runPrompt(
                  this.reviewerHandle
                    ? ((await this.activeReviewerInstruction()) ?? this.cornerTurnEndNudge)
                    : checksTurn
                      ? CORNER_YOLO_MERGE_NUDGE
                      : CORNER_DELIVERY_NUDGE,
                );
                trace.promptSettled();
                explained = await this.explainEmpty(result);
              }
              // The requester stopped this turn while it ran. What the model
              // had already written STAYS, as in a Room (`monolith-room-turn`
              // says why), and the tool narration settles with it — the work
              // reached the branch and the ledger must not lie about it. The
              // partial reply carries no mentions.
              if (this.stoppedTurns.has(requestId)) {
                stream.close();
                throw new TurnStoppedError('turn stopped by the requester');
              }
              let answer = durableReplyText(result.agentText);
              // Recovered text comes from the harness's own session record,
              // not from this stream, so no offset measured here describes it.
              let fromStream = Boolean(answer);
              if (!answer && explained?.recoveredText) {
                answer = durableReplyText(explained.recoveredText);
                fromStream = false;
              }
              const withNudgeReply = (text: string): string =>
                [replyBeforeNudge, text].filter(Boolean).join('\n\n');
              // The dedupe inside the flush compares a pending narration with
              // the answer as it stands BEFORE any cut: that comparison is how
              // a narration duplicating the whole answer gets dropped instead
              // of saved, which is also what keeps the offset off it.
              await flushToolCalls(result.toolCalls, withNudgeReply(answer), true);
              // Past the flush the persisted offset is final for this turn, so
              // the answer can give up whatever head the ledger now carries.
              if (fromStream) answer = durableReplyText(stream.remainderOf(result.agentText));
              const reply = withNudgeReply(answer);
              // A refusal the operator cannot read is a refusal that happens twice.
              for (const call of result.toolCalls) {
                const failure = toolCallFailureLine(call);
                if (failure) console.warn(`[thin-core] corner ${cornerId} ${failure}`);
              }
              // Close the draft lane before the answer is published: the finished
              // reply must never queue behind a draft nobody will read.
              stream.close();
              if (!reply && explained) {
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
              // The reply is the remainder past this turn's persisted offset:
              // everything the ledger did not already save, cut only where the
              // saved snapshot provably reaches into the closing run, so a
              // corner that narrated before a tool call still lands that
              // closing message entire. A reply that only restates the
              // server's own check notes says nothing new, and that turn
              // settles through its receipt instead.
              const durableReply = spoken(reply);
              deliberateNoReply = isDeliberateCornerNoReply(reply, restates);
              await trace.measure('publish', () =>
                stream.settle(
                  durableReply,
                  durableReply
                    ? {
                        ...(requestedById ? { triggerMessageId: requestId } : {}),
                      }
                    : {},
                ),
              );
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
        ...(deliberateNoReply ? { completionKind: 'no-reply' as const } : {}),
        generationId: this.commandContext.generationId,
      });
      // After the receipt: an operator artifact never delays the answer, and
      // never becomes one — the trace has no way to post a Room row.
      await trace.finish('complete');
    } catch (error) {
      // A stopped turn already has its ending: the server wrote `cancelled` and
      // named who stopped it when it accepted the request. Nothing to post, and
      // nothing the helper is to blame for.
      if (error instanceof TurnStoppedError || this.stoppedTurns.has(requestId)) {
        console.log(`[thin-core] corner ${cornerId} turn ${requestId} stopped by the requester`);
        await trace.finish('cancelled');
        return;
      }
      const reason = distillTurnFailureReason(error);
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: cornerId,
        requestId,
        status: 'failed',
        generationId: this.commandContext.generationId,
        reason: reason.text,
        ...(reason.kind ? { reasonKind: reason.kind } : {}),
      });
      await trace.finish('failed', reason.text);
      throw error;
    } finally {
      this.busy = false;
      this.currentTurn = undefined;
      this.harvestWarmNodeModules();
    }
  }

  /**
   * Offer this worktree's `node_modules` to the host-wide warm store.
   *
   * A turn's end is the moment the tree is most likely to be a finished
   * install, and the store keeps only the first complete tree per lockfile —
   * so after the first corner on a lockfile this is one `stat` that answers
   * `already-warm`. The copy that the first one does is deliberately NOT
   * awaited by the turn: nobody in the Room is waiting on a cache, and the
   * only thing that waits is shutdown, so a half-copied tree is never left
   * where a later corner could read it as complete.
   */
  private harvestWarmNodeModules(): void {
    if (this.harvest || !this.options.repository) return;
    const { cornerId, worktreePath, runtime } = this.options;
    const run = harvestWarmNodeModules({
      worktreePath,
      storeRoot: warmNodeModulesStoreDir(runtime.supervisorRoot),
    })
      .then((outcome) => {
        if (outcome.reason === 'already-warm' || outcome.reason === 'no-lockfile') return;
        console.log(
          `[thin-core] corner ${cornerId} warm node_modules harvest: ${outcome.reason}${
            outcome.detail ? ` (${outcome.detail})` : ''
          }`,
        );
      })
      .catch((error) => {
        console.error(`[thin-core] corner ${cornerId} warm node_modules harvest failed:`, error);
      })
      .finally(() => {
        if (this.harvest === run) this.harvest = undefined;
      });
    this.harvest = run;
  }

  /**
   * Bring this worktree onto the corner's branch as GitHub currently has it,
   * before any work is done on top of it.
   *
   * The branch is the shared artifact: another member agent may have pushed to
   * it since this helper last looked, and a first touch of a corner this
   * helper did not open starts from whatever `room-runtime.ts` restored. A
   * conflicting local commits are realigned to that remote branch so the
   * fixed objective can be attempted again without clobbering a sibling push.
   */
  private async syncBranch(): Promise<void> {
    const repository = this.options.repository;
    if (!repository) return;
    const token = await this.options.api
      .execute('getRoomGitHubToken', { roomId: this.options.parentRoomId })
      .then((granted) => granted.token)
      .catch(() => repository.githubToken);
    await syncCornerBranch({
      worktreePath: this.options.worktreePath,
      featureBranch: repository.featureBranch,
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  async run(): Promise<void> {
    const { api, cornerId, signal } = this.options;
    try {
      await runServerCommandIntake({
        api,
        roomId: cornerId,
        agentId: this.agent.publicKey,
        context: this.commandContext,
        signal,
        pollMs: this.options.pollMs,
        presence: {
          ...(this.options.config.daemonReleaseVersion
            ? { releaseVersion: this.options.config.daemonReleaseVersion }
            : {}),
          ...(this.options.config.daemonSourceSha
            ? { sourceSha: this.options.config.daemonSourceSha }
            : {}),
          available: !this.options.config.modelUnavailable,
        },
        onWake: (wake) => {
          this.wakeIntake = wake;
        },
        onPoll: () => this.options.onPoll(),
        onError: (error) => console.error('[thin-core] corner command failed', error),
        stop: (requestId) => this.stopTurn(requestId),
        restart: () => this.options.onRestartRequested?.(),
        canStartTurn: this.options.canStartTurn,
        closed: async () => {
          if (this.closePushed) {
            this.closePushed = false;
            await this.harvest;
            await this.options.onCloseRequested();
            return true;
          }
          const now = Date.now();
          if (this.lastCloseCheck !== 0 && now - this.lastCloseCheck < this.closePollMs)
            return false;
          this.lastCloseCheck = now;
          const state = await api.execute('getCornerRestoreState', { cornerId });
          if (!state.closeRequested) return false;
          // The reap deletes the worktree a harvest is still reading.
          await this.harvest;
          await this.options.onCloseRequested();
          return true;
        },
        run: (command) =>
          this.prompt(
            command.turnRequestId,
            command.source.body,
            command.source.attachments,
            command.source.authorId,
            command.reason === 'corner_check' ? [command.source.body] : undefined,
            command.source.type === 'message' ? command.sourceMessageId : undefined,
          ).finally(() => {
            // One recovery GET after the turn; idle ticks stay on the 10 min net.
            this.lastCloseCheck = 0;
          }),
      });
    } finally {
      this.options.grantRunner?.unregister(cornerId);
      await this.options.scheduler.suspend(cornerId);
      // A harvest writes into host-wide state, so it finishes or is discarded
      // with this corner — never left running against a reaped worktree.
      await this.harvest;
    }
  }
}
