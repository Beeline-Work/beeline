import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import {
  SCHEDULE_RAN_VERB,
  SCHEDULE_SCHEDULER_NAME,
} from '@beeline/api-contract/scheduled-prompts';
import {
  isResumeKind,
  isServerEventKind,
  type SystemEvent,
} from '@beeline/api-contract/daemon';
import {
  AcpClient,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type McpServerWire,
  type PromptResult,
} from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { openRouterRoutingInput } from './openrouter-routing.js';
import { isSenderPermitted, LEGACY_ACCESS_POLICY } from './access-policy.js';
import {
  attachmentImageBlocks,
  attachmentPromptLines,
  deliverAttachments,
  promptWithImages,
  withoutImageData,
  type DeliveredAttachment,
} from './attachment-delivery.js';
import { beelineCapabilityContextForHarness } from './beeline-skill.js';
import { beelineAgentMcpServer, readOnlyMcpServer } from './room-session.js';
import { sessionConfigFingerprint } from './session-config-fingerprint.js';
import {
  isMountedMcpToolPermissionRequest,
  isSquireMcpPermissionRequest,
  ROOM_MOUNTED_MCP_SERVERS,
} from './read-only-policy.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  explainEmptyAgentTurn,
  nextPinnedProvider,
  shouldRetryEmptyTurn,
  turnFailureReasonWithProvider,
  type EmptyTurnExplanation,
} from './empty-turn.js';
import type {
  GrantCommandRunner,
  GrantRunnerEndpoint,
  GrantWritePolicy,
} from './grant-runner.js';
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
import { stripCornerOpenEcho } from './reply-sanitizer.js';
import { AgentTurnStream, durableReplyText } from './turn-stream.js';
import { TurnTrace, TurnTraceFile, type TurnTraceSink } from './turn-trace.js';
import { isFailedToolCall, toolCallFailureLine } from './tool-call-failure.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { withTurnReceiptHeartbeat } from './turn-receipt-heartbeat.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
import { WarmTranscript } from './warm-transcript.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type RoomRepositoryState = DaemonOperationMap['getRoomRepositoryState']['output'];
type RoomMessage = DaemonOperationMap['getRoomInbox']['output']['items'][number];
type HumanMessage = Pick<
  RoomMessage,
  'id' | 'authorId' | 'body' | 'createdAt' | 'attachments' | 'type' | 'mentionIds'
>;
type RoomAuthority = DaemonOperationMap['getRoomAuthority']['output'];

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

/** Agents are server-validated Room members; human turns additionally honor host access policy. */
export function roomPrincipalMayAddressAgent(
  authority: RoomAuthority,
  humanPermitted: boolean,
): boolean {
  return (
    authority.member &&
    (authority.principalKind === 'agent' || (authority.principalKind === 'human' && humanPermitted))
  );
}

/** Server-authored scheduled prompts arrive as system lines (`Beeline Scheduler ran a
 *  schedule for <agent> · <message>`) mentioning this agent and carrying the structured
 *  event; the scheduler is not a Room principal, so its lines skip the per-author
 *  authority check (schedule creation was already authority-gated). Recognised by
 *  the event's verb, never by the text. */
export function isScheduledPrompt(
  item: { type: string; body: string; mentionIds: readonly string[]; systemEvent?: SystemEvent },
  agentId: string,
): boolean {
  if (item.type !== 'system' || !item.mentionIds.includes(agentId)) return false;
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
  item: { type: string; authorId: string; mentionIds: readonly string[]; body: string; systemEvent?: SystemEvent },
  agentId: string,
  names: ReadonlyMap<string, string>,
): string {
  if (isScheduledPrompt(item, agentId)) return SCHEDULE_SCHEDULER_NAME;
  const subject = item.systemEvent?.subject;
  if (item.type === 'system' && subject?.name) return subject.name;
  return names.get(item.authorId) ?? item.authorId.slice(0, 12);
}

/** What the harness is shown for an inbox item: a scheduled prompt's message
 *  itself (the event's consequence), otherwise the row's text. An event line's
 *  own sentence already carries the fact — `Ada joined Beeline Welcome` names
 *  the newcomer — so it is shown as written rather than restated. */
export function inboxItemPromptBody(
  item: { type: string; body: string; mentionIds: readonly string[]; systemEvent?: SystemEvent },
  agentId: string,
): string {
  return isScheduledPrompt(item, agentId)
    ? (item.systemEvent?.consequence ?? item.body)
    : item.body;
}

/**
 * An event this agent subscribed to: a mentioned system line whose structured
 * event carries a `kind`. The kind is the contract — never the line's wording,
 * which is prose an editor may reword. A RESUME kind is excluded: a grant
 * decision answers a turn already paused on the ask, and starting a second
 * turn on it would run the same work twice.
 */
