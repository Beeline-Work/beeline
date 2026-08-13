/**
 * BuzzRigTransport — real-Buzz implementation of RigTransport.
 *
 * Speaks only to the Buzz relay via @beeline/buzz-client. No Happy server calls.
 *
 * **P1 coverage:** identity, sessionsRead, sessionRead, sessionEventsBackfill,
 * sessionEventsSubscribe, messageSubmit. Everything else is a loud stub
 * (RigTransportNotImplementedError) — see BUZZ-SEAM.md rank-2/3 methods.
 *
 * Tradeoff note for the next lane: the session model is channel-scoped
 * (a "session" = a TLC or subchannel), not a single-user Happy session.
 * The UI mapping is 1:1 in the first slice but will diverge when worktrees
 * and agent-run state arrive.
 */
import type {
  ChangedFile,
  ChannelId,
  MergeActionInput,
  MessageSubmitInput,
  PermissionDecision,
  RigTransport,
  SessionDetail,
  SessionEvent,
  SessionId,
  SessionSummary,
  WorktreeCreateInput,
} from './rig-transport';
import { RigTransportNotImplementedError, RigTransportStubbedError } from './rig-transport';
import {
  createBuzzClient,
  buildAttachmentTags,
  tagValue,
  classifySessionEvent,
  CHANGE_REVIEW_EVENT_KIND,
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_MANIFEST_TAG,
  parseChangeReviewManifest,
  type BuzzClient,
  type Identity,
  type MergeTarget,
  type WritePermissionDecision,
  type AttachmentReference,
} from '@beeline/buzz-client';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { cornerName, type CornerSummary } from '@/buzz/corners';
import { toRigEvent } from './buzz-event-projection';

let sharedClientEntry: { key: string; client: BuzzClient } | undefined;

function sharedClient(identity: Identity, baseUrl: string): BuzzClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const key = `${normalizedBaseUrl}\u0000${identity.publicKey}`;
  if (sharedClientEntry?.key === key) return sharedClientEntry.client;
  sharedClientEntry?.client.disconnect();
  const client = createBuzzClient({
    baseUrl: normalizedBaseUrl,
    identity,
    batchQueries: true,
  });
  sharedClientEntry = { key, client };
  return client;
}

export class BuzzRigTransport implements RigTransport {
  private client: BuzzClient | null = null;
  private identity: Identity;
  private baseUrl: string;
  /** Track open subscriptions for cleanup. */
  private subscriptions = new Map<SessionId, () => void>();

  constructor(identity: Identity, baseUrl: string = getBuzzRuntimeConfig().relayUrl) {
    this.identity = identity;
    this.baseUrl = baseUrl;
  }

  // ── Client lazy-init ──────────────────────────────────────────────────

  private async getClient(): Promise<BuzzClient> {
    if (!this.client) {
      // Screen bootstrap reads use the authenticated HTTP bridge. The client
      // connects its WebSocket lazily when the first live subscription starts,
      // so navigation never waits on an unrelated socket handshake. Clients are
      // shared by relay + identity so a later Room reuses the authenticated WS.
      this.client = sharedClient(this.identity, this.baseUrl);
    }
    return this.client;
  }

  /** Expose the underlying client for direct buzz-client calls when needed. */
  async ensureClient(): Promise<BuzzClient> {
    return this.getClient();
  }

  // ── Sessions (P1: channels as sessions) ────────────────────────────────

  async sessionCreate(_input: WorktreeCreateInput & { prompt?: string }): Promise<SessionDetail> {
    throw new RigTransportNotImplementedError(
      'sessionCreate',
      'P2: requires body with ACP session/new + worktree create + subchannel',
    );
  }

  async sessionsRead(_scope?: { channelId?: ChannelId }): Promise<SessionSummary[]> {
    const client = await this.getClient();
    const channels = await client.listMyChannels();
    return Promise.all(
      channels.map(async (c) => {
        const metadata = await client.getChannelMetadata(c.channelId);
        const nameTag = c.event.tags.find((t) => t[0] === 'name');
        return {
          id: c.channelId,
          active: true,
          title: metadata?.name ?? nameTag?.[1] ?? c.channelId.slice(0, 8),
          updatedAt: c.event.created_at,
          createdAt: c.event.created_at,
        };
      }),
    );
  }

