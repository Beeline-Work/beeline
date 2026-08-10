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
import { AcpClient, type McpServerWire } from './acp.js';
import { projectActivity, postControlMessage } from './activity.js';
import {
  createChannel,
  setMemberRole,
  newIdentity,
  publishEvent,
  queryEvents,
  archiveChannel,
  checkAgentNotPushAllowed,
  git,
  gitAuthed,
  lsRemoteRef,
  isRegisteredAgentIdentity,
  type Identity,
} from '@beeline/gate';
import {
  createAgent,
  isMember,
  listAgents,
  waitUntilMember,
  type ChannelOpsContext,
} from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import type { BodyConfig } from './config.js';

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

export const AGENT_REQUEST_TAG = 'buzz-agent-request';
export const MERGE_READY_TAG = 'merge-ready';

/** The intentionally narrow channel → edit-session trigger. */
export function isChannelTaskRequest(event: NostrEvent, agentPubkey: string): boolean {
  return Boolean(
    event.kind === 9 &&
    event.content.trim() &&
    event.pubkey !== agentPubkey &&
    event.tags.some((tag) => tag[0] === 'p' && tag[1] === agentPubkey) &&
    event.tags.some((tag) => tag[0] === 't' && tag[1] === AGENT_REQUEST_TAG),
  );
}

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
  private processedRequestIds = new Set<string>();
  private requestCursors = new Map<string, number>();
  private runningAgentTasks = new Map<string, Promise<void>>();

  constructor(config: BodyConfig, bodyIdentity?: Identity, agentIdentity?: Identity) {
    this.config = config;
    this.bodyIdentity = bodyIdentity ?? newIdentity('buzzy-body');
    this.agentIdentity = agentIdentity ?? newIdentity('buzzy-agent');
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
  }

  /** Lookup a session by channel ID. */
  getSession(channelId: string): AgentSession | undefined {
    return this.sessions.get(channelId);
  }

  /** List all active sessions. */
  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
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

    const client = new AcpClient({
      agentBinary: this.config.agentBinary,
      agentEnv: this.config.agentEnv,
      autoApprovePermissions: this.config.autoApprovePermissions,
    });

    await client.start();

    // Read-only session: NO mcpServers — the boundary IS the MCP mount.
    const { sessionId } = await client.sessionNew({
      cwd: boundRepo?.localPath ?? this.config.workspaceRoot,
      mcpServers: [],
      systemPrompt: [
        'You are a helpful coding assistant in a read-only conversation channel.',
        'You can answer questions, discuss architecture, and help plan work.',
        'You CANNOT create, edit, or delete files in this channel.',
        'You do not have shell access or file edit tools.',
        'When the user asks you to write code, explain that you need an edit session.',
      ].join('\n'),
    });

    // Project activity to the TLC channel.
    const unsub = projectActivity(client, tlcChannelId, agentId, sessionId);

    const session: AgentSession = {
      channelId: tlcChannelId,
      sessionId,
      client,
      mode: 'readonly',
      unsubscribeActivity: unsub,
    };

    this.sessions.set(tlcChannelId, session);

    await postControlMessage(
      tlcChannelId,
      agentId,
      `🤖 Agent session started (read-only) — session=${sessionId}`,
      [
        ['session', sessionId],
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
      `sub-${tlcChannelId.slice(0, 8)}`,
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

    const client = new AcpClient({
      agentBinary: this.config.agentBinary,
      agentEnv: this.config.agentEnv,
      autoApprovePermissions: this.config.autoApprovePermissions,
    });

    await client.start();

    const { sessionId } = await client.sessionNew({
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
    });

    // 6. Project activity to the subchannel.
    const unsub = projectActivity(client, subchannelId, agentId, sessionId);

    const now = Math.floor(Date.now() / 1000);
    const session: AgentSession = {
      channelId: subchannelId,
      sessionId,
      client,
      mode: 'edit',
      worktreePath,
      featureBranch,
      parentChannelId: tlcChannelId,
      unsubscribeActivity: unsub,
      lastPolledAt: now,
      archived: false,
    };

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

    // 7. Post link message to TLC with repo and tip.
    await postControlMessage(
      tlcChannelId,
      agentId,
      `Agent opened a work branch for: ${intent?.trim() || 'channel request'}`,
      [
        ['subchannel', subchannelId],
        ['session', sessionId],
        ['agent', agentId.publicKey],
        ['feature', featureBranch],
        ['branch', targetBranch],
        ['mode', 'edit'],
        ['status', 'open'],
        ['repo', repoId],
        ...requestTags,
      ],
    );

    // 8. Post intro to subchannel with merge target metadata.
    await postControlMessage(
      subchannelId,
      agentId,
      `🤖 Agent edit session started — members mirrored from parent TLC.\nWorktree: ${worktreePath}\nBranch: ${featureBranch}`,
      [
        ['session', sessionId],
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

    return info;
  }

  /**
   * Poll a human-created channel for explicit messages addressed to this agent.
   * Every accepted request opens exactly one agent-owned subchannel. Agent-authored
   * requests are rejected, preserving the human → agent direction of the loop.
   */
  async pollChannelRequests(tlcChannelId: string, boundRepo: BoundRepo): Promise<number> {
    const since = this.requestCursors.get(tlcChannelId) ?? 0;
    const events = await queryEvents(
      [
        {
          kinds: [9],
          '#h': [tlcChannelId],
          '#p': [this.agentIdentity.publicKey],
          since,
          limit: 100,
        },
      ],
      this.agentIdentity.publicKey,
    );
    let opened = 0;
    let maxCreatedAt = since;

    for (const event of [...events].sort((a, b) => a.created_at - b.created_at)) {
      maxCreatedAt = Math.max(maxCreatedAt, event.created_at);
      if (this.processedRequestIds.has(event.id)) continue;
      if (!isChannelTaskRequest(event, this.agentIdentity.publicKey)) continue;
      if (await this.requestAlreadyOpened(tlcChannelId, event.id)) {
        this.processedRequestIds.add(event.id);
        continue;
      }
      this.processedRequestIds.add(event.id);

      // Fail closed: a registered agent can never task another body through the
      // human request affordance, regardless of any channel role it holds.
      if (await isRegisteredAgentIdentity(event.pubkey, this.agentIdentity.publicKey)) {
        await postControlMessage(
          tlcChannelId,
          this.agentIdentity,
          'Agent-authored work request refused. Ask a human channel member to start work.',
          [
            ['request', event.id],
            ['status', 'refused'],
          ],
        );
        continue;
      }

      const request: ChannelTaskRequest = {
        eventId: event.id,
        authorPubkey: event.pubkey,
        content: event.content.trim(),
        createdAt: event.created_at,
      };
      const info = await this.openSubchannel(tlcChannelId, boundRepo, request.content, request);
      this.startAgentTask(info, request.content);
      opened++;
    }

    this.requestCursors.set(tlcChannelId, maxCreatedAt);
    return opened;
  }

  /** Start the requested work without blocking discovery/UI updates. */
  private startAgentTask(info: SubchannelInfo, prompt: string): void {
    const task = (async () => {
      try {
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
        info.mergeSummary = result.agentText.trim() || `Completed: ${prompt}`;
        await this.publishMergeReady(info);
      } catch (error) {
        await postControlMessage(
          info.subchannelId,
          this.agentIdentity,
          `Agent task stopped before merge-ready: ${String(error)}`,
          [['status', 'failed']],
        ).catch(() => undefined);
      } finally {
        this.runningAgentTasks.delete(info.subchannelId);
      }
    })();
    this.runningAgentTasks.set(info.subchannelId, task);
  }

  /** Push the agent's feature tip and publish the exact human-approval target. */
  private async publishMergeReady(info: SubchannelInfo): Promise<boolean> {
    const boundRepo = info.boundRepo;
    if (!boundRepo || info.archived) return false;
    const tip = git(info.worktreePath, ['rev-parse', 'HEAD']).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(tip)) return false;

    const push = boundRepo.ownerHex
      ? gitAuthed(info.worktreePath, this.agentIdentity, boundRepo.ownerHex, boundRepo.repo, [
          'push',
          boundRepo.remoteName ?? 'origin',
          `${info.featureBranch}:refs/heads/${info.featureBranch}`,
        ])
      : boundRepo.remoteName
        ? git(info.worktreePath, [
            'push',
            boundRepo.remoteName,
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
      return false;
    }

    const target = {
      repo: this.repoId(boundRepo),
      branch: boundRepo.targetBranch ?? 'refs/heads/main',
      tip,
    };
    if (info.mergeTarget?.tip === tip) return true;
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
    return true;
  }

  /** Archive only after the protected target ref actually reaches the approved tip. */
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
    await this.provision(tlcChannelId, boundRepo);
    const pollMs = opts.pollMs ?? 1_000;
    while (!opts.signal?.aborted) {
      await this.pollChannelRequests(tlcChannelId, boundRepo);
      for (const subchannelId of [...this.subchannels.keys()]) {
        if (!this.runningAgentTasks.has(subchannelId)) await this.pollMembers(subchannelId);
      }
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
    if (boundRepo.ownerHex) {
      const protection = await checkAgentNotPushAllowed({
        ownerHex: boundRepo.ownerHex,
        repo: boundRepo.repo,
        agentPubkey: this.agentIdentity.publicKey,
        protectedRef: boundRepo.targetBranch ?? 'refs/heads/main',
      });
      if (!protection.ok) throw new Error(`unsafe repository provisioning: ${protection.reason}`);
    }

    const pollMs = opts.pollMs ?? 3_000;
    while (
      !opts.signal?.aborted &&
      !(await isMember(this.agentClientContext(), channelId, this.agentIdentity.publicKey))
    ) {
      await setMemberRole(this.agentIdentity, channelId, this.agentIdentity.publicKey, 'member');
      await this.waitForPoll(pollMs, opts.signal);
    }
    if (opts.signal?.aborted) return;
    await this.provision(channelId, boundRepo);

    while (!opts.signal?.aborted) {
      try {
        await this.pollChannelRequests(channelId, boundRepo);
      } catch (error) {
        console.error('[body] repository Room request poll failed:', error);
      }
      for (const subchannelId of [...this.subchannels.keys()]) {
        if (!this.runningAgentTasks.has(subchannelId)) await this.pollMembers(subchannelId);
      }
      await this.pollMergeCompletions();
      await this.waitForPoll(pollMs, opts.signal);
    }
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
    const since = info.lastPolledAt;

    try {
      const events = await queryEvents(
        [
          {
            kinds: [9],
            '#h': [subchannelId],
            since,
            limit: 100,
          },
        ],
        this.agentIdentity.publicKey,
      );

      let count = 0;
      let maxCreated = since;

      for (const evt of events) {
        // Skip events published by the agent itself (no self-steering).
        if (evt.pubkey === this.agentIdentity.publicKey) continue;
        // Skip events that are not plain text messages.
        if (!evt.content || evt.tags.some((t) => t[0] === 't' && t[1] === 'agent-activity'))
          continue;
        // Skip control messages.
        if (evt.tags.some((t) => t[0] === 't' && t[1] === 'body-control')) continue;

        if (evt.created_at > maxCreated) {
          maxCreated = evt.created_at;
        }

        // Forward the member's message as a session prompt.
        const prompt = `[Member ${evt.pubkey.slice(0, 12)}]: ${evt.content}`;
        try {
          const result = await session.client.sessionPrompt(session.sessionId, prompt, 60_000);
          info.mergeSummary = result.agentText.trim() || info.mergeSummary;
          await this.publishMergeReady(info);
          count++;
        } catch (err) {
          console.error(`[body] pollMembers: sessionPrompt failed for event ${evt.id}:`, err);
        }
      }

      // Advance the poll cursor.
      if (maxCreated > info.lastPolledAt) {
        info.lastPolledAt = maxCreated;
        info.session.lastPolledAt = maxCreated;
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
      const creates = await queryEvents(
        [{ kinds: [9007], '#h': [channelId], authors: [agent.publicKey], limit: 5 }],
        this.bodyIdentity.publicKey,
      );
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
      },
      identity: this.agentIdentity,
    };
  }

  /** Resolve the parent channel's optional community linkage. */
  private async channelCommunityId(channelId: string): Promise<string | null> {
    const creates = await queryEvents(
      [{ kinds: [9007], '#h': [channelId], limit: 5 }],
      this.agentIdentity.publicKey,
    );
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
      const [creates, memberEvents] = await Promise.all([
        queryEvents(
          [{ kinds: [9007], '#h': [sourceChannelId], limit: 5 }],
          this.agentIdentity.publicKey,
        ),
        queryEvents(
          [
            {
              kinds: [9000],
              '#h': [sourceChannelId],
              limit: 100,
            },
          ],
          this.agentIdentity.publicKey,
        ),
      ]);

      const roles = new Map<string, 'owner' | 'admin' | 'member'>();
      const creator = creates.sort((a, b) => a.created_at - b.created_at)[0]?.pubkey;
      if (creator) roles.set(creator, 'owner');
      for (const evt of [...memberEvents].sort((a, b) => b.created_at - a.created_at)) {
        const pTag = evt.tags.find((t: string[]) => t[0] === 'p');
        if (!pTag?.[1]) continue;
        const pubkey = pTag[1];
        if (pubkey === this.agentIdentity.publicKey || roles.has(pubkey)) continue;

        const roleTag = evt.tags.find((t: string[]) => t[0] === 'role');
        const role = (roleTag?.[1] as 'owner' | 'admin' | 'member') ?? 'member';
        roles.set(pubkey, role);
      }
      for (const [pubkey, role] of roles) {
        if (pubkey === this.agentIdentity.publicKey) continue;
        await setMemberRole(this.agentIdentity, targetChannelId, pubkey, role);
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
          : git(boundRepo.localPath, ['fetch', boundRepo.remoteName]);
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
    const events = await queryEvents(
      [
        {
          kinds: [9],
          '#h': [channelId],
          '#request': [requestId],
          authors: [this.agentIdentity.publicKey],
          limit: 5,
        },
      ],
      this.agentIdentity.publicKey,
    );
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
    for (const [, session] of this.sessions) {
      if (session.unsubscribeActivity) session.unsubscribeActivity();
      await session.client.stop();
    }
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
