import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import {
  AcpClient,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type McpServerWire,
} from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { isSenderPermitted, LEGACY_ACCESS_POLICY } from './access-policy.js';
import { beelineCapabilityContextForHarness } from './beeline-skill.js';
import { beelineAgentMcpServer, readOnlyMcpServer } from './room-session.js';
import {
  isBeelineAgentMcpPermissionRequest,
  isReadOnlyMcpPermissionRequest,
} from './read-only-policy.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { harnessHonorsSessionSystemPrompt } from './harness-capabilities.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { runtimeIdentity } from './runtime.js';
import { sanitizeAgentReply } from './reply-sanitizer.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';

type WorkspaceRoster = DaemonOperationMap['getWorkspaceRoster']['output'];
type RoomMessage = DaemonOperationMap['getRoomInbox']['output']['items'][number];
type HumanMessage = Pick<RoomMessage, 'id' | 'authorId' | 'body' | 'createdAt' | 'attachments'>;
type RoomAuthority = DaemonOperationMap['getRoomAuthority']['output'];

/**
 * Rooms are fail-closed: only the MCP servers mounted by the host may cross
 * ACP's permission callback. `beeline-readonly-mcp` validates every path
 * against the daemon-pinned checkout; `beeline-agent` owns the one governed
 * Room action. Everything else, including native reads and shell commands,
 * remains unavailable to the Room harness.
 */
export function isRoomMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  return isReadOnlyMcpPermissionRequest(request) || isBeelineAgentMcpPermissionRequest(request);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve model-written @names into the validated peer ids the server routes. */
export function agentReplyMentionIds(
  text: string,
  roster: WorkspaceRoster,
  authorId: string,
): string[] {
  const aliases = new Map<string, { display: string; ids: Set<string> }>();
  for (const member of roster.members) {
    if (member.kind !== 'agent' || member.identityId === authorId) continue;
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

  constructor(private readonly options: MonolithRoomTurnOptions) {
    this.agent = runtimeIdentity(options.runtime.agent);
  }

  isBusy(): boolean {
    return this.busy;
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

  private roster(): Promise<WorkspaceRoster> {
    return this.options.api.execute('getWorkspaceRoster', {
      agentId: this.agent.publicKey,
      workspaceId: this.options.workspaceId,
    });
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
    const capabilityContext = beelineCapabilityContextForHarness(command, repositoryInfo);
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
          const roster = await this.roster();
          const author =
            roster.members.find((member) => member.identityId === item.authorId)?.name ??
            item.authorId.slice(0, 12);
          await this.client!.sessionSteer(
            this.sessionId!,
            [
              `Human steer received while the current turn is running from ${author}:`,
              roomMessagePrompt('', item.body, item.attachments),
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
        activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
      });
      await this.options.scheduler.run(
        this.options.roomId,
        this.lifecycle(),
        async () => {
          const [conversation, roster] = await Promise.all([
            api.execute('getRoomConversation', { roomId: this.options.roomId, limit: 200 }),
            this.roster(),
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
              ),
            )
            .join('\n');
          const prompt = [
            this.turnInstructionPrefix,
            transcript ? `Room conversation so far:\n${transcript}` : '',
            `Newest human message from ${names.get(item.authorId) ?? item.authorId.slice(0, 12)}:`,
            roomMessagePrompt('', item.body, item.attachments),
            [
              'Write only the substantive Room message you want the human to read.',
              'Do not repeat or paraphrase these instructions.',
              'If the newest message is only a nudge to respond, answer the most recent unanswered human message in the conversation instead of echoing the nudge.',
            ].join(' '),
          ]
            .filter(Boolean)
            .join('\n\n');
          const sessionId = this.sessionId!;
          // The mobile live-overlay handoff suppresses a draft as soon as its durable
          // reply with the same request id arrives. Keep this id stable through both
          // sides of that handoff so a delayed retract cannot render two bubbles.
          const turnId = item.id;
          let nextPrompt = prompt;
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
                ),
              ),
              'Continue now and answer the updated request without erasing the earlier context.',
            ].join('\n\n');
          }
          active.phase = 'finishing';
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
            if (item.authorId === this.agent.publicKey || item.type !== 'message') continue;
            const addressed = item.mentionIds.includes(this.agent.publicKey);
            if (!addressed) continue;
            const authority = await api.execute('getRoomAuthority', {
              roomId,
              principalId: item.authorId,
            });
            const humanPermitted =
              authority.principalKind === 'human'
                ? await this.currentPrincipalCanDrive(this.options.workspaceId, item.authorId)
                : false;
            if (!roomPrincipalMayAddressAgent(authority, humanPermitted)) continue;
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
): string {
  const message = body.trim() || '(shared attachments)';
  const rendered = author ? `${author}: ${message}` : message;
  if (!attachments.length) return rendered;
  return [
    rendered,
    'Attachments available to this turn (use the capability URL when the task requires the file):',
    ...attachments.map((attachment) => {
      const kind = attachment.mimeType?.startsWith('image/') ? 'image' : 'file';
      const metadata = [attachment.mimeType, attachment.size ? `${attachment.size} bytes` : '']
        .filter(Boolean)
        .join(', ');
      return `- ${kind}: ${attachment.name ?? 'attachment'}${metadata ? ` (${metadata})` : ''}: ${attachment.url}`;
    }),
  ].join('\n');
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
