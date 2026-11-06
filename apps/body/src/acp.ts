import { STDERR_TAIL_MAX_CHARS, flattenHarnessCause, AcpRuntimeExitedError, isPiAcpHarness, killChildProcessGroup } from './acp-stderr-tail-max-chars.js';



import { piStartupEnvironment } from './pi-startup.js';

import { explainAgentProgramFailure } from './agent-command.js';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
/**
 * Minimal ACP client over stdio for an ACP coding agent.
 *
 * Wire protocol (buzz-agent ACP, NOT MCP):
 *   - initialize: protocolVersion is u32 (1), uses clientCapabilities
 *   - session/new: returns { sessionId, models }
 *   - session/prompt: sends prompt as array of {type, text}
 *   - session/update: notification from agent with { sessionId, update }
 *   - session/request_permission: request from agent with options
 *
 * Rationale (see PR): stock buzz-acp auto-approves permissions, mounts at most
 * one MCP via env, and does not project session/update onto the relay. The body
 * therefore drives the selected ACP server directly so session modes/MCP mounts
 * stay enforceable and multi-user activity projection remains possible.
 */
import { spawn } from 'node:child_process';
import { acpClientPreparePromptDelivery, acpClientPromptDelivery, acpClientHandleChildExit, acpClientFailRuntime, acpClientProcessPid, acpClientSessionCommandsFor, acpClientCanLoadSession, acpClientCanPromptWithImages, acpClientSessionNew, acpClientSessionLoad, acpClientApplySessionMode, acpClientSessionPrompt } from './acp-prepare-prompt-delivery.js';
import { acpClientSessionSteer, acpClientActiveRunId, acpClientSessionCancel, acpClientSetConfigOption, acpClientSetModel, acpClientOnData, acpClientHandleMessage, acpClientActiveRunIdFromUpdate, acpClientWaitForActiveRun, acpClientHandlePermission, acpClientRequest, acpClientNotify, acpClientWrite } from './acp-session-steer.js';
import { CodexPromptDelivery } from './codex-prompt-delivery.js';
import { readUsageWindow, type AgentUsage, type UsageWindow } from '@beeline/api-contract/daemon';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PiSessionInstructions } from './pi-session-instructions.js';
import { McpLaunchFiles } from './mcp-launch-files.js';
import { AcpResourceScope } from './acp-resource-scope.js';
import type { SessionMode } from './config.js';
import { harnessSupportsNativeSessionResume } from './harness-capabilities.js';
import { cgroupOomKillProbe, OomKillTracker, type OomKillDetector } from './oom-kill.js';
import { SessionUpdate, ToolCallEntry, AcpPermissionRequest, AcpAvailableCommand, AcpPermissionHandler, AcpPermissionAllowlist, McpServerWire, AcpPromptBlock, AcpTextChunkHandler, AcpStreamHandler, PromptResult, SteerResult } from './acp-stderr-tail-max-chars.js';
export { STDERR_TAIL_MAX_CHARS, meaningfulHarnessStderr, flattenHarnessCause, AcpRequestError, AcpRuntimeExitedError, AcpResourceLimitError, killChildProcessGroup, type McpServerWire, type SessionUpdate, type ToolCallEntry, type PromptResult, type AcpPromptBlock, type SteerResult, type AcpPermissionOption, type AcpAvailableCommand, parseAvailableCommands, type AcpPermissionRequest, type AcpPermissionDecision, type AcpPermissionHandler, type AcpPermissionAllowlist, type AcpTextChunkHandler, type AcpStreamSnapshot, type AcpStreamHandler, agentMessageChunkText, isPiAcpHarness, agentMessageRuns, isPureRetryNarration, finalAgentMessageText, type AgentTurnStep, agentTurnSteps, describeEmptyTurn, agentStreamSnapshot } from './acp-stderr-tail-max-chars.js';



