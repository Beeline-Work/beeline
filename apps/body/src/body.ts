/**
 * Body service: the operator-run service that gives the coding agent its
 * computer, enforces the read-only→edit tool boundary, and makes the session
 * multi-user-visible.
 *
 * Core operations:
 *   - `provision(tlcChannelId, boundRepo)`: attach the read-only agent to a TLC.
 *   - `openSubchannel(tlcChannelId, intent)`: create child channel + worktree +
 *       edit-mode session + activity projection.
 *   - `archiveSubchannel(subchannelId)`: cancel session, remove worktree, archive
 *       channel metadata.
 *   - Activity projection bridges ACP session/update → relay channel events.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AcpClient,
  isMutatingPermissionRequest,
  type AcpPermissionHandler,
  type AcpPermissionRequest,
  type McpServerWire,
} from './acp.js';
import {
  projectActivity,
  postAgentMessage,
  postAgentTurnStatus,
  postControlMessage,
  stripAgentReplyPreamble,
} from './activity.js';
import {
  createChannel,
  setMemberRole,
  newIdentity,
  createRelayClient,
  archiveChannel,
  assertAgentNotPushAllowed,
  DurableMergeGate,
  git,
  gitAuthed,
  gitWithUserCredentials,
  lsRemoteRef,
  isRegisteredAgentIdentity,
  type Identity,
  type RelayClient,
} from '@beeline/gate';
import {
  createBuzzClient,
  createAgent,
  isMember,
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_MANIFEST_TAG,
  CHANGE_REVIEW_VERSION,
  WRITE_PERMISSION_REQUEST_TAG,
  WRITE_PERMISSION_RESPONSE_TAG,
  listAgents,
  listMembers,
  getParentChannelId,
  tagValue,
  waitUntilMember,
  type ChannelOpsContext,
} from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import type { BodyConfig } from './config.js';
import { DurableBodyState } from './durable-state.js';
import { SessionScheduler, type SessionLifecycle } from './session-scheduler.js';
import { appendPersonaSessionInstructions } from './persona-instructions.js';
import {
  chunkChangeReviewPatch,
  listChangeReviewFiles,
  postChangeReviewMetadata,
  readChangeReviewPatch,
  resolveReviewBaseTip,
} from './change-review.js';

/** Tracks a single agent session. */
export interface AgentSession {
  /** Channel ID this session belongs to. */
  channelId: string;
  /** ACP session ID. */
  sessionId: string;
  /** AcpClient instance managing the agent. */
  client: AcpClient;
  /** Session mode. */
  mode: 'readonly' | 'edit';
  /** Git worktree path (edit mode only). */
  worktreePath?: string;
  /** Feature branch name (edit mode only). */
  featureBranch?: string;
  /** Parent TLC channel ID (subchannels only). */
  parentChannelId?: string;
  /** Unsubscribe from activity projection. */
  unsubscribeActivity?: () => void;
  /** Last created_at timestamp when polling for member messages (subchannels only). */
  lastPolledAt?: number;
  /** Whether this subchannel has been archived. */
  archived?: boolean;
  /** Stable channel-scoped pin; physical ACP ids may rotate only after idle suspension. */
  logicalSessionId?: string;
  /** Internal lifecycle used by the bounded Workspace scheduler. */
  lifecycle?: SessionLifecycle;
}

/**
 * Exhaust a newest-first relay result window without advancing past omitted
 * older events. `until` walks backward; the durable inbox later restores
 * chronological processing and a composite `(created_at,id)` delivery cursor.
 */
export async function queryEventBacklog(
  filter: Record<string, unknown>,
  options: {
    pageSize?: number;
    query: RelayClient['queryEvents'];
  },
): Promise<NostrEvent[]> {
  const pageSize = options.pageSize ?? 5_000;
  const query = options.query;
  const found = new Map<string, NostrEvent>();
  let until = typeof filter.until === 'number' ? filter.until : undefined;

  while (true) {
    const page = await query([
      { ...filter, ...(until === undefined ? {} : { until }), limit: pageSize },
    ]);
    for (const event of page) found.set(event.id, event);
    if (page.length < pageSize) break;
    const oldest = Math.min(...page.map((event) => event.created_at));
    const nextUntil = oldest - 1;
    if (until !== undefined && nextUntil >= until) break;
    until = nextUntil;
    const since = typeof filter.since === 'number' ? filter.since : undefined;
    if (since !== undefined && until < since) break;
  }

  return [...found.values()].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
}

export interface SubchannelInfo {
  subchannelId: string;
  worktreePath: string;
  featureBranch: string;
  /** Identity authorized to administer/archive this subchannel (agent for new opens). */
  role: Identity;
  session: AgentSession;
  /** Last created_at timestamp when polling for member messages. */
  lastPolledAt: number;
  /** Whether this subchannel has been archived. */
  archived: boolean;
  /** Repository this edit session will push to. */
  boundRepo?: BoundRepo;
  /** Human request that caused the agent to open this subchannel. */
  request?: ChannelTaskRequest;
  /** Exact target advertised to the human merge gate once work is pushed. */
  mergeTarget?: { repo: string; branch: string; tip: string };
  /** Latest agent-authored completion summary. */
  mergeSummary?: string;
  /** Successfully forwarded member events, preventing same-second relay replays. */
  processedMemberEventIds?: Set<string>;
}

/** Fail closed unless an archive target is the exact relay-linked child session. */
export function assertSubchannelArchiveTarget(
  info: SubchannelInfo,
  relayParentChannelId: string | null,
): void {
  const sessionParentChannelId = info.session.parentChannelId;
  if (
    info.session.channelId !== info.subchannelId ||
    !sessionParentChannelId ||
    sessionParentChannelId === info.subchannelId ||
    relayParentChannelId !== sessionParentChannelId
  ) {
    throw new Error(
      `refusing to archive non-corner channel ${info.subchannelId}: ` +
        `session=${info.session.channelId} sessionParent=${sessionParentChannelId ?? 'none'} ` +
        `relayParent=${relayParentChannelId ?? 'none'}`,
    );
  }
}

export interface BoundRepo {
  /** Relay repository owner, when origin is a Buzz smart-HTTP remote. */
  ownerHex?: string;
  repo: string;
  targetBranch?: string;
  /** Paired checkout used as the source repository for all Room worktrees. */
  localPath?: string;
  remoteName?: string;
  repositoryKey?: string;
  localOnly?: boolean;
}

export interface ChannelTaskRequest {
  eventId: string;
  authorPubkey: string;
  content: string;
  createdAt: number;
}

interface PendingRoomTurn {
  request: ChannelTaskRequest;
  boundRepo: BoundRepo;
  permissionHandled: boolean;
  transitionedToCorner: boolean;
}

/** @deprecated Explicit Start-work events are ordinary Room messages now. */
export const AGENT_REQUEST_TAG = 'buzz-agent-request';
export const MERGE_READY_TAG = 'merge-ready';
export const LANDED_TAG = 'landed';
export const AGENT_CANCEL_TAG = 'buzz-agent-cancel';

export function cornerNameForIntent(intent: string | undefined, parentChannelId: string): string {
  const slug = intent
    ?.normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
    .replace(/-+$/g, '');
  return slug || `corner-${parentChannelId.slice(0, 8)}`;
}

/**
 * Whether a Room message is addressed to this agent.
 *
 * A direct @ mention always addresses this agent. In a two-party Room the
 * sole human can speak naturally because there is nobody else to address.
 * Machine-held merge workers are removed before `roomParticipants` reaches
 * this helper, so they never make a human/agent conversation look multi-party.
 */
export function isChannelAddressedMessage(
  event: NostrEvent,
  agentPubkey: string,
  roomParticipants: readonly string[] = [],
): boolean {
  if (event.kind !== 9 || !event.content.trim() || event.pubkey === agentPubkey) return false;
  if (event.tags.some((tag) => tag[0] === 'p' && tag[1] === agentPubkey)) return true;

  const participants = new Set(roomParticipants);
  participants.delete(agentPubkey);
  return participants.size === 1 && participants.has(event.pubkey);
}

/**
 * Whether an addressed Room message explicitly authorizes opening a corner.
 *
 * This intentionally recognizes only direct corner commands. A vague request
 * to implement something still enters the read-only Room session, where the
 * first mutating tool request uses the existing human ALLOW/DENY boundary.
 */