export function isSubscribedEvent(
  item: { type: string; mentionIds: readonly string[]; systemEvent?: SystemEvent },
  agentId: string,
): boolean {
  const kind = item.systemEvent?.kind;
  return (
    item.type === 'system' &&
    kind !== undefined &&
    !isResumeKind(kind) &&
    item.mentionIds.includes(agentId)
  );
}

/**
 * Whether an item may skip the per-sender access policy. The SERVER authored a
 * server-kind line — a join, a schedule, a check — so the row's author is the
 * subject of the fact, not the principal asking for work: gating on them would
 * keep a greeter asleep, since a newcomer is never the agent's creator. An
 * `agent:` kind is a fact another agent emitted and stays gated on that agent.
 * Grant decisions were already authority-gated by the owner's own decision.
 */
export function inboxItemSkipsSenderPolicy(
  item: { type: string; mentionIds: readonly string[]; body: string; systemEvent?: SystemEvent },
  agentId: string,
): boolean {
  if (isGrantDecisionLine(item, agentId)) return true;
  if (item.type !== 'system' || !item.mentionIds.includes(agentId)) return false;
  const kind = item.systemEvent?.kind;
  // The one-release verb fallback covers a scheduled prompt written before the
  // server stamped kinds; it is server-authored either way.
  return kind === undefined ? isScheduledPrompt(item, agentId) : isServerEventKind(kind);
}

/** The owner's answer to a grant card arrives as a server-authored system line
 *  mentioning this agent (`<name> approved: command …`); it resumes the turn that
 *  paused on the ask. Recognised structurally, never by a bare `system` type. */
export function isGrantDecisionLine(
  item: { type: string; body: string; mentionIds: readonly string[] },
  agentId: string,
): boolean {
  return (
    item.type === 'system' &&
    item.mentionIds.includes(agentId) &&
    parseGrantDecisionLine(item.body) !== undefined
  );
}

/** Which inbox items may start or steer a turn: ordinary messages from others that
 *  mention the agent, mentioned event lines (plus the one-release verb fallback for
 *  a scheduled prompt written before the server stamped kinds), and the grant
 *  decision that resumes a turn paused on the ask. Never a plain system line and
 *  never the agent's own rows.
 *
 *  A RESUME kind reaches the loop only through `isGrantDecisionLine`, its own
 *  path, which prompts the paused turn's session with the decision and the
 *  resume instruction. `isSubscribedEvent` excludes it so it cannot ALSO be
 *  handled as an ordinary event and prompt the granted work a second time. */
export function inboxItemTriggersTurn(item: RoomMessage, agentId: string): boolean {
  if (item.authorId === agentId) return false;
  if (!item.mentionIds.includes(agentId)) return false;
  return (
    item.type === 'message' ||
    isSubscribedEvent(item, agentId) ||
    isScheduledPrompt(item, agentId) ||
    isGrantDecisionLine(item, agentId)
  );
}

