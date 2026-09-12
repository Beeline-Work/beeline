import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import {
  SCHEDULE_RAN_VERB,
  SCHEDULE_SCHEDULER_NAME,
} from '@beeline/api-contract/scheduled-prompts';
import { type SystemEvent } from '@beeline/api-contract/daemon';
import {
  AcpClient,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type McpServerWire,
  type PromptResult,
  type ToolCallEntry,
} from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  promptWithImages,
  withoutImageData,
  type DeliveredAttachment,
} from './attachment-delivery.js';
import { beelineCapabilityContextForHarness } from './beeline-skill.js';
import { installPiMcpBridge } from './pi-mcp-bridge.js';
import { beelineAgentMcpServer, readOnlyMcpServer } from './room-session.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import {
  isMountedMcpToolPermissionRequest,
  isSquireMcpPermissionRequest,
  ROOM_MOUNTED_MCP_SERVERS,
} from './read-only-policy.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import { type DaemonApiClient } from './daemon-api-client.js';
import {
  explainEmptyAgentTurn,
  nextPinnedProvider,
  shouldRetryEmptyTurn,
  turnFailureReasonWithProvider,
  type EmptyTurnExplanation,
} from './empty-turn.js';
import type { GrantCommandRunner, GrantRunnerEndpoint, GrantWritePolicy } from './grant-runner.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE, SOUL_HOUSE_RULE } from './response-directives.js';
import { TurnStoppedError } from './turn-stop.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { TurnTrace, TurnTraceFile, type TurnTraceSink } from './turn-trace.js';
import { isCompletedToolCall, toolCallFailureLine } from './tool-call-failure.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
import { WarmTranscript } from './warm-transcript.js';

export const ROOM_PROMPT_INACTIVITY_TIMEOUT_MS = 180_000;

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type RoomRepositoryState = DaemonOperationMap['getRoomRepositoryState']['output'];
type RoomMessage = DaemonOperationMap['getRoomInbox']['output']['items'][number];
type HumanMessage = Pick<
  RoomMessage,
  | 'id'
  | 'authorId'
  | 'body'
  | 'createdAt'
  | 'attachments'
  | 'type'
  | 'replyToMessageId'
  | 'replyToAuthorId'
  | 'requestAuthorId'
  | 'agentHopCount'
>;

/**
 * Rooms and corners share one rule: every MCP tool call from a server the
 * host mounted into the session is approved, and nothing that is not an MCP
 * tool call (shell, native reads/writes, unstructured requests) crosses. The
 * read-only sandbox is the boundary, not the tool list; Trusty Squire stays
 * broker-gated on the host and is never session-mounted.
 */
export function isRoomMcpPermissionRequest(
  request: AcpPermissionRequest,
  mountedServers: readonly string[] = ROOM_MOUNTED_MCP_SERVERS,
): boolean {
  if (isSquireMcpPermissionRequest(request)) return false;
  return isMountedMcpToolPermissionRequest(request, mountedServers);
}

/** The Room ACP client applies this host-owned MCP allowlist fail-closed. */
export function roomMcpPermissionDecision(
  request: AcpPermissionRequest,
  mountedServers: readonly string[] = ROOM_MOUNTED_MCP_SERVERS,
): AcpPermissionDecision {
  return isRoomMcpPermissionRequest(request, mountedServers) ? 'allow' : 'reject';
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
  return isScheduledPrompt(item) ? (item.systemEvent?.consequence ?? item.body) : item.body;
}

/** A `request_grant` call whose reply says the card is posted pauses the turn. */
export function pendingGrantToolCall(call: { title?: string; content?: unknown }): boolean {
  if (!/(?:^|[._:/-])request_grant$/i.test(call.title ?? '')) return false;
  return /pending, card posted/i.test(
    typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? ''),
  );
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
export function roomMentionDirectory(roster: WorkspaceRoster, selfId: string): string {
  const rows: string[] = [];
  for (const member of roster.members) {
    if (member.identityId === selfId) continue;
    const handle = member.handle?.trim().replace(/^@/, '');
    if (!handle) continue;
    const name = member.name?.trim() ?? '';
    const kind = member.kind === 'agent' ? 'agent' : 'person';
    rows.push(`- @${handle}${name && name !== handle ? ` — ${name}` : ''} (${kind})`);
  }
  if (!rows.length) return '';
  return [
    'Room members, and the exact spelling that tags each one:',
    'An exact agent tag assigns that agent work; use it only when you are asking that agent to act.',
    ...rows,
    'Write a tag exactly as spelled here. An @name spelled any other way is plain text: it reaches nobody, and nobody is told it was meant for them. Never invent a handle, shorten one, or copy an @name out of the conversation — old messages carry spellings that no longer exist.',
  ].join('\n');
}