export function isChannelWorkIntent(
  event: NostrEvent,
  agentPubkey: string,
  roomParticipants: readonly string[] = [],
): boolean {
  if (!isChannelAddressedMessage(event, agentPubkey, roomParticipants)) return false;

  const content = event.content
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    // Addressing is already authenticated through the signed `p` tag. Ignore
    // a leading display-name mention when deciding whether the rest is a command.
    .replace(/^@[\p{L}\p{N}_-]+[,:]?\s+/u, '');
  const requestLead = String.raw`(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+|i(?:['’]d| would)\s+like\s+you\s+to\s+)?`;
  const directCornerCommand = new RegExp(
    String.raw`^${requestLead}(?:open|create|launch|start)\s+(?:up\s+)?(?:a\s+|the\s+)?(?:new\s+)?corner\b`,
    'i',
  );
  const startWorkInCornerCommand = new RegExp(
    String.raw`^${requestLead}start\s+(?:(?:the|this|that)\s+)?(?:work|working)\b.{0,200}\b(?:in|inside|within)\s+(?:a\s+|the\s+)?(?:new\s+)?corner\b`,
    'i',
  );
  return directCornerCommand.test(content) || startWorkInCornerCommand.test(content);
}

/** @deprecated Use isChannelWorkIntent; retained for wire/test compatibility. */
export const isChannelTaskRequest = isChannelWorkIntent;

/** Create the relay-side child channel under the agent's own signing key. */
export function createAgentSubchannel(
  agentIdentity: Identity,
  parentChannelId: string,
  name: string,
  communityId?: string,
): Promise<string> {
  return createChannel(agentIdentity, name, {
    parentChannelId,
    ...(communityId ? { communityId } : {}),
  });
}

/**
 * The Body orchestrates agent sessions, worktrees, and channel management.
 *
 * The body identity is the entity that creates channels and manages sessions.
 * In the product, an operator runs this service against a specific channel.
 */
export class Body {
  private config: BodyConfig;
  private sessions = new Map<string, AgentSession>();
  private subchannels = new Map<string, SubchannelInfo>();
  private bodyIdentity: Identity;
  private agentIdentity: Identity;
  private mergeWorkerIdentity?: Identity;
  private processedRequestIds = new Set<string>();
  private requestCursors = new Map<string, number>();
  private runningAgentTasks = new Map<string, Promise<void>>();
  private scheduler: SessionScheduler;
  private ownsScheduler: boolean;
  private durableState: DurableBodyState;
  private agentRelay: RelayClient;
  private mergeWorkerRelay?: RelayClient;
  private pendingRoomTurns = new Map<string, PendingRoomTurn>();

  constructor(
    config: BodyConfig,
    bodyIdentity?: Identity,
    agentIdentity?: Identity,
    mergeWorkerIdentity?: Identity,
    services: { scheduler?: SessionScheduler; statePath?: string } = {},
  ) {
    this.config = config;
    this.bodyIdentity = bodyIdentity ?? newIdentity('buzzy-body');
    this.agentIdentity = agentIdentity ?? newIdentity('buzzy-agent');
    this.mergeWorkerIdentity = mergeWorkerIdentity;
    const relayConfig = { baseUrl: config.relayBaseUrl, host: config.relayHost };
    this.agentRelay = createRelayClient(this.agentIdentity, relayConfig);
    this.mergeWorkerRelay = mergeWorkerIdentity
      ? createRelayClient(mergeWorkerIdentity, relayConfig)
      : undefined;
    this.scheduler =
      services.scheduler ??
      new SessionScheduler({
        maxLiveSessions: Number(process.env.BUZZY_BODY_MAX_SESSIONS ?? '4'),
        idleMs: Number(process.env.BUZZY_BODY_SESSION_IDLE_MS ?? String(5 * 60_000)),
      });
    this.ownsScheduler = !services.scheduler;
    this.durableState = new DurableBodyState(
      services.statePath ?? resolve(config.workspaceRoot, '.beeline-body-state.json'),
    );
    this.assertDistinctAgentIdentity(this.agentIdentity);
  }

  get identity(): Identity {
    return this.bodyIdentity;
  }

  get agent(): Identity {
    return this.agentIdentity;
  }

  /** Register a session for a channel (used by tests to add externally-created sessions). */
  registerSession(session: AgentSession): void {
    this.sessions.set(session.channelId, session);
  }

  /** Register subchannel info (used by tests to add externally-created subchannel state). */
  registerSubchannel(info: SubchannelInfo): void {
    this.subchannels.set(info.subchannelId, info);
    this.sessions.set(info.subchannelId, info.session);
  }

  /** Register (or override) the agent's Nostr identity. */
  setAgentIdentity(id: Identity): void {
    this.assertDistinctAgentIdentity(id);
    this.agentIdentity = id;
    this.agentRelay = createRelayClient(id, {
      baseUrl: this.config.relayBaseUrl,
      host: this.config.relayHost,
    });
  }

  /** Lookup a session by channel ID. */
  getSession(channelId: string): AgentSession | undefined {
    return this.sessions.get(channelId);
  }

  /** List all active sessions. */
  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  private async createManagedSession(input: {
    channelId: string;
    mode: 'readonly' | 'edit';
    cwd: string;
    mcpServers: McpServerWire[];
    systemPrompt: string;
    autoApprovePermissions: boolean;
    permissionHandler?: AcpPermissionHandler;
    parentChannelId?: string;
    worktreePath?: string;
    featureBranch?: string;
    communityId?: string;
  }): Promise<AgentSession> {
    let client = new AcpClient({
      agentCommand: this.config.agentCommand ?? this.config.agentBinary,
      agentArgs: this.config.agentArgs,
      agentEnv: this.config.agentEnv,
      autoApprovePermissions: input.autoApprovePermissions,
      permissionHandler: input.permissionHandler,
    });
    const session: AgentSession = {
      channelId: input.channelId,
      sessionId: '',
      logicalSessionId: `${this.agentIdentity.publicKey}:${input.channelId}`,
      client,
      mode: input.mode,
      ...(input.parentChannelId ? { parentChannelId: input.parentChannelId } : {}),
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
      ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
    };
    const lifecycle: SessionLifecycle = {
      activate: async () => {
        if (client.isAlive && session.sessionId) return session.sessionId;
        client = new AcpClient({
          agentCommand: this.config.agentCommand ?? this.config.agentBinary,
          agentArgs: this.config.agentArgs,
          agentEnv: this.config.agentEnv,
          autoApprovePermissions: input.autoApprovePermissions,
          permissionHandler: input.permissionHandler,
        });
        session.client = client;
        const profile = input.communityId
          ? (await listAgents(this.agentClientContext(), input.communityId)).find(
              (agent) => agent.pubkey === this.agentIdentity.publicKey,
            )?.soulProfile
          : undefined;
        await client.start();
        const transcript = await this.durableState.conversation(input.channelId);
        const restored = transcript.length
          ? [
              '',
              'This logical channel session was suspended while idle. Restore its single',
              'continuous conversation from this ordered transcript; do not treat it as a new task:',
              ...transcript.map((entry) => `[${entry.role}] ${entry.text}`),
            ].join('\n')
          : '';
        const created = await client.sessionNew({
          cwd: input.cwd,
          mcpServers: input.mcpServers,
          systemPrompt: `${appendPersonaSessionInstructions(input.systemPrompt, profile)}${restored}`,
          mode: input.mode,
        });
        session.sessionId = created.sessionId;
        session.unsubscribeActivity?.();
        session.unsubscribeActivity = projectActivity(
          client,
          input.channelId,
          this.agentIdentity,
          created.sessionId,
        );
        return created.sessionId;
      },
      suspend: async () => {
        session.unsubscribeActivity?.();
        session.unsubscribeActivity = undefined;
        if (client.isAlive) await client.stop();
      },
    };
    session.lifecycle = lifecycle;
    // Provisioning itself consumes capacity: this evicts the least-recently-used
    // quiet process before another ACP child is spawned.
    await this.scheduler.run(input.channelId, lifecycle, async () => undefined);
    return session;
  }

  private runOnSession<T>(session: AgentSession, task: () => Promise<T>): Promise<T> {
    if (!session.lifecycle) return task();
    return this.scheduler.run(session.channelId, session.lifecycle, task);
  }