  async sessionRead(sessionId: SessionId): Promise<SessionDetail | null> {
    const client = await this.getClient();
    const meta = await client.getChannelMetadata(sessionId);
    if (!meta) {
      // Channel exists but metadata not materialised yet — return a skeleton.
      return { id: sessionId, active: true };
    }
    return {
      id: meta.channelId,
      channelId: meta.parentChannelId,
      active: !meta.archived,
      title: meta.name,
    };
  }

  async sessionArchive(_sessionId: SessionId): Promise<{ success: boolean; message?: string }> {
    throw new RigTransportNotImplementedError(
      'sessionArchive',
      'P2: needs channel.archive or metadata set archived+closed',
    );
  }

  // ── Messaging (P1) ─────────────────────────────────────────────────────

  async messageSubmit(input: MessageSubmitInput): Promise<void> {
    await this.messageSubmitWithEventId(input);
  }

  /** Submit a message and return the signed event id for optimistic UI reconciliation. */
  async messageSubmitWithEventId(input: MessageSubmitInput): Promise<string> {
    const client = await this.getClient();
    const attachmentTags = buildAttachmentTags(input.attachments ?? []);
    const event = await client.messageSubmit(
      input.sessionId,
      input.text,
      attachmentTags.length ? { extraTags: attachmentTags } : undefined,
    );
    return event.id;
  }

  /** Send an ordinary Room message addressed to one @-mentioned agent. */
  async messageSubmitMentioningAgent(
    channelId: string,
    text: string,
    agentPubkey: string,
    attachments: AttachmentReference[] = [],
  ): Promise<string> {
    const client = await this.getClient();
    const attachmentTags = buildAttachmentTags(attachments);
    const event = await client.messageSubmit(channelId, text, {
      mentionAgent: agentPubkey,
      ...(attachmentTags.length ? { extraTags: attachmentTags } : {}),
    });
    return event.id;
  }

  /** Respond to the agent's first mutating-tool request in a Room. */
  async respondToWritePermission(
    channelId: string,
    permissionId: string,
    requestId: string,
    agentPubkey: string,
    decision: WritePermissionDecision,
  ): Promise<string> {
    const client = await this.getClient();
    const event = await client.respondToWritePermission(
      channelId,
      permissionId,
      requestId,
      agentPubkey,
      decision,
    );
    return event.id;
  }

  /** Invite one already-linked Workspace agent to this Room; no pairing/restart. */
  async inviteAgentToChannel(
    channelId: string,
    agentPubkey: string,
    communityId: string,
  ): Promise<boolean> {
    const client = await this.getClient();
    const result = await client.attachAgentToChannel(channelId, agentPubkey, communityId);
    return result.joined;
  }

  /** Add one existing Workspace person to this Room as a normal member. */
  async inviteWorkspaceMemberToChannel(
    channelId: string,
    memberPubkey: string,
    communityId: string,
  ): Promise<boolean> {
    const client = await this.getClient();
    const result = await client.attachCommunityMemberToChannel(
      channelId,
      memberPubkey,
      communityId,
    );
    return result.joined;
  }

  /** Create or reopen the unique private Room for two Workspace members. */
  async resolveDirectMessage(
    communityId: string,
    otherPubkey: string,
  ): Promise<{ channelId: string; created: boolean }> {
    const client = await this.getClient();
    const result = await client.resolveDirectMessage(communityId, otherPubkey);
    return { channelId: result.directMessage.channelId, created: result.created };
  }

  async runAbort(sessionId: SessionId): Promise<void> {
    const client = await this.getClient();
    await client.messageSubmit(sessionId, 'Cancel the active Agent turn.', {
      extraTags: [['t', 'buzz-agent-cancel']],
    });
  }

  // ── Realtime + permissions (P1: subscribe + backfill) ──────────────────

