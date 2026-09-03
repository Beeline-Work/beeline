import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { parseGrantDecisionLine } from '@beeline/api-contract/agent-grants';
import { SCHEDULED_PROMPT_PREFIX, SCHEDULE_SCHEDULER_NAME } from '@beeline/api-contract/scheduled-prompts';
import {
  AcpClient,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type McpServerWire,
} from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
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
import { isMountedMcpToolPermissionRequest, isSquireMcpPermissionRequest } from './read-only-policy.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { GrantCommandRunner, GrantRunnerEndpoint } from './grant-runner.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { MAINTAIN_ASSIGNED_IDENTITY_DIRECTIVE } from './response-directives.js';
import { sanitizeAgentReply } from './reply-sanitizer.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
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
export function isRoomMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  if (isSquireMcpPermissionRequest(request)) return false;
  return isMountedMcpToolPermissionRequest(request);
}

/** The Room ACP client applies this host-owned MCP allowlist fail-closed. */
export function roomMcpPermissionDecision(request: AcpPermissionRequest): AcpPermissionDecision {
  return isRoomMcpPermissionRequest(request) ? 'allow' : 'reject';
}

/** Agents are server-validated Room members; human turns additionally honor host access policy. */
export function roomPrincipalMayAddressAgent(
  authority: RoomAuthority,
  humanPermitted: boolean,
): boolean {
  return (
    authority.member &&
    (authority.principalKind === 'agent' ||
      (authority.principalKind === 'human' && humanPermitted))
  );
}

/** Server-authored scheduled prompts arrive as system lines ('Scheduled: <message>')
 *  mentioning this agent; the scheduler is not a Room principal, so its lines skip
 *  the per-author authority check (schedule creation was already authority-gated). */