  /** Rebuild durable corner actors after a daemon restart. */
  private async restoreSubchannels(parentChannelId: string, boundRepo: BoundRepo): Promise<void> {
    const client = createBuzzClient({
      baseUrl: this.config.relayBaseUrl,
      host: this.config.relayHost,
      identity: this.agentIdentity,
    });
    try {
      const communityId = await this.channelCommunityId(parentChannelId);
      const ids = await client.listSubchannels(parentChannelId);
      const parentEvents = await this.agentRelay.queryEvents([
        { kinds: [9], '#h': [parentChannelId], limit: 5_000 },
      ]);
      for (const subchannelId of ids) {
        if (this.subchannels.has(subchannelId)) continue;
        if ((await client.getChannelMetadata(subchannelId))?.archived) continue;
        const events = await this.agentRelay.queryEvents([
          {
            kinds: [9],
            '#h': [subchannelId],
            authors: [this.agentIdentity.publicKey],
            limit: 5_000,
          },
        ]);
        const control = [...events]
          .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
          .find((event) => tagValue(event, 'feature') && tagValue(event, 'parent'));
        const featureBranch = control ? tagValue(control, 'feature') : undefined;
        if (!featureBranch) continue;
        const worktreePath = resolve(this.config.workspaceRoot, `.worktrees/${subchannelId}`);
        if (!existsSync(worktreePath)) {
          await postControlMessage(
            subchannelId,
            this.agentIdentity,
            'Agent restart could not restore this corner worktree; no input was discarded.',
            [['status', 'failed']],
          ).catch(() => undefined);
          continue;
        }
        const session = await this.createManagedSession({
          channelId: subchannelId,
          mode: 'edit',
          cwd: worktreePath,
          mcpServers: [{ name: 'buzz-dev-mcp', command: this.config.mcpBinary, args: [], env: [] }],
          systemPrompt: [
            'You are a coding agent resuming one durable corner after a supervisor restart.',
            `You are working in a git worktree: ${worktreePath}`,
            `Your feature branch is: ${featureBranch}`,
            'Continue the restored transcript on this branch. Never start a second context.',
          ].join('\n'),
          autoApprovePermissions: true,
          parentChannelId,
          worktreePath,
          featureBranch,
          ...(communityId ? { communityId } : {}),
        });
        const cursor = await this.durableState.cursor(subchannelId);
        const requestId = control ? tagValue(control, 'request') : undefined;
        const requestEvent = requestId
          ? parentEvents.find((event) => event.id === requestId)
          : undefined;
        const request = requestEvent
          ? {
              eventId: requestEvent.id,
              authorPubkey: requestEvent.pubkey,
              content: requestEvent.content.trim(),
              createdAt: requestEvent.created_at,
            }
          : undefined;
        const ready = [...events]
          .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
          .find((event) =>
            event.tags.some(
              (tag) => tag[0] === 't' && (tag[1] === MERGE_READY_TAG || tag[1] === LANDED_TAG),
            ),
          );
        const tip = ready ? tagValue(ready, 'tip') : undefined;
        const info: SubchannelInfo = {
          subchannelId,
          worktreePath,
          featureBranch,
          role: this.agentIdentity,
          session,
          lastPolledAt: cursor.createdAt,
          archived: false,
          boundRepo,
          ...(request ? { request } : {}),
          ...(tip
            ? {
                mergeTarget: {
                  repo: tagValue(ready!, 'repo') ?? this.repoId(boundRepo),
                  branch: tagValue(ready!, 'branch') ?? boundRepo.targetBranch ?? 'refs/heads/main',
                  tip,
                },
              }
            : {}),
        };
        session.lastPolledAt = cursor.createdAt;
        this.registerSubchannel(info);
        if (request && !tip) this.startAgentTask(info, request.content);
      }
    } finally {
      client.disconnect();
    }
  }

  /**
   * Provision a read-only agent session for a TLC channel.
   *
   * 1. Ensure the agent is a member of the channel.
   * 2. Start an ACP session with NO write MCP (empty mcpServers).
   * 3. Project activity into the TLC channel.
   */
  async provision(tlcChannelId: string, boundRepo?: BoundRepo): Promise<AgentSession> {
    const existing = this.sessions.get(tlcChannelId);
    if (existing) {
      if (existing.mode === 'readonly') return existing;
      // If there's a read-only session, we're good. If the existing is edit,
      // we need a separate read-only session — but for now return it since
      // edit implies read-only capabilities too.
      return existing;
    }

    const agentId = this.agentIdentity;
    await this.ensureAgentInChannel(tlcChannelId, agentId);
    await this.ensureAgentEntity(tlcChannelId);
    const communityId = await this.channelCommunityId(tlcChannelId);

    // Read-only session: NO mcpServers — the boundary IS the MCP mount.
    const session = await this.createManagedSession({
      channelId: tlcChannelId,
      mode: 'readonly',
      cwd: boundRepo?.localPath ?? this.config.workspaceRoot,
      mcpServers: [],
      systemPrompt: [
        'You are a helpful coding assistant in a read-only conversation channel.',
        'You can answer questions, discuss architecture, and help plan work.',
        'You CANNOT create, edit, or delete files until the host grants a human-approved edit session.',
        'When the user asks for a concrete file change, attempt the appropriate write/edit tool.',
        'The host will turn that first mutating permission request into a human allow/deny prompt.',
        'Never claim that work started until the host transitions you into an edit session.',
      ].join('\n'),
      // Read-only mode must reject native-agent permission escalation as well
      // as omitting write MCP servers. Edit corners remain auto-approved below.
      autoApprovePermissions: false,
      permissionHandler: (permission) =>
        this.handleRoomPermissionRequest(tlcChannelId, permission),
      ...(communityId ? { communityId } : {}),
    });

    this.sessions.set(tlcChannelId, session);

    await postControlMessage(
      tlcChannelId,
      agentId,
      `🤖 Agent session started (read-only) — session=${session.logicalSessionId}`,
      [
        ['session', session.logicalSessionId!],
        ['mode', 'readonly'],
      ],
    );

    return session;
  }

  /**
   * Open a subchannel + worktree + edit-mode session.
   *
   * 1. Create child channel (UUID) under the TLC.
   * 2. Mirror parent members (assert via 39002 query).
   * 3. Create git worktree + feature branch.
   * 4. Start edit-mode ACP session (full MCP, cwd=worktree).
   * 5. Post control message to TLC linking the subchannel.
   * 6. Start activity projection into the subchannel.
   */
  async openSubchannel(
    tlcChannelId: string,
    boundRepo: BoundRepo,
    intent?: string,
    request?: ChannelTaskRequest,
  ): Promise<SubchannelInfo> {
    const agentId = this.agentIdentity;
    await this.ensureAgentInChannel(tlcChannelId, agentId);
    const communityId = await this.channelCommunityId(tlcChannelId);

    // 1. The agent itself creates/signs the child channel.
    const subchannelId = await createAgentSubchannel(
      agentId,
      tlcChannelId,
      cornerNameForIntent(intent, tlcChannelId),
      communityId ?? undefined,
    );

    // 2. Mirror parent members: query members of TLC, add each as member of subchannel.
    await this.mirrorMembers(tlcChannelId, subchannelId);

    // 4. Create git worktree + feature branch.
    const worktreePath = resolve(this.config.workspaceRoot, `.worktrees/${subchannelId}`);
    const featureBranch = `feature/${subchannelId.slice(0, 8)}`;
    await this.createWorktree(boundRepo, worktreePath, featureBranch);

    // 5. Start edit-mode ACP session.
    const mcpServers: McpServerWire[] = [
      {
        name: 'buzz-dev-mcp',
        command: this.config.mcpBinary,
        args: [],
        env: [],
      },
    ];

    const session = await this.createManagedSession({
      channelId: subchannelId,
      mode: 'edit',
      cwd: worktreePath,
      mcpServers,
      systemPrompt: [
        'You are a coding agent in an edit session.',
        `You are working in a git worktree: ${worktreePath}`,
        `Your feature branch is: ${featureBranch}`,
        'You have full shell and file editing tools available.',
        'You CAN create, edit, and delete files in this worktree.',
        'Commit your changes to the feature branch when appropriate.',
        `Repo: ${boundRepo.ownerHex}/${boundRepo.repo}`,
        ...(intent ? [`User intent: ${intent}`] : []),
      ].join('\n'),
      // A corner is the agent's isolated worktree. Relay repositories retain the
      // protected-line human gate; ordinary remotes land with operator credentials.
      autoApprovePermissions: true,
      parentChannelId: tlcChannelId,
      worktreePath,
      featureBranch,
      ...(communityId ? { communityId } : {}),
    });

    const now = Math.floor(Date.now() / 1000);
    session.lastPolledAt = now;
    session.archived = false;

    this.sessions.set(subchannelId, session);

    const info: SubchannelInfo = {
      subchannelId,
      worktreePath,
      featureBranch,
      role: agentId,
      session,
      lastPolledAt: now,
      archived: false,
      boundRepo,
      ...(request ? { request } : {}),
    };

    this.subchannels.set(subchannelId, info);

    const repoId = this.repoId(boundRepo);
    const targetBranch = boundRepo.targetBranch ?? 'refs/heads/main';
    const requestTags = request
      ? [
          ['request', request.eventId],
          ['requester', request.authorPubkey],
        ]
      : [];

    // 7. Post intro to subchannel with merge target metadata.
    await postControlMessage(
      subchannelId,
      agentId,
      `🤖 Agent edit session started — members mirrored from parent TLC.\nWorktree: ${worktreePath}\nBranch: ${featureBranch}`,
      [
        ['session', session.logicalSessionId!],
        ['parent', tlcChannelId],
        ['mode', 'edit'],
        ['repo', repoId],
        ['agent', agentId.publicKey],
        ['feature', featureBranch],
        ['branch', targetBranch],
        ['status', 'live'],
        ...requestTags,
      ],
    );

    // 8. The parent renders this as a durable card. IDs stay in tags for
    // navigation and are never exposed as transcript copy.
    await this.postParentCornerStatus(
      info,
      'starting',
      `Agent is starting work on: ${intent?.trim() || 'channel request'}`,
    );

    return info;
  }

