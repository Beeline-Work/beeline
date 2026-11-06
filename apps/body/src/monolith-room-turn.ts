import { CommandActivationContext } from './helper-activation-context.js';
import { FreeAgentContinuation } from './free-agent-continuation.js';
import { subscriptionActionPrompt } from '@beeline/api-contract/daemon';
import { type TurnTokenFigure } from './harness-turn-tokens.js';
import { TurnUsageAccumulator } from './turn-usage.js';
import { CommandExecutionContext } from './server-command-intake.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SharedAssetCategory } from '@beeline/api-contract/agent-grants';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { SCHEDULE_RAN_VERB, SCHEDULE_SCHEDULER_NAME } from '@beeline/api-contract/scheduled-prompts';
import { type SystemEvent } from '@beeline/api-contract/daemon';
import { AcpClient, type AcpPermissionDecision, type AcpPermissionRequest, type PromptResult, type ToolCallEntry } from './acp.js';
import { HarnessQuotaReader } from './harness-quota.js';
import { attachmentMarkerLines, attachmentPromptLines, type DeliveredAttachment } from './attachment-delivery.js';
import { CODE_OWNED_HOST_MCP_NAMES } from './mcp-route-class.js';
import { isHostMcpPermissionRequest, isMcpShapedPermissionRequest, isMountedMcpToolPermissionRequest, ROOM_MOUNTED_MCP_SERVERS } from './read-only-policy.js';
import { type BodyConfig } from './config.js';
import { type DaemonApiClient } from './daemon-api-client.js';
import { type EmptyTurnExplanation } from './empty-turn.js';
import type { GrantCommandRunner, GrantRunnerEndpoint, GrantWritePolicy } from './grant-runner.js';
import { harnessSupportsNativeSessionResume } from './harness-capabilities.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { type PromptSurface } from './prompt-assembly.js';
import { TurnTrace, type TurnTraceSink } from './turn-trace.js';
import { isCompletedToolCall } from './tool-call-failure.js';
import { turnErrorDetail } from './turn-failure-reason.js';
import { AgentProcesses, type AgentProcessLifecycle } from './agent-process.js';
import { WarmTranscript } from './warm-transcript.js';
import { PromptSectionBaseline } from './prompt-section-baseline.js';
import type { RoomSupervisor } from './room-supervisor.js';
import { monolithRoomTurnLoopConfigurationChanged, monolithRoomTurnLoopRequestReconciliation, monolithRoomTurnLoopIsBusy, monolithRoomTurnLoopPausedGrantRequestId, monolithRoomTurnLoopGrantWritePolicy, monolithRoomTurnLoopBeginTurnTrace, monolithRoomTurnLoopCurrentTurnForRunner, monolithRoomTurnLoopRequesterOf, monolithRoomTurnLoopRefreshPersonaForSoulUpdate, monolithRoomTurnLoopPrepareForForcedUpdateRestart, monolithRoomTurnLoopInterruptedTurn, monolithRoomTurnLoopInterruptForServerMinimum, monolithRoomTurnLoopForceRecoverRoom, monolithRoomTurnLoopCommandActivation, monolithRoomTurnLoopConfiguration, monolithRoomTurnLoopRoster, monolithRoomTurnLoopAcceptsImages, monolithRoomTurnLoopDeliver, monolithRoomTurnLoopRepositoryState, monolithRoomTurnLoopWriteBackClaudeLogin, monolithRoomTurnLoopPublishOpenRouterSpend, monolithRoomTurnLoopPublishHarnessQuota, monolithRoomTurnLoopCaptureTurnMetrics, monolithRoomTurnLoopWatchClaudeLogin, monolithRoomTurnLoopStopClaudeLoginWatch, monolithRoomTurnLoopDiscardSession, monolithRoomTurnLoopSessionIsCurrent, monolithRoomTurnLoopRefreshTurnCheckout, monolithRoomTurnLoopCurrentSessionFingerprint, monolithRoomTurnLoopGrantedResources, monolithRoomTurnLoopMountedMcpServers, monolithRoomTurnLoopActivate } from './monolith-room-turn-configuration-changed.js';
import { monolithRoomTurnLoopActivateCold, monolithRoomTurnLoopLifecycle, monolithRoomTurnLoopServingProviders, monolithRoomTurnLoopExplainEmpty, monolithRoomTurnLoopRepinNextProvider, monolithRoomTurnLoopStartPrompt, monolithRoomTurnLoopStopTurn } from './monolith-room-turn-activate-cold.js';
import { monolithRoomTurnLoopPrompt } from './monolith-room-turn-prompt.js';
import { monolithRoomTurnLoopRun } from './monolith-room-turn-run.js';

export class MonolithRoomTurnLoop {

   readonly commandContext: CommandExecutionContext;

   readonly activationContext: CommandActivationContext;

   readonly squireRelay: SquireTaskRelay;

   readonly agent: ReturnType<typeof runtimeIdentity>;