/** Collapse ACP's start/update/result notifications into one physical tool call. */
export function toolCallEntries(updates: readonly SessionUpdate[]): ToolCallEntry[] {
  const calls = new Map<string, ToolCallEntry>();
  let anonymous = 0;
  let activeAnonymous: string | undefined;
  for (const { update } of updates) {
    const sessionUpdate = update.sessionUpdate as string | undefined;
    if (
      sessionUpdate !== 'tool_call' &&
      sessionUpdate !== 'tool_call_update' &&
      sessionUpdate !== 'tool_result'
    ) {
      continue;
    }
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    if (id) activeAnonymous = undefined;
    if (!id && (sessionUpdate === 'tool_call' || !activeAnonymous)) {
      activeAnonymous = `anonymous-${anonymous++}`;
    }
    const key = id ?? activeAnonymous!;
    const previous = calls.get(key);
    calls.set(key, {
      ...previous,
      id: key,
      ...(typeof update.name === 'string' ? { name: update.name } : {}),
      ...(typeof update.title === 'string' ? { title: update.title } : {}),
      ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
      ...(typeof update.status === 'string' ? { status: update.status } : {}),
      ...(sessionUpdate === 'tool_result' ? { resultReceived: true } : {}),
      ...('rawInput' in update ? { rawInput: update.rawInput } : {}),
      ...('content' in update ? { content: update.content } : {}),
      ...('rawOutput' in update ? { rawOutput: update.rawOutput } : {}),
      ...('locations' in update ? { locations: update.locations } : {}),
    });
    if (!id && sessionUpdate === 'tool_result') activeAnonymous = undefined;
  }
  return [...calls.values()];
}


export interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  sessionId?: string;
}


/** Claude ACP's negotiated asyncTasks extension keeps background Bash lifecycle
 * separate from the tool call, which is already completed once Bash detaches. */
export function asyncTaskCall(update: Record<string, unknown>): ToolCallEntry | undefined {
  if (typeof update.asyncTaskId !== 'string' || !update.asyncTaskId ||
      !['async_task_spawned', 'async_task_progress', 'async_task_state_update'].includes(String(update.sessionUpdate)))
    return undefined;
  const state = update.state;
  return {
    id: `async:${update.asyncTaskId}`,
    ...(typeof update.name === 'string' ? { title: update.name } :
      typeof update.description === 'string' ? { title: update.description } : {}),
    ...(update.sessionUpdate === 'async_task_spawned' ? { status: 'in_progress' } : {}),
    ...(typeof state === 'string' ? { status: state === 'stopped' ? 'failed' : state } : {}),
  };
}


export class AcpClient extends EventEmitter {

   child: ChildProcessWithoutNullStreams | null = null;

   buf = '';

   nextId = 1;

   pending = new Map<number, Pending>();

   activeRunIds = new Map<string, string>();

   activePromptSessions = new Set<string>();

   detachedTools = new Map<string, {
    call: ToolCallEntry;
    complete: (call: ToolCallEntry) => void;
  }>();

  /** Tool metadata arrives in session/update just before a sparse permission request. */
   toolCallMetadata = new Map<string, AcpPermissionRequest['toolCall']>();

  /** Latest `available_commands_update` per session, keyed by sessionId. */
   sessionCommands = new Map<string, AcpAvailableCommand[]>();

   supportsStandardSteering = false;

   supportsSessionLoading = false;

   supportsImagePrompts = false;

   supportsStructuredSystemPrompt = false;

   codexBlockDelivery = false;

   piDeliveryMarkers = new Map<string, string>();

   readonly promptDeliveries = new Map<string, CodexPromptDelivery>();
  async preparePromptDelivery(sessionId: string | undefined): Promise<void> { return acpClientPreparePromptDelivery(this, sessionId); }
  promptDelivery(sessionId: string | undefined): CodexPromptDelivery | undefined { return acpClientPromptDelivery(this, sessionId); }

   alive = false;

  /**
   * Byte length of the last prompt handed to the harness, measured here because
   * this is the boundary that actually sends it. The rollout budget gate turns
   * the harness's real prompt-token count into the institutional block's share
   * by dividing through this exact figure, so it may not be estimated anywhere
   * else.
   */
   lastPromptByteCount: number | undefined;

  /** Bounded tail of recent stderr, so a spawn/exit failure's rejection text
   *  carries the real reason (e.g. a harness's own "missing API key" notice)
   *  instead of just the bare exit code, in the daemon's log. */
   stderrTail = '';

   agentEnv: Record<string, string>;

   readonly piSessionInstructions = new PiSessionInstructions();

   harnessCommand: string;

   agentCommand: string;