  /** Poll a Room for addressed conversation and explicit corner commands. */
  async pollChannelRequests(tlcChannelId: string, boundRepo: BoundRepo): Promise<number> {
    const durableCursor = await this.durableState.cursor(tlcChannelId);
    const since = Math.max(this.requestCursors.get(tlcChannelId) ?? 0, durableCursor.createdAt);
    const client = createBuzzClient({
      baseUrl: this.config.relayBaseUrl,
      ...(this.config.relayHost ? { host: this.config.relayHost } : {}),
      identity: this.agentIdentity,
    });
    let roomParticipants: string[];
    try {
      roomParticipants = (await client.listMembers(tlcChannelId))
        .map((member) => member.pubkey)
        .filter((pubkey) => pubkey !== this.mergeWorkerIdentity?.publicKey);
    } finally {
      client.disconnect();
    }
    const events = await queryEventBacklog(
      {
        kinds: [9],
        '#h': [tlcChannelId],
        since,
      },
      { query: this.agentRelay.queryEvents },
    );
    await this.durableState.enqueue(tlcChannelId, events);
    let opened = 0;
    let maxCreatedAt = since;

    for (const event of await this.durableState.pending(tlcChannelId)) {
      maxCreatedAt = Math.max(maxCreatedAt, event.created_at);
      if (this.processedRequestIds.has(event.id)) {
        await this.durableState.delivered(tlcChannelId, event.id);
        continue;
      }
      if (
        event.tags.some(
          (tag) => tag[0] === 't' && tag[1] === WRITE_PERMISSION_RESPONSE_TAG,
        )
      ) {
        this.processedRequestIds.add(event.id);
        await this.durableState.delivered(tlcChannelId, event.id);
        continue;
      }
      if (!isChannelAddressedMessage(event, this.agentIdentity.publicKey, roomParticipants)) {
        await this.durableState.delivered(tlcChannelId, event.id);
        continue;
      }
      if (await this.requestAlreadyOpened(tlcChannelId, event.id)) {
        this.processedRequestIds.add(event.id);
        await this.durableState.delivered(tlcChannelId, event.id);
        continue;
      }

      try {
        // Fail closed: a registered agent can never task another body through the
        // human request affordance, regardless of any channel role it holds.
        if (await isRegisteredAgentIdentity(event.pubkey, this.agentRelay)) {
          await postControlMessage(
            tlcChannelId,
            this.agentIdentity,
            'Agent-authored Room prompt refused.',
            [
              ['request', event.id],
              ['status', 'refused'],
            ],
          );
          this.processedRequestIds.add(event.id);
          await this.durableState.delivered(tlcChannelId, event.id);
          continue;
        }

        const request: ChannelTaskRequest = {
          eventId: event.id,
          authorPubkey: event.pubkey,
          content: event.content.trim(),
          createdAt: event.created_at,
        };
        if (
          await this.replyInRoom(
            tlcChannelId,
            boundRepo,
            request,
            isChannelWorkIntent(event, this.agentIdentity.publicKey, roomParticipants),
          )
        ) {
          opened++;
        }
        this.processedRequestIds.add(event.id);
        await this.durableState.delivered(tlcChannelId, event.id);
      } catch (error) {
        await this.durableState.failed(tlcChannelId, event.id, error);
        throw error;
      }
    }

    this.requestCursors.set(tlcChannelId, maxCreatedAt);
    return opened;
  }

  /** Run one addressed turn through the provisioned read-only Room session. */
  private async replyInRoom(
    tlcChannelId: string,
    boundRepo: BoundRepo,
    request: ChannelTaskRequest,
    explicitCornerWork = false,
  ): Promise<boolean> {
    const prompt = `[Member ${request.authorPubkey.slice(0, 12)}]: ${request.content}`;
    await this.durableState.appendConversation(tlcChannelId, {
      role: 'user',
      text: prompt,
      eventId: request.eventId,
      at: new Date().toISOString(),
    });
    if (explicitCornerWork) {
      const info = await this.openSubchannel(tlcChannelId, boundRepo, request.content, request);
      this.startAgentTask(info, request.content);
      return true;
    }

    const session =
      this.sessions.get(tlcChannelId) ?? (await this.provision(tlcChannelId, boundRepo));
    if (session.mode !== 'readonly') {
      throw new Error('Room conversation requires a read-only ACP session');
    }
    const turn: PendingRoomTurn = {
      request,
      boundRepo,
      permissionHandled: false,
      transitionedToCorner: false,
    };
    this.pendingRoomTurns.set(tlcChannelId, turn);
    try {
      await postAgentTurnStatus(
        tlcChannelId,
        this.agentIdentity,
        request.eventId,
        session.logicalSessionId ?? session.sessionId,
        'working',
      );
      const result = await this.runOnSession(session, () =>
        session.client.sessionPrompt(session.sessionId, prompt, 10 * 60_000),
      );
      if (turn.transitionedToCorner) {
        await postAgentTurnStatus(
          tlcChannelId,
          this.agentIdentity,
          request.eventId,
          session.logicalSessionId ?? session.sessionId,
          'complete',
        );
        return true;
      }
      const reply =
        stripAgentReplyPreamble(result.agentText).trim() ||
        (turn.permissionHandled
          ? 'Editing was not allowed. I’ll stay in the read-only Room conversation.'
          : '');
      if (!reply) throw new Error('agent returned an empty Room reply');
      await this.durableState.appendConversation(tlcChannelId, {
        role: 'agent',
        text: reply,
        at: new Date().toISOString(),
      });
      await postAgentMessage(tlcChannelId, this.agentIdentity, reply, request.eventId);
      await postAgentTurnStatus(
        tlcChannelId,
        this.agentIdentity,
        request.eventId,
        session.logicalSessionId ?? session.sessionId,
        'complete',
      );
      return false;
    } catch (error) {
      await postAgentTurnStatus(
        tlcChannelId,
        this.agentIdentity,
        request.eventId,
        session.logicalSessionId ?? session.sessionId,
        'failed',
      ).catch((statusError) =>
        console.error('[body] failed to publish Room turn failure status:', statusError),
      );
      throw error;
    } finally {
      this.pendingRoomTurns.delete(tlcChannelId);
    }
  }

  /**
   * A Room ACP process always rejects the concrete tool invocation: allowing it
   * in-place would mutate the paired checkout. Human ALLOW instead creates the
   * isolated edit corner and replays the same request there.
   */
  private async handleRoomPermissionRequest(
    tlcChannelId: string,
    permission: AcpPermissionRequest,
  ): Promise<'reject'> {
    const turn = this.pendingRoomTurns.get(tlcChannelId);
    if (!turn || turn.permissionHandled || !isMutatingPermissionRequest(permission)) {
      return 'reject';
    }
    turn.permissionHandled = true;
    const permissionId = randomUUID();
    const tool = this.permissionToolLabel(permission);
    await postControlMessage(
      tlcChannelId,
      this.agentIdentity,
      `${this.agentIdentity.name || 'Agent'} wants to start editing files — allow?`,
      [
        ['t', WRITE_PERMISSION_REQUEST_TAG],
        ['permission', permissionId],
        ['request', turn.request.eventId],
        ['requester', turn.request.authorPubkey],
        ['agent', this.agentIdentity.publicKey],
        ['p', this.agentIdentity.publicKey],
        ['tool', tool],
        ['status', 'pending'],
      ],
    );

    const decision = await this.waitForWritePermissionDecision(
      tlcChannelId,
      permissionId,
      turn.request.eventId,
    );
    if (decision === 'allow') {
      await this.postWritePermissionStatus(
        tlcChannelId,
        permissionId,
        turn.request.eventId,
        tool,
        'allowed',
        'Editing allowed. Opening an isolated corner and worktree.',
      );
      try {
        const info = await this.openSubchannel(
          tlcChannelId,
          turn.boundRepo,
          turn.request.content,
          turn.request,
        );
        turn.transitionedToCorner = true;
        this.startAgentTask(info, turn.request.content);
      } catch (error) {
        await this.postWritePermissionStatus(
          tlcChannelId,
          permissionId,
          turn.request.eventId,
          tool,
          'failed',
          'Editing was allowed, but the isolated corner could not be opened.',
        ).catch(() => undefined);
        throw error;
      }
    } else if (decision === 'deny') {
      await this.postWritePermissionStatus(
        tlcChannelId,
        permissionId,
        turn.request.eventId,
        tool,
        'denied',
        'Editing denied. The Agent remains read-only.',
      );
    } else if (decision === 'timeout') {
      await this.postWritePermissionStatus(
        tlcChannelId,
        permissionId,
        turn.request.eventId,
        tool,
        'expired',
        'Editing request expired. The Agent remains read-only.',
      );
    }
    return 'reject';
  }