   wakeIntake?: () => void;

   recoverIntake?: () => void;
configurationChanged(): void { return monolithRoomTurnLoopConfigurationChanged(this); }
/** Wake the intake after reconciliation or a storage lease release. */
requestReconciliation(): void { return monolithRoomTurnLoopRequestReconciliation(this); }

   client?: AcpClient;

   claudeLoginWatch?: { close(): void };

   sessionId?: string;

  /** MCP subprocesses capture this generation-specific path at launch. */
   sessionContextPath?: string;

   sessionCwd?: string;

   sessionCommit?: string;

   sessionGitHubToken?: string;

   turnCheckout?: { branch?: string; commit?: string; githubToken?: string };

  /** The configuration the live session baked in; a change invalidates it. */
   sessionFingerprint?: string;

  /** Whether CodeGraph preparation succeeded for the live session. */
   sessionCodegraphReady = false;

  /** The live session's environment, read back for pi's own turn record. */
   agentEnv: Record<string, string> = {};

  /** This agent's own OpenRouter key when its model routes there. */
   openRouterKey?: string;

   openRouterSpendPublish: Promise<unknown> = Promise.resolve();

  /** Plan quota read through quota-axi, throttled per agent across loops. */
   harnessQuota?: HarnessQuotaReader;

   sharedAssetsActive = false;

   isolatedCategories: SharedAssetCategory[] = [];

  /**
   * The real size of the last settled prompt, captured while the session that
   * sent it is still alive — `discardSession` clears both the client and the id,
   * and the terminal receipt is posted on a path that may run after it.
   */
   turnMetrics: {
    inputTokens?: number;
    promptBytes?: number;
    totalInputTokens?: number;
    modelCalls?: number;
    modelCallsWithoutUsage?: number;
  } = {};

   turnUsage = new TurnUsageAccumulator();

   harnessTokens: TurnTokenFigure | undefined;

  /** OpenRouter providers this activation pinned, in order (C92). */
   pinnedProviders: string[] = [];

  /** The one provider re-pinned after an empty completion, until the session ends. */
   pinnedProviderOverride?: string;

   busy = false;

   turnInstructionPrefix = '';

  /** The session prompt's section ids, for `report_feedback` (with each turn's). */
   sessionPromptSectionIds: readonly string[] = [];

   sessionSurface: PromptSurface = 'room';

   activeTurn?: ActiveTurn;

   readonly queuedTurns: HumanMessage[] = [];

  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
   attachmentDir?: string;

   modelContextTokens?: number;

  /** Whether the pinned model takes images; `undefined` when the pin did not say. */
   modelTakesImages?: boolean;

  /** The session's TMPDIR: writable to a granted command in a Room, as it is to the harness (C94). */
   sessionScratchDir?: string;

  /** The `agent-home.ts` overlay this session writes into; a Room grant keeps it. */
   sessionStateDirs: string[] = [];

  /** What this exact ACP session has already been prompted with (`warm-transcript.ts`). */
   readonly warmTranscript: WarmTranscript;

   readonly freeContinuation: FreeAgentContinuation;

  /** What each turn section last sent to this exact ACP session hashed to (`prompt-section-baseline.ts`). */
   readonly sectionBaseline = new PromptSectionBaseline();

  /** Local copies already delivered this session, by message id, so transcript renders reuse them. */
   readonly deliveredAttachments = new Map<string, DeliveredAttachment[]>();

  /** Names from the latest roster read, for ledger bylines the runner writes. */
   memberNames = new Map<string, string>();

  /** The request id of the turn that paused on a grant card, until its decision arrives. */
   pausedOnGrantRequestId?: string;

   pausedOnGrantKind?: PendingCardKind;

   readonly approvalDecisionWrites = new Set<Promise<void>>();

   readonly approvalDecisionFailures = new Map<string, unknown>();

  /** Operator-local turn traces; built once when the daemon configured a directory. */
   turnTraceSink?: TurnTraceSink;