   agentLabel: string;

   agentArgs: string[];

   agentCwd?: string;

   inheritProcessEnv: boolean;

   autoApprove: boolean;

   backgroundTasks: boolean;

   osSandbox: boolean;

   permissionHandler?: AcpPermissionHandler;

   permissionAllowlist?: AcpPermissionAllowlist;

   usageHandler?: (usage: AgentUsage) => void;

   sessionUsage = new Map<string, AgentUsage>();

   commandsHandler?: (commands: readonly AcpAvailableCommand[]) => void;

   oomKills: OomKillDetector;

   readonly useResourceScope: boolean;

   readonly resourceScopeMemoryMaxBytes?: number;

   resourceScope?: AcpResourceScope;

  /** A deliberate stop owns its SIGKILL; that exit is never labelled OOM. */
   stopping = false;

   readonly mcpLaunchFiles = new McpLaunchFiles();


  constructor(opts: {
    /** Legacy bare-binary option. Prefer agentCommand + agentArgs. */
    agentBinary?: string;
    agentCommand?: string;
    agentArgs?: string[];
    /**
     * Human name for the harness in error text. When the daemon wraps the child
     * in an OS sandbox (`bwrap-sandbox.ts`), `agentCommand` is `bwrap` — but a
     * spawn/exit failure has to name the harness the operator configured, not
     * the wrapper, or every harness crash is logged as a bubblewrap crash.
     */
    agentLabel?: string;
    /**
     * The child is wrapped in the daemon's OS sandbox (`bwrap-sandbox.ts`), so
     * the filesystem rule is held by the kernel and a `readonly` session may
     * select a harness mode that does not itself cut the network
     * (`roomModeCandidates`). Defaults to false: an unwrapped child keeps the
     * harness's own read-only mode.
     */
    osSandbox?: boolean;
    agentEnv: Record<string, string>;
    /** Actual harness executable before any OS sandbox wrapper. */
    harnessCommand?: string;
    /**
     * Working directory for the child process. The ACP session `cwd` is a
     * protocol parameter, so without this a harness that keys per-project
     * state off its own process cwd sees the daemon's directory for every
     * Room and corner.
     */
    agentCwd?: string;
    /**
     * Restore the pre-allowlist behaviour of spreading the daemon's whole
     * `process.env` underneath `agentEnv`. Escape hatch only — see
     * `buildAgentEnv`'s passthrough set.
     */
    inheritProcessEnv?: boolean;
    /** Negotiate pushed background Bash task lifecycles for corner continuations. */
    backgroundTasks?: boolean;
    autoApprovePermissions?: boolean;
    permissionHandler?: AcpPermissionHandler;
    /** Host-owned requests allowed while all other permissions are rejected. */
    permissionAllowlist?: AcpPermissionAllowlist;
    /** Provider plan and context snapshots, merged per session. */
    onUsage?: (usage: AgentUsage) => void;
    /** Full advertised-command snapshots, ready for the daemon's indexed read. */
    onCommands?: (commands: readonly AcpAvailableCommand[]) => void;
    /**
     * Kernel OOM-kill detector for this child. Defaults to the daemon cgroup's
     * own `memory.events` counter; tests inject a stub.
     */
    oomKills?: OomKillDetector;
    /** Managed Linux helpers use a scope by default; tests may opt out. */
    resourceScope?: 'systemd' | 'none';
    /** Test seam for the scope's hard memory ceiling. */
    resourceScopeMemoryMaxBytes?: number;
  }) {
    super();
    const command = opts.agentCommand ?? opts.agentBinary;
    if (!command) throw new Error('ACP agent command is required');
    this.agentCommand = command;
    this.harnessCommand = opts.harnessCommand ?? command;
    this.agentLabel = opts.agentLabel ?? command;
    this.agentArgs = [...(opts.agentArgs ?? [])];
    this.agentEnv = opts.agentEnv;
    if (opts.agentCwd) this.agentCwd = opts.agentCwd;
    this.inheritProcessEnv = opts.inheritProcessEnv ?? false;
    this.autoApprove = opts.autoApprovePermissions ?? true;
    this.backgroundTasks = opts.backgroundTasks ?? false;
    this.osSandbox = opts.osSandbox ?? false;
    this.permissionHandler = opts.permissionHandler;
    this.permissionAllowlist = opts.permissionAllowlist;
    this.commandsHandler = opts.onCommands;
    this.usageHandler = opts.onUsage;
    this.oomKills = opts.oomKills ?? new OomKillTracker(cgroupOomKillProbe());
    this.useResourceScope = opts.resourceScope === 'systemd' ||
      (opts.resourceScope === undefined && process.platform === 'linux' &&
        process.env.BEELINE_MANAGED_BY_SYSTEMD === '1');
    this.resourceScopeMemoryMaxBytes = opts.resourceScopeMemoryMaxBytes;
  }
  async startProcess(): Promise<void> {
    if (this.alive) return;
    this.promptDeliveries.clear();
    this.piDeliveryMarkers.clear();
    // Record the cgroup's OOM counter before this child can be its victim, so
    // an OOM kill later is measured against this run rather than the first
    // probe at exit time (which would miss it).
    await this.oomKills.prime().catch(() => undefined);
    this.stopping = false;
    let childEnv = piStartupEnvironment(
      this.agentLabel,
      this.inheritProcessEnv ? { ...process.env, ...this.agentEnv } : this.agentEnv,
    );
    if (isAbsolute(this.harnessCommand) &&
        !childEnv.BEELINE_FREE_AGENT_ID && !childEnv.BEELINE_FREE_AGENT_MODEL_TOKEN) {
      try {
        // npm links point into node_modules, while Node lives beside the bin
        // link. Prefer the real entry's directory, then its invoked directory,
        // before the inherited PATH so version-manager siblings stay together.
        const directories = [dirname(realpathSync(this.harnessCommand)), dirname(this.harnessCommand)];
        const pathKey = process.platform === 'win32'
          ? Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'PATH'
          : 'PATH';
        const previous = childEnv[pathKey];
        // POSIX exec uses this default search path when PATH is absent.
        // Adding the harness directory must preserve that implicit fallback.
        const entries = previous === undefined
          ? (process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])
          : previous.split(delimiter);
        const additions = [...new Set(directories)].filter(dir => !entries.includes(dir));
        if (additions.length) childEnv = { ...childEnv, [pathKey]: [...additions, ...entries].join(delimiter) };
      } catch {
        // Preserve the spawn error for a missing or inaccessible executable.
      }
    }
    this.resourceScope = this.useResourceScope
      ? new AcpResourceScope(this.resourceScopeMemoryMaxBytes) : undefined;
    const launch = this.resourceScope?.launch(this.agentCommand, this.agentArgs, childEnv);
    // Managed adapters are immutable; a candidate install never blocks sessions.
    this.child = spawn(launch?.command ?? this.agentCommand, launch?.args ?? this.agentArgs, {
      // agentEnv is the child's whole environment: buildAgentEnv's allowlist is
      // a real boundary, not a decorative one layered over a full inherit.
      env: launch?.env ?? childEnv,
      ...(this.agentCwd ? { cwd: this.agentCwd } : {}),
      // Managed Linux sessions use a cgroup scope. The process-group fallback
      // covers helpers without a user systemd manager.
      detached: !launch && process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;

    this.stderrTail = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
      this.emit('stderr', chunk);
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    const child = this.child;
    // Pipe closure is process loss even if a wrapper is still resident.
    const pipeClosed = (pipe: string) => {
      if (this.child === child && this.alive) {
        const stderr = flattenHarnessCause(this.stderrTail);
        this.failRuntime(`ACP agent ${this.agentLabel} ${pipe} pipe closed${stderr ? `: ${stderr}` : ''}`);
      }
    };
    this.child.stdout.on('end', () => pipeClosed('stdout'));
    this.child.stdout.on('close', () => pipeClosed('stdout'));
    this.child.stdout.on('error', (error) => this.failRuntime(`stdout: ${error.message}`));
    this.child.stdin.on('close', () => pipeClosed('stdin'));
    this.child.stdin.on('error', (error) => this.failRuntime(`stdin: ${error.message}`));

    this.child.on('exit', (code, signal) => {
      if (this.child === child) void this.handleChildExit(code, signal);
    });

    this.child.on('error', (err) => {
      // An ENOENT/unspawnable command never emits 'exit', so without this the
      // in-flight `initialize` request (and every later one) would hang until
      // its full timeout instead of failing now — which is what a catalog
      // probe or a session spawn against a broken agent binary needs.
      this.failRuntime(`ACP agent ${this.agentLabel}: ${err.message}`);
      // EventEmitter's 'error' event is special: emitting it with no
      // listener attached throws the error as an uncaught exception instead
      // of merely going unheard. No caller currently subscribes to this
      // instance's 'error' event (the rejected `pending` requests above are
      // the real, always-observed failure path), so guard the emit.
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    // ACP handshake: initialize, then send initialized notification.
    let initResult: Record<string, unknown>;
    try {
      initResult = (await this.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            ...(/(^|[/\\])(?:codex-acp|claude-(?:agent|code)-acp)(\.[a-z]+)?$/i.test(this.agentLabel)
              ? { session: { compaction: {} } } : {}),
            ...(this.backgroundTasks
              ? { _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } } } : {}),
          },
        },
      )) as Record<string, unknown>;
    } catch (error) {
      if (/EPIPE/.test(String(error)) && this.stderrTail.trim()) {
        throw new AcpRuntimeExitedError(`ACP agent ${this.agentLabel}: ${String(error)}: ${flattenHarnessCause(this.stderrTail)}`);
      }
      throw await explainAgentProgramFailure(error, this.agentEnv);
    }
    const initMeta = initResult._meta as Record<string, unknown> | undefined;
    const steering = initMeta?.steering as Record<string, unknown> | undefined;
    this.supportsStandardSteering = steering?.supported === true;
    const agentCapabilities = initResult.agentCapabilities as
      | {
          loadSession?: unknown;
          promptCapabilities?: { image?: unknown };
          sessionCapabilities?: { systemPrompt?: object | null };
        }
      | undefined;
    this.supportsSessionLoading = agentCapabilities?.loadSession === true;
    this.supportsImagePrompts = agentCapabilities?.promptCapabilities?.image === true;
    this.supportsStructuredSystemPrompt = agentCapabilities?.sessionCapabilities?.systemPrompt != null;
    const info = initResult.agentInfo as { version?: string } | undefined;
    // This adapter version was verified to emit all automatic and manual
    // compactions when the client advertises session.compaction. Unknown
    // adapters keep full delivery until their behavior is measured.
    this.codexBlockDelivery = (/(^|[/\\])codex-acp(\.[a-z]+)?$/i.test(this.agentLabel) &&
      this.supportsStructuredSystemPrompt && info?.version === '2.3.0') ||
      (/(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i.test(this.agentLabel) && info?.version === '0.97.0') ||
      isPiAcpHarness(this.agentLabel);
    this.emit('initialized', initResult);
    // ACP defines no `initialized` notification; pi-acp answers it with -32601
    // and dumps the notification to stderr on every session. Do not send it to
    // a harness that rejects it.
    if (!isPiAcpHarness(this.agentLabel)) this.notify('notifications/initialized', {});
  }
  /**
 * One child exit: reject every in-flight request so the turn fails and is
 * reported instead of hanging, then publish the exit. A scoped SIGKILL/137
 * is a likely memory-limit hit, while an unscoped SIGKILL uses the daemon
 * cgroup's OOM counter to distinguish it from a deliberate kill.
 */
async handleChildExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> { return acpClientHandleChildExit(this, code, signal); }
  failRuntime(detail: string): void { return acpClientFailRuntime(this, detail); }
  async stopProcess(): Promise<void> {
    const child = this.child;
    const scope = this.resourceScope;
    if (!child && !scope) { this.mcpLaunchFiles.clear(); return; }
    this.stopping = true;
    try {
      // Send shutdown if child is still alive.
      if (child?.stdin.writable) {
        this.notify('shutdown', {});
      }
    } catch {
      /* ignore */
    }
    // A scope contains even grandchildren that opened a new process group.
    // Fall back to the old group teardown only for unscoped sessions.
    if (scope) {
      await scope.stop();
      if (this.resourceScope === scope) this.resourceScope = undefined;
    } else if (child) {
      const exited = !child.pid || child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
      try { killChildProcessGroup(child, 'SIGKILL'); } catch { /* ignore */ }
      await exited;
    }
    this.mcpLaunchFiles.clear();
    this.child = null;
    this.alive = false;
    this.activeRunIds.clear();
    this.activePromptSessions.clear();
    this.detachedTools.clear();
    this.toolCallMetadata.clear();
  }


  get isAlive(): boolean {
    return this.alive;
  }
  /** Host pid of the harness wrapper (bwrap when enabled). */