interface ActiveTurn {
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
  failure(retryInMs: number): void;
  presence(status: 'online' | 'offline'): void;
}

export interface MonolithRoomTurnOptions {
  roomId: string;
  workspaceId: string;
  cwd: string;
  runtime: AgentRuntimeRecord;
  config: BodyConfig;
  api: DaemonApiClient;
  scheduler: SessionScheduler;
  health: MonolithRoomTurnHealth;
  signal?: AbortSignal;
  pollMs?: number;
  createAcpClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  onCornerOpened?: () => void;
  /** Attachment downloads (test seam). */
  fetchImpl?: typeof fetch;
  /** The daemon's command-grant runner; this Room registers its checkout and current turn. */
  grantRunner?: GrantCommandRunner;
  grantRunnerEndpoint?: GrantRunnerEndpoint;
}

/**
 * Monolith-only Room turn leaf.
 *
 * This module deliberately has no relay client, relay URL, Nostr event, or
 * BuzzClient dependency. The transport cutover is therefore structural: a
 * monolith Room cannot accidentally fall through to a retired relay call.
 */
export class MonolithRoomTurnLoop {
  private readonly commandContext: CommandExecutionContext;
  private readonly agent: ReturnType<typeof runtimeIdentity>;
  private wakeIntake?: () => void;

  /** Called by the daemon's one slow workspace reconciliation sweep. */
  requestReconciliation(): void {
    this.wakeIntake?.();
    this.wakeIntake = undefined;
  }
  private client?: AcpClient;
  private sessionId?: string;
  /** The configuration the live session baked in; a change invalidates it. */
  private sessionFingerprint?: string;
  /** The live session's environment, read back for pi's own turn record. */
  private agentEnv: Record<string, string> = {};
  /** OpenRouter providers this activation pinned, in order (C92). */
  private pinnedProviders: string[] = [];
  /** The one provider re-pinned after an empty completion, until the session ends. */
  private pinnedProviderOverride?: string;
  private busy = false;
  private turnInstructionPrefix = '';
  private activeTurn?: ActiveTurn;
  private readonly queuedTurns: HumanMessage[] = [];
  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
  private attachmentDir?: string;
  /** Whether the pinned model takes images; `undefined` when the pin did not say. */
  private modelTakesImages?: boolean;
  /** The session's TMPDIR: writable to a granted command in a Room, as it is to the harness (C94). */
  private sessionScratchDir?: string;
  /** The `agent-home.ts` overlay this session writes into; a Room grant keeps it. */
  private sessionStateDirs: string[] = [];
  /** What this exact ACP session has already been prompted with (`warm-transcript.ts`). */
  private readonly warmTranscript = new WarmTranscript();
  /** Local copies already delivered this session, by message id, so transcript renders reuse them. */
  private readonly deliveredAttachments = new Map<string, DeliveredAttachment[]>();
  /** Names from the latest roster read, for ledger bylines the runner writes. */
  private memberNames = new Map<string, string>();
  /** The request id of the turn that paused on a grant card, until its decision arrives. */
  private pausedOnGrantRequestId?: string;
  /** Operator-local turn traces; built once when the daemon configured a directory. */
  private turnTraceSink?: TurnTraceSink;