  private permissionToolLabel(permission: AcpPermissionRequest): string {
    const title = permission.toolCall?.title?.trim();
    const kind = permission.toolCall?.kind?.trim();
    return (title || kind || 'edit files').replace(/\s+/g, ' ').slice(0, 120);
  }

  private postWritePermissionStatus(
    tlcChannelId: string,
    permissionId: string,
    requestId: string,
    tool: string,
    status: 'allowed' | 'denied' | 'expired' | 'failed',
    message: string,
  ): Promise<void> {
    return postControlMessage(tlcChannelId, this.agentIdentity, message, [
      ['t', WRITE_PERMISSION_REQUEST_TAG],
      ['permission', permissionId],
      ['request', requestId],
      ['agent', this.agentIdentity.publicKey],
      ['tool', tool],
      ['status', status],
    ]);
  }

  private async waitForWritePermissionDecision(
    tlcChannelId: string,
    permissionId: string,
    requestId: string,
    timeoutMs = 10 * 60_000,
  ): Promise<'allow' | 'deny' | 'timeout'> {
    const startedAt = Math.floor(Date.now() / 1000) - 1;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await this.agentRelay.queryEvents([
        {
          kinds: [9],
          '#h': [tlcChannelId],
          '#t': [WRITE_PERMISSION_RESPONSE_TAG],
          since: startedAt,
          limit: 100,
        },
      ]);
      const candidates = events
        .filter(
          (event) =>
            event.pubkey !== this.agentIdentity.publicKey &&
            tagValue(event, 'permission') === permissionId &&
            tagValue(event, 'request') === requestId &&
            tagValue(event, 'p') === this.agentIdentity.publicKey,
        )
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      for (const event of candidates) {
        const members = new Set(
          (await listMembers(this.agentClientContext(), tlcChannelId)).map(
            (member) => member.pubkey,
          ),
        );
        if (!members.has(event.pubkey)) continue;
        if (await isRegisteredAgentIdentity(event.pubkey, this.agentRelay)) continue;
        const decision = tagValue(event, 'decision');
        if (decision === 'allow' || decision === 'deny') return decision;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    return 'timeout';
  }

  /** Start the requested work without blocking discovery/UI updates. */
  private startAgentTask(info: SubchannelInfo, prompt: string): void {
    const task = this.runOnSession(info.session, async () => {
      try {
        await this.postParentCornerStatus(info, 'working', `Agent is working on: ${prompt}`);
        await this.durableState.appendConversation(info.subchannelId, {
          role: 'user',
          text: prompt,
          eventId: info.request?.eventId,
          at: new Date().toISOString(),
        });
        const result = await info.session.client.sessionPrompt(
          info.session.sessionId,
          [
            'Implement the following human request in this worktree.',
            'Keep all edits on the current feature branch. Commit the completed work.',
            '',
            prompt,
          ].join('\n'),
          10 * 60_000,
        );
        info.mergeSummary =
          stripAgentReplyPreamble(result.agentText).trim() || `Completed: ${prompt}`;
        await this.durableState.appendConversation(info.subchannelId, {
          role: 'agent',
          text: info.mergeSummary,
          at: new Date().toISOString(),
        });
        await postAgentMessage(info.subchannelId, this.agentIdentity, info.mergeSummary);
        await this.publishMergeReady(info);
      } catch (error) {
        await postControlMessage(
          info.subchannelId,
          this.agentIdentity,
          `Agent task stopped before merge-ready: ${String(error)}`,
          [['status', 'failed']],
        ).catch(() => undefined);
        await this.postParentCornerStatus(
          info,
          'failed',
          'Work stopped. Open corner for details.',
        ).catch(() => undefined);
      } finally {
        this.runningAgentTasks.delete(info.subchannelId);
      }
    });
    this.runningAgentTasks.set(info.subchannelId, task);
  }

  private postParentCornerStatus(
    info: SubchannelInfo,
    status: 'starting' | 'working' | 'needs-attention' | 'ready' | 'failed',
    message: string,
    extraTags: string[][] = [],
  ): Promise<void> {
    const parentId = info.session.parentChannelId;
    if (!parentId) return Promise.resolve();
    const boundRepo = info.boundRepo;
    const wireStatus = status === 'starting' ? 'open' : status;
    return postControlMessage(parentId, this.agentIdentity, message, [
      ['subchannel', info.subchannelId],
      ['session', info.session.logicalSessionId ?? info.session.sessionId],
      ['agent', this.agentIdentity.publicKey],
      ['feature', info.featureBranch],
      ['branch', boundRepo?.targetBranch ?? 'refs/heads/main'],
      ['mode', 'edit'],
      ['status', wireStatus],
      ['display-status', status],
      ...(boundRepo ? [['repo', this.repoId(boundRepo)]] : []),
      ...(info.request ? [['request', info.request.eventId]] : []),
      ...extraTags,
    ]);
  }

  /** Push the agent's feature tip and publish the exact human-approval target. */
  private async publishMergeReady(info: SubchannelInfo): Promise<boolean> {
    const boundRepo = info.boundRepo;
    if (!boundRepo || info.archived) return false;
    const tip = git(info.worktreePath, ['rev-parse', 'HEAD']).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(tip)) return false;

    if (!boundRepo.ownerHex && boundRepo.remoteName) {
      return this.publishDirectRemoteDelivery(info, tip);
    }

    const push = boundRepo.ownerHex
      ? gitAuthed(info.worktreePath, this.agentIdentity, boundRepo.ownerHex, boundRepo.repo, [
          'push',
          boundRepo.remoteName ?? 'origin',
          `${info.featureBranch}:refs/heads/${info.featureBranch}`,
        ])
      : { ok: true, status: 0, stdout: '', stderr: '' };
    if (!push.ok) {
      await postControlMessage(
        info.subchannelId,
        this.agentIdentity,
        `Feature push failed; merge approval is not available. ${push.stderr.trim()}`,
        [['status', 'failed']],
      );
      await this.postParentCornerStatus(
        info,
        'failed',
        'Delivery failed. Open corner for details.',
      );
      return false;
    }

    const target = {
      repo: this.repoId(boundRepo),
      branch: boundRepo.targetBranch ?? 'refs/heads/main',
      tip,
    };
    if (info.mergeTarget?.tip === tip) return true;

    // Publish review data before advertising merge readiness. The manifest is
    // small and eager; patches are separate, bounded events fetched per file.
    const base = resolveReviewBaseTip(info.worktreePath, target.branch);
    const files = listChangeReviewFiles(info.worktreePath, base, tip);
    for (const [fileIndex, file] of files.entries()) {
      const patch = readChangeReviewPatch(info.worktreePath, base, tip, file);
      const chunks = chunkChangeReviewPatch(patch);
      for (const [index, content] of chunks.entries()) {
        await postChangeReviewMetadata(
          info.subchannelId,
          this.agentIdentity,
          `${info.subchannelId}:${tip}:file:${fileIndex}:${index}`,
          content,
          [
            ['t', CHANGE_REVIEW_FILE_TAG],
            ['f', file.path],
            ['r', tip],
            ['base', base],
            ['tip', tip],
            ['chunk', String(index)],
            ['chunks', String(chunks.length)],
            ...(file.isBinary ? [['binary', 'true']] : []),
          ],
        );
      }
    }
    for (let index = 0; index < Math.max(1, Math.ceil(files.length / 100)); index++) {
      await postChangeReviewMetadata(
        info.subchannelId,
        this.agentIdentity,
        `${info.subchannelId}:${tip}:manifest:${index}`,
        JSON.stringify({
          version: CHANGE_REVIEW_VERSION,
          base,
          tip,
          files: files.slice(index * 100, (index + 1) * 100),
        }),
        [
          ['t', CHANGE_REVIEW_MANIFEST_TAG],
          ['r', tip],
          ['base', base],
          ['tip', tip],
          ['chunk', String(index)],
        ],
      );
    }

    info.mergeTarget = target;
    await postControlMessage(
      info.subchannelId,
      this.agentIdentity,
      `Work is ready for human merge approval — ${tip.slice(0, 12)}…`,
      [
        ['t', MERGE_READY_TAG],
        ['status', 'ready'],
        ['repo', target.repo],
        ['branch', target.branch],
        ['feature', info.featureBranch],
        ['tip', target.tip],
        ['agent', this.agentIdentity.publicKey],
      ],
    );
    await this.postParentCornerStatus(info, 'ready', 'Work is ready for review.');
    return true;
  }