processPid(): number | undefined { return acpClientProcessPid(this); }
  /** The latest command list this harness advertised for a session, if any. */
sessionCommandsFor(sessionId: string): AcpAvailableCommand[] { return acpClientSessionCommandsFor(this, sessionId); }
  /** Whether this live ACP process advertised the stable `session/load` method. */
canLoadSession(): boolean { return acpClientCanLoadSession(this); }
  /** Whether this live ACP process accepts `image` prompt blocks (`promptCapabilities.image`). */
canPromptWithImages(): boolean { return acpClientCanPromptWithImages(this); }
  async sessionNew(opts: {
    cwd: string;
    mcpServers?: McpServerWire[];
    systemPrompt?: string;
    /** Ask agents with ACP modes to enforce the Body session boundary. */
    mode?: SessionMode;
}): Promise<{
    sessionId: string;
    raw: unknown;
}> { return acpClientSessionNew(this, opts); }
  /**
 * Reopen a provider-persisted logical conversation in this new ACP process.
 * Unlike `session/new`, load accepts no system prompt: the harness restores
 * its own conversation and instructions instead of receiving transcript
 * text from Body again.
 */
async sessionLoad(opts: {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServerWire[];
    mode?: SessionMode;
}): Promise<{
    sessionId: string;
    raw: unknown;
}> { return acpClientSessionLoad(this, opts); }
  async applySessionMode(sessionId: string, raw: Record<string, unknown>, mode: SessionMode | undefined): Promise<void> { return acpClientApplySessionMode(this, sessionId, raw, mode); }


  /** Tool progress and process exit arrive through the ACP stream. */
  get hasBackgroundTools(): boolean {
    return this.detachedTools.size > 0;
  }


  get lastPromptBytes(): number | undefined {
    return this.lastPromptByteCount;
  }
  async sessionPrompt(sessionId: string, text: string | readonly AcpPromptBlock[], onChunk?: AcpTextChunkHandler, onActivity?: AcpStreamHandler, onToolCalls?: (calls: readonly ToolCallEntry[]) => void, onBackgroundToolCompletion?: (call: ToolCallEntry) => void): Promise<PromptResult> { return acpClientSessionPrompt(this, sessionId, text, onChunk, onActivity, onToolCalls, onBackgroundToolCompletion); }
  /**
 * Inject follow-up input into the prompt currently running for this session.
 * buzz-agent advertises the target run through ACP session metadata; binding
 * the request to that id prevents a late message from steering a newer turn.
 */