  constructor( readonly options: MonolithRoomTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
    const nativeResume = harnessSupportsNativeSessionResume(options.config.agentCommand ?? options.config.agentBinary);
    this.freeContinuation = new FreeAgentContinuation(options.config.agentHomeRoot
      ? resolve(options.config.agentHomeRoot, 'free-agent-continuation.json') : undefined);
    this.warmTranscript = new WarmTranscript(nativeResume && options.config.agentHomeRoot
      ? { path: join(options.config.agentHomeRoot, 'warm-transcript.json') } : {});
    this.commandContext = new CommandExecutionContext(options.config.agentHomeRoot);
    this.squireRelay = new SquireTaskRelay(
      this.agent.publicKey,
      options.roomId,
      this.commandContext.path,
      async (call) =>
        (
          await options.api.execute('authorizeResourceCall', {
            roomId: call.roomId,
            requestId: call.requestId,
            generationId: call.generationId,
            target: 'squire',
            ...resourceCallFacts({ method: 'tools/call', params: { name: call.tool } }),
          })
        ).allowed,
      options.config.operatorHome ?? homedir(),
      undefined,
      (decision) => {
        const write = options.api
          .execute('postSquireApprovalDecision', { roomId: options.roomId, ...decision })
          .then(() => { this.approvalDecisionFailures.delete(decision.requestId); })
          .catch((error: unknown) => {
            this.approvalDecisionFailures.set(decision.requestId, error);
            console.error('[thin-core] Squire approval decision publication failed:', turnErrorDetail(error));
          });
        this.approvalDecisionWrites.add(write);
        void write.finally(() => this.approvalDecisionWrites.delete(write));
      },
      (sessionId) => {
        options.api.execute('endComputerSession', { roomId: options.roomId, sessionId })
          .catch((error: unknown) => console.error('[thin-core] Squire session end publication failed:', turnErrorDetail(error)));
      },
      async (lease) => (await options.api.execute('refreshComputerSession', { roomId: options.roomId, ...lease })).live,
      (url, siteUrl) => {
        options.api.execute('forgetSquireSignIn', { url, ...(siteUrl ? { siteUrl } : {}) })
          .catch((error: unknown) => console.error('[thin-core] Squire sign-in removal failed:', turnErrorDetail(error)));
      },
      async (service) => {
        const view = await this.options.api.execute('readAgentWorkbench', { roomId: options.roomId });
        return view.apps?.find(app => app.appKey === service.trim().toLowerCase() &&
          app.transport === 'squire-api' && app.status === 'connected')?.connectionReference;
      },
      () => options.api.refreshMachineVault(),
    );
    this.options = { ...options, api: this.commandContext.bind(options.api) };
    this.activationContext=new CommandActivationContext({
      scope:()=>options.api.channel?.activationScope?.(),
      machine:()=>Boolean(options.api.channel?.isOpen),
      ready:()=>options.api.waitForConnection(),
      read:input=>options.api.readCommandActivation(input),
    });
    options.grantRunner?.register(options.roomId, {
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      // A top-level Room keeps its read-only promise for grants too: the runner
      // wraps the command in this Room's own mount table (C94).
      writePolicy: () => this.grantWritePolicy(),
      turn: () => {
        const turn = this.currentTurnForRunner();
        return turn ? { ...turn, generationId: this.commandContext.generationId } : undefined;
      },
    });
  }
isBusy(): boolean { return monolithRoomTurnLoopIsBusy(this); }
/** The turn a `request_grant` paused, if any (cleared when its decision resumes it). */
pausedGrantRequestId(): string | undefined { return monolithRoomTurnLoopPausedGrantRequestId(this); }
/**
 * What the grant runner may write here: the session's own scratch and home
 * overlay and nothing else, enforced by the same read-only mount table the
 * harness runs under. With no usable bwrap there is no way to keep that
 * promise, so the policy carries no path and the runner refuses the run
 * rather than widening the boundary.
 */
grantWritePolicy(): GrantWritePolicy { return monolithRoomTurnLoopGrantWritePolicy(this); }
/**
 * One turn's stopwatch. It is created for every turn — measuring is cheap —
 * and only WRITES when the daemon configured a runtime directory to write
 * into, so a standalone or test Body stays silent.
 */
beginTurnTrace(requestId: string): TurnTrace { return monolithRoomTurnLoopBeginTurnTrace(this, requestId); }
currentTurnForRunner(): {
    requestId: string;
    requester?: {
        pubkey: string;
        name?: string;
    };
} | undefined { return monolithRoomTurnLoopCurrentTurnForRunner(this); }
requesterOf(authorId: string): {
    pubkey: string;
    name?: string;
} { return monolithRoomTurnLoopRequesterOf(this, authorId); }
async refreshPersonaForSoulUpdate(): Promise<void> { return monolithRoomTurnLoopRefreshPersonaForSoulUpdate(this); }
async prepareForForcedUpdateRestart(): Promise<void> { return monolithRoomTurnLoopPrepareForForcedUpdateRestart(this); }
interruptedTurn(): InterruptedTurn | undefined { return monolithRoomTurnLoopInterruptedTurn(this); }
interruptForServerMinimum(): InterruptedTurn | undefined { return monolithRoomTurnLoopInterruptForServerMinimum(this); }
async forceRecoverRoom(): Promise<void> { return monolithRoomTurnLoopForceRecoverRoom(this); }
commandActivation() { return monolithRoomTurnLoopCommandActivation(this); }
async configuration() { return monolithRoomTurnLoopConfiguration(this); }
async roster(): Promise<WorkspaceRoster> { return monolithRoomTurnLoopRoster(this); }
/**
 * Whether a picture actually reaches the model this session. Both halves
 * have to hold (C87): the harness must advertise `promptCapabilities.image`,
 * AND — when the pin knows the model's modalities — the model must take
 * images. `undefined` modalities mean the question was never settled, and
 * the harness answer stands alone as before.
 */
acceptsImages(): boolean { return monolithRoomTurnLoopAcceptsImages(this); }
/** Reuse successful local copies; a later delivery retries failed files. */
async deliver(item: HumanMessage): Promise<DeliveredAttachment[]> { return monolithRoomTurnLoopDeliver(this, item); }
async repositoryState(): Promise<RoomRepositoryState> { return monolithRoomTurnLoopRepositoryState(this); }
/**
 * Drop this Room's live harness process. The next activation starts cold.
 * A rotation is a fact about one live session, so the pin goes with it.
 */
/**
 * Claude Code may have refreshed its login during the prompt, detaching
 * this Room's credential link. Share the rotated login now so other Rooms
 * do not spend the old refresh token before this Room's next activation.
 */
async writeBackClaudeLogin(): Promise<void> { return monolithRoomTurnLoopWriteBackClaudeLogin(this); }
/**
 * After a turn, refresh the owner's view of this agent's OpenRouter key
 * spend. `refused` marks a turn OpenRouter refused with 402.
 */
publishOpenRouterSpend(refused = false): void { return monolithRoomTurnLoopPublishOpenRouterSpend(this, refused); }
/** After a turn, refresh the owner's view of this agent's plan quota. */
publishHarnessQuota(): void { return monolithRoomTurnLoopPublishHarnessQuota(this); }
async captureTurnMetrics() { return monolithRoomTurnLoopCaptureTurnMetrics(this); }
/**
 * Watch this client's Claude login so a refresh made while the
 * Room is idle reaches other Rooms at once (see `watchRoomClaudeLogin`).
 */
watchClaudeLogin(): void { return monolithRoomTurnLoopWatchClaudeLogin(this); }
stopClaudeLoginWatch(): void { return monolithRoomTurnLoopStopClaudeLoginWatch(this); }
async discardSession(preserveConversation = false): Promise<void> { return monolithRoomTurnLoopDiscardSession(this, preserveConversation); }
/**
 * Whether the retained session still matches the agent's server-side
 * configuration. Retention (C104) is a saving only while what it keeps is
 * still current, and a session's persona, model pin, and mounted MCP set are
 * fixed when it opens: they cannot be corrected in place, so a changed one
 * has to cost a respawn. The check is one round trip — the roster half of
 * which the turn was going to fetch anyway — against a cold spawn measured
 * in seconds. A harness process that has exited (a memory-limit kill, a
 * crash) is never current: handing it back fails the turn with
 * `AcpClient not started` instead of spawning a fresh one.
 */
async sessionIsCurrent(): Promise<boolean> { return monolithRoomTurnLoopSessionIsCurrent(this); }
async refreshTurnCheckout(): Promise<void> { return monolithRoomTurnLoopRefreshTurnCheckout(this); }
async currentSessionFingerprint(): Promise<string> { return monolithRoomTurnLoopCurrentSessionFingerprint(this); }
async grantedResources() { return monolithRoomTurnLoopGrantedResources(this); }
mountedMcpServers(preparedEnv?: Record<string, string>): string[] { return monolithRoomTurnLoopMountedMcpServers(this, preparedEnv); }
async activate(trace?: TurnTrace): Promise<string> { return monolithRoomTurnLoopActivate(this, trace); }
async activateCold(trace: TurnTrace | undefined, startupStep: (step: string) => void): Promise<string> { return monolithRoomTurnLoopActivateCold(this, trace, startupStep); }
/**
 * The scheduler seam, and the only place that can see the boundary between
 * waiting for the previous turn and spawning a harness: `queue-wait` closes when
 * the process starts, and `cold` vs `warm` is decided by whether this
 * Room already holds a live ACP client.
 */
lifecycle(trace?: TurnTrace): AgentProcessLifecycle { return monolithRoomTurnLoopLifecycle(this, trace); }
/** The pinned providers a failure reason should name for this session. */
servingProviders(): string[] { return monolithRoomTurnLoopServingProviders(this); }
/** Why a turn carried no answer text, or undefined when it did. */
async explainEmpty(result: PromptResult): Promise<EmptyTurnExplanation | undefined> { return monolithRoomTurnLoopExplainEmpty(this, result); }
/**
 * Re-pin the session to the next provider in the OpenRouter order and open a
 * fresh session on it, so the retry of an empty completion or a failing
 * provider is served — and named — by exactly one provider. Undefined when
 * the pin has nowhere left to go.
 */
async repinNextProvider(trace?: TurnTrace, reason?: string): Promise<string | undefined> { return monolithRoomTurnLoopRepinNextProvider(this, trace, reason); }
startPrompt(item: HumanMessage): void { return monolithRoomTurnLoopStartPrompt(this, item); }
/**
 * Obey a stop the requester already made a fact.
 *
 * A stop names ONE request id and touches only the turn that answers it. The
 * turn in flight is cancelled at the harness and marked so its own run
 * publishes nothing; a turn still queued is simply dropped, since starting
 * work the person has already withdrawn is worse than never starting it.
 * A stop for neither is ignored — it belongs to a turn that ended between
 * the press and the delivery, and the server's own receipt already said so.
 */
stopTurn(requestId: string): void { return monolithRoomTurnLoopStopTurn(this, requestId); }
async prompt(active: ActiveTurn): Promise<void> { return monolithRoomTurnLoopPrompt(this, active); }
async run(): Promise<void> { return monolithRoomTurnLoopRun(this); }
}