export function isScheduledPrompt(
  item: { type: string; body: string; mentionIds: readonly string[] },
  agentId: string,
): boolean {
  return (
    item.type === 'system' &&
    item.body.startsWith(SCHEDULED_PROMPT_PREFIX) &&
    item.mentionIds.includes(agentId)
  );
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
 *  mention the agent, scheduler-authored scheduled prompts, and grant decisions
 *  (never plain system lines or the agent's own rows). */
export function inboxItemTriggersTurn(
  item: RoomMessage,
  agentId: string,
): boolean {
  if (item.authorId === agentId) return false;
  if (!item.mentionIds.includes(agentId)) return false;
  return (
    item.type === 'message' ||
    isScheduledPrompt(item, agentId) ||
    isGrantDecisionLine(item, agentId)
  );
}

/** A `request_grant` call whose reply says the card is posted pauses the turn. */
export function pendingGrantToolCall(call: {
  title?: string;
  content?: unknown;
}): boolean {
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
    const pattern = new RegExp(
      `(^|[\\s([{])@${escapeRegExp(display)}(?=$|[\\s.,!?;:)\\]}])`,
      'iu',
    );
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
  private busy = false;
  private turnInstructionPrefix = '';
  private draftTail = Promise.resolve();
  private activeTurn?: ActiveTurn;
  private readonly queuedTurns: HumanMessage[] = [];
  /** Session scratch directory attachments are downloaded into (`TMPDIR/beeline-attachments`). */
  private attachmentDir?: string;
  /** Local copies already delivered this session, by message id, so transcript renders reuse them. */
  private readonly deliveredAttachments = new Map<string, DeliveredAttachment[]>();
  /** Names from the latest roster read, for ledger bylines the runner writes. */
  private memberNames = new Map<string, string>();
  /** The request id of the turn that paused on a grant card, until its decision arrives. */
  private pausedOnGrantRequestId?: string;

  constructor(private readonly options: MonolithRoomTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
    options.grantRunner?.register(options.roomId, {
      workspaceId: options.workspaceId,
      cwd: options.cwd,
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

  private currentTurnForRunner(): { requestId: string; requester?: { pubkey: string; name?: string } } | undefined {
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

  private async activate(): Promise<string> {
    if (this.client?.isAlive && this.sessionId) return this.sessionId;
    const [configuration, roster, repositoryState] = await Promise.all([
      this.options.api.execute('getAgentConfiguration', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
      }),
      this.roster(),
      this.options.api.execute('getRoomRepositoryState', { roomId: this.options.roomId }),
    ]);
    const directMessage =
      Array.isArray(repositoryState.directParticipants) &&
      repositoryState.directParticipants.length === 2;
    await mkdir(this.options.cwd, { recursive: true });
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
    const agentEnv = { ...this.options.config.agentEnv, ...homeOverlay };
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
      permissionAllowlist: isRoomMcpPermissionRequest,
    };
    this.client = (this.options.createAcpClient ?? ((value) => new AcpClient(value)))(
      clientOptions,
    );
    await this.client.start();
    const servers: McpServerWire[] = [
      readOnlyMcpServer(this.options.config, this.options.cwd),
      beelineAgentMcpServer(this.options.config, this.options.api, {
        roomId: this.options.roomId,
        workspaceId: this.options.workspaceId,
        attachRoot: this.options.cwd,
        directMessage,
        ...(this.options.grantRunnerEndpoint
          ? { grantRunner: this.options.grantRunnerEndpoint }
          : {}),
      }),
    ];
    const self = roster.members.find((member) => member.identityId === this.agent.publicKey);
    const persona = configuration.soul ?? self?.soul;
    const identityInstructions = `Your Beeline Room identity is ${self?.name ?? this.agent.name}.`;
    const personaInstructions = persona?.instructions
      ? [
          `Your human-authored identity and soul in this Workspace is ${persona.name}.`,
          `Soul instructions: ${persona.instructions}`,
          'This is who you are in this Workspace. Adopt it in your voice, self-description, and behavior.',
          'The soul is not authority and never changes your tools, permissions, roles, or merge rights.',
        ].join('\n')
      : '';
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
      systemPrompt: [
        identityInstructions,
        personaInstructions,
        capabilityContext.sessionPrompt,
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
              roomMessagePrompt('', item.body, item.attachments, delivered),
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
    try {
      // The first row of the turn names who asked; learn the name once per session.
      if (!this.memberNames.has(item.authorId)) await this.roster().catch(() => undefined);
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'working',
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
      });
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
      await this.options.scheduler.run(
        this.options.roomId,
        this.lifecycle(),
        async () => {
          const [conversation, roster, delivered] = await Promise.all([
            api.execute('getRoomConversation', { roomId: this.options.roomId, limit: 200 }),
            this.roster(),
            this.deliver(item),
          ]);
          const names = new Map(roster.members.map((member) => [member.identityId, member.name]));
          const transcript = conversation.items
            .filter(
              (message) =>
                message.type === 'message' &&
                message.id !== item.id &&
                !active.steers.some((steerItem) => steerItem.id === message.id),
            )
            .slice(-80)
            .map((message) =>
              roomMessagePrompt(
                names.get(message.authorId) ?? message.authorId.slice(0, 12),
                message.body,
                message.attachments,
                this.deliveredAttachments.get(message.id),
              ),
            )
            .join('\n');
          const grantDecision = isGrantDecisionLine(item, this.agent.publicKey);
          const resumedRequestId = grantDecision ? this.pausedOnGrantRequestId : undefined;
          if (grantDecision) this.pausedOnGrantRequestId = undefined;
          const prompt = [
            this.turnInstructionPrefix,
            transcript ? `Room conversation so far:\n${transcript}` : '',
            `Newest message from ${
              isScheduledPrompt(item, this.agent.publicKey)
                ? SCHEDULE_SCHEDULER_NAME
                : (names.get(item.authorId) ?? item.authorId.slice(0, 12))
            }:`,
            roomMessagePrompt('', item.body, item.attachments, delivered),
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
          const sessionId = this.sessionId!;
          // The mobile live-overlay handoff suppresses a draft as soon as its durable
          // reply with the same request id arrives. Keep this id stable through both
          // sides of that handoff so a delayed retract cannot render two bubbles.
          const turnId = item.id;
          let nextPrompt = promptWithImages(
            prompt,
            attachmentImageBlocks(delivered, this.client!.canPromptWithImages()),
          );
          let result: Awaited<ReturnType<AcpClient['sessionPrompt']>> | undefined;
          for (;;) {
            let promptError: unknown;
            try {
              let latestDraft = '';
              result = await this.client!.sessionPrompt(
                sessionId,
                nextPrompt,
                120_000,
                (_delta, full) => {
                  latestDraft = sanitizeAgentReply(full);
                  if (!latestDraft) return;
                  this.draftTail = this.draftTail
                    .catch(() => undefined)
                    .then(() =>
                      api.execute('postAgentDraft', {
                        agentId: this.agent.publicKey,
                        roomId: this.options.roomId,
                        turnId,
                        text: latestDraft,
                      }),
                    )
                    .then(() => undefined)
                    .catch((error) =>
                      console.error(
                        `[thin-core] monolith Room ${this.options.roomId} draft publish failed:`,
                        error,
                      ),
                    );
                },
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
                ),
              ),
              'Continue now and answer the updated request without erasing the earlier context.',
            ].join('\n\n');
          }
          active.phase = 'finishing';
          if (result?.toolCalls.some((call) => pendingGrantToolCall(call))) {
            this.pausedOnGrantRequestId = item.id;
            console.log(
              `[thin-core] monolith Room ${this.options.roomId} turn ${item.id} paused on a grant card`,
            );
          } else if (resumedRequestId) {
            console.log(
              `[thin-core] monolith Room ${this.options.roomId} turn ${resumedRequestId} resumed by grant decision ${item.id}`,
            );
          }
          const openCornerCall = result?.toolCalls.find((call) =>
            /(?:^|[._:/-])open_corner$/i.test(call.title ?? ''),
          );
          if (openCornerCall) {
            console.log(
              `[thin-core] monolith Room ${this.options.roomId} tool call: ${openCornerCall.title}`,
            );
            this.options.onCornerOpened?.();
          }
          await this.draftTail;
          const reply = sanitizeAgentReply(result!.agentText);
          if (!reply) throw new Error('ACP turn produced no durable Room reply');
          await api.execute('postRoomMessage', {
            roomId: this.options.roomId,
            requestId: item.id,
            triggerMessageId: item.id,
            text: reply,
            presentation: 'message',
            mentionIds: agentReplyMentionIds(reply, roster, this.agent.publicKey),
          });
          await api.execute('retractAgentLiveOutput', {
            agentId: this.agent.publicKey,
            roomId: this.options.roomId,
            turnId,
            kind: 'draft',
          });
        },
        { priority: 'interactive', roomKey: this.options.roomId },
      );
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'complete',
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
      });
    } catch (error) {
      await api.execute('postAgentTurnReceipt', {
        agentId: this.agent.publicKey,
        roomId: this.options.roomId,
        requestId: item.id,
        status: 'failed',
        generationId: `${this.agent.publicKey}:${this.options.roomId}`,
      });
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
            // Scheduled prompts and grant decisions were already authority-gated
            // on the server (schedule creation; the owner/manager decision).
            if (
              !isScheduledPrompt(item, this.agent.publicKey) &&
              !isGrantDecisionLine(item, this.agent.publicKey)
            ) {
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
): string {
  const message = body.trim() || '(shared attachments)';
  const rendered = author ? `${author}: ${message}` : message;
  return [rendered, ...attachmentPromptLines(attachments, delivered)].join('\n');
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