async sessionSteer(sessionId: string, text: string): Promise<SteerResult> { return acpClientSessionSteer(this, sessionId, text); }
  /** Active ACP run for a session, if the agent has advertised one. */
activeRunId(sessionId: string): string | undefined { return acpClientActiveRunId(this, sessionId); }
  sessionCancel(sessionId: string): void { return acpClientSessionCancel(this, sessionId); }
  /**
 * The portable model/effort setter, confirmed round-tripping on pi/codex/
 * claude (report `data/buzzy-multiagent-runtimes/report.md` §3.2). The
 * param is `configId`, not `optionId`. Harnesses that advertise this shape
 * must use it; `session/set_model` is reserved for the distinct standard
 * `session/new.models` shape. Returns the runtime's updated `configOptions`.
 * Callers must validate `configId`/`value` against the
 * allow-listed catalog before calling this — see
 * `apps/body/src/model-config.ts`'s `assertModelConfigOptionAllowed`; this
 * method performs no policy checks of its own.
 */
async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> { return acpClientSetConfigOption(this, sessionId, configId, value); }
  /**
 * Standard ACP model setter used only when `session/new.models` supplied the
 * corresponding safe model axis. Most Beeline harnesses use configOptions;
 * Grok currently exposes models through this standard method instead.
 */