export const execFileAsync = promisify(execFile);


export type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];

export type RoomRepositoryState = DaemonOperationMap['getRoomRepositoryState']['output'];

export type RoomMessage = DaemonOperationMap['getRoomInbox']['output']['items'][number];

export type HumanMessage = Pick<
  RoomMessage,
  | 'id'
  | 'authorId'
  | 'body'
  | 'createdAt'
  | 'attachments'
  | 'type'
  | 'replyToMessageId'
  | 'replyToAuthorId'
  | 'replyToAuthorName'
  | 'replyToExcerpt'
  | 'requestAuthorId'
  | 'agentHopCount'
>;


/**
 * Rooms and corners share one rule for MCP: every tool call from a server the
 * host mounted into the session is approved. A host-classified server is kept
 * out of the isolated harness home until an owner grant rewrites the route in;
 * a call that reaches an ungated host identity stays refused here. Granted
 * names drop out of that host list so every capability on that server crosses.
 */
export function isRoomMcpPermissionRequest(
  request: AcpPermissionRequest,
  mountedServers: readonly string[] = ROOM_MOUNTED_MCP_SERVERS,
  hostServers: readonly string[] = CODE_OWNED_HOST_MCP_NAMES,
): boolean {
  if (isHostMcpPermissionRequest(request, hostServers)) return false;
  return isMountedMcpToolPermissionRequest(request, mountedServers);
}


