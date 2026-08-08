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
  checkAgentNotPushAllowed,
  type Identity,
} from '@buzzy/gate';
import { signEvent, type NostrEvent } from '@buzzy/nostr';
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
}

export interface SubchannelInfo {
  subchannelId: string;
  worktreePath: string;
  featureBranch: string;
  role: Identity;
  session: AgentSession;
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
  private agentIdentity: Identity | null = null;

  constructor(config: BodyConfig, bodyIdentity?: Identity) {
    this.config = config;
    this.bodyIdentity =
      bodyIdentity ??
      newIdentity('buzzy-body');
  }

  get identity(): Identity {
    return this.bodyIdentity;
  }

  /** Register (or override) the agent's Nostr identity. */
  setAgentIdentity(id: Identity): void {
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
  async provision(tlcChannelId: string): Promise<AgentSession> {
    const existing = this.sessions.get(tlcChannelId);
    if (existing) {
      if (existing.mode === 'readonly') return existing;
      // If there's a read-only session, we're good. If the existing is edit,
      // we need a separate read-only session — but for now return it since
      // edit implies read-only capabilities too.
      return existing;
    }

    // Determine agent identity. For testing, use body identity if no agent set.
    const agentId = this.agentIdentity ?? this.bodyIdentity;
    const agentRole = await this.ensureAgentInChannel(tlcChannelId, agentId);

    const client = new AcpClient({
      agentBinary: this.config.agentBinary,
      agentEnv: this.config.agentEnv,
      autoApprovePermissions: this.config.autoApprovePermissions,
    });

    await client.start();

    // Read-only session: NO mcpServers — the boundary IS the MCP mount.
    const { sessionId } = await client.sessionNew({
      cwd: this.config.workspaceRoot,
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
    const unsub = projectActivity(client, tlcChannelId, this.bodyIdentity, sessionId);

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
      this.bodyIdentity,
      `🤖 Agent session started (read-only) — session=${sessionId}`,
      [['session', sessionId], ['mode', 'readonly']],
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
    boundRepo: { ownerHex: string; repo: string },
    intent?: string,
  ): Promise<SubchannelInfo> {
    const agentId = this.agentIdentity ?? this.bodyIdentity;

    // 1. Create child channel.
    const subchannelId = await createChannel(this.bodyIdentity, `sub-${tlcChannelId.slice(0, 8)}`);

    // 2. Mirror parent members: query members of TLC, add each as member of subchannel.
    await this.mirrorMembers(tlcChannelId, subchannelId);

    // 3. Ensure agent is a member of the subchannel.
    if (agentId.publicKey !== this.bodyIdentity.publicKey) {
      await setMemberRole(this.bodyIdentity, subchannelId, agentId.publicKey, 'member');
    }

    // 4. Create git worktree + feature branch.
    const worktreePath = resolve(
      this.config.workspaceRoot,
      `.worktrees/${subchannelId}`,
    );
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
    const unsub = projectActivity(client, subchannelId, this.bodyIdentity, sessionId);

    const session: AgentSession = {
      channelId: subchannelId,
      sessionId,
      client,
      mode: 'edit',
      worktreePath,
      featureBranch,
      parentChannelId: tlcChannelId,
      unsubscribeActivity: unsub,
    };

    this.sessions.set(subchannelId, session);

    const info: SubchannelInfo = {
      subchannelId,
      worktreePath,
      featureBranch,
      role: this.bodyIdentity,
      session,
    };

    this.subchannels.set(subchannelId, info);

    // 7. Post link message to TLC.
    await postControlMessage(
      tlcChannelId,
      this.bodyIdentity,
      `🛠 Edit session opened — subchannel=${subchannelId} worktree=${worktreePath} branch=${featureBranch}`,
      [
        ['subchannel', subchannelId],
        ['session', sessionId],
        ['branch', featureBranch],
        ['mode', 'edit'],
      ],
    );

    // 8. Post intro to subchannel.
    await postControlMessage(
      subchannelId,
      this.bodyIdentity,
      `🤖 Agent edit session started — members mirrored from parent TLC.\nWorktree: ${worktreePath}\nBranch: ${featureBranch}`,
      [
        ['session', sessionId],
        ['parent', tlcChannelId],
        ['mode', 'edit'],
      ],
    );

    return info;
  }

  /**
   * Archive a subchannel: cancel session, remove worktree, post archive message.
   */
  async archiveSubchannel(subchannelId: string): Promise<void> {
    const info = this.subchannels.get(subchannelId);
    if (!info) {
      throw new Error(`Subchannel ${subchannelId} not found`);
    }

    const { session, worktreePath, featureBranch, subchannelId: scId } = info;

    // Cancel the ACP session.
    session.client.sessionCancel(session.sessionId);

    // Stop activity projection.
    if (session.unsubscribeActivity) {
      session.unsubscribeActivity();
    }

    // Stop the client.
    await session.client.stop();

    // Remove worktree.
    await this.removeWorktree(scId, worktreePath, featureBranch);

    // Post archive message.
    const parentId = session.parentChannelId;
    if (parentId) {
      await postControlMessage(
        parentId,
        this.bodyIdentity,
        `📦 Edit session archived — subchannel=${subchannelId}`,
        [['subchannel', subchannelId], ['status', 'archived']],
      );
    }

    // Remove from state.
    this.sessions.delete(subchannelId);
    this.subchannels.delete(subchannelId);
  }

  /** Ensure the agent is a member of the channel, returns current role. */
  private async ensureAgentInChannel(
    channelId: string,
    agent: Identity,
  ): Promise<string> {
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

  /** Mirror TLC members into the subchannel. */
  private async mirrorMembers(
    sourceChannelId: string,
    targetChannelId: string,
  ): Promise<void> {
    try {
      const memberEvents = await queryEvents(
        [
          {
            kinds: [9000],
            '#h': [sourceChannelId],
            limit: 100,
          },
        ],
        this.bodyIdentity.publicKey,
      );

      const seen = new Set<string>();
      for (const evt of memberEvents) {
        const pTag = evt.tags.find((t: string[]) => t[0] === 'p');
        if (!pTag?.[1]) continue;
        const pubkey = pTag[1];
        if (seen.has(pubkey)) continue;
        seen.add(pubkey);

        const roleTag = evt.tags.find((t: string[]) => t[0] === 'role');
        const role = (roleTag?.[1] as 'owner' | 'admin' | 'member') ?? 'member';

        await setMemberRole(this.bodyIdentity, targetChannelId, pubkey, role);
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
    boundRepo: { ownerHex: string; repo: string },
    worktreePath: string,
    featureBranch: string,
  ): Promise<void> {
    // Ensure workspace root exists.
    await mkdir(this.config.workspaceRoot, { recursive: true });

    const gitDir = resolve(this.config.workspaceRoot, `.git-${boundRepo.repo}`);
    const repoUrl = `${this.config.relayBaseUrl}/git/${boundRepo.ownerHex}/${boundRepo.repo}`;

    // Clone repo as bare if not already present.
    if (!existsSync(gitDir)) {
      const clone = spawnSync('git', ['clone', '--bare', repoUrl, gitDir], {
        cwd: this.config.workspaceRoot,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      });
      if (clone.status !== 0 && clone.stderr && !clone.stderr.includes('already exists')) {
        throw new Error(`git clone --bare failed: ${clone.stderr}`);
      }
    }

    // Fetch latest.
    spawnSync('git', ['fetch', 'origin'], {
      cwd: gitDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    });

    // Create worktree with new branch.
    const worktreeAdd = spawnSync(
      'git',
      ['worktree', 'add', '-b', featureBranch, worktreePath, 'origin/main'],
      {
        cwd: gitDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      },
    );

    if (worktreeAdd.status !== 0) {
      throw new Error(`git worktree add failed: ${worktreeAdd.stderr}`);
    }
  }

  /** Remove a git worktree and clean up. */
  private async removeWorktree(
    subchannelId: string,
    worktreePath: string,
    _featureBranch: string,
  ): Promise<void> {
    const gitDir = worktreePath.includes('.worktrees')
      ? resolve(this.config.workspaceRoot, `.git-${subchannelId.slice(0, 12)}`)
      : undefined;

    // Try to prune worktree.
    if (existsSync(worktreePath)) {
      spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: this.config.workspaceRoot,
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

  /** Dispose all sessions. */
  async dispose(): Promise<void> {
    for (const [channelId] of this.sessions) {
      const session = this.sessions.get(channelId)!;
      if (session.unsubscribeActivity) session.unsubscribeActivity();
      await session.client.stop();
    }
    this.sessions.clear();
    this.subchannels.clear();
  }
}