  /**
   * Push and land a non-relay remote with the operator's own git credentials.
   * No Beeline merge worker, approval, or protected-push assertion participates
   * in this path; the remote host's branch policy is the remaining authority.
   */
  private async publishDirectRemoteDelivery(info: SubchannelInfo, tip: string): Promise<boolean> {
    const boundRepo = info.boundRepo;
    const remote = boundRepo?.remoteName;
    if (!boundRepo || !remote) return false;
    const branch = boundRepo.targetBranch ?? 'refs/heads/main';
    const featureRef = `refs/heads/${info.featureBranch}`;
    const featurePush = gitWithUserCredentials(info.worktreePath, [
      'push',
      remote,
      `${tip}:${featureRef}`,
    ]);
    if (!featurePush.ok) {
      await postControlMessage(
        info.subchannelId,
        this.agentIdentity,
        `Feature push failed; work was not landed. ${featurePush.stderr.trim()}`,
        [['status', 'failed']],
      );
      await this.postParentCornerStatus(
        info,
        'failed',
        'Delivery failed. Open corner for details.',
      );
      return false;
    }

    const land = gitWithUserCredentials(info.worktreePath, ['push', remote, `${tip}:${branch}`]);
    if (!land.ok) {
      await postControlMessage(
        info.subchannelId,
        this.agentIdentity,
        `Feature branch pushed, but landing on ${branch} failed. ${land.stderr.trim()}`,
        [
          ['status', 'failed'],
          ['feature', info.featureBranch],
          ['tip', tip],
        ],
      );
      await this.postParentCornerStatus(
        info,
        'failed',
        'Delivery failed after the feature push. Open corner for details.',
        [['tip', tip]],
      );
      return false;
    }

    const target = { repo: this.repoId(boundRepo), branch, tip };
    info.mergeTarget = target;
    await postControlMessage(
      info.subchannelId,
      this.agentIdentity,
      `Work landed on ${branch} at ${tip}.`,
      [
        ['t', LANDED_TAG],
        ['status', 'ready'],
        ['delivery', 'landed'],
        ['repo', target.repo],
        ['branch', target.branch],
        ['feature', info.featureBranch],
        ['tip', target.tip],
        ['agent', this.agentIdentity.publicKey],
      ],
    );
    await this.postParentCornerStatus(
      info,
      'ready',
      `Work landed at ${tip.slice(0, 12)} on ${branch.replace(/^refs\/heads\//, '')}.`,
      [
        ['delivery', 'landed'],
        ['tip', tip],
      ],
    );
    return true;
  }

  /** Archive only after the target ref actually reaches the delivered tip. */
  async pollMergeCompletions(): Promise<number> {
    let merged = 0;
    for (const info of [...this.subchannels.values()]) {
      if (info.archived || !info.mergeTarget || !info.boundRepo) continue;
      const targetTip = info.boundRepo.ownerHex
        ? lsRemoteRef(
            info.worktreePath,
            this.agentIdentity,
            info.boundRepo.ownerHex,
            info.boundRepo.repo,
            info.mergeTarget.branch,
          )
        : info.boundRepo.remoteName
          ? gitWithUserCredentials(info.worktreePath, [
              'ls-remote',
              info.boundRepo.remoteName,
              info.mergeTarget.branch,
            ])
              .stdout.trim()
              .split(/\s+/)[0]
          : info.boundRepo.localPath
            ? git(info.boundRepo.localPath, [
                'rev-parse',
                '--verify',
                info.mergeTarget.branch,
              ]).stdout.trim()
            : undefined;
      if (targetTip !== info.mergeTarget.tip) continue;
      await this.postMergeSummary(
        info.subchannelId,
        info.mergeSummary ?? `Merged ${info.featureBranch} at ${targetTip.slice(0, 12)}…`,
      );
      await this.archiveSubchannel(info.subchannelId);
      merged++;
    }
    return merged;
  }