/**
 * A shell command, read from the only thing that identifies one: the `execute`
 * kind the harness itself declares. claude-agent-acp marks its native `Bash`
 * that way, which is the whole of what a Room shell needs; a title or a command
 * line that happens to contain the word `bash` is prose, not an identity, and
 * classifying on it moved the boundary with the user's wording. An MCP-shaped
 * request is never re-read as a shell: it was already decided above, so a
 * command line wearing an inspection tool's title stays refused instead of
 * crossing as the shell it also is.
 */
export function isRoomShellPermissionRequest(
  request: AcpPermissionRequest,
  hostServers: readonly string[],
): boolean {
  if (request.toolCall?.kind !== 'execute') return false;
  return !isMcpShapedPermissionRequest(request, hostServers);
}


/** Every path a native file request names, or undefined when one is malformed. */
export function nativeRequestPaths(call: AcpPermissionRequest['toolCall']): string[] | undefined {
  const paths: string[] = [];
  if (call?.locations !== undefined) {
    if (!Array.isArray(call.locations)) return undefined;
    for (const location of call.locations) {
      if (!location || typeof location.path !== 'string' || !location.path) return undefined;
      paths.push(location.path);
    }
  }
  const input = call?.rawInput;
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'notebook_path', 'path'] as const) {
      if (!(key in input)) continue;
      const value = (input as Record<string, unknown>)[key];
      if (typeof value !== 'string' || !value) return undefined;
      paths.push(value);
    }
  }
  return paths;
}


export const strictlyInside = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};


/** Allow only existing files named entirely within this session's attachment tree. */
export function isAttachmentRead(request: AcpPermissionRequest, attachmentsDir?: string): boolean {
  const call = request.toolCall;
  if (!attachmentsDir || call?.kind !== 'read') return false;
  const paths = nativeRequestPaths(call);
  if (!paths?.length) return false;
  try {
    const root = resolve(attachmentsDir);
    const realRoot = realpathSync(root);
    return paths.every(path => isAbsolute(path) && strictlyInside(root, resolve(path)) &&
      strictlyInside(realRoot, realpathSync(path)));
  } catch {
    return false;
  }
}


/**
 * A path as the filesystem would resolve it on write: the nearest entry that
 * exists (a dangling symlink counts, and then fails realpath) is realpathed and
 * the not-yet-created remainder is appended, so a new file is judged by the
 * directory it lands in.
 */
export function realWriteTarget(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  return join(realpathSync(existing), ...missing);
}


/** Allow a native write/edit only when every path it names lands inside the sandbox home. */
export function isSandboxHomeEdit(request: AcpPermissionRequest, sandboxHome?: string): boolean {
  const call = request.toolCall;
  if (!sandboxHome || call?.kind !== 'edit') return false;
  const paths = nativeRequestPaths(call);
  if (!paths?.length) return false;
  try {
    const root = resolve(sandboxHome);
    const realRoot = realpathSync(root);
    // Only an already-normal path: `resolve` folds `..` before symlinks are
    // followed, so `home/link/../x` would be judged by a different directory
    // than the one the filesystem writes through.
    return paths.every(path => isAbsolute(path) && path === resolve(path) &&
      strictlyInside(root, path) && strictlyInside(realRoot, realWriteTarget(path)));
  } catch {
    return false;
  }
}