/** A `request_grant` call whose reply says the card is posted pauses the turn. */
export function pendingGrantToolCall(call: { title?: string; content?: unknown }): boolean {
  if (!/(?:^|[._:/-])request_grant$/i.test(call.title ?? '')) return false;
  return /pending, card posted/i.test(
    typeof call.content === 'string' ? call.content : JSON.stringify(call.content ?? ''),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve model-written @names into validated member ids (agents and humans) the server routes. */
export function agentReplyMentionIds(
  text: string,
  roster: WorkspaceRoster,
  authorId: string,
): string[] {
  const aliases = new Map<string, { display: string; ids: Set<string> }>();
  for (const member of roster.members) {
    if (member.identityId === authorId) continue;
    for (const raw of [member.name, member.handle, member.soul?.name]) {
      const display = raw?.trim().replace(/^@/, '');
      if (!display) continue;
      const key = display.toLocaleLowerCase();
      const entry = aliases.get(key) ?? { display, ids: new Set<string>() };
      entry.ids.add(member.identityId);
      aliases.set(key, entry);
    }
  }
  const mentioned: string[] = [];
  for (const { display, ids } of [...aliases.values()].sort(
    (left, right) => right.display.length - left.display.length,
  )) {
    if (ids.size !== 1) continue;
    const pattern = new RegExp(`(^|[\\s([{])@${escapeRegExp(display)}(?=$|[\\s.,!?;:)\\]}])`, 'iu');
    if (!pattern.test(text)) continue;
    const identityId = [...ids][0]!;
    if (!mentioned.includes(identityId)) mentioned.push(identityId);
  }
  return mentioned;
}

interface ActiveTurn {
  item: HumanMessage;
  steers: HumanMessage[];
  steerTail: Promise<void>;
  resumeRequested: boolean;
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
  private readonly agent: ReturnType<typeof runtimeIdentity>;
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
    options.grantRunner?.register(options.roomId, {
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      // A top-level Room keeps its read-only promise for grants too: the runner
      // wraps the command in this Room's own mount table (C94).
      writePolicy: () => this.grantWritePolicy(),
      turn: () => this.currentTurnForRunner(),
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

  currentPrincipalCanDrive(_workspaceId: string, principalId: string): Promise<boolean> {
    return Promise.resolve(
      isSenderPermitted(
        this.options.config.accessPolicy ?? LEGACY_ACCESS_POLICY,
        principalId,
        this.options.config.accessOwnerPubkey,
        this.options.config.accessAllowlist,
      ),
    );
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
    const spawnCommand = wrapAgentCommand({
      bwrapPath: this.options.config.bwrapPath,
      spec: {
        mode: 'readonly',
        cwd: this.options.cwd,
        harnessStateDirs: stateDirs,
        harnessHomeStateDirs: homeStateDirs,
        ...(tmpDir ? { tmpDir } : {}),
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
        attachScratchRoot: this.options.config.agentHomeRoot ?? tmpDir,
        directMessage,
        ...(this.options.grantRunnerEndpoint
          ? { grantRunner: this.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
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
  private async repinNextProvider(
    trace?: TurnTrace,
    reason?: string,
  ): Promise<string | undefined> {
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
        if (this.activeTurn === active) this.activeTurn = undefined;
      });
  }

  private steer(active: ActiveTurn, item: HumanMessage): void {
    active.steers.push(item);
    active.steerTail = active.steerTail
      .catch(() => undefined)
      .then(async () => {
        try {
          const [roster, delivered] = await Promise.all([this.roster(), this.deliver(item)]);
          const author =
            roster.members.find((member) => member.identityId === item.authorId)?.name ??
            item.authorId.slice(0, 12);
          await this.client!.sessionSteer(
            this.sessionId!,
            [
              `Human steer received while the current turn is running from ${author}:`,
              roomMessagePrompt('', item.body, item.attachments, delivered, this.acceptsImages()),
              'Adjust the current work now. Keep the original request and earlier messages as context.',
            ].join('\n\n'),
          );
        } catch (error) {
          active.resumeRequested = true;
          this.client?.sessionCancel(this.sessionId!);
          console.warn(
            `[thin-core] monolith Room ${this.options.roomId} live steer unavailable; cancelling and resuming:`,
            error,
          );
        }
      });
  }

  private async prompt(active: ActiveTurn): Promise<void> {
    const { item } = active;
    const api = this.options.api;
    // Admission is busy before the first awaited receipt write. The updater
    // cannot observe an accepted/queued turn as idle in this window.
    this.busy = true;
    const trace = this.beginTurnTrace(item.id);
    try {
      // The first row of the turn names who asked; learn the name once per session.
      if (!this.memberNames.has(item.authorId)) await this.roster().catch(() => undefined);
      await withTurnReceiptHeartbeat(
        api,
        {
          agentId: this.agent.publicKey,
          roomId: this.options.roomId,
          requestId: item.id,
          generationId: `${this.agent.publicKey}:${this.options.roomId}`,
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
              const [conversation, roster, delivered] = await trace.measure('context-fetch', () =>
                Promise.all([
                  api.execute('getRoomConversation', { roomId: this.options.roomId, limit: 200 }),
                  this.roster(),
                  this.deliver(item),
                ]),
              );
              const names = new Map(roster.members.map((member) => [member.identityId, member.name]));
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
              const grantDecision = isGrantDecisionLine(item, this.agent.publicKey);
              const resumedRequestId = grantDecision ? this.pausedOnGrantRequestId : undefined;
              if (grantDecision) this.pausedOnGrantRequestId = undefined;
              // Built per ATTEMPT, never once per turn: a C92 re-pin runs the
              // same turn against a NEW session id that holds none of this
              // conversation, so it has to render the whole window again.
              const buildPrompt = (): string => [
                this.turnInstructionPrefix,
                WarmTranscript.render(
                  this.warmTranscript.select(this.sessionId, transcriptRows),
                  'Room conversation so far:',
                  'New in the Room since your last turn (the earlier conversation is already in this session):',
                ),
                `Newest message from ${inboxItemAuthorName(item, this.agent.publicKey, names)}:`,
                roomMessagePrompt(
                  '',
                  inboxItemPromptBody(item, this.agent.publicKey),
                  item.attachments,
                  delivered,
                  this.acceptsImages(),
                ),
                grantDecision
                  ? [
                      'This is the answer to your grant request; your paused work resumes now.',
                      'If it was approved and it is a command grant, run it with run_granted_command and the exact argv.',
                      'If it was declined, try another way or say plainly what you cannot do.',
                    ].join(' ')
                  : '',
                [
                  'Write only the substantive Room message you want the human to read.',
                  'Do not repeat or paraphrase these instructions.',
                  'If the newest message is only a nudge to respond, answer the most recent unanswered human message in the conversation instead of echoing the nudge.',
                  MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE,
                ].join(' '),
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
                      120_000,
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
              let explained = await this.explainEmpty(result);
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
                  explained = await this.explainEmpty(result);
                }
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
              const openCornerCall = result.toolCalls.find((call) =>
                /(?:^|[._:/-])open_corner$/i.test(call.title ?? ''),
              );
              if (openCornerCall) {
                console.log(
                  `[thin-core] monolith Room ${this.options.roomId} tool call: ${openCornerCall.title} (${openCornerCall.status ?? 'no status'})`,
                );
                if (!isFailedToolCall(openCornerCall)) this.options.onCornerOpened?.();
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
              // The server's corner-open card already announces a corner the
              // turn opened; the model's own "Opened corner …" echo is dropped and
              // a turn left with nothing else settles through its receipt.
              if (openCornerCall && !isFailedToolCall(openCornerCall)) {
                reply = stripCornerOpenEcho(reply);
              }
              await trace.measure('publish', () =>
                stream.settle(
                  reply,
                  reply
                    ? {
                        triggerMessageId: item.id,
                        mentionIds: agentReplyMentionIds(reply, roster, this.agent.publicKey),
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
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
      });
      // After the receipt: an operator artifact must never delay the answer,
      // and it never becomes one — the trace has no way to post a Room row.
      await trace.finish('complete');
    } catch (error) {
      const reason = distillTurnFailureReason(error);
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'failed',
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
        reason,
      });
      await trace.finish('failed', reason);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async run(): Promise<void> {
    const { api, roomId, signal } = this.options;
    const status = this.options.config.modelUnavailable ? 'offline' : 'online';
    const postPresence = async (presence: 'online' | 'offline') => {
      await api.execute('postAgentPresence', {
        agentId: this.agent.publicKey,
        roomId,
        status: presence,
        ...(this.options.config.daemonReleaseVersion
          ? { releaseVersion: this.options.config.daemonReleaseVersion }
          : {}),
        ...(this.options.config.daemonSourceSha
          ? { sourceSha: this.options.config.daemonSourceSha }
          : {}),
      });
      this.options.health.presence(presence);
    };
    await postPresence(status);
    const heartbeat = setInterval(
      () =>
        void postPresence(status).catch((error) =>
          console.error(`[thin-core] monolith Room ${roomId} presence heartbeat failed:`, error),
        ),
      30_000,
    );
    heartbeat.unref?.();
    let cursor: string | undefined;
    try {
      cursor = (await api.execute('getRoomInbox', { roomId, startAtLatest: true })).cursor;
      while (!signal?.aborted) {
        try {
          if (!this.activeTurn && this.queuedTurns.length) {
            this.startPrompt(this.queuedTurns.shift()!);
          }
          const inbox = await api.execute('getRoomInbox', {
            roomId,
            ...(cursor ? { after: cursor } : {}),
            limit: 200,
          });
          for (const item of inbox.items) {
            if (!inboxItemTriggersTurn(item, this.agent.publicKey)) continue;
            // A server-authored event was already authority-gated where the
            // fact was made (schedule creation; the owner's grant decision;
            // membership). Everything else answers to the per-sender policy.
            if (!inboxItemSkipsSenderPolicy(item, this.agent.publicKey)) {
              const authority = await api.execute('getRoomAuthority', {
                roomId,
                principalId: item.authorId,
              });
              const humanPermitted =
                authority.principalKind === 'human'
                  ? await this.currentPrincipalCanDrive(this.options.workspaceId, item.authorId)
                  : false;
              if (!roomPrincipalMayAddressAgent(authority, humanPermitted)) continue;
            }
            const active = this.activeTurn;
            if (!active) this.startPrompt(item);
            else if (active.phase === 'prompting') this.steer(active, item);
            else this.queuedTurns.push(item);
          }
          cursor = inbox.cursor ?? cursor;
          this.options.health.poll();
          await wait(this.options.pollMs ?? 1_000, signal);
        } catch (error) {
          if (signal?.aborted) break;
          this.options.health.failure(1_000);
          console.error(`[thin-core] monolith Room ${roomId} turn loop failed:`, error);
          await wait(1_000, signal);
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.options.grantRunner?.unregister(roomId);
      if (this.activeTurn?.phase === 'prompting' && this.client && this.sessionId) {
        this.client.sessionCancel(this.sessionId);
      }
      await this.activeTurn?.promise;
      await postPresence('offline').catch((error) =>
        console.error(`[thin-core] monolith Room ${roomId} offline presence failed:`, error),
      );
      await this.options.scheduler.suspend(roomId);
    }
  }
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