  /** One long-running body loop owns request discovery, steering, and merge closure. */
  async runChannelLoop(
    tlcChannelId: string,
    boundRepo: BoundRepo,
    opts: { pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.assertRepositorySafety(tlcChannelId, boundRepo);
    await this.provision(tlcChannelId, boundRepo);
    if (boundRepo.repositoryKey) await this.restoreSubchannels(tlcChannelId, boundRepo);
    const pollMs = opts.pollMs ?? 1_000;
    while (!opts.signal?.aborted) {
      await this.pollChannelRequests(tlcChannelId, boundRepo);
      await Promise.all(
        [...this.subchannels.keys()].map((subchannelId) => this.pollMembers(subchannelId)),
      );
      await this.pollMergeCompletions();
      await this.waitForPoll(pollMs, opts.signal);
    }
  }

  /** Durable paired-agent loop for the repository's single Workspace Room. */
  async runRepositoryRoomLoop(
    communityId: string,
    channelId: string,
    boundRepo: BoundRepo,
    opts: { pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!boundRepo.repositoryKey) throw new Error('paired Room is missing its repository key');
    await this.assertRepositorySafety(channelId, boundRepo);

    const mergeGate =
      this.mergeWorkerIdentity && boundRepo.ownerHex
        ? new DurableMergeGate({
            worker: this.mergeWorkerIdentity,
            ownerHex: boundRepo.ownerHex,
            repo: boundRepo.repo,
            channelId,
            targetBranch: boundRepo.targetBranch ?? 'refs/heads/main',
            ...(this.mergeWorkerRelay ? { relay: this.mergeWorkerRelay } : {}),
          })
        : undefined;

    const pollMs = opts.pollMs ?? 3_000;
    await this.provision(channelId, boundRepo);
    await this.restoreSubchannels(channelId, boundRepo);

    while (!opts.signal?.aborted) {
      // The Workspace supervisor owns current-role discovery. It aborts this
      // loop when the Room disappears from the agent's member/admin projection,
      // then waits for accepted turns to drain before disposing the Body.
      try {
        await this.pollChannelRequests(channelId, boundRepo);
      } catch (error) {
        console.error('[body] repository Room request poll failed:', error);
      }
      await Promise.all(
        [...this.subchannels.keys()].map((subchannelId) => this.pollMembers(subchannelId)),
      );
      if (mergeGate) {
        try {
          const attempts = await mergeGate.poll();
          for (const attempt of attempts) {
            console.log(
              `[gate] ${attempt.outcome.merged ? 'LANDED' : attempt.outcome.reason} ` +
                `${attempt.candidate.featureBranch} approval=${attempt.approvalId}`,
            );
          }
        } catch (error) {
          console.error('[gate] Room merge poll failed; will retry:', error);
        }
      }
      await this.pollMergeCompletions();
      await this.waitForPoll(pollMs, opts.signal);
    }
  }

  /**
   * Startup hard gate: establish the agent's actual Room membership first,
   * then fail closed unless that identity is excluded from protected pushes.
   */
  async assertRepositorySafety(channelId: string, boundRepo: BoundRepo): Promise<void> {
    if (!(await isMember(this.agentClientContext(), channelId, this.agentIdentity.publicKey))) {
      throw new Error(`agent is not an invited member of repository Room ${channelId}`);
    }
    if (!boundRepo.ownerHex) return;
    await assertAgentNotPushAllowed({
      ownerHex: boundRepo.ownerHex,
      repo: boundRepo.repo,
      agentPubkey: this.agentIdentity.publicKey,
      protectedRef: boundRepo.targetBranch ?? 'refs/heads/main',
      relay: this.agentRelay,
    });
  }

  /** Test/CLI synchronization point; never exposes task credentials or prompt data. */
  async waitForAgentTasks(): Promise<void> {
    await Promise.all([...this.runningAgentTasks.values()]);
  }

  /**
   * Post a merge summary to the parent channel and mark subchannel as archived.
   * After calling this, polling for member messages stops and the subchannel
   * is considered read-only.
   */
  async postMergeSummary(subchannelId: string, summary: string): Promise<void> {
    const info = this.subchannels.get(subchannelId);
    if (!info) {
      throw new Error(`Subchannel ${subchannelId} not found`);
    }
    const parentId = info.session.parentChannelId;
    if (!parentId) {
      throw new Error(`Subchannel ${subchannelId} has no parent TLC`);
    }

    // Post summary to parent channel.
    await postControlMessage(
      parentId,
      this.agentIdentity,
      `🤖 Merge summary — ${subchannelId}\n\n${summary}`,
      [
        ['subchannel', subchannelId],
        ['t', 'merge-summary'],
      ],
    );

    // Mark subchannel as archived.
    info.archived = true;
    info.session.archived = true;
  }

  /**
   * Poll the subchannel for member messages (kind:9) and forward them as
   * session prompts to the ACP session. Only processes messages since the
   * last poll and from members other than the body identity.
   * Returns the number of new messages processed.
   */
  async pollMembers(subchannelId: string): Promise<number> {
    const info = this.subchannels.get(subchannelId);
    if (!info) {
      throw new Error(`Subchannel ${subchannelId} not found`);
    }

    // Archived subchannels are read-only — no more member message processing.
    if (info.archived) {
      return 0;
    }

    const session = info.session;
    const durableCursor = await this.durableState.cursor(subchannelId);
    const since = Math.max(info.lastPolledAt, durableCursor.createdAt);

    try {
      const events = await queryEventBacklog(
        {
          kinds: [9],
          '#h': [subchannelId],
          since,
        },
        { query: this.agentRelay.queryEvents },
      );

      let count = 0;
      let maxCreated = since;
      let retryFrom: number | undefined;

      await this.durableState.enqueue(subchannelId, events);
      const processed = info.processedMemberEventIds ?? new Set<string>();
      info.processedMemberEventIds = processed;
      const orderedEvents = await this.durableState.pending(subchannelId);

      for (const evt of orderedEvents) {
        maxCreated = Math.max(maxCreated, evt.created_at);
        if (processed.has(evt.id)) {
          await this.durableState.delivered(subchannelId, evt.id);
          continue;
        }
        // Skip events published by the agent itself (no self-steering).
        if (evt.pubkey === this.agentIdentity.publicKey) {
          await this.durableState.delivered(subchannelId, evt.id);
          continue;
        }
        // Skip events that are not plain text messages.
        if (!evt.content || evt.tags.some((t) => t[0] === 't' && t[1] === 'agent-activity')) {
          await this.durableState.delivered(subchannelId, evt.id);
          continue;
        }
        // Skip control messages.
        if (evt.tags.some((t) => t[0] === 't' && t[1] === 'body-control')) {
          await this.durableState.delivered(subchannelId, evt.id);
          continue;
        }

        if (evt.tags.some((t) => t[0] === 't' && t[1] === AGENT_CANCEL_TAG)) {
          session.client.sessionCancel(session.sessionId);
          processed.add(evt.id);
          await this.durableState.appendConversation(subchannelId, {
            role: 'control',
            text: 'Human cancelled the active turn.',
            eventId: evt.id,
            at: new Date().toISOString(),
          });
          await this.durableState.delivered(subchannelId, evt.id);
          count++;
          continue;
        }

        // Forward the member's message into the active run when possible. If
        // the original task ended between polling and delivery, wait for its
        // cleanup and preserve this message as the next ordered prompt.
        const prompt = `[Member ${evt.pubkey.slice(0, 12)}]: ${evt.content}`;
        try {
          let agentReply = '';
          const runningTask = this.runningAgentTasks.get(subchannelId);
          if (runningTask || session.client.activeRunId(session.sessionId)) {
            try {
              await session.client.sessionSteer(session.sessionId, prompt, 60_000);
            } catch (error) {
              if (!runningTask) throw error;
              await runningTask;
              const result = await this.runOnSession(session, () =>
                session.client.sessionPrompt(session.sessionId, prompt, 60_000),
              );
              agentReply = result.agentText.trim();
              info.mergeSummary = agentReply || info.mergeSummary;
              await this.publishMergeReady(info);
            }
          } else {
            const result = await this.runOnSession(session, () =>
              session.client.sessionPrompt(session.sessionId, prompt, 60_000),
            );
            agentReply = result.agentText.trim();
            info.mergeSummary = agentReply || info.mergeSummary;
            await this.publishMergeReady(info);
          }
          await this.durableState.appendConversation(subchannelId, {
            role: 'user',
            text: prompt,
            eventId: evt.id,
            at: new Date().toISOString(),
          });
          if (agentReply) {
            await this.durableState.appendConversation(subchannelId, {
              role: 'agent',
              text: agentReply,
              at: new Date().toISOString(),
            });
            await postAgentMessage(subchannelId, this.agentIdentity, agentReply);
          }
          processed.add(evt.id);
          await this.durableState.delivered(subchannelId, evt.id);
          count++;
        } catch (err) {
          retryFrom = Math.min(retryFrom ?? evt.created_at, evt.created_at);
          await this.durableState.failed(subchannelId, evt.id, err);
          console.error(`[body] pollMembers: forwarding failed for event ${evt.id}:`, err);
        }
      }

      // Advance the poll cursor.
      const nextCursor = retryFrom ?? maxCreated;
      if (nextCursor > info.lastPolledAt) {
        info.lastPolledAt = nextCursor;
        info.session.lastPolledAt = nextCursor;
      }

      return count;
    } catch (err) {
      console.error('[body] pollMembers: query failed:', err);
      return 0;
    }
  }

  /**
   * Archive a subchannel: cancel session, remove worktree, post archive message.
   * After archiving, the subchannel is read-only (no more member message processing).
   */
  async archiveSubchannel(subchannelId: string): Promise<void> {
    const info = this.subchannels.get(subchannelId);
    if (!info) {
      throw new Error(`Subchannel ${subchannelId} not found`);
    }

    // The map name is not authority. Confirm both the in-memory session and
    // the immutable kind:9007 parent link before any cleanup or metadata edit.
    // A top-level Room has no parent link and can never pass this gate.
    const relayParentChannelId = await getParentChannelId(
      this.agentClientContext(),
      subchannelId,
    );
    assertSubchannelArchiveTarget(info, relayParentChannelId);

    const { session, worktreePath, featureBranch, subchannelId: scId } = info;

    // Mark as archived before cleanup.
    info.archived = true;
    info.session.archived = true;

    // Cancel the ACP session.
    session.client.sessionCancel(session.sessionId);

    // Stop activity projection.
    if (session.unsubscribeActivity) {
      session.unsubscribeActivity();
    }

    // Stop the client.
    await session.client.stop();

    // Remove worktree.
    await this.removeWorktree(scId, worktreePath, featureBranch, info.boundRepo);

    // Post status messages BEFORE archiving (relay rejects events on archived channels).
    const parentId = session.parentChannelId;
    if (parentId) {
      await postControlMessage(
        parentId,
        this.agentIdentity,
        `📦 Edit session archived — subchannel=${subchannelId}`,
        [
          ['subchannel', subchannelId],
          ['status', 'archived'],
        ],
      );
    }

    // Post archive message to subchannel before archival (relay will reject it after).
    await postControlMessage(
      subchannelId,
      this.agentIdentity,
      `📦 Subchannel archived — session ended. This channel is now read-only.`,
      [['status', 'archived']],
    );

    // Mark subchannel as archived in relay metadata (kind:9002 → 39000 archived=true).
    // After this call, the relay rejects any further events on this channel.
    // New subchannels are agent-owned. `role` preserves compatibility for
    // externally registered historical sessions created by another owner.
    await archiveChannel(info.role, subchannelId);

    // Remove from active state.
    this.sessions.delete(subchannelId);
    this.subchannels.delete(subchannelId);
  }

  /** Ensure the agent is a member of the channel, returns current role. */
  private async ensureAgentInChannel(channelId: string, agent: Identity): Promise<string> {
    if (await isMember(this.agentClientContext(), channelId, agent.publicKey)) return 'member';
    // Try to get existing role
    try {
      const creates = await this.agentRelay.queryEvents([
        { kinds: [9007], '#h': [channelId], authors: [agent.publicKey], limit: 5 },
      ]);
      if (creates.length > 0) return 'owner';
    } catch {
      // Query may fail, continue to add member.
    }

    // Add as member if not already.
    await setMemberRole(this.bodyIdentity, channelId, agent.publicKey, 'member');
    return 'member';
  }

  private assertDistinctAgentIdentity(agent: Identity): void {
    if (agent.publicKey === this.bodyIdentity.publicKey) {
      throw new Error('agent identity must be distinct from the human/operator identity');
    }
  }

  private agentClientContext(): ChannelOpsContext {
    return {
      http: {
        baseUrl: this.config.relayBaseUrl,
        host: this.config.relayHost,
        identity: this.agentIdentity,
      },
      identity: this.agentIdentity,
    };
  }

  /** Resolve the parent channel's optional community linkage. */
  private async channelCommunityId(channelId: string): Promise<string | null> {
    const creates = await this.agentRelay.queryEvents([
      { kinds: [9007], '#h': [channelId], limit: 5 },
    ]);
    for (const event of creates) {
      const community = event.tags.find((tag) => tag[0] === 'community')?.[1];
      if (community) return community;
    }
    return null;
  }

  /**
   * Community-linked TLCs get a durable, self-signed agent record. Standalone
   * channels remain supported for backwards-compatible local/live tests.
   */
  private async ensureAgentEntity(tlcChannelId: string): Promise<void> {
    const communityId = await this.channelCommunityId(tlcChannelId);
    if (!communityId) return;

    const ctx = this.agentClientContext();
    const existing = await listAgents(ctx, communityId);
    if (existing.some((agent) => agent.pubkey === this.agentIdentity.publicKey)) return;
    await setMemberRole(this.bodyIdentity, communityId, this.agentIdentity.publicKey, 'member');
    await waitUntilMember(ctx, communityId, this.agentIdentity.publicKey);
    await createAgent(ctx, communityId, {
      displayName: this.agentIdentity.name || 'Agent',
    });
  }

  /** Mirror TLC membership/roles into the agent-owned subchannel. */
  private async mirrorMembers(sourceChannelId: string, targetChannelId: string): Promise<void> {
    try {
      // Current 39001/39002 projections are authoritative. Replaying kind:9000
      // history cannot order same-second member → admin transitions and could
      // silently demote the human reviewer inside the corner.
      const members = await listMembers(this.agentClientContext(), sourceChannelId);
      for (const member of members) {
        if (member.pubkey === this.agentIdentity.publicKey) continue;
        const role = member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
        await setMemberRole(this.agentIdentity, targetChannelId, member.pubkey, role);
      }
    } catch (err) {
      console.error('[body] mirrorMembers error:', err);
      // Non-fatal: subchannel still works with body + agent.
    }
  }

  /**
   * Create a git worktree from the bound repo.
   * Fetches from relay, creates a feature branch, and adds the worktree.
   */
  private async createWorktree(
    boundRepo: BoundRepo,
    worktreePath: string,
    featureBranch: string,
  ): Promise<void> {
    // Ensure workspace root exists.
    await mkdir(this.config.workspaceRoot, { recursive: true });

    if (boundRepo.localPath) {
      await mkdir(resolve(worktreePath, '..'), { recursive: true });
      if (boundRepo.remoteName) {
        const fetch = boundRepo.ownerHex
          ? gitAuthed(boundRepo.localPath, this.agentIdentity, boundRepo.ownerHex, boundRepo.repo, [
              'fetch',
              boundRepo.remoteName,
            ])
          : gitWithUserCredentials(boundRepo.localPath, ['fetch', boundRepo.remoteName]);
        if (!fetch.ok) throw new Error(`git fetch failed: ${fetch.stderr}`);
      }
      const target = (boundRepo.targetBranch ?? 'refs/heads/main').replace(/^refs\/heads\//, '');
      const remoteRef = boundRepo.remoteName
        ? `refs/remotes/${boundRepo.remoteName}/${target}`
        : '';
      const remoteBase = remoteRef
        ? git(boundRepo.localPath, ['rev-parse', '--verify', remoteRef])
        : { ok: false };
      const localRef = `refs/heads/${target}`;
      const localBase = git(boundRepo.localPath, ['rev-parse', '--verify', localRef]);
      const baseRef = remoteBase.ok ? remoteRef : localBase.ok ? localRef : 'HEAD';
      const worktreeAdd = git(boundRepo.localPath, [
        'worktree',
        'add',
        '-b',
        featureBranch,
        worktreePath,
        baseRef,
      ]);
      if (!worktreeAdd.ok) throw new Error(`git worktree add failed: ${worktreeAdd.stderr}`);
      git(worktreePath, ['config', 'user.name', this.agentIdentity.name || 'buzzy-agent']);
      git(worktreePath, ['config', 'user.email', 'agent@buzzy.local']);
      return;
    }

    if (!boundRepo.ownerHex) throw new Error('relay repo binding is missing its owner');

    const gitDir = resolve(this.config.workspaceRoot, `.git-${boundRepo.repo}`);
    const repoUrl = `${this.config.relayBaseUrl}/git/${boundRepo.ownerHex}/${boundRepo.repo}`;

    // Clone repo as bare if not already present.
    if (!existsSync(gitDir)) {
      const clone = gitAuthed(
        this.config.workspaceRoot,
        this.agentIdentity,
        boundRepo.ownerHex,
        boundRepo.repo,
        ['clone', '--bare', repoUrl, gitDir],
      );
      if (!clone.ok && clone.stderr && !clone.stderr.includes('already exists')) {
        throw new Error(`git clone --bare failed: ${clone.stderr}`);
      }
    }

    // Fetch latest.
    const fetch = gitAuthed(gitDir, this.agentIdentity, boundRepo.ownerHex, boundRepo.repo, [
      'fetch',
      'origin',
    ]);
    if (!fetch.ok) throw new Error(`git fetch failed: ${fetch.stderr}`);

    // A bare clone stores the default branch at refs/heads/main; an existing
    // mirror may instead have refs/remotes/origin/main after fetch.
    const remoteMain = git(gitDir, ['rev-parse', '--verify', 'refs/remotes/origin/main']);
    const localMain = git(gitDir, ['rev-parse', '--verify', 'refs/heads/main']);
    const baseRef = remoteMain.ok
      ? 'refs/remotes/origin/main'
      : localMain.ok
        ? 'refs/heads/main'
        : '';
    if (!baseRef) throw new Error('bound repo has no main branch');

    // Create worktree with new branch.
    const worktreeAdd = spawnSync(
      'git',
      ['worktree', 'add', '-b', featureBranch, worktreePath, baseRef],
      {
        cwd: gitDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      },
    );

    if (worktreeAdd.status !== 0) {
      throw new Error(`git worktree add failed: ${worktreeAdd.stderr}`);
    }

    // The edit agent commits locally; the body authenticates and pushes the
    // resulting feature tip under the agent identity after the turn completes.
    spawnSync('git', ['config', 'user.name', this.agentIdentity.name || 'buzzy-agent'], {
      cwd: worktreePath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    });
    spawnSync('git', ['config', 'user.email', 'agent@buzzy.local'], {
      cwd: worktreePath,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    });
  }

  /** Remove a git worktree and clean up. */
  private async removeWorktree(
    subchannelId: string,
    worktreePath: string,
    _featureBranch: string,
    boundRepo?: BoundRepo,
  ): Promise<void> {
    const gitDir = worktreePath.includes('.worktrees')
      ? resolve(this.config.workspaceRoot, `.git-${subchannelId.slice(0, 12)}`)
      : undefined;

    // Try to prune worktree.
    if (existsSync(worktreePath)) {
      spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: boundRepo?.localPath ?? this.config.workspaceRoot,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
      });
    }

    // Remove worktree directory if it still exists.
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    if (gitDir && existsSync(gitDir)) {
      try {
        await rm(gitDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private repoId(boundRepo: BoundRepo): string {
    return boundRepo.ownerHex
      ? `${boundRepo.ownerHex}/${boundRepo.repo}`
      : `${boundRepo.localOnly ? 'local' : 'remote'}/${boundRepo.repositoryKey ?? boundRepo.repo}`;
  }

  private async requestAlreadyOpened(channelId: string, requestId: string): Promise<boolean> {
    const events = await this.agentRelay.queryEvents([
      {
        kinds: [9],
        '#h': [channelId],
        '#request': [requestId],
        authors: [this.agentIdentity.publicKey],
        limit: 5,
      },
    ]);
    return events.some((event) =>
      event.tags.some((tag) => tag[0] === 'request' && tag[1] === requestId),
    );
  }

  private async waitForPoll(pollMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, pollMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolveWait();
        },
        { once: true },
      );
    });
  }

  /** Dispose all sessions. */
  async dispose(): Promise<void> {
    await this.waitForAgentTasks();
    for (const [, session] of this.sessions) {
      if (session.unsubscribeActivity) session.unsubscribeActivity();
      if (this.ownsScheduler) continue;
      await this.scheduler.suspend(session.channelId);
    }
    if (this.ownsScheduler) await this.scheduler.dispose();
    this.sessions.clear();
    this.subchannels.clear();
  }

  /** Get the sessions map (for testing introspection). */
  getSessions(): Map<string, AgentSession> {
    return this.sessions;
  }

  /** Get the subchannels map (for testing introspection). */
  getSubchannels(): Map<string, SubchannelInfo> {
    return this.subchannels;
  }
}