/**
 * The Room ACP client applies this host-owned decision fail-closed: a mounted
 * MCP tool call is approved; shell commands and native read/search requests
 * are approved while the OS sandbox wraps this session, as are native
 * writes/edits whose every path resolves inside the sandbox home (`$HOME`, the
 * `agent-home/user` directory the sandbox already binds writable for the
 * shell). Without the sandbox, only native reads confined to downloaded
 * attachments are approved. Other native writes/edits, deletes, moves and
 * unstructured requests remain refused.
 *
 * Shell is conditioned on the sandbox because the sandbox IS the Room's
 * read-only filesystem: unwrapped, `wrapAgentCommand` spawns the harness bare
 * and masks no credential path, so an approved command would write anywhere the
 * daemon account can. Codex keeps its own offline read-only mode in exactly
 * that case (`harness-capabilities.ts`), so requiring the wrap is what parity
 * means. `ensureBwrapSandbox` installs bubblewrap at daemon start so this is a
 * capability the host gains rather than a refusal it lives with, and the
 * session primer states the outcome either way. The same wrap is why a home
 * write is safe to approve: the native tool runs inside it, so a symlink the
 * agent swaps in after this check still reaches only what the shell could.
 */
export function roomPermissionDecision(
  request: AcpPermissionRequest,
  options: {
    mountedServers?: readonly string[];
    hostServers?: readonly string[];
    /** `config.bwrapPath`, set only when the sandbox self-test passed. */
    shellSandboxed?: boolean;
    /** The attachment subtree under BEELINE_ATTACH_SCRATCH_ROOT. */
    attachmentsDir?: string;
    /** The wrapped session's `$HOME` (`agent-home/user`), writable in the sandbox. */
    sandboxHome?: string;
  } = {},
): AcpPermissionDecision {
  const hostServers = options.hostServers ?? CODE_OWNED_HOST_MCP_NAMES;
  const mountedServers = options.mountedServers ?? ROOM_MOUNTED_MCP_SERVERS;
  if (isRoomMcpPermissionRequest(request, mountedServers, hostServers)) return 'allow';
  if (!isMcpShapedPermissionRequest(request, hostServers)) {
    if (options.shellSandboxed) {
      if (request.toolCall?.kind === 'read' || request.toolCall?.kind === 'search') return 'allow';
      if (isSandboxHomeEdit(request, options.sandboxHome)) return 'allow';
    } else if (isAttachmentRead(request, options.attachmentsDir)) return 'allow';
  }
  if (!options.shellSandboxed) return 'reject';
  return isRoomShellPermissionRequest(request, hostServers) ? 'allow' : 'reject';
}


/**
 * Whether this principal may start a turn. Agents are server-validated Room members
 * and are never gated; a human answers to the agent's access policy.
 *
 * The policy lives on the SERVER (`agent-access.ts`) and its verdict rides on the
 * authority round trip the intake loop already makes per candidate message — so an
 * owner's change in the members page takes effect on a helper that is already
 * running, on its next poll. `humanPermitted` is the runtime record's own reading,
 * used only against a server too old to answer.
 */
/** Server-authored scheduled prompts arrive as system lines (`@scheduler ran a
 *  schedule for <agent> · <message>`) carrying the structured event; the
 *  scheduler is not a Room principal, so its lines skip the per-author
 *  authority check (schedule creation was already authority-gated). Recognised by
 *  the event's verb, never by the text.
 *
 *  Nothing here re-checks that the line is addressed to this agent. An inbox
 *  item exists BECAUSE the server routed it to this agent, so the item IS the
 *  address; asking the line to name the reader again only invites the two to
 *  disagree. */
export function isScheduledPrompt(item: {
  type: string;
  body: string;
  systemEvent?: SystemEvent;
}): boolean {
  if (item.type !== 'system') return false;
  if (item.systemEvent?.kind) return item.systemEvent.kind === 'schedule-ran';
  // One release of fallback: a line written before the server stamped kinds
  // carries the verb and nothing else. Remove after the next release; the
  // verb is display text and must not be a permanent contract.
  return item.systemEvent?.verb === SCHEDULE_RAN_VERB;
}


/**
 * Who the harness is told an inbox item is from.
 *
 * An event line's subject is the person or agent the fact is ABOUT, and the
 * server put their display name on the structured event. A newcomer's join is
 * the case that needs it: the roster this turn was built from was read before
 * they arrived, so a lookup by author id finds nothing and the greeting comes
 * out addressed to a truncated public key instead of a name.
 */
export function inboxItemAuthorName(
  item: {
    type: string;
    authorId: string;
    body: string;
    systemEvent?: SystemEvent;
  },
  names: ReadonlyMap<string, string>,
): string {
  if (isScheduledPrompt(item)) return SCHEDULE_SCHEDULER_NAME;
  const subject = item.systemEvent?.subject;
  if (item.type === 'system' && subject?.name) return subject.name;
  return names.get(item.authorId) ?? item.authorId.slice(0, 12);
}


