/**
 * BuzzRigTransport — real-Buzz implementation of RigTransport.
 *
 * Speaks only to the Buzz relay via @buzzy/buzz-client. No Happy server calls.
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
import {
  RigTransportNotImplementedError,
  RigTransportStubbedError,
} from './rig-transport';
import {
  createBuzzClient,
  type BuzzClient,
  type Identity,
  type SessionEvent as BuzzSessionEvent,
} from '@buzzy/buzz-client';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:3010';

/**
 * Map a buzz-client SessionEvent (kind:'message'|'agent-activity'|'other')
 * to a RigTransport SessionEvent.
 */
function toRigEvent(ev: BuzzSessionEvent): SessionEvent {
  if (ev.kind === 'agent-activity') {
    return {
      type: 'assistant_delta',
      sessionId: ev.channelId,
      text: ev.content,
      seq: ev.createdAt,
    };
  }
  if (ev.kind === 'message') {
    return {
      type: 'raw',
      sessionId: ev.channelId,
      payload: {
        id: ev.id,
        content: ev.content,
        pubkey: ev.pubkey,
        createdAt: ev.createdAt,
      },
    };
  }
  return {
    type: 'raw',
    sessionId: ev.channelId,
    payload: ev.event,
  };
}

export class BuzzRigTransport implements RigTransport {
  private client: BuzzClient | null = null;
  private identity: Identity;
  private baseUrl: string;
  /** Track open subscriptions for cleanup. */
  private subscriptions = new Map<SessionId, () => void>();

  constructor(identity: Identity, baseUrl: string = DEFAULT_RELAY_URL) {
    this.identity = identity;
    this.baseUrl = baseUrl;
  }

  // ── Client lazy-init ──────────────────────────────────────────────────

  private async getClient(): Promise<BuzzClient> {
    if (!this.client) {
      this.client = createBuzzClient({
        baseUrl: this.baseUrl,
        identity: this.identity,
      });
      await this.client.connect();
    }
    return this.client;
  }

  /** Expose the underlying client for direct buzz-client calls when needed. */
  async ensureClient(): Promise<BuzzClient> {
    return this.getClient();
  }

  // ── Sessions (P1: channels as sessions) ────────────────────────────────

  async sessionCreate(
    _input: WorktreeCreateInput & { prompt?: string },
  ): Promise<SessionDetail> {
    throw new RigTransportNotImplementedError(
      'sessionCreate',
      'P2: requires body with ACP session/new + worktree create + subchannel',
    );
  }

  async sessionsRead(
    _scope?: { channelId?: ChannelId },
  ): Promise<SessionSummary[]> {
    const client = await this.getClient();
    const channels = await client.listMyChannels();
    return channels.map((c) => {
      const nameTag = c.event.tags.find((t) => t[0] === 'name');
      return {
        id: c.channelId,
        active: true,
        title: nameTag?.[1] ?? c.channelId.slice(0, 8),
        updatedAt: c.event.created_at,
        createdAt: c.event.created_at,
      };
    });
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

  async sessionArchive(
    _sessionId: SessionId,
  ): Promise<{ success: boolean; message?: string }> {
    throw new RigTransportNotImplementedError(
      'sessionArchive',
      'P2: needs channel.archive or metadata set archived+closed',
    );
  }

  // ── Messaging (P1) ─────────────────────────────────────────────────────

  async messageSubmit(input: MessageSubmitInput): Promise<void> {
    const client = await this.getClient();
    await client.messageSubmit(input.sessionId, input.text);
  }

  async runAbort(_sessionId: SessionId): Promise<void> {
    throw new RigTransportNotImplementedError(
      'runAbort',
      'P2: owner !cancel mention or body control → ACP session/cancel',
    );
  }

  // ── Realtime + permissions (P1: subscribe + backfill) ──────────────────

  sessionEventsSubscribe(
    sessionId: SessionId,
    handler: (event: SessionEvent) => void,
  ): () => void {
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
        console.warn(
          `BuzzRigTransport: sessionEventsSubscribe(${sessionId}) failed:`,
          err,
        );
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

  async worktreeArchive(
    _worktreeId: string,
    _opts?: { sessionId?: SessionId },
  ): Promise<void> {
    throw new RigTransportNotImplementedError(
      'worktreeArchive',
      'P2: body remove worktree, archive child channel',
    );
  }

  // ── Files (P2) ─────────────────────────────────────────────────────────

  async changedFileRead(
    _sessionId: SessionId,
    _path: string,
  ): Promise<{ content: string; isBinary?: boolean } | null> {
    throw new RigTransportNotImplementedError(
      'changedFileRead',
      'P2: body git show/diff or client git fetch + local read',
    );
  }

  async workspaceFilesRead(
    _sessionId: SessionId,
  ): Promise<ChangedFile[]> {
    throw new RigTransportNotImplementedError(
      'workspaceFilesRead',
      'P2: body walk worktree or client git ls-files',
    );
  }

  async changedFilesRevert(
    _sessionId: SessionId,
    _paths: string[],
  ): Promise<void> {
    throw new RigTransportNotImplementedError(
      'changedFilesRevert',
      'P2: body git checkout in worktree',
    );
  }

  // ── Merge (P2) ─────────────────────────────────────────────────────────

  async mergeAction(
    _input: MergeActionInput,
  ): Promise<{ success: boolean; message?: string }> {
    throw new RigTransportNotImplementedError(
      'mergeAction',
      'P2: emit workflow-approval grant (kinds 46010/46011/46012)',
    );
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