  sessionEventsSubscribe(sessionId: SessionId, handler: (event: SessionEvent) => void): () => void {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    this.getClient()
      .then((client) => {
        if (cancelled) return;
        client
          .sessionEventsSubscribe(sessionId, (bev) => {
            handler(toRigEvent(bev));
          })
          .then((u) => {
            if (cancelled) {
              u();
              return;
            }
            unsub = u;
            this.subscriptions.set(sessionId, u);
          });
      })
      .catch((err) => {
        console.warn(`BuzzRigTransport: sessionEventsSubscribe(${sessionId}) failed:`, err);
      });

    const unsubscribe = () => {
      cancelled = true;
      if (unsub) {
        unsub();
        this.subscriptions.delete(sessionId);
      }
    };
    this.subscriptions.set(sessionId, unsubscribe);
    return unsubscribe;
  }

  async sessionEventsBackfill(
    sessionId: SessionId,
    opts?: { beforeSeq?: number; afterSeq?: number; limit?: number },
  ): Promise<SessionEvent[]> {
    const client = await this.getClient();
    const buzzEvents = await client.sessionEventsBackfill(sessionId, {
      limit: opts?.limit,
      until: opts?.beforeSeq,
      since: opts?.afterSeq,
    });
    return buzzEvents.map(toRigEvent);
  }

  async permissionRespond(
    _sessionId: SessionId,
    _requestId: string,
    _decision: PermissionDecision,
    _extras?: {
      mode?: string;
      allowedTools?: string[];
      updatedInput?: Record<string, unknown>;
    },
  ): Promise<void> {
    throw new RigTransportNotImplementedError(
      'permissionRespond',
      'P2: body-mediated; stock buzz-acp auto-approves today',
    );
  }

  // ── Worktrees (P2) ─────────────────────────────────────────────────────

  async worktreeCreate(
    _input: WorktreeCreateInput,
  ): Promise<{ worktreeId: string; path: string; branch?: string }> {
    throw new RigTransportNotImplementedError(
      'worktreeCreate',
      'P2: body git worktree + subchannel + edit MCP',
    );
  }

  async worktreeArchive(_worktreeId: string, _opts?: { sessionId?: SessionId }): Promise<void> {
    throw new RigTransportNotImplementedError(
      'worktreeArchive',
      'P2: body remove worktree, archive child channel',
    );
  }

  // ── Files (P2) ─────────────────────────────────────────────────────────

