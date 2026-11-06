import { maskCredentialResult } from './mask-credential-result.js';
import { CommandActivationContext } from './helper-activation-context.js';
import { FreeAgentContinuation } from './free-agent-continuation.js';
import { type TurnTokenFigure } from './harness-turn-tokens.js';
import { TurnUsageAccumulator } from './turn-usage.js';
import { CommandExecutionContext } from './server-command-intake.js';
import type { InterruptedTurn } from './force-update-journal.js';
import { SquireTaskRelay } from './squire-task-relay.js';
import { resourceCallFacts } from './resource-mcp-facade.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type DaemonAttachment, type DaemonOperationMap } from '@beeline/api-contract/daemon';
import { AcpClient, type PromptResult, type ToolCallEntry } from './acp.js';
import { HarnessQuotaReader } from './harness-quota.js';
import { ConnectorUsageRecorder } from './connector-runner.js';
import { turnErrorDetail } from './turn-failure-reason.js';
import { type BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { type EmptyTurnExplanation } from './empty-turn.js';
import type { GrantCommandRunner, GrantRunnerEndpoint } from './grant-runner.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { cornerReviewerInstruction, type PromptSurface, type SessionPromptContext } from './prompt-assembly.js';
import { AgentProcesses, type AgentProcessLifecycle } from './agent-process.js';
import { WarmTranscript } from './warm-transcript.js';
import { harnessSupportsNativeSessionResume } from './harness-capabilities.js';
import { PromptSectionBaseline } from './prompt-section-baseline.js';
import type { RoomSupervisor } from './room-supervisor.js';
import { TurnTrace, type TurnTraceSink } from './turn-trace.js';
import { type CornerGitHubCli } from './corner-github-auth.js';

import { monolithCornerTurnLoopRetainBackgroundClient, monolithCornerTurnLoopConfigurationChanged, monolithCornerTurnLoopRequestReconciliation, monolithCornerTurnLoopIsBusy, monolithCornerTurnLoopRequestClose, monolithCornerTurnLoopRefreshPersonaForSoulUpdate, monolithCornerTurnLoopPrepareForForcedUpdateRestart, monolithCornerTurnLoopInterruptedTurn, monolithCornerTurnLoopInterruptForServerMinimum, monolithCornerTurnLoopForceRecoverRoom, monolithCornerTurnLoopStopTurn, monolithCornerTurnLoopCommandActivation, monolithCornerTurnLoopConfiguration, monolithCornerTurnLoopRestoredState, monolithCornerTurnLoopRepositoryState, monolithCornerTurnLoopRoster, monolithCornerTurnLoopWriteBackClaudeLogin, monolithCornerTurnLoopPublishOpenRouterSpend, monolithCornerTurnLoopPublishHarnessQuota, monolithCornerTurnLoopCaptureTurnMetrics, monolithCornerTurnLoopWatchClaudeLogin, monolithCornerTurnLoopStopClaudeLoginWatch, monolithCornerTurnLoopDiscardSession, monolithCornerTurnLoopSessionIsCurrent, monolithCornerTurnLoopCurrentSessionFingerprint, monolithCornerTurnLoopGrantedResources, monolithCornerTurnLoopActivate } from './monolith-corner-turn-retain-background-client.js';
import { monolithCornerTurnLoopActivateCold, monolithCornerTurnLoopActiveReviewerInstruction, monolithCornerTurnLoopLifecycle } from './monolith-corner-turn-activate-cold.js';
import { monolithCornerTurnLoopAcceptsImages, monolithCornerTurnLoopServingProviders, monolithCornerTurnLoopExplainEmpty, monolithCornerTurnLoopRepinNextProvider, monolithCornerTurnLoopBeginTurnTrace, monolithCornerTurnLoopWithCheckout } from './monolith-corner-turn-accepts-images.js';
import { monolithCornerTurnLoopPrompt } from './monolith-corner-turn-prompt.js';
import { monolithCornerTurnLoopHarvestWarmNodeModules, monolithCornerTurnLoopSyncBranch, monolithCornerTurnLoopRun } from './monolith-corner-turn-harvest-warm-node-modules.js';

export class MonolithCornerTurnLoop {

   readonly commandContext: CommandExecutionContext;

   readonly activationContext: CommandActivationContext;

   readonly squireRelay: SquireTaskRelay;

   readonly agent: ReturnType<typeof runtimeIdentity>;

   wakeIntake?: () => void;

   reviewerCheckout = false;

   branchSyncNotice?: string;

   readonly retiredClients = new Map<AcpClient, { done: Promise<void>; check: () => void; stop: () => void }>();
/** Retire the conversation immediately, but keep its existing tools and wake callbacks alive. */
retainBackgroundClient(client: AcpClient): Promise<void> { return monolithCornerTurnLoopRetainBackgroundClient(this, client); }

   recoverIntake?: () => void;
configurationChanged(): void { return monolithCornerTurnLoopConfigurationChanged(this); }
/**
 * Called on socket resubscription. A `corner-complete` published while that
 * socket was down is recovered by a single durable read.
 *
 * The wake is the intake loop's own stable notify and is handed back exactly
 * once, so it is kept: clearing it here left `requestClose` waking nothing
 * after the first reconciliation. Intake clears it itself when it exits.
 */
requestReconciliation(): void { return monolithCornerTurnLoopRequestReconciliation(this); }

   client?: AcpClient;

   claudeLoginWatch?: { close(): void };

   sessionId?: string;

  /** MCP subprocesses capture this generation-specific path at launch. */
   sessionContextPath?: string;

  /** The configuration the live session baked in; a change invalidates it. */
   sessionFingerprint?: string;

  /** Whether CodeGraph preparation succeeded for the live session. */
   sessionCodegraphReady = false;

  /** What this exact ACP session has already been prompted with (`warm-transcript.ts`). */
   readonly warmTranscript: WarmTranscript;

   readonly freeContinuation: FreeAgentContinuation;

  /** What each turn section last sent to this exact ACP session hashed to (`prompt-section-baseline.ts`). */
   readonly sectionBaseline = new PromptSectionBaseline();

  /** The live session's environment, read back for pi's own turn record. */
   agentEnv: Record<string, string> = {};

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

   modelContextTokens?: number;

  /** OpenRouter providers this activation pinned, in order (C92). */
   pinnedProviders: string[] = [];

  /** Whether the pinned model takes images; `undefined` when the pin did not say. */
   modelTakesImages?: boolean;

  /** The one provider re-pinned after an empty completion, until the session ends. */
   pinnedProviderOverride?: string;

  /**
   * Identity-only reviewer context, set when this agent holds the Room's
   * reviewer post; the exact PR head is refreshed inside each review turn.
   */
   reviewerInstructionInput?: ReviewerInstructionInput;

  /** The role-specific second-chance instruction for this session. */
  /** Repository state already given a delivery reminder, until that state changes. */
   lastDeliveryNudgeState?: string;

   turnSessionPrefix = '';

  /** The session prompt's section ids, for `report_feedback` (with each turn's). */
   sessionPromptSectionIds: readonly string[] = [];

   sessionSurface: PromptSurface = 'code-corner';

   sessionPromptContext?: SessionPromptContext;

   repositoryWork = true;

  /** Whether this corner's gh launcher uses a host binary or the REST fallback. */
   cornerGitHubCli: CornerGitHubCli = 'host';

   busy = false;

   forcedStop = false;

   branchSyncController?:AbortController;

   activityTail = Promise.resolve();

  /** The model selected for the live ACP session, independent of later settings edits. */
   sessionModel: string | null = null;

  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
   attachmentDir?: string;

  /** The session's TMPDIR, where a granted command's script argument may also live. */
   sessionScratchDir?: string;

  /** The turn in flight and who asked for it, for ledger rows and the grant runner. */
   currentTurn?: { requestId: string; requester?: { pubkey: string; name?: string } };

  /** Operator-local turn traces; built once when the daemon configured a directory. */
   turnTraceSink?: TurnTraceSink;

   memberNames = new Map<string, string>();

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
   readonly stoppedTurns = new Set<string>();

  /** Live corner-complete: close now, do not wait for the recovery GET. */
   closePushed = false;

  /** One durable state read after a socket reconnect/discovery pass. */
   reconcileCloseRequested = false;


  /** In-flight warm-store harvest, awaited at shutdown and never by a turn. */
   harvest: Promise<void> | undefined;


  constructor( readonly options: MonolithCornerTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
    const nativeResume = harnessSupportsNativeSessionResume(options.config.agentCommand ?? options.config.agentBinary);
    this.freeContinuation = new FreeAgentContinuation(options.config.agentHomeRoot
      ? resolve(options.config.agentHomeRoot, 'free-agent-continuation.json') : undefined);
    this.warmTranscript = new WarmTranscript(nativeResume && options.config.agentHomeRoot
      ? { path: join(options.config.agentHomeRoot, 'warm-transcript.json') } : {});
    this.commandContext = new CommandExecutionContext(options.config.agentHomeRoot);
    this.squireRelay = new SquireTaskRelay(
      this.agent.publicKey,
      options.cornerId,
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
        options.api
          .execute('postSquireApprovalDecision', { roomId: options.cornerId, ...decision })
          .catch((error: unknown) =>
            console.error('[thin-core] Squire approval decision publication failed:', turnErrorDetail(error)));
      },
      (sessionId) => {
        options.api.execute('endComputerSession', { roomId: options.cornerId, sessionId }).catch(() => {});
      },
      async (lease) => (await options.api.execute('refreshComputerSession', { roomId: options.cornerId, ...lease })).live,
      (url, siteUrl) => {
        options.api.execute('forgetSquireSignIn', { url, ...(siteUrl ? { siteUrl } : {}) }).catch(() => {});
      },
      async (service) => {
        const view = await this.options.api.execute('readAgentWorkbench', { roomId: options.cornerId });
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
    const checkout = this.options;
    options.grantRunner?.register(options.cornerId, {
      workspaceId: options.workspaceId,
      get cwd() { return checkout.worktreePath; },
      // A corner is the surface with `run-host-command`: its worktree becomes a
      // branch and a pull request, and host work belongs here, next to the
      // transcript that explains it. A granted command runs unwrapped (C94).
      writePolicy: () => {
        return {
          surface: this.options.repository?.readOnly ? 'room' as const : 'corner' as const,
          ...(this.options.repository?.readOnly ? { bwrapPath: this.options.config.bwrapPath,
            harnessStateDirs: [this.options.config.agentHomeRoot, this.options.config.agentPrivateRoot].filter((path): path is string => Boolean(path)),
          } : {}),
          ...(this.sessionScratchDir ? { scratch: this.sessionScratchDir } : {}),
        };
      },
      turn: () =>
        this.currentTurn
          ? { ...this.currentTurn, generationId: this.commandContext.generationId }
          : undefined,
    });
  }
isBusy(): boolean { return monolithCornerTurnLoopIsBusy(this); }
/** corner-complete on the wire: wake intake so `closed()` reaps now. */
requestClose(): void { return monolithCornerTurnLoopRequestClose(this); }
refreshPersonaForSoulUpdate(): Promise<void> { return monolithCornerTurnLoopRefreshPersonaForSoulUpdate(this); }
async prepareForForcedUpdateRestart(): Promise<void> { return monolithCornerTurnLoopPrepareForForcedUpdateRestart(this); }
interruptedTurn(): InterruptedTurn | undefined { return monolithCornerTurnLoopInterruptedTurn(this); }
interruptForServerMinimum(): InterruptedTurn | undefined { return monolithCornerTurnLoopInterruptForServerMinimum(this); }
async forceRecoverRoom(): Promise<void> { return monolithCornerTurnLoopForceRecoverRoom(this); }
/**
 * Obey a stop the requester already made a fact.
 *
 * The id is remembered whether or not it names the turn in flight: a stop for
 * work not yet started must still keep that work from starting, and one for a
 * turn that has already ended is simply never read again. Only the session
 * actually running the stopped turn is cancelled.
 */
stopTurn(requestId: string): void { return monolithCornerTurnLoopStopTurn(this, requestId); }
commandActivation() { return monolithCornerTurnLoopCommandActivation(this); }
async configuration() { return monolithCornerTurnLoopConfiguration(this); }
async restoredState() { return monolithCornerTurnLoopRestoredState(this); }
async repositoryState() { return monolithCornerTurnLoopRepositoryState(this); }
async roster(): Promise<WorkspaceRoster> { return monolithCornerTurnLoopRoster(this); }
/**
 * Drop this corner's live harness process. The next activation starts cold.
 * A rotation is a fact about one live session, so the pin goes with it.
 */
/**
 * Claude Code may have refreshed its login during the prompt, detaching
 * this Room's credential link. Share the rotated login now so other Rooms
 * do not spend the old refresh token before this Room's next activation.
 */
async writeBackClaudeLogin(): Promise<void> { return monolithCornerTurnLoopWriteBackClaudeLogin(this); }


  /**
   * What this turn really cost and did, read at the moment its prompt settled.
   *
   * The token count is the harness's own (pi records it; every other harness
   * leaves it unknown) and the byte count is the prompt this process handed over
   * — together they are the only way the rollout budget gate can measure the
   * institutional block's share of a real prompt instead of a byte estimate.
   * Missing numbers are omitted rather than zeroed.
   */
  /** This agent's own OpenRouter key when its model routes there. */
   openRouterKey?: string;

   openRouterSpendPublish: Promise<unknown> = Promise.resolve();

  /** Plan quota read through quota-axi, throttled per agent across loops. */
   harnessQuota?: HarnessQuotaReader;
/**
 * After a turn, refresh the owner's view of this agent's OpenRouter key
 * spend. `refused` marks a turn OpenRouter refused with 402.
 */
publishOpenRouterSpend(refused = false): void { return monolithCornerTurnLoopPublishOpenRouterSpend(this, refused); }
/** After a turn, refresh the owner's view of this agent's plan quota. */
publishHarnessQuota(): void { return monolithCornerTurnLoopPublishHarnessQuota(this); }
async captureTurnMetrics() { return monolithCornerTurnLoopCaptureTurnMetrics(this); }
/**
 * Watch this client's Claude login so a refresh made while the
 * corner is idle reaches other Rooms at once (see `watchRoomClaudeLogin`).
 */
watchClaudeLogin(): void { return monolithCornerTurnLoopWatchClaudeLogin(this); }
stopClaudeLoginWatch(): void { return monolithCornerTurnLoopStopClaudeLoginWatch(this); }
async discardSession(preserveConversation = false, stopBackground = false): Promise<void> { return monolithCornerTurnLoopDiscardSession(this, preserveConversation, stopBackground); }
/** See `MonolithRoomTurnLoop.sessionIsCurrent`: retention never keeps a
 *  session whose persona, model pin, or mounted MCP set the operator has
 *  since changed, or whose harness process has exited. */
async sessionIsCurrent(): Promise<boolean> { return monolithCornerTurnLoopSessionIsCurrent(this); }
async currentSessionFingerprint(): Promise<string> { return monolithCornerTurnLoopCurrentSessionFingerprint(this); }
async grantedResources() { return monolithCornerTurnLoopGrantedResources(this); }
async activate(trace?: TurnTrace): Promise<string> { return monolithCornerTurnLoopActivate(this, trace); }
async activateCold(trace?: TurnTrace): Promise<string> { return monolithCornerTurnLoopActivateCold(this, trace); }
/**
 * Resolve the review target at prompt time, not session activation time.
 *
 * A push can land after a reviewer session starts but before its first
 * prompt, or while that prompt is running. The active prompt and its bounded
 * second pass therefore each read the current green lifecycle head. The
 * server still compares approve_merge's SHA with the current head, so a push
 * after this read fails closed too.
 */
async activeReviewerInstruction(refreshChecks = true): Promise<string | undefined> { return monolithCornerTurnLoopActiveReviewerInstruction(this, refreshChecks); }
/** Queue timing ends when this conversation starts or reuses its process. */
lifecycle(trace?: TurnTrace): AgentProcessLifecycle { return monolithCornerTurnLoopLifecycle(this, trace); }
/** A picture reaches the model only if the harness AND the model take one (C87). */
acceptsImages(): boolean { return monolithCornerTurnLoopAcceptsImages(this); }
/** The pinned providers a failure reason should name for this session. */
servingProviders(): string[] { return monolithCornerTurnLoopServingProviders(this); }
/** Why a turn carried no answer text, or undefined when it did. */
async explainEmpty(result: PromptResult): Promise<EmptyTurnExplanation | undefined> { return monolithCornerTurnLoopExplainEmpty(this, result); }
/**
 * Re-pin the session to the next provider in the OpenRouter order and open a
 * fresh session on it, so the retry of an empty completion or a failing
 * provider is served — and named — by exactly one provider (C92).
 */
async repinNextProvider(trace?: TurnTrace, reason?: string): Promise<string | undefined> { return monolithCornerTurnLoopRepinNextProvider(this, trace, reason); }
/** One turn's stopwatch; writes only when the daemon configured a trace directory. */
beginTurnTrace(requestId: string): TurnTrace { return monolithCornerTurnLoopBeginTurnTrace(this, requestId); }
async withCheckout<T>(work: () => Promise<T>): Promise<T> { return monolithCornerTurnLoopWithCheckout(this, work); }
async prompt(requestId: string, trigger: string, attachments: readonly DaemonAttachment[] = [], requestedById?: string,
/** Server system lines this turn answers; a reply that only restates them is dropped. */
restates?: readonly string[], sourceMessageId?: string): Promise<void> { return monolithCornerTurnLoopPrompt(this, requestId, trigger, attachments, requestedById, restates, sourceMessageId); }
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
harvestWarmNodeModules(): void { return monolithCornerTurnLoopHarvestWarmNodeModules(this); }
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
async syncBranch(): Promise<void> { return monolithCornerTurnLoopSyncBranch(this); }
async run(): Promise<void> { return monolithCornerTurnLoopRun(this); }
}



export type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];

export type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

export type ReviewerInstructionInput = Parameters<typeof cornerReviewerInstruction>[0];


export const execFileAsync = promisify(execFile);

export const TOOL_ARGUMENT_MAX_BYTES = 1_200;

export const TOOL_OUTPUT_MAX_BYTES = 3_200;

export const TOOL_PATH_LIMIT = 12;

/** How long a turn start waits out a GitHub outage before it fails. */

export function isCornerChecksTurn(trigger: string, restates?: readonly string[]): boolean {
  return Boolean(restates) || /\b(?:passed|failed) a check\b/i.test(trigger);
}


/**
 * A green-checks wake of the Room's reviewer: the server wakes only the
 * reviewer on a green head (`corner-lifecycle.ts` `checksReported`). A
 * failing-checks wake goes to the agent that writes the code, so a reviewer
 * that writes code still gets its fix-and-push turn.
 */
export function isCornerReviewTurn(reviewer: boolean, trigger: string): boolean {
  return reviewer && /\bpassed a check\b/i.test(trigger);
}


export async function cornerUndeliveredRepositoryState(
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


export async function firstResolvedRemoteRef(
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


export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}


export function serialized(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}


export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}


export function clampBytes(value: string, maxBytes: number, preserveWhitespace = false): string {
  const clean = preserveWhitespace ? value : value.trim();
  if (Buffer.byteLength(clean) <= maxBytes) return clean;
  const suffix = '\n…[truncated]';
  const allowed = maxBytes - Buffer.byteLength(suffix);
  let end = Math.max(0, allowed);
  const bytes = Buffer.from(clean);
  // Do not persist a replacement glyph produced by cutting a UTF-8 sequence.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}${suffix}`;
}


export function outputText(value: unknown): string {
  if (typeof value === 'string') {
    if (!/^[\s]*[\[{\"]/.test(value)) return value;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'string') return parsed;
      return outputText(parsed);
    } catch {
      // The harness can also send ordinary, unencoded text.
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join('\n');
  const object = record(value);
  if (!object) return '';
  const entries = Object.entries(object);
  for (const key of [
    'formatted_output',
    'stdout',
    'stderr',
    'output',
    'text',
    'content',
    'message',
    'result',
    'error',
  ]) {
    for (const [entryKey, entryValue] of entries) {
      if (entryKey.toLowerCase() !== key) continue;
      const text = outputText(entryValue);
      if (text) return text;
    }
  }
  return serialized(value);
}


export function outputExcerpt(value: unknown): string | undefined {
  const text = outputText(value);
  if (!text.trim()) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  if (lines.length <= 8) return clampBytes(lines.join('\n'), TOOL_OUTPUT_MAX_BYTES, true);
  return clampBytes(
    [...lines.slice(0, 4), '…[output omitted]…', ...lines.slice(-4)].join('\n'),
    TOOL_OUTPUT_MAX_BYTES,
    true,
  );
}


export function filePaths(value: unknown, worktreePath: string): string[] {
  const paths = new Set<string>();
  const visit = (candidate: unknown, key?: string) => {
    if (paths.size >= TOOL_PATH_LIMIT || candidate === null || candidate === undefined) return;
    if (typeof candidate === 'string') {
      if (key && /(?:^|_)(?:path|file|filename|target)$/i.test(key)) {
        const path = candidate.startsWith(`${worktreePath}/`)
          ? candidate.slice(worktreePath.length + 1)
          : candidate;
        if (path && path.length <= 512) paths.add(path);
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


export function resultStatus(call: ToolCallEntry): string {
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


export function toolArguments(call: ToolCallEntry): { command?: string; input?: string } {
  const raw = record(call.rawInput);
  const command =
    typeof call.rawInput === 'string'
      ? call.rawInput
      : typeof raw?.command === 'string'
        ? raw.command
        : typeof raw?.cmd === 'string'
          ? raw.cmd
          : undefined;
  if (command) return { command: clampBytes(command, TOOL_ARGUMENT_MAX_BYTES) };
  const input = serialized(call.rawInput);
  return input ? { input: clampBytes(input, TOOL_ARGUMENT_MAX_BYTES) } : {};
}


export function toolCallKey(call: ToolCallEntry, index: number): string {
  return call.id ? `id-${createHash('sha256').update(call.id).digest('hex')}` : `tool-${index}`;
}


export function toolCallSettled(call: ToolCallEntry): boolean {
  if (call.resultReceived) return true;
  return /^(?:completed|complete|failed|error|succeeded|success|passed|done)$/i.test(
    call.status ?? '',
  );
}


export function isSuccessfulCommit(call: ToolCallEntry): boolean {
  if (/failed|error|denied/i.test(call.status ?? '')) return false;
  return /\bgit\s+commit\b|\bcommit(?:ted)?\s+(?:changes|files?)\b/i.test(
    `${call.title ?? ''} ${serialized(call.rawInput)}`,
  );
}


/** Turn one physical ACP tool call into a bounded indexed ledger row. */
export async function cornerToolActivity(
  call: ToolCallEntry,
  worktreePath: string,
  requestedBy?: { pubkey: string; name?: string },
): Promise<DaemonActivity> {
  call = maskCredentialResult(call);
  const operation = oneLine(call.kind ?? '') || 'tool';
  let title = oneLine(call.title ?? '') || `${operation} tool`;
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
  const output = outputExcerpt(call.content ?? call.rawOutput);
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
  /** Present exactly when the parent Room is bound to a repository: this is then a code corner. */
  repository?: {
    featureBranch: string;
    targetBranch: string;
    gitCommonDir: string;
    githubToken: string;
    readOnly?: boolean;
  };
  /** Gives a writer its private copy; every other turn gets the Room's read-only checkout. */
  prepareCheckout?: (repositoryWork: boolean, implementerAgentId?: string, assigned?: boolean) =>
    Promise<{ path: string; gitCommonDir: string; writable: boolean }>;
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: AgentProcesses;
  signal?: AbortSignal;
  /** Close-request recovery interval (test seam); defaults to the jittered 10 min. */
  closePollMs?: number;
  onPoll(): void;
  onSubscriptionState?: (connected: boolean) => void;
  onIntakeError?: (error: unknown) => void;
  onCloseRequested(): Promise<void>;
  onRestartRequested?: () => Promise<void>;
  canStartTurn?: () => boolean;
  /** Keeps this corner's intake alive across failed reads. */
  supervisor?: RoomSupervisor;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  /** Attachment downloads (test seam). */
  fetchImpl?: typeof fetch;
  /** The daemon's command-grant runner; this corner registers its worktree and current turn. */
  grantRunner?: GrantCommandRunner;
  grantRunnerEndpoint?: GrantRunnerEndpoint;
  /** Connection usage capture: batched per turn into one postConnectionUsage. */
  connectorUsage?: ConnectorUsageRecorder;
}