/** What the harness is shown for an inbox item: a scheduled prompt's message
 *  itself (the event's consequence), otherwise the row's text. An event line's
 *  own sentence already carries the fact — `Ada joined Beeline Welcome` names
 *  the newcomer — so it is shown as written rather than restated. */
export function inboxItemPromptBody(item: {
  type: string;
  body: string;
  systemEvent?: SystemEvent;
}): string {
  if (item.systemEvent?.kind === 'subscription-fired') return subscriptionActionPrompt(item.systemEvent);
  return isScheduledPrompt(item) ? (item.systemEvent?.consequence ?? item.body) : item.body;
}


/**
 * A `request_grant` or `offer_connector` call whose reply says the card is
 * posted pauses the turn: the person's answer on that card resumes it (a
 * `grant-decided` or `connector-offer-decided` RESUME kind).
 */
export type PendingCardKind = 'grant' | 'connector';

export function pendingCardKind(call: { title?: string; content?: unknown }): PendingCardKind | undefined {
  if (/(?:^|[._:/-])connect$/i.test(call.title ?? '')) {
    try {
      let content = call.content;
      if (content && typeof content === 'object' && 'content' in content) content = content.content;
      if (Array.isArray(content)) content = content.find(item => item?.type === 'text')?.text;
      const result = typeof content === 'string' ? JSON.parse(content) : content;
      if (result && typeof result === 'object' && ['needs_sign_in', 'needs_approval'].includes(result.status))
        return result.grantId ? 'grant' : 'connector';
    } catch { /* An invalid reply does not pause the turn. */ }
  }
  const kind = /(?:^|[._:/-])(request_grant|request_shared_asset_isolation|offer_connector)$/i.exec(call.title ?? '')?.[1];
  if (!kind || !/(?:pending|already offered), card (?:posted|still open)/i.test(
    typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? ''),
  )) return undefined;
  return kind.toLowerCase() === 'offer_connector' ? 'connector' : 'grant';
}


export function pendingGrantToolCall(call: { title?: string; content?: unknown }): boolean {
  return pendingCardKind(call) !== undefined;
}


/**
 * The device an instantly approved `request_grant` added this turn, if any.
 * bwrap fixes `/dev` when a session starts, so the turn loop runs the same turn
 * again in a fresh session that has it (`deviceGrantResumePrompt`).
 */
export function approvedDeviceGrant(
  calls: readonly { title?: string; content?: unknown }[],
): string | undefined {
  for (const call of calls) {
    if (!/(?:^|[._:/-])request_grant$/i.test(call.title ?? '')) continue;
    const text = typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? '');
    const device = /approved: use (\/dev\/\S+) \[grant [^\]]*\]\. A running session cannot add a device/.exec(text)?.[1];
    if (device) return device;
  }
  return undefined;
}


/** The prompt that continues a turn after an instantly approved device grant. */
export function deviceGrantResumePrompt(device: string, earlierReply: string): string {
  const earlier = earlierReply.trim();
  return [
    `Your device grant for ${device} was approved and ${device} is in this session now; this is the same turn continuing.`,
    ...(earlier ? [`Your reply just before this was: ${earlier}`] : []),
    'Continue the work that needed the device. Do not request it again or ask anyone to restart.',
  ].join(' ');
}


/**
 * The resume prompt for the answer that woke a paused turn. A grant answer and
 * a connector-offer answer resume the same way (`RESUME_KINDS`), but the model
 * must be told which question was answered — the connector one arrives as
 * `<person> added <tool>`, and its right response is to acknowledge and carry
 * on with the work that needed the tool, not to look for a grant verdict.
 */
export function resumePrompt(item: { body: string; systemEvent?: SystemEvent }): string {
  if (item.systemEvent?.kind === 'squire-approval-decided') {
    return [
      `This is Trusty Squire's answer to the approval you were waiting on: ${item.body}.`,
      'Your paused work resumes now.',
      'If it was approved, continue exactly where you left off with Trusty Squire; do not ask the person to approve again, and do not restart the task.',
      'If it was denied, stop that Trusty Squire action and say plainly what you cannot do.',
      'If it got no answer, the approval expired; say so plainly, and ask again only if the person still wants it.',
    ].join(' ');
  }
  if (item.systemEvent?.kind === 'connector-offer-decided') {
    return [
      `This is the answer to your connector offer: ${item.body}.`,
      'Your paused work resumes now. The tool is being installed on your machine; its sign-in and status reach the person through the tool’s own status message, not through you.',
      'Acknowledge in one short line (for example "Adding Trusty Squire now.") and continue the work that needed it, or say plainly what still has to happen before you can.',
    ].join(' ');
  }
  const grant = parseGrantDecisionLine(item.body);
  if (grant?.kind === 'device' && grant.decision !== 'deny') {
    return [
      'This is the answer to your grant request; your paused work resumes now.',
      `The approved device ${grant.target} is in this session.`,
      'Continue the paused work with it now; do not restart, schedule another turn, or request the device again.',
    ].join(' ');
  }
  if (grant?.kind === 'mcp' && grant.decision !== 'deny') {
    return [
      'This is the answer to your grant request; your paused work resumes now.',
      `The approved ${grant.target} route is mounted in this session.`,
      'Continue the paused work with that tool now; do not restart, schedule another turn, or request the route again.',
    ].join(' ');
  }
  return [
    'This is the answer to your grant request; your paused work resumes now.',
    'If it was approved and it is a command grant, run it with run_granted_command and the exact argv.',
    'If it was declined, try another way or say plainly what you cannot do.',
  ].join(' ');
}