  async changedFileRead(
    sessionId: SessionId,
    path: string,
  ): Promise<{ content: string; isBinary?: boolean } | null> {
    const client = await this.getClient();
    const mergeInfo = await this.getSubchannelMergeTarget(sessionId);
    if (!mergeInfo) return null;
    const events = await client.query([
      {
        kinds: [CHANGE_REVIEW_EVENT_KIND],
        authors: [mergeInfo.authorPubkey],
        '#t': [CHANGE_REVIEW_FILE_TAG],
        '#r': [mergeInfo.target.tip],
        '#f': [path],
        limit: 500,
      },
      {
        // Compatibility for changes published before review payloads moved
        // out of kind-9 chat history.
        kinds: [9],
        '#h': [sessionId],
        '#t': [CHANGE_REVIEW_FILE_TAG],
        '#f': [path],
        limit: 500,
      },
    ]);
    const matching = events.filter(
      (event) =>
        event.pubkey === mergeInfo.authorPubkey &&
        tagValue(event, 'h') === sessionId &&
        tagValue(event, 'tip') === mergeInfo.target.tip &&
        tagValue(event, 'f') === path,
    );
    if (matching.length === 0) return null;
    const uniqueChunks = new Map<number, (typeof matching)[number]>();
    for (const event of [...matching].sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    )) {
      uniqueChunks.set(Number(tagValue(event, 'chunk') ?? 0), event);
    }
    const chunks = [...uniqueChunks.values()].sort(
      (a, b) => Number(tagValue(a, 'chunk') ?? 0) - Number(tagValue(b, 'chunk') ?? 0),
    );
    const expected = Number(tagValue(chunks[0]!, 'chunks') ?? chunks.length);
    const complete =
      Number.isInteger(expected) &&
      expected > 0 &&
      chunks.length === expected &&
      chunks.every((event, index) => Number(tagValue(event, 'chunk') ?? -1) === index);
    if (!complete) {
      throw new Error(
        `Incomplete diff for ${path}: received ${chunks.length} of ${expected} chunks`,
      );
    }
    return {
      content: chunks.map((event) => event.content).join(''),
      ...(chunks.some((event) => tagValue(event, 'binary') === 'true') ? { isBinary: true } : {}),
    };
  }

  async workspaceFilesRead(sessionId: SessionId): Promise<ChangedFile[]> {
    const client = await this.getClient();
    const mergeInfo = await this.getSubchannelMergeTarget(sessionId);
    if (!mergeInfo) return [];
    const events = await client.query([
      {
        kinds: [CHANGE_REVIEW_EVENT_KIND],
        authors: [mergeInfo.authorPubkey],
        '#t': [CHANGE_REVIEW_MANIFEST_TAG],
        '#r': [mergeInfo.target.tip],
        limit: 500,
      },
      {
        kinds: [9],
        '#h': [sessionId],
        '#t': [CHANGE_REVIEW_MANIFEST_TAG],
        limit: 500,
      },
    ]);
    const manifests = events
      .filter(
        (event) =>
          event.pubkey === mergeInfo.authorPubkey &&
          tagValue(event, 'h') === sessionId &&
          tagValue(event, 'tip') === mergeInfo.target.tip,
      )
      .sort((a, b) => Number(tagValue(a, 'chunk') ?? 0) - Number(tagValue(b, 'chunk') ?? 0))
      .map((event) => parseChangeReviewManifest(event.content))
      .filter((manifest) => manifest !== null);
    if (manifests.length === 0) {
      throw new Error('File-diff metadata is unavailable for this corner');
    }
    const files = manifests.flatMap((manifest) => manifest.files);
    return [...new Map(files.map((file) => [file.path, file])).values()];
  }

  async changedFilesRevert(_sessionId: SessionId, _paths: string[]): Promise<void> {
    throw new RigTransportNotImplementedError(
      'changedFilesRevert',
      'P2: body git checkout in worktree',
    );
  }

  // ── Merge (P2) ─────────────────────────────────────────────────────────

  /**
   * Read the merge target from the subchannel's control messages.
   * The body posts a control message with repo/branch/tip tags on subchannel open.
   */
  async getSubchannelMergeTarget(subchannelId: string): Promise<{
    target: MergeTarget;
    channelId: string;
    authorPubkey: string;
  } | null> {
    const client = await this.getClient();
    // Backfill messages to find the body's control message with merge target.
    const events = await client.sessionEventsBackfill(subchannelId, { limit: 20 });
    for (const ev of [...events].reverse()) {
      if (ev.kind !== 'other' && ev.kind !== 'message') continue;
      const tTags = (ev.event.tags ?? []).filter((t: string[]) => t[0] === 't');
      const isControl = tTags.some((t: string[]) => t[1] === 'body-control');
      if (!isControl) continue;
      const repo = tagValue(ev.event, 'repo');
      const branch = tagValue(ev.event, 'branch');
      const tip = tagValue(ev.event, 'tip');
      const parent = tagValue(ev.event, 'parent');
      if (repo && branch && tip) {
        return {
          target: { repo, branch, tip },
          channelId: parent ?? '',
          authorPubkey: ev.event.pubkey,
        };
      }
    }
    return null;
  }

  /**
   * Publish a merge approval for the given subchannel.
   * Signs with the transport's identity key and submits to the relay.
   */
  async submitMergeApproval(
    subchannelId: string,
    target: MergeTarget,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const client = await this.getClient();
      await client.submitMergeApproval(subchannelId, target);
      return { success: true, message: 'Approval sent for merge' };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  }

  /** Check whether this channel itself is archived. */
  async isChannelArchived(channelId: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      const meta = await client.getChannelMetadata(channelId);
      if (meta?.archived) return true;
      const parentChannelId = await client.getParentChannelId(channelId);
      if (!parentChannelId) return false;
      // A corner archive also posts a status card into its parent Room. That
      // card describes the tagged subchannel; it is not Room lifecycle state.
      // Legacy self-archive messages have no subchannel tag, so keep accepting
      // those for verified corners when relay metadata has not materialized.
      const events = await client.sessionEventsBackfill(channelId, { limit: 10 });
      for (const ev of events) {
        const tTags = (ev.event.tags ?? []).filter((t: string[]) => t[0] === 't');
        const isControl = tTags.some((t: string[]) => t[1] === 'body-control');
        if (isControl) {
          const status = tagValue(ev.event, 'status');
          const scopedSubchannel = tagValue(ev.event, 'subchannel');
          if (status === 'archived' && (!scopedSubchannel || scopedSubchannel === channelId)) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * List subchannels of a parent parentChannelId.
   */
  async listSubchannels(parentChannelId: string): Promise<string[]> {
    const client = await this.getClient();
    return client.listSubchannels(parentChannelId);
  }

  /** Person-facing corner projection used by navigation and the full browse view. */
  async listSubchannelLifecycle(parentChannelId: string): Promise<CornerSummary[]> {
    const client = await this.getClient();
    const ids = await client.listSubchannels(parentChannelId);
    const parentEvents = await client.query([
      {
        kinds: [9],
        '#h': [parentChannelId],
        '#t': ['merge-summary'],
        limit: 500,
      },
    ]);
    const mergedIds = new Set(
      parentEvents
        .map((event) => tagValue(event, 'subchannel'))
        .filter((id): id is string => Boolean(id)),
    );

    return Promise.all(
      ids.map(async (id) => {
        const [creates, metadata, events] = await Promise.all([
          client.query([{ kinds: [9007], '#h': [id], limit: 5 }]),
          client.getChannelMetadata(id),
          client.sessionEventsBackfill(id, { limit: 50 }),
        ]);
        const create = [...creates].sort((a, b) => a.created_at - b.created_at)[0];
        const statuses = events
          .map((event) => tagValue(event.event, 'status'))
          .filter((status): status is string => Boolean(status));
        const archived = Boolean(metadata?.archived) || statuses.includes('archived');
        const reviewReady =
          statuses.includes('ready') ||
          events.some((event) =>
            event.event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
          );
        return {
          id,
          name: cornerName(create ? tagValue(create, 'name') : undefined, id),
          openerPubkey: create?.pubkey ?? '',
          status: mergedIds.has(id)
            ? 'merged'
            : archived
              ? 'archived'
              : reviewReady
                ? 'open'
                : 'live',
          createdAt: create?.created_at,
        };
      }),
    );
  }

  async getChannelCreator(channelId: string): Promise<string | null> {
    const client = await this.getClient();
    const creates = await client.query([{ kinds: [9007], '#h': [channelId], limit: 5 }]);
    return [...creates].sort((a, b) => a.created_at - b.created_at)[0]?.pubkey ?? null;
  }

  /**
   * Resolve parent channel ID from the 9007 create event.
   * Returns null if the channel is a top-level TLC (no parent).
   */
  async getParentChannelId(channelId: string): Promise<string | null> {
    const client = await this.getClient();
    return client.getParentChannelId(channelId);
  }

  /**
   * Get pubkey short npub for provenance display.
   */
  getPubkey(): string {
    return this.identity.publicKey;
  }

  async mergeAction(input: MergeActionInput): Promise<{ success: boolean; message?: string }> {
    // The mergeAction in RigTransport uses approvalToken-style input.
    // For P2, we read the merge target from the subchannel's control messages.
    // If input has channelId, try to find merge target there.
    if (input.channelId) {
      const mergeInfo = await this.getSubchannelMergeTarget(input.channelId);
      if (mergeInfo) {
        return this.submitMergeApproval(input.channelId, mergeInfo.target);
      }
      return { success: false, message: 'No merge target found in subchannel messages' };
    }
    return { success: false, message: 'channelId required for merge action' };
  }

  // ── Terminals: STUB ────────────────────────────────────────────────────

  async terminalCreate(): Promise<never> {
    throw new RigTransportStubbedError('terminalCreate');
  }
  async terminalStop(): Promise<never> {
    throw new RigTransportStubbedError('terminalStop');
  }
  async terminalConnect(): Promise<never> {
    throw new RigTransportStubbedError('terminalConnect');
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  /** Disconnect the WS and clean up subscriptions. */
  disconnect(): void {
    for (const [, unsub] of this.subscriptions) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.subscriptions.clear();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }
}