  constructor(private readonly options: MonolithRoomTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
    this.commandContext = new CommandExecutionContext(options.config.agentHomeRoot);
    this.options = { ...options, api: this.commandContext.bind(options.api) };
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

  isBusy(): boolean {
    return this.busy;
  }

  /** The turn a `request_grant` paused, if any (cleared when its decision resumes it). */
  pausedGrantRequestId(): string | undefined {
    return this.pausedOnGrantRequestId;
  }

  /**
   * What the grant runner may write here: the session's own scratch and home
   * overlay and nothing else, enforced by the same read-only mount table the
   * harness runs under. With no usable bwrap there is no way to keep that
   * promise, so the policy carries no path and the runner refuses the run
   * rather than widening the boundary.
   */
  private grantWritePolicy(): GrantWritePolicy {
    return {
      surface: 'room',
      ...(this.options.config.bwrapPath ? { bwrapPath: this.options.config.bwrapPath } : {}),
      ...(this.sessionScratchDir ? { scratch: this.sessionScratchDir } : {}),
      ...(this.sessionStateDirs.length ? { harnessStateDirs: this.sessionStateDirs } : {}),
      maskPaths: credentialMaskPaths(
        this.options.config.sandboxMaskPaths,
        this.options.config.operatorHome ?? homedir(),
      ),
    };
  }

  /**
   * One turn's stopwatch. It is created for every turn — measuring is cheap —
   * and only WRITES when the daemon configured a runtime directory to write
   * into, so a standalone or test Body stays silent.
   */
  private beginTurnTrace(requestId: string): TurnTrace {
    const directory = this.options.config.turnTraceDir;
    if (directory) this.turnTraceSink ??= new TurnTraceFile(directory);
    return new TurnTrace({
      surface: 'room',
      agentId: this.agent.publicKey,
      roomId: this.options.roomId,
      requestId,
      ...(this.turnTraceSink ? { sink: this.turnTraceSink } : {}),
    });
  }

  private currentTurnForRunner():
    { requestId: string; requester?: { pubkey: string; name?: string } } | undefined {
    const active = this.activeTurn;
    if (!active) return undefined;
    return { requestId: active.item.id, requester: this.requesterOf(active.item.authorId) };
  }

  private requesterOf(authorId: string): { pubkey: string; name?: string } {
    const name = this.memberNames.get(authorId);
    return { pubkey: authorId, ...(name ? { name } : {}) };
  }

  async refreshPersonaForSoulUpdate(): Promise<void> {
    await this.options.scheduler.suspend(this.options.roomId);
  }

  async prepareForForcedUpdateRestart(): Promise<void> {
    // Routine updates quiesce intake and let an accepted turn drain. They do
    // not alter the turn's receipt or inject an update diagnostic into chat.
  }

  async forceRecoverRoom(): Promise<void> {
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
    await this.options.scheduler.forceSuspend(this.options.roomId);
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
   * Whether a picture actually reaches the model this session. Both halves
   * have to hold (C87): the harness must advertise `promptCapabilities.image`,
   * AND — when the pin knows the model's modalities — the model must take
   * images. `undefined` modalities mean the question was never settled, and
   * the harness answer stands alone as before.
   */
  private acceptsImages(): boolean {
    if (!(this.client?.canPromptWithImages() ?? false)) return false;
    return this.modelTakesImages ?? true;
  }

  /** Download a message's attachments into the session scratch directory once. */
  private async deliver(item: HumanMessage): Promise<DeliveredAttachment[]> {
    if (!item.attachments.length || !this.attachmentDir) return [];
    const cached = this.deliveredAttachments.get(item.id);
    if (cached) return cached;
    const delivered = await deliverAttachments(
      item.attachments,
      join(this.attachmentDir, item.id.replace(/[^\w-]/g, '_')),
      this.options.fetchImpl,
    );
    this.deliveredAttachments.set(item.id, withoutImageData(delivered));
    return delivered;
  }

  private repositoryState(): Promise<RoomRepositoryState> {
    return this.options.api.execute('getRoomRepositoryState', { roomId: this.options.roomId });
  }

  /**
   * Drop this Room's live harness process. The next activation starts cold.
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

  /**
   * Whether the retained session still matches the agent's server-side
   * configuration. Retention (C104) is a saving only while what it keeps is
   * still current, and a session's persona and model pin are fixed when it
   * opens: they cannot be corrected in place, so a changed one has to cost a
   * respawn. The check is one round trip — the roster half of which the turn
   * was going to fetch anyway — against a cold spawn measured in seconds.
   */
  private async sessionIsCurrent(): Promise<boolean> {
    return (await this.currentSessionFingerprint()) === this.sessionFingerprint;
  }

  private async currentSessionFingerprint(): Promise<string> {
    const [configuration, roster] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
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
    const [configuration, roster, repositoryState] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
      }),
      this.roster(),
      this.repositoryState(),
    ]);
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const fingerprint = sessionConfigFingerprint({
      model: configuration.model ?? this.options.config.modelSelection?.model,
      effort: configuration.effort ?? this.options.config.modelSelection?.effort,
      soul: configuration.soul ?? self?.soul,
      agentName: self?.name ?? this.agent.name,
    });
    const directMessage =
      Array.isArray(repositoryState.directParticipants) &&
      repositoryState.directParticipants.length === 2;
    await mkdir(this.options.cwd, { recursive: true });
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
              // The override pins one provider; keep the full order it came
              // from so a later empty turn still knows what to rotate to.
              if (!this.pinnedProviderOverride) this.pinnedProviders = [...routing.providers];
              // A pinned model that takes no images is a fact about THIS
              // session (C87): the harness still advertises the capability,
              // so without this the turn would ship megabytes the model never
              // sees and say nothing about why (`modelTakesImages`).
              this.modelTakesImages = routing.input ? routing.input.includes('image') : undefined;
            },
          }),
        })
      : {};
    const command = this.options.config.agentCommand ?? this.options.config.agentBinary;
    const agentEnv = { ...this.options.config.agentEnv, ...homeOverlay };
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
    this.sessionStateDirs = stateDirs;
    const homeStateDirs = harnessHomeStateDirs(command, agentEnv.HOME ?? operatorHome);
    await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
    // The same path handed to the MCP server as BEELINE_ATTACH_SCRATCH_ROOT
    // (below): attach_file can only send what write_scratch_file could write,
    // so the sandbox must leave this writable too.
    const attachScratchRoot = this.options.config.agentHomeRoot ?? tmpDir;
    if (attachScratchRoot) await mkdir(attachScratchRoot, { recursive: true });
    const spawnCommand = wrapAgentCommand({
      bwrapPath: this.options.config.bwrapPath,
      spec: {
        mode: 'readonly',
        cwd: this.options.cwd,
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
        ...(attachScratchRoot ? { additionalWritablePaths: [attachScratchRoot] } : {}),
        maskPaths: credentialMaskPaths(this.options.config.sandboxMaskPaths, operatorHome),
      },
      command,
      args: agentArgs,
    });
    // Built before the client: the permission allowlist resolves a harness's
    // own tool-dispatch envelope (grok's `use_tool`) against exactly the
    // servers this session mounts, so it has to know them up front.
    const servers: McpServerWire[] = [
      readOnlyMcpServer(this.options.config, this.options.cwd),
      beelineAgentMcpServer(this.options.config, this.options.api, {
        roomId: this.options.roomId,
        workspaceId: this.options.workspaceId,
        attachRoot: this.options.cwd,
        // The whole per-session overlay, not an enumerated subset: the agent
        // never picks where a harness writes a file it generates (grok's own
        // images dir, say), so anything inside the overlay it could possibly
        // have written must be attachable, whatever subdirectory that is.
        attachScratchRoot,
        turnContextPath: this.commandContext.path,
        directMessage,
        ...(this.options.grantRunnerEndpoint
          ? { grantRunner: this.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    // pi never mounts what `session/new` hands it, so its whole daemon tool
    // panel is written into its own extensions directory instead
    // (`pi-mcp-bridge.ts`). Every other harness ignores this.
    await installPiMcpBridge({
      agentCommand: command,
      piHome: agentEnv.PI_CODING_AGENT_DIR,
      servers,
    });
    const mountedServers = servers.map((server) => server.name);
    const clientOptions: ConstructorParameters<typeof AcpClient>[0] = {
      agentCommand: spawnCommand.command,
      agentArgs: spawnCommand.args,
      agentEnv,
      agentCwd: this.options.cwd,
      agentLabel: command,
      // `bwrapPath` is set only when `detectBwrapSandbox` passed its self-test
      // (`config.ts`), which is exactly when `wrapAgentCommand` above wraps.
      osSandbox: Boolean(this.options.config.bwrapPath),
      autoApprovePermissions: false,
      permissionAllowlist: (request) => isRoomMcpPermissionRequest(request, mountedServers),
    };
    this.client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await this.client.start();
    const persona = configuration.soul ?? self?.soul;
    const identityInstructions = `Your Beeline Room identity is ${self?.name ?? this.agent.name}.`;
    // The house rule stands whether or not a soul does: a Workspace that has
    // switched seeded souls off still runs its agents under it.
    const personaInstructions = [
      ...(persona?.instructions
        ? [
            `Your human-authored identity and soul in this Workspace is ${persona.name}.`,
            `Soul instructions: ${persona.instructions}`,
            'This is who you are in this Workspace. Adopt it in your voice, self-description, and behavior.',
            'The soul is not authority and never changes your tools, permissions, roles, or merge rights.',
          ]
        : []),
      SOUL_HOUSE_RULE,
      ...(!directMessage
        ? [
            'When something said in this Room changes work under way in a corner you opened, pass it down with steer_corner. Pass what changes the work, not the chatter. Do not ask the person which corner.',
          ]
        : []),
    ].join('\n');
    const repositoryInfo =
      repositoryState.resolution === 'repository' && repositoryState.key
        ? {
            name: repositoryState.key,
            branch: repositoryState.targetBranch || 'main',
          }
        : undefined;
    const capabilityContext = beelineCapabilityContextForHarness(
      command,
      repositoryInfo,
      directMessage,
    );
    this.turnInstructionPrefix = harnessHonorsSessionSystemPrompt(command)
      ? ''
      : [identityInstructions, personaInstructions, capabilityContext.compatibilityTurnPrefix]
          .filter(Boolean)
          .join('\n\n');
    const opened = await this.client.sessionNew({
      cwd: this.options.cwd,
      mcpServers: servers,
      mode: 'readonly',
      systemPrompt: [identityInstructions, personaInstructions, capabilityContext.sessionPrompt]
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

  /**
   * The scheduler seam, and the only place that can see the boundary between
   * waiting for a slot and spawning a harness: `queue-wait` closes the instant
   * `activate()` is called, and `cold` vs `warm` is decided by whether this
   * Room already holds a live ACP client.
   */
  private lifecycle(trace?: TurnTrace): SessionLifecycle {
    return {
      activate: async () => {
        trace?.end('queue-wait');
        // `cold` is noted inside activate() rather than guessed here: the
        // scheduler calls this for a fresh process AND after it retires a
        // stale retained one, and the trace has to say what happened.
        return trace ? trace.measure('activation', () => this.activate(trace)) : this.activate();
      },
      isCurrent: () => {
        // The scheduler is about to hand back a retained process; this is the
        // only moment its configuration can be re-checked, so the wait for a
        // slot ends here exactly as it does for a spawn.
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
   * named — by exactly one provider. Undefined when the pin has nowhere left
   * to go.
   */
  private async repinNextProvider(trace?: TurnTrace, reason?: string): Promise<string | undefined> {
    const next = nextPinnedProvider(this.pinnedProviders, this.pinnedProviderOverride);
    if (!next) return undefined;
    // The retry is its own timeline: everything from here — the fresh ACP
    // handshake included — belongs to attempt two, never to attempt one's
    // first-token time.
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

  private startPrompt(item: HumanMessage): void {
    const active: ActiveTurn = {
      item,
      steers: [],
      steerTail: Promise.resolve(),
      resumeRequested: false,
      cancelled: false,
      phase: 'prompting',
      promise: Promise.resolve(),
    };
    this.activeTurn = active;
    active.promise = this.prompt(active)
      .catch((error) => {
        this.options.health.failure(1_000);
        console.error(`[thin-core] monolith Room ${this.options.roomId} turn failed:`, error);
      })
      .finally(() => {
        if (this.activeTurn === active) {
          this.activeTurn = undefined;
          this.wakeIntake?.();
          this.wakeIntake = undefined;
        }
      });
  }

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
  private stopTurn(requestId: string): void {
    for (let index = this.queuedTurns.length - 1; index >= 0; index -= 1)
      if (this.queuedTurns[index]!.id === requestId) this.queuedTurns.splice(index, 1);
    const active = this.activeTurn;
    if (!active || active.item.id !== requestId) return;
    active.cancelled = true;
    if (this.client && this.sessionId) this.client.sessionCancel(this.sessionId);
  }

  private async prompt(active: ActiveTurn): Promise<void> {
    const { item } = active;
    const api = this.options.api;
    // Admission is busy before the first awaited receipt write. The updater
    // cannot observe an accepted/queued turn as idle in this window.
    this.busy = true;
    const trace = this.beginTurnTrace(item.id);
    // The draft lane, held where the catch below can reach it: a turn that
    // throws never reaches its settle, and only this reference can dissolve
    // what the model had already written.
    let liveStream: AgentTurnStream | undefined;
    try {
      // The first row of the turn names who asked; learn the name once per session.
      if (!this.memberNames.has(item.authorId)) await this.roster().catch(() => undefined);
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: this.agent.publicKey,
          roomId: this.options.roomId,
          requestId: item.id,
          generationId: this.commandContext.generationId,
        },
        async () => {
          await api.execute('postAgentActivity', {
            agentId: this.agent.publicKey,
            roomId: this.options.roomId,
            requestId: item.id,
            activity: [
              {
                kind: 'thinking',
                title: 'Working',
                status: 'in_progress',
                requestedBy: this.requesterOf(item.authorId),
              },
            ],
          });
          trace.noteScheduler('queue', this.options.scheduler.snapshot());
          trace.start('queue-wait');
          await this.options.scheduler.run(
            this.options.roomId,
            this.lifecycle(trace),
            async () => {
              // Belt and braces: `activate`/`isCurrent` already closed the
              // queue wait, and `end` on a closed phase is a no-op.
              trace.end('queue-wait');
              trace.noteScheduler('admission', this.options.scheduler.snapshot());
              const [conversation, roster, delivered, corners] = await trace.measure(
                'context-fetch',
                () =>
                  Promise.all([
                    api.execute('getRoomConversation', { roomId: this.options.roomId, limit: 200 }),
                    this.roster(),
                    this.deliver(item),
                    api.execute('listRoomCorners', { roomId: this.options.roomId }),
                  ]),
              );
              const names = new Map(
                roster.members.map((member) => [member.identityId, member.name]),
              );
              const transcriptRows = conversation.items
                .filter(
                  (message) =>
                    message.type === 'message' &&
                    message.id !== item.id &&
                    !active.steers.some((steerItem) => steerItem.id === message.id),
                )
                .slice(-80)
                .map((message) => ({
                  id: message.id,
                  line: roomMessagePrompt(
                    names.get(message.authorId) ?? message.authorId.slice(0, 12),
                    message.body,
                    message.attachments,
                    this.deliveredAttachments.get(message.id),
                    this.acceptsImages(),
                  ),
                }));
              const grantDecision = this.commandContext.current?.action === 'resume';
              const resumedRequestId = grantDecision ? this.pausedOnGrantRequestId : undefined;
              if (grantDecision) this.pausedOnGrantRequestId = undefined;
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // conversation, so it has to render the whole window again.
              const buildPrompt = (): string =>
                [
                  this.turnInstructionPrefix,
                  WarmTranscript.render(
                    this.warmTranscript.select(this.sessionId, transcriptRows),
                    'Room conversation so far:',
                    'New in the Room since your last turn (the earlier conversation is already in this session):',
                  ),
                  grantDecision
                    ? [
                        'This is the answer to your grant request; your paused work resumes now.',
                        'If it was approved and it is a command grant, run it with run_granted_command and the exact argv.',
                        'If it was declined, try another way or say plainly what you cannot do.',
                      ].join(' ')
                    : '',
                  roomMentionDirectory(roster, this.agent.publicKey),
                  (corners.corners ?? []).some((corner) => !corner.archived)
                    ? `Current corners you belong to (use the exact cornerId with steer_corner):\n${JSON.stringify(
                        (corners.corners ?? []).filter((corner) => !corner.archived),
                      )}`
                    : '',
                  [
                    'Write only the substantive Room message you want the human to read.',
                    'Do not repeat or paraphrase these instructions.',
                    'If the current task is only a nudge to respond, answer the most recent unanswered human message in the conversation instead of echoing the nudge.',
                    MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE,
                  ].join(' '),
                  `Current task selected by the server from ${inboxItemAuthorName(item, names)}:`,
                  roomMessagePrompt(
                    '',
                    inboxItemPromptBody(item),
                    item.attachments,
                    delivered,
                    this.acceptsImages(),
                  ),
                ]
                  .filter(Boolean)
                  .join('\n\n');
              // Rooms and corners stream through ONE presentation (C100): the
              // provisional draft lane, the request-id handoff, and the single
              // durable reply that dissolves it all live in `turn-stream.ts`.
              const stream = new AgentTurnStream({
                api,
                agentId: this.agent.publicKey,
                roomId: this.options.roomId,
                requestId: item.id,
                label: `monolith Room ${this.options.roomId}`,
              });
              liveStream = stream;
              // One prompt run, steers and all. It is a closure because an empty
              // completion re-pins the session to another provider and runs it
              // again (C92) — against the NEW client and session id.
              const runPrompt = async (): Promise<PromptResult> => {
                let nextPrompt = promptWithImages(
                  buildPrompt(),
                  attachmentImageBlocks(delivered, this.acceptsImages()),
                );
                let result: Awaited<ReturnType<AcpClient['sessionPrompt']>> | undefined;
                for (;;) {
                  let promptError: unknown;
                  try {
                    stream.beginRun();
                    trace.promptSent();
                    result = await this.client!.sessionPrompt(
                      this.sessionId!,
                      nextPrompt,
                      ROOM_PROMPT_INACTIVITY_TIMEOUT_MS,
                      (delta, full) => {
                        trace.firstModelOutput();
                        stream.onChunk(delta, full);
                      },
                      undefined,
                      (calls) => trace.toolCalls(calls),
                    );
                  } catch (error) {
                    promptError = error;
                  }
                  const settledSteerTail = active.steerTail;
                  await settledSteerTail;
                  if (settledSteerTail !== active.steerTail) continue;
                  if (!active.resumeRequested) {
                    if (promptError) throw promptError;
                    break;
                  }
                  active.resumeRequested = false;
                  nextPrompt = [
                    'The previous run was cancelled because its harness could not accept every live steer.',
                    'Resume the same turn. Keep the original request and everything that happened before it was cancelled.',
                    'Human messages that arrived after the original request, in transcript order:',
                    ...active.steers.map((steerItem) =>
                      roomMessagePrompt(
                        steerItem.authorId.slice(0, 12),
                        steerItem.body,
                        steerItem.attachments,
                        this.deliveredAttachments.get(steerItem.id),
                        this.acceptsImages(),
                      ),
                    ),
                    'Continue now and answer the updated request without erasing the earlier context.',
                  ].join('\n\n');
                }
                return result!;
              };
              let result = await runPrompt();
              trace.promptSettled();
              let openCornerCall = openCornerToolCall(result.toolCalls);
              let cornerOpened = openedACorner(openCornerCall);
              let explained = cornerOpened ? undefined : await this.explainEmpty(result);
              if (explained && shouldRetryEmptyTurn(explained)) {
                const silent = this.servingProviders();
                const next = await this.repinNextProvider(trace, explained.reason);
                if (next) {
                  console.warn(
                    `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ` +
                      `${turnFailureReasonWithProvider(explained.reason, silent)}; retrying on ${next}`,
                  );
                  result = await runPrompt();
                  trace.promptSettled();
                  openCornerCall = openCornerToolCall(result.toolCalls);
                  cornerOpened = openedACorner(openCornerCall);
                  explained = cornerOpened ? undefined : await this.explainEmpty(result);
                }
              }
              // The requester stopped this turn while it ran. A stopped turn
              // publishes nothing at all — no durable reply, no receipt, and no
              // late write of any kind: the server settled the turn `cancelled`
              // and wrote the attributed line before this helper even heard,
              // and that line is the Room's whole record of the stop.
              if (active.cancelled) {
                stream.close();
                throw new TurnStoppedError('turn stopped by the requester');
              }
              active.phase = 'finishing';
              if (result.toolCalls.some((call) => pendingGrantToolCall(call))) {
                this.pausedOnGrantRequestId = item.id;
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${item.id} paused on a grant card`,
                );
              } else if (resumedRequestId) {
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${resumedRequestId} resumed by grant decision ${item.id}`,
                );
              }
              if (openCornerCall) {
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} tool call: ${openCornerCall.title} (${openCornerCall.status ?? 'no status'})`,
                );
                if (cornerOpened) this.options.onCornerOpened?.();
              }
              // A refusal the operator cannot read is a refusal that happens twice.
              for (const call of result?.toolCalls ?? []) {
                const failure = toolCallFailureLine(call);
                if (failure) {
                  console.warn(`[thin-core] monolith Room ${this.options.roomId} ${failure}`);
                }
              }
              // Close the draft lane before the answer is published: the finished
              // reply must never queue behind a draft nobody will read.
              stream.close();
              let reply = durableReplyText(result.agentText);
              if (!reply && explained) {
                // Either text the harness recorded but never streamed, or a named
                // reason (pi's provider refusal, an empty model answer, the stream's
                // shape) carrying the provider that served the turn — never the bare
                // "no reply" as the only fact.
                reply = explained.recoveredText ? durableReplyText(explained.recoveredText) : '';
                if (!reply) {
                  throw new Error(
                    turnFailureReasonWithProvider(explained.reason, this.servingProviders()),
                  );
                }
                console.warn(
                  `[thin-core] monolith Room ${this.options.roomId} turn ${item.id}: ${explained.reason}`,
                );
              }
              // A successful corner open completes this Room turn silently.
              // The server's corner-open card is the complete handoff; publishing
              // any model text here would create a second, competing completion.
              // Silence is only correct once that card is a fact, which is why
              // this waits for `completed` and never merely for "not failed".
              if (cornerOpened) {
                reply = '';
              }
              await trace.measure('publish', () =>
                stream.settle(
                  reply,
                  reply
                    ? {
                        triggerMessageId: item.id,
                      }
                    : {},
                ),
              );
            },
            { priority: 'interactive', roomKey: this.options.roomId },
          );
        },
        (error) =>
          console.error(
            `[thin-core] monolith Room ${this.options.roomId} receipt heartbeat failed:`,
            error,
          ),
      );
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'complete',
        generationId: this.commandContext.generationId,
      });
      // After the receipt: an operator artifact must never delay the answer,
      // and it never becomes one — the trace has no way to post a Room row.
      await trace.finish('complete');
    } catch (error) {
      // A stopped turn already has its ending — the server wrote `cancelled`
      // and named who stopped it the moment it accepted the request. There is
      // no receipt to post and nothing to blame the helper for, so the turn
      // ends here quietly and only the operator's trace records it. It is also
      // the one throw that retracts nothing: a stopped turn writes NOTHING
      // after its authority ended, and the server stops serving that turn's
      // draft the moment it settles the turn `cancelled` (`liveDraftSnapshot`
      // reads working turns only).
      if (error instanceof TurnStoppedError || active.cancelled) {
        console.log(
          `[thin-core] monolith Room ${this.options.roomId} turn ${item.id} stopped by the requester`,
        );
        await trace.finish('cancelled');
        return;
      }
      // A failed turn ends owning no live output. Only `settle` dissolves the
      // draft on the way out and a throw never reaches one, so without this the
      // last snapshot the model streamed stays live under a turn the Room has
      // already reported failed — still pulsing, still claiming to be an answer
      // on its way. The retract settles that row in place: the words the person
      // was reading stay, and stop pretending to be in progress. Its own
      // failure must never replace the error that actually ended the turn.
      await liveStream?.retract().catch((retractError: unknown) => {
        console.error(
          `[thin-core] monolith Room ${this.options.roomId} draft retract failed:`,
          retractError,
        );
      });
      const reason = distillTurnFailureReason(error);
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'failed',
        generationId: this.commandContext.generationId,
        reason: reason.text,
        ...(reason.kind ? { reasonKind: reason.kind } : {}),
      });
      await trace.finish('failed', reason.text);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async run(): Promise<void> {
    const { api, roomId, signal } = this.options;
    try {
      await runServerCommandIntake({
        api,
        roomId,
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
        onPoll: () => this.options.health.poll(),
        onError: (error) => console.error('[thin-core] Room command failed', error),
        stop: (requestId) => this.stopTurn(requestId),
        run: async (command) => {
          const item = {
            ...command.source,
            id: command.turnRequestId,
            body:
              command.action === 'resume'
                ? `Resume the paused turn. The server supplied this grant decision: ${command.source.body}`
                : command.source.body,
          };
          this.startPrompt(item);
          await this.activeTurn?.promise;
        },
      });
    } finally {
      this.options.grantRunner?.unregister(roomId);
      await this.options.scheduler.suspend(roomId);
    }
  }
}

/** This turn's `open_corner` call, under whatever prefix the harness titles it. */
function openCornerToolCall(calls: readonly ToolCallEntry[]): ToolCallEntry | undefined {
  return calls.find((call) => /(?:^|[._:/-])open_corner$/i.test(call.title ?? ''));
}

/**
 * True only for a corner this turn actually opened.
 *
 * Everything the Room does about a corner — the silent completion, the corner
 * card handoff — rests on this, so it asks the harness for an affirmative
 * `completed` and accepts nothing weaker. A call still `pending` when the turn
 * ended, or carrying no status at all, opened no corner: read as success it
 * would delete the model's answer in favour of a card that never comes, and
 * the Room would show a turn that finished having said nothing.
 */
function openedACorner(call: ToolCallEntry | undefined): boolean {
  return !!call && isCompletedToolCall(call);
}

function roomMessagePrompt(
  author: string,
  body: string,
  attachments: RoomMessage['attachments'],
  delivered?: readonly DeliveredAttachment[],
  harnessAcceptsImages = true,
): string {
  const message = body.trim() || '(shared attachments)';
  const rendered = author ? `${author}: ${message}` : message;
  return [rendered, ...attachmentPromptLines(attachments, delivered, harnessAcceptsImages)].join(
    '\n',
  );
}