async setModel(sessionId: string, modelId: string): Promise<unknown> { return acpClientSetModel(this, sessionId, modelId); }
  onData(chunk: string): void { return acpClientOnData(this, chunk); }
  handleMessage(msg: Record<string, unknown>): void { return acpClientHandleMessage(this, msg); }
  activeRunIdFromUpdate(update: Record<string, unknown>): string | undefined { return acpClientActiveRunIdFromUpdate(this, update); }
  waitForActiveRun(sessionId: string): Promise<string> { return acpClientWaitForActiveRun(this, sessionId); }


   readonly terminalSessions = new Set<string>();
  async handlePermission(id: unknown, params: unknown): Promise<void> { return acpClientHandlePermission(this, id, params); }
  /** Responses and transport loss settle requests; silence never starts a retry. */
request(method: string, params: unknown): Promise<unknown> { return acpClientRequest(this, method, params); }
  notify(method: string, params: unknown): void { return acpClientNotify(this, method, params); }
  write(obj: unknown): void { return acpClientWrite(this, obj); }
}


export interface OpenAcpConversationOptions {
  client: AcpClient;
  /** Configured harness command, not a bwrap wrapper command. */
  agentCommand: string | undefined;
  /** Logical conversation id retained across suspension or a helper restart. */
  resumeSessionId?: string;
  cwd: string;
  mcpServers?: McpServerWire[];
  mode?: SessionMode;
  /** Lazily builds the bounded re-prime and creates a genuinely new session. */
  create(): Promise<{ sessionId: string; raw: unknown }>;
  onResumeFailure?(error: unknown): void;
}


export type OpenAcpConversationResult = {
  sessionId: string;
  raw: unknown;
  kind: 'resumed' | 'created';
};


/**
 * Prefer the harness's own persisted conversation on an idle wake or helper restart.
 * The `create` callback is deliberately lazy: reading durable transcript and
 * constructing `session-reprime.ts` output must happen only when no native
 * conversation exists (expired idle lease, unsupported harness, or failed load).
 */
export async function openAcpConversation(
  options: OpenAcpConversationOptions,
): Promise<OpenAcpConversationResult> {
  if (
    options.resumeSessionId &&
    harnessSupportsNativeSessionResume(options.agentCommand) &&
    options.client.canLoadSession()
  ) {
    try {
      const resumed = await options.client.sessionLoad({
        sessionId: options.resumeSessionId,
        cwd: options.cwd,
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      });
      return { ...resumed, kind: 'resumed' };
    } catch (error) {
      options.onResumeFailure?.(error);
    }
  }

  const created = await options.create();
  return { ...created, kind: 'created' };
}


/** claude-agent-acp forwards SDK rate_limit_event.rate_limit_info here. */
export function parseAcpUsage(update: Record<string, unknown>, previous?: AgentUsage): AgentUsage | undefined {
  if (update.sessionUpdate !== 'usage_update') return;
  const updatedAt = Date.now() / 1000;
  const meta = update._meta as Record<string, unknown> | undefined;
  const info = meta?.['_claude/rateLimit'] as Record<string, unknown> | undefined;
  const window = readUsageWindow(info, updatedAt);
  const unified: UsageWindow[] = [];
  if (info?.unifiedWindows && typeof info.unifiedWindows === 'object') {
    for (const [rateLimitType, value] of Object.entries(info.unifiedWindows)) {
      if (!value || typeof value !== 'object') continue;
      const parsed = readUsageWindow({ ...value, rateLimitType,
        status: rateLimitType === info.rateLimitType ? info.status : 'allowed' }, updatedAt);
      if (parsed) unified.push(parsed);
    }
  }
  const used = update.used;
  const size = update.size;
  const context = typeof used === 'number' && Number.isFinite(used) && used >= 0 &&
    typeof size === 'number' && Number.isFinite(size) && size > 0 ? { used, size } : undefined;
  if (!window && !unified.length && !context) return;
  const windows = new Map(previous?.windows.map(w => [w.rateLimitType, w]));
  for (const w of unified) windows.set(w.rateLimitType, w);
  if (window) windows.set(window.rateLimitType, { ...unified.find(w => w.rateLimitType === window.rateLimitType), ...window });
  const retainedContext = context ?? previous?.context;
  return { updatedAt, windows: [...windows.values()], ...(retainedContext ? { context: retainedContext } : {}) };
}