/**
 * The Room's members and the one @spelling that reaches each of them.
 *
 * Everywhere else the prompt names people by DISPLAY name — the transcript's
 * bylines, `Current task selected by the server from <name>` — and nothing in it ever carried a
 * handle. So a model with something to say to someone had no authoritative
 * spelling to write and had to guess one, or copy one out of the conversation,
 * where a handle retired releases ago still sits in its own old messages. A
 * guessed tag resolves to nobody, and nobody is told it was written.
 *
 * Built from the roster this turn was fetched with, so a newcomer is taggable
 * on the turn they arrive. The server resolves tags in the final reply against
 * current Room membership when it stores the message.
 */
export interface ActiveTurn {
  item: HumanMessage;
  steers: HumanMessage[];
  steerTail: Promise<void>;
  resumeRequested: boolean;
  /** The requester stopped this turn: publish nothing, settle nothing. */
  cancelled: boolean;
  phase: 'prompting' | 'finishing';
  promise: Promise<void>;
}


export interface MonolithRoomTurnHealth {
  poll(): void;
}


export interface MonolithRoomTurnOptions {
  roomId: string;
  workspaceId: string;
  cwd: string;
  /** Refresh the server-bound checkout before each admitted Room turn. */
  refreshCheckout?: () => Promise<{
    cwd: string;
    branch?: string;
    commit?: string;
    githubToken?: string;
  }>;
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: AgentProcesses;
  health: MonolithRoomTurnHealth;
  onSubscriptionState?: (connected: boolean) => void;
  onIntakeError?: (error: unknown) => void;
  signal?: AbortSignal;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  onCornerOpened?: () => void;
  onRestartRequested?: () => Promise<void>;
  canStartTurn?: () => boolean;
  /** Keeps this Room's intake alive across failed reads. */
  supervisor?: RoomSupervisor;
  /** Attachment downloads (test seam). */
  fetchImpl?: typeof fetch;
  /** The daemon's command-grant runner; this Room registers its checkout and current turn. */
  grantRunner?: GrantCommandRunner;
  grantRunnerEndpoint?: GrantRunnerEndpoint;
}


/** This turn's `open_corner` call, under whatever prefix the harness titles it. */
export function openCornerToolCall(calls: readonly ToolCallEntry[]): ToolCallEntry | undefined {
  return calls.find((call) => /(?:^|[._:/-])open_corner$/i.test(call.title ?? ''));
}


/**
 * True only for a corner this turn actually opened.
 *
 * A completed open is what lets a textless turn settle through the card alone,
 * and what excuses the empty-turn retry and the turn backstop, so it asks
 * the harness for an affirmative `completed` and accepts nothing weaker. A call
 * still `pending` when the turn ended, or carrying no status at all, opened no
 * corner: read as success it would let a turn that said nothing pass as
 * answered by a card that never comes.
 */
export function openedACorner(call: ToolCallEntry | undefined): boolean {
  return !!call && isCompletedToolCall(call);
}


/**
 * An earlier transcript message: its attachments are markers the agent can
 * pass to download_attachment, never a download made while building the prompt.
 */
export function transcriptMessagePrompt(
  author: string,
  body: string,
  attachments: RoomMessage['attachments'],
  messageId: string,
  replyContext = '',
): string {
  return [
    `[message id: ${messageId}]`,
    `${author}: ${body.trim() || '(shared attachments)'}`,
    ...(replyContext ? [replyContext] : []),
    ...attachmentMarkerLines(attachments),
  ].join('\n');
}


export function roomMessagePrompt(
  author: string,
  body: string,
  attachments: RoomMessage['attachments'],
  delivered?: readonly DeliveredAttachment[],
  harnessAcceptsImages = true,
  messageId?: string,
  replyContext = '',
): string {
  const message = body.trim() || '(shared attachments)';
  const rendered = author ? `${author}: ${message}` : message;
  return [
    ...(messageId ? [`[message id: ${messageId}]`] : []),
    rendered,
    ...(replyContext ? [replyContext] : []),
    ...attachmentPromptLines(attachments, delivered, harnessAcceptsImages),
  ].join('\n');
}
