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
  tagValues,
  classifySessionEvent,
  toSessionEvent,
  CHANGE_REVIEW_EVENT_KIND,
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_MANIFEST_TAG,
  CHANGE_REVIEW_COMPLETE_TAG,
  CHANGE_REVIEW_GENERATION_TAG,
  APPROVAL_MARKER,
  KIND_AGENT_PRESENCE,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_EDIT_METADATA,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY,
  TAG_PARENT,
  TAG_DIRECT_MESSAGE,
  TAG_AGENT_PRESENCE,
  parseChangeReviewManifest,
  parseChangeReviewGenerationComplete,
  type BuzzClient,
  type ChannelMetadata,
  type Identity,
  type MergeTarget,
  type SessionEvent as BuzzSessionEvent,
  type WritePermissionDecision,
  type AttachmentReference,
  type AgentModelCatalog,
  type AgentModelConfig,
  type AgentModelConfigInput,
  type AgentCommandList,
  TAG_CORNER_STATE,
  KIND_CORNER_STATE,
  parseCornerStateRecord,
  cornerStateKey,
  type RoomRepository,
  type RoomRepositoryResolution,
  type RoomRepositoryInput,
  getAuthCapabilities,
  listGitHubRepositories,
  startGitHubInstallation,
  createGitHubRepository,
  getGitHubRepositoryAccess,
  type GitHubInstallationAccess,
  type GitHubRepositoryAccessResult,
} from '@beeline/buzz-client';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { dedupeRepoCandidates } from '@/buzz/room-repo-picker';
import type { NostrEvent } from '@beeline/nostr';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { cornerName, type CornerSummary } from '@/buzz/corners';
import { projectChatEvent, toRigEvent, type ChatDisplayMessage } from './buzz-event-projection';
import {
  ROOM_CONTEXT_LIMIT,
  selectRoomContext,
  type RoomContextEntry,
} from '@/buzz/corner-context';
import {
  clearCornerLifecycleCache,
  getCachedCornerLifecycle,
  setCachedCornerLifecycle,
} from './corner-lifecycle-cache';
import { resolveCornerVerdict } from './corner-state-verdict';
import type { CornerStateRecord } from '@beeline/buzz-client';

export { invalidateCornerLifecycleCache } from './corner-lifecycle-cache';

/** Room events read back to find the pre-open window. Generous enough that a
 *  burst of corner status cards and activity batches right before the corner
 *  opened cannot crowd out the conversation underneath them. */
const ROOM_CONTEXT_SCAN_LIMIT = 80;
const ROOM_REPOSITORY_MARKER = 'buzz-room-repository';

let sharedClientEntry: { key: string; client: BuzzClient } | undefined;

/** One best-effort multi-`#d` read of the daemon-authoritative corner state
 * records across corners. Filtered by `#d`, never `#h` (kind:30078 records
 * are indexed by `d`). A failed or empty read resolves an empty map, which
 * can only produce canonical idle — never history-derived activity. */
async function fetchCornerStateRecords(
  client: BuzzClient,
  cornerIds: string[],
): Promise<Map<string, Array<{ record: CornerStateRecord; authorPubkey: string }>>> {
  if (cornerIds.length === 0) return new Map();
  let events: NostrEvent[];
  try {
    events = await client.query([
      {
        kinds: [KIND_CORNER_STATE],
        '#d': cornerIds.map((id) => cornerStateKey(id)),
        limit: Math.max(200, cornerIds.length * 5),
      },
    ]);
  } catch {
    events = [];
  }
  const byCorner = new Map<string, Array<{ record: CornerStateRecord; authorPubkey: string }>>();
  for (const event of events) {
    const record = parseCornerStateRecord(event);
    if (!record) continue;
    const records = byCorner.get(record.cornerId) ?? [];
    records.push({ record, authorPubkey: event.pubkey });
    byCorner.set(record.cornerId, records);
  }
  return byCorner;
}

/** Pure projection shared by the single-Room and cross-Room lifecycle fetchers. */
function cornerSummaryFromEvents(
  id: string,
  creates: NostrEvent[],
  metadata: ChannelMetadata | null,
  events: BuzzSessionEvent[],
  parentRoomLive: boolean,
  authoredStates: Array<{ record: CornerStateRecord; authorPubkey: string }> = [],
): CornerSummary {
  const create = [...creates].sort((a, b) => a.created_at - b.created_at)[0];
  // The immutable kind:9007 creator is the lifecycle authority. A different
  // pubkey can publish the same d text under its own replaceable namespace,
  // but it cannot speak for this corner.
  const stateRecord = create
    ? authoredStates
        .filter((candidate) => candidate.authorPubkey === create.pubkey)
        .sort((a, b) => b.record.at - a.record.at)[0]?.record
    : undefined;
  const lastActivityAt = Math.max(
    create?.created_at ?? 0,
    ...events.map((event) => event.createdAt),
  );
  const verdict = resolveCornerVerdict({
    ...(stateRecord !== undefined ? { stateRecord } : {}),
    channelExists: metadata !== null && metadata.archived !== true,
    parentRoomLive,
  });
  return {
    id,
    name: cornerName(create ? tagValue(create, 'name') : undefined, id),
    openerPubkey: create?.pubkey ?? '',
    status: verdict.status,
    ...(verdict.machineState ? { machineState: verdict.machineState } : {}),
    ...(verdict.machineReason ? { machineReason: verdict.machineReason } : {}),
    ...(verdict.stateAt !== undefined ? { stateAt: verdict.stateAt } : {}),
    ...(verdict.awaitingReply ? { awaitingReply: true } : {}),
    createdAt: create?.created_at,
    ...(lastActivityAt > 0 ? { lastActivityAt } : {}),
  };
}

function sharedClient(identity: Identity, baseUrl: string): BuzzClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const key = `${normalizedBaseUrl}\u0000${identity.publicKey}`;
  if (sharedClientEntry?.key === key) return sharedClientEntry.client;
  sharedClientEntry?.client.disconnect();
  clearCornerLifecycleCache();
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
  /** A second caller publishing the same prepared event joins the first publish. */
  private outgoingPublishes = new Map<string, Promise<string>>();

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

  /** Compose one signed message. Retries must publish this returned event unchanged. */
  async composeMessage(
    input: MessageSubmitInput,
    opts?: { mentionAgent?: string; mentionPubkeys?: string[] },
  ): Promise<NostrEvent> {
    const client = await this.getClient();
    const attachmentTags = buildAttachmentTags(input.attachments ?? []);
    return client.buildMessage(input.sessionId, input.text, {
      ...(opts?.mentionAgent ? { mentionAgent: opts.mentionAgent } : {}),
      ...(opts?.mentionPubkeys?.length ? { mentionPubkeys: opts.mentionPubkeys } : {}),
      ...(attachmentTags.length ? { extraTags: attachmentTags } : {}),
    });
  }

  /** Publish a prepared message at most once while it is in flight. */
  async publishPreparedMessage(event: NostrEvent): Promise<string> {
    const existing = this.outgoingPublishes.get(event.id);
    if (existing) return existing;

    const publish = this.getClient()
      .then((client) => client.publish(event))
      .then(() => event.id)
      .finally(() => {
        if (this.outgoingPublishes.get(event.id) === publish) {
          this.outgoingPublishes.delete(event.id);
        }
      });
    this.outgoingPublishes.set(event.id, publish);
    return publish;
  }

  /** Submit a message and return the stable signed event id for optimistic UI reconciliation. */
  async messageSubmitWithEventId(
    input: MessageSubmitInput,
    opts?: { mentionAgent?: string; mentionPubkeys?: string[]; event?: NostrEvent },
  ): Promise<string> {
    const event = opts?.event ?? (await this.composeMessage(input, opts));
    return this.publishPreparedMessage(event);
  }

  /** Send an ordinary Room message addressed to one @-mentioned agent. */
  async messageSubmitMentioningAgent(
    channelId: string,
    text: string,
    agentPubkey: string,
    attachments: AttachmentReference[] = [],
  ): Promise<string> {
    return this.messageSubmitWithEventId(
      { sessionId: channelId, text, attachments },
      { mentionAgent: agentPubkey },
    );
  }

  /** Publish a NIP-10 reply, optionally addressing the original Agent explicitly. */
  async messageSubmitReply(
    channelId: string,
    text: string,
    replyToId: string,
    mentionAgent?: string,
    attachments: AttachmentReference[] = [],
    mentionPubkeys: string[] = [],
  ): Promise<string> {
    const client = await this.getClient();
    const attachmentTags = buildAttachmentTags(attachments);
    const [replyTarget] = await client.query([{ ids: [replyToId], limit: 1 }]);
    const replyRootId =
      replyTarget?.tags.find((tag) => tag[0] === 'e' && tag[1] && tag[3] === 'root')?.[1] ??
      replyTarget?.tags.find((tag) => tag[0] === 'e' && tag[1] && tag[3] === 'reply')?.[1] ??
      replyToId;
    const event = await client.messageSubmit(channelId, text, {
      ...(mentionAgent ? { mentionAgent } : {}),
      ...(mentionPubkeys.length ? { mentionPubkeys } : {}),
      extraTags: [
        ...(replyRootId !== replyToId ? [['e', replyRootId, '', 'root']] : []),
        ['e', replyToId, '', 'reply'],
        ...attachmentTags,
      ],
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
    repository: string,
  ): Promise<string> {
    const client = await this.getClient();
    const event = await client.respondToWritePermission(
      channelId,
      permissionId,
      requestId,
      agentPubkey,
      decision,
      repository,
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

  /** Remove another Room participant through the SDK's admin-authorized path. */
  async removeRoomMember(channelId: string, memberPubkey: string): Promise<void> {
    const client = await this.getClient();
    await client.removeRoomMember(channelId, memberPubkey);
  }

  /** Leave a Room as a normal member and wait until the relay projection drops us. */
  async leaveRoom(channelId: string): Promise<void> {
    const client = await this.getClient();
    await client.leaveRoom(channelId);
  }

  /** Archive a top-level Room through the explicit human-admin path. */
  async archiveRoom(channelId: string): Promise<void> {
    const client = await this.getClient();
    await client.archiveRoom(channelId);
  }

  /** Delete a Room and wait until the relay retracts every discovery projection. */
  async deleteRoom(channelId: string): Promise<void> {
    const client = await this.getClient();
    await client.deleteRoom(channelId);
  }

  /**
   * Leave a Workspace as the signed-in member. The SDK drops this identity's
   * top-level Room memberships first (best-effort), then publishes the
   * self-authored Workspace removal and waits for the projection to drop it —
   * so a relay refusal for elevated roles surfaces here instead of silently
   * leaving the Workspace on the device.
   */
  async leaveWorkspace(communityId: string): Promise<void> {
    const client = await this.getClient();
    await client.leaveWorkspace(communityId);
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

  /** Close a corner outright: the body archives the subchannel (also cancels any active turn). */
  async closeCorner(subchannelId: ChannelId): Promise<void> {
    const client = await this.getClient();
    await client.messageSubmit(subchannelId, 'Close this corner.', {
      extraTags: [['t', 'buzz-corner-close']],
    });
  }

  // ── Realtime + permissions (P1: subscribe + backfill) ──────────────────

  /** Resolve only once relay delivery is installed, so callers can backfill without a race gap. */
  async sessionEventsSubscribeReady(
    sessionId: SessionId,
    handler: (event: SessionEvent) => void,
  ): Promise<() => void> {
    const client = await this.getClient();
    const relayUnsubscribe = await client.sessionEventsSubscribe(sessionId, (event) => {
      handler(toRigEvent(event));
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      relayUnsubscribe();
      if (this.subscriptions.get(sessionId) === stop) this.subscriptions.delete(sessionId);
    };
    this.subscriptions.set(sessionId, stop);
    return stop;
  }

  sessionEventsSubscribe(sessionId: SessionId, handler: (event: SessionEvent) => void): () => void {
    let stopReadySubscription: (() => void) | undefined;
    let cancelled = false;

    this.sessionEventsSubscribeReady(sessionId, handler)
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        stopReadySubscription = stop;
      })
      .catch((err) => {
        console.warn(`BuzzRigTransport: sessionEventsSubscribe(${sessionId}) failed:`, err);
      });

    const unsubscribe = () => {
      cancelled = true;
      stopReadySubscription?.();
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

  /**
   * Read every relay record needed to derive a Room's quiet state-change
   * transcript. The returned records are structure, not new chat messages:
   * membership/metadata/repository history plus the canonical per-corner
   * lifecycle records and existing land summaries used only for digest copy.
   */
  async roomUpdateEventsBackfill(roomId: string): Promise<NostrEvent[]> {
    const client = await this.getClient();
    const cornerIds = await client.listSubchannels(roomId);
    const [roomCreate, roomMutations, repository, cornerStates, cornerCreates, landContext] =
      await Promise.all([
        client.query([{ kinds: [KIND_CREATE_GROUP], '#h': [roomId], limit: 10 }]),
        client.query([
          {
            kinds: [KIND_PUT_USER, KIND_REMOVE_USER, KIND_EDIT_METADATA],
            '#h': [roomId],
            limit: 2_000,
          },
        ]),
        client.query([
          {
            kinds: [KIND_CORNER_STATE],
            '#d': [`${ROOM_REPOSITORY_MARKER}:${roomId}`],
            limit: 100,
          },
        ]),
        cornerIds.length
          ? client.query([
              {
                kinds: [KIND_CORNER_STATE],
                '#d': cornerIds.map((cornerId) => cornerStateKey(cornerId)),
                limit: Math.max(100, cornerIds.length * 20),
              },
            ])
          : Promise.resolve([]),
        cornerIds.length
          ? client.query([
              { kinds: [KIND_CREATE_GROUP], '#h': cornerIds, limit: cornerIds.length * 5 },
            ])
          : Promise.resolve([]),
        client.query([
          {
            kinds: [KIND_STREAM_MESSAGE],
            '#h': [roomId],
            '#t': ['landed', 'land-summary', 'merge-summary'],
            limit: 500,
          },
        ]),
      ]);
    return [
      ...new Map(
        [
          ...roomCreate,
          ...roomMutations,
          ...repository,
          ...cornerStates,
          ...cornerCreates,
          ...landContext,
        ].map((event) => [event.id, event]),
      ).values(),
    ].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }

  /** Live structural delivery. It reuses the Room socket and emits no writes. */
  async roomUpdateEventsSubscribeReady(
    roomId: string,
    handler: (event: NostrEvent) => void,
  ): Promise<() => void> {
    const subscriptionKey = `room-updates:${roomId}`;
    const client = await this.getClient();
    const cornerIds = new Set(await client.listSubchannels(roomId));
    const stops: Array<() => void> = [];
    const relayUnsubscribe = await client.sessionEventsSubscribe(
      roomId,
      (event) => {
        const raw = event.event;
        const marker = tagValue(raw, 't');
        if (
          raw.kind === KIND_STREAM_MESSAGE &&
          !['landed', 'land-summary', 'merge-summary'].includes(marker ?? '')
        ) {
          return;
        }
        handler(raw);
      },
      {
        kinds: [KIND_PUT_USER, KIND_REMOVE_USER, KIND_EDIT_METADATA, KIND_STREAM_MESSAGE],
      },
    );
    stops.push(relayUnsubscribe);

    // Kind:30078 is indexed by `d`, not the Room's `h`. Keep its live path on
    // exact repository/corner keys, mirroring the canonical corner-state
    // reader. A child create dynamically installs the new key; the create is
    // also handed to the renderer as the immutable objective/authority fact.
    await client.connect();
    const socket = client.socket;
    if (!socket) throw new Error('Room update socket unavailable after connect');
    const subscribeCorner = (cornerId: string) => {
      if (cornerIds.has(cornerId)) return;
      cornerIds.add(cornerId);
      stops.push(
        socket.subscribe(
          [{ kinds: [KIND_CORNER_STATE], '#d': [cornerStateKey(cornerId)] }],
          handler,
        ),
      );
    };
    const initialCornerIds = [...cornerIds];
    cornerIds.clear();
    initialCornerIds.forEach(subscribeCorner);
    stops.push(
      socket.subscribe(
        [
          {
            kinds: [KIND_CORNER_STATE],
            '#d': [`${ROOM_REPOSITORY_MARKER}:${roomId}`],
          },
        ],
        (event) => {
          if (tagValue(event, 't') === ROOM_REPOSITORY_MARKER) handler(event);
        },
      ),
    );
    stops.push(
      socket.subscribe([{ kinds: [KIND_CREATE_GROUP], [`#${TAG_PARENT}`]: [roomId] }], (event) => {
        const cornerId = tagValue(event, 'h');
        if (!cornerId) return;
        handler(event);
        subscribeCorner(cornerId);
      }),
    );
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stops.splice(0).forEach((unsubscribe) => unsubscribe());
      if (this.subscriptions.get(subscriptionKey) === stop) {
        this.subscriptions.delete(subscriptionKey);
      }
    };
    this.subscriptions.set(subscriptionKey, stop);
    return stop;
  }

  /** Read the current parameterized-replaceable presence record(s) for a Room. */
  async agentPresenceBackfill(channelId: string): Promise<SessionEvent[]> {
    const client = await this.getClient();
    const buzzEvents = await client.agentPresenceBackfill(channelId);
    return buzzEvents.map(toRigEvent);
  }

  /**
   * Read presence across every Room in a Workspace, not just one — the Agents
   * directory has no single Room context, unlike a Corner list or Room roster.
   * Presence is published per (agent, Room) with no workspace-wide record, so
   * this fans a single multi-`#h` query (same proven pattern as
   * `fetchManyRoomsLifecycle`'s cross-Room corner reads) across every Room the
   * Workspace has, and callers merge to newest-per-agent via
   * `presenceMapFromSessionEvents`. An agent with no live daemon anywhere in
   * the Workspace correctly yields no record, i.e. offline.
   */
  async agentPresenceBackfillForWorkspace(communityId: string): Promise<SessionEvent[]> {
    const client = await this.getClient();
    const roomIds = await client.communityChannels(communityId);
    if (roomIds.length === 0) return [];
    // Filtered by `#d`, NOT `#h`. Presence is a parameterized-replaceable
    // kind:30078 record and the relay indexes those by `d`: a `#h` filter over
    // kind 30078 matches nothing, even though the record carries an `h` tag.
    // This read was the only presence reader that reached for `#h` — the
    // per-Room reads always spelled the `d` key out — so it returned zero
    // events for every Workspace, always, and this directory reported every
    // agent OFFLINE regardless of what its daemon was doing. Confirmed against
    // the live relay: `#h` → 0 events, `#d` → the same agent's four-second-old
    // `online` heartbeat.
    const buzzEvents = await client.query([
      {
        kinds: [KIND_AGENT_PRESENCE],
        // Built from `TAG_AGENT_PRESENCE`, a long-standing export, rather
        // than from the newer `agentPresenceKey` helper. Metro resolves
        // `@beeline/buzz-client` to its BUILT `dist/`, so a mobile fix that
        // reaches for a brand-new SDK symbol is `undefined` at runtime against
        // a stale build — and this read is best-effort, so the resulting
        // TypeError is swallowed and every agent reads OFFLINE. A fix must not
        // depend on a rebuild it cannot verify.
        '#d': roomIds.map((roomId) => `${TAG_AGENT_PRESENCE}:${roomId}`),
        limit: Math.max(200, roomIds.length * 10),
      },
    ]);
    return buzzEvents
      .map(toSessionEvent)
      .filter((event): event is BuzzSessionEvent => event !== null)
      .map(toRigEvent);
  }

  /** Subscribe only to Room presence, keeping telemetry out of chat backfill. */
  async agentPresenceSubscribeReady(
    channelId: string,
    handler: (event: SessionEvent) => void,
  ): Promise<() => void> {
    const subscriptionKey = `presence:${channelId}`;
    const client = await this.getClient();
    const relayUnsubscribe = await client.agentPresenceSubscribe(channelId, (event) => {
      handler(toRigEvent(event));
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      relayUnsubscribe();
      if (this.subscriptions.get(subscriptionKey) === stop) {
        this.subscriptions.delete(subscriptionKey);
      }
    };
    this.subscriptions.set(subscriptionKey, stop);
    return stop;
  }

  /** Subscribe only to Room presence, keeping telemetry out of chat backfill. */
  agentPresenceSubscribe(channelId: string, handler: (event: SessionEvent) => void): () => void {
    const subscriptionKey = `presence:${channelId}`;
    let stopReadySubscription: (() => void) | undefined;
    let cancelled = false;

    this.agentPresenceSubscribeReady(channelId, handler)
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        stopReadySubscription = stop;
      })
      .catch((error) => {
        console.warn(`BuzzRigTransport: agentPresenceSubscribe(${channelId}) failed:`, error);
      });

    const unsubscribe = () => {
      cancelled = true;
      stopReadySubscription?.();
    };
    this.subscriptions.set(subscriptionKey, unsubscribe);
    return unsubscribe;
  }

  /** Read the current live agent reply draft (parameterized-replaceable), if any. */
  async agentDraftBackfill(channelId: string): Promise<SessionEvent[]> {
    const client = await this.getClient();
    const buzzEvents = await client.agentDraftBackfill(channelId);
    return buzzEvents.map(toRigEvent);
  }

  /** Subscribe only to this Room's live agent reply draft, isolated from chat backfill. */
  async agentDraftSubscribeReady(
    channelId: string,
    handler: (event: SessionEvent) => void,
  ): Promise<() => void> {
    const subscriptionKey = `draft:${channelId}`;
    const client = await this.getClient();
    const relayUnsubscribe = await client.agentDraftSubscribe(channelId, (event) => {
      handler(toRigEvent(event));
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      relayUnsubscribe();
      if (this.subscriptions.get(subscriptionKey) === stop) {
        this.subscriptions.delete(subscriptionKey);
      }
    };
    this.subscriptions.set(subscriptionKey, stop);
    return stop;
  }

  /** Subscribe only to this Room's live agent reply draft, isolated from chat backfill. */
  agentDraftSubscribe(channelId: string, handler: (event: SessionEvent) => void): () => void {
    const subscriptionKey = `draft:${channelId}`;
    let stopReadySubscription: (() => void) | undefined;
    let cancelled = false;

    this.agentDraftSubscribeReady(channelId, handler)
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        stopReadySubscription = stop;
      })
      .catch((error) => {
        console.warn(`BuzzRigTransport: agentDraftSubscribe(${channelId}) failed:`, error);
      });

    const unsubscribe = () => {
      cancelled = true;
      stopReadySubscription?.();
      if (this.subscriptions.get(subscriptionKey) === unsubscribe) {
        this.subscriptions.delete(subscriptionKey);
      }
    };
    this.subscriptions.set(subscriptionKey, unsubscribe);
    return unsubscribe;
  }

  /** Current canonical lifecycle records for exact corner ids. */
  async cornerStateBackfill(cornerIds: string[]): Promise<CornerStateRecord[]> {
    const client = await this.getClient();
    const authorities = new Map(
      await Promise.all(
        cornerIds.map(async (id) => [id, await this.getChannelCreator(id)] as const),
      ),
    );
    const events = await client.cornerStateBackfill(cornerIds);
    return events
      .filter((event) => {
        const record = parseCornerStateRecord(event);
        return record !== undefined && authorities.get(record.cornerId) === event.pubkey;
      })
      .map(parseCornerStateRecord)
      .filter((record): record is CornerStateRecord => record !== undefined);
  }

  /** Live canonical lifecycle delivery. Parent body-control cards never enter. */
  async cornerStateSubscribeReady(
    cornerIds: string[],
    handler: (record: CornerStateRecord) => void,
  ): Promise<() => void> {
    const subscriptionKey = `corner-state:${[...cornerIds].sort().join(',')}`;
    const client = await this.getClient();
    const authorities = new Map(
      await Promise.all(
        cornerIds.map(async (id) => [id, await this.getChannelCreator(id)] as const),
      ),
    );
    const relayUnsubscribe = await client.cornerStateSubscribe(cornerIds, (event) => {
      const record = parseCornerStateRecord(event);
      if (record && authorities.get(record.cornerId) === event.pubkey) handler(record);
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      relayUnsubscribe();
      if (this.subscriptions.get(subscriptionKey) === stop) {
        this.subscriptions.delete(subscriptionKey);
      }
    };
    this.subscriptions.set(subscriptionKey, stop);
    return stop;
  }

  /** The runtime's currently advertised model/effort catalog for an agent, if any session has published one. */
  async agentModelCatalogRead(
    communityId: string,
    agentPubkey: string,
  ): Promise<AgentModelCatalog | null> {
    const client = await this.getClient();
    return client.getAgentModelCatalog(communityId, agentPubkey);
  }

  /** The current human-chosen model/effort selection for an agent, if any. */
  async agentModelConfigRead(
    communityId: string,
    agentPubkey: string,
  ): Promise<AgentModelConfig | null> {
    const client = await this.getClient();
    return client.getAgentModelConfig(communityId, agentPubkey);
  }

  /**
   * The slash commands/skills an agent's harness advertises, if published.
   *
   * Command records are keyed by Workspace root, never by Room id or relay
   * tenant. Resolve that immutable Room linkage here so screen selection/cache
   * state cannot silently query a different `d` key. Older corners may lack
   * the linkage on their own create event, so their already-resolved parent
   * Workspace remains a compatibility fallback.
   */
  async agentCommandsRead(
    channelId: string,
    agentPubkey: string,
    fallbackWorkspaceRootId?: string,
  ): Promise<AgentCommandList | null> {
    const client = await this.getClient();
    let roomWorkspaceRootId: string | null;
    try {
      roomWorkspaceRootId = await client.getChannelCommunityId(channelId);
    } catch (error) {
      if (!fallbackWorkspaceRootId) throw error;
      roomWorkspaceRootId = null;
    }
    const workspaceRootId = roomWorkspaceRootId ?? fallbackWorkspaceRootId;
    if (!workspaceRootId) return null;
    return client.getAgentCommands(workspaceRootId, agentPubkey);
  }

  /** Choose a model/effort for an agent. Applied on that agent's next session (re)activation. */
  async agentModelConfigSet(
    communityId: string,
    agentPubkey: string,
    input: AgentModelConfigInput,
  ): Promise<AgentModelConfig> {
    const client = await this.getClient();
    return client.setAgentModelConfig(communityId, agentPubkey, input);
  }

  // ── Room→repo (Stage 2 app UI over Stage 1's daemon/relay backbone) ─────

  /** Resolve the repository a Room owns, or `null` for a chat-only Room. */
  /**
   * The Room's repository, keeping "we could not tell" distinct from "there
   * isn't one".
   *
   * `roomRepositoryRead` collapses both into `null`, and its caller then
   * collapses a thrown error into `null` as well — so one slow or refused
   * relay read made the app tell an admin their configured Room had no
   * repository, and intercept their open-a-corner message to say so.
   */
  async roomRepositoryState(channelId: string): Promise<RoomRepositoryResolution> {
    const client = await this.getClient();
    return client.resolveRoomRepositoryState(channelId);
  }

  async roomRepositoryRead(channelId: string): Promise<RoomRepository | null> {
    const client = await this.getClient();
    return client.resolveRoomRepository(channelId);
  }

  /** Bind (or re-bind) a Room's repository. Room-admin authority is enforced server-side too. */
  async roomRepositorySet(
    channelId: string,
    input: RoomRepositoryInput & { communityId?: string },
  ): Promise<RoomRepository> {
    const client = await this.getClient();
    return client.setRoomRepository(channelId, input);
  }

  /**
   * Repoint a Room's landing target, carrying its current repository binding
   * forward. This is the admin-confirm half of the chat-native target-branch
   * change: the agent only ever publishes a proposal card, and this event is
   * signed by the confirming admin's own key. Non-admins are refused here AND
   * again by every reader (`getRoomRepository` re-checks the author's current
   * role), so a refusal cannot be bypassed by publishing directly.
   */
  async roomTargetBranchSet(channelId: string, targetBranch: string): Promise<RoomRepository> {
    const client = await this.getClient();
    return client.setRoomTargetBranch(channelId, targetBranch);
  }

  /**
   * Toggle whether this Room receives GitHub repository activity (pushes,
   * pull requests, issues, CI, and reviews). Same admin authority and
   * carry-forward shape as the target-branch change above; absent/`undefined`
   * reads as enabled — the shipped default is ON.
   */
  async roomGitHubEventsSet(channelId: string, enabled: boolean): Promise<RoomRepository> {
    const client = await this.getClient();
    return client.setRoomGitHubEvents(channelId, enabled);
  }

  /** App repositories when enabled; the unchanged connected-Room list while dark. */
  async workspaceRoomRepositoryCandidates(communityId: string): Promise<RepoCandidate[]> {
    const capabilities = await getAuthCapabilities(this.baseUrl).catch(() => undefined);
    if (capabilities?.github) {
      const access = await listGitHubRepositories(this.baseUrl, this.identity);
      return dedupeRepoCandidates(
        access.repositories.map((repo) => ({
          key: `github:${repo.id}`,
          name: repo.fullName,
          remote: `git://github.com/${repo.fullName}`,
          githubInstallationId: repo.installationId,
          defaultBranch: repo.defaultBranch,
        })),
      );
    }

    const client = await this.getClient();
    const creates = await client.query([{ kinds: [KIND_CREATE_GROUP], limit: 500 }]);
    const roomIds = new Set<string>();
    for (const create of creates) {
      if (tagValue(create, TAG_COMMUNITY) !== communityId) continue;
      if (tagValue(create, TAG_PARENT) || tagValues(create, 't').includes(TAG_DIRECT_MESSAGE))
        continue;
      const id = tagValue(create, 'h') ?? tagValue(create, 'd');
      if (id && id !== communityId) roomIds.add(id);
    }
    const repos = await Promise.all(
      [...roomIds].map((id) => client.resolveRoomRepository(id).catch(() => null)),
    );
    return dedupeRepoCandidates(
      repos
        .filter((repo): repo is RoomRepository => repo !== null && Boolean(repo.binding.remote))
        .map((repo) => ({
          key: repo.binding.key,
          name: repo.binding.name,
          remote: repo.binding.remote!,
        })),
    );
  }

  async workspaceGitHubAccess(options: { refresh?: boolean } = {}): Promise<{
    installed: boolean;
    installations: GitHubInstallationAccess[];
    candidates: RepoCandidate[];
  }> {
    const access = await listGitHubRepositories(this.baseUrl, this.identity, options);
    return {
      installed: access.installed,
      installations: access.installations,
      candidates: dedupeRepoCandidates(
        access.repositories.map((repo) => ({
          key: `github:${repo.id}`,
          name: repo.fullName,
          remote: `git://github.com/${repo.fullName}`,
          githubInstallationId: repo.installationId,
          defaultBranch: repo.defaultBranch,
        })),
      ),
    };
  }

  async githubInstallationStart(redirectUri: string, installationId?: number): Promise<string> {
    return startGitHubInstallation(this.baseUrl, this.identity, redirectUri, installationId);
  }

  async githubRepositoryCreate(input: {
    installationId: number;
    name: string;
    description?: string;
    private?: boolean;
  }): Promise<RepoCandidate> {
    const repository = await createGitHubRepository(this.baseUrl, this.identity, input);
    return {
      key: `github:${repository.id}`,
      name: repository.fullName,
      remote: `git://github.com/${repository.fullName}`,
      githubInstallationId: repository.installationId,
      defaultBranch: repository.defaultBranch,
    };
  }

  async githubRepositoryAccess(fullName: string): Promise<GitHubRepositoryAccessResult> {
    return getGitHubRepositoryAccess(this.baseUrl, this.identity, fullName);
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
    reviewTip?: string,
  ): Promise<{ content: string; isBinary?: boolean } | null> {
    const client = await this.getClient();
    const mergeInfo = await this.getSubchannelMergeTarget(sessionId);
    if (!mergeInfo || !('target' in mergeInfo)) return null;
    const tip = reviewTip ?? mergeInfo.target.tip;
    const events = await client.query([
      {
        kinds: [CHANGE_REVIEW_EVENT_KIND],
        authors: [mergeInfo.authorPubkey],
        '#t': [CHANGE_REVIEW_FILE_TAG],
        '#r': [tip],
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
        tagValue(event, 'tip') === tip &&
        tagValue(event, 'f') === path,
    );
    if (matching.length === 0) {
      throw new Error(`Missing diff chunks for ${path} at ${tip.slice(0, 12)}`);
    }
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

  async workspaceFilesRead(sessionId: SessionId, reviewTip?: string): Promise<ChangedFile[]> {
    const client = await this.getClient();
    const mergeInfo = await this.getSubchannelMergeTarget(sessionId);
    if (!mergeInfo || !('target' in mergeInfo)) return [];
    const tip = reviewTip ?? mergeInfo.target.tip;
    const events = await client.query([
      {
        kinds: [CHANGE_REVIEW_EVENT_KIND],
        authors: [mergeInfo.authorPubkey],
        '#t': [CHANGE_REVIEW_MANIFEST_TAG],
        '#r': [tip],
        limit: 500,
      },
      {
        kinds: [CHANGE_REVIEW_EVENT_KIND],
        authors: [mergeInfo.authorPubkey],
        '#t': [CHANGE_REVIEW_COMPLETE_TAG],
        '#r': [tip],
        limit: 10,
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
          tagValue(event, 'tip') === tip,
      )
      .sort((a, b) => Number(tagValue(a, 'chunk') ?? 0) - Number(tagValue(b, 'chunk') ?? 0))
      .map((event) => parseChangeReviewManifest(event.content))
      .filter((manifest) => manifest !== null);
    if (manifests.length === 0) {
      throw new Error(`Missing review manifest for ${tip.slice(0, 12)}`);
    }
    const files = manifests.flatMap((manifest) => manifest.files);
    const uniqueFiles = [...new Map(files.map((file) => [file.path, file])).values()];
    const transactional = events.some(
      (event) =>
        event.pubkey === mergeInfo.authorPubkey &&
        tagValue(event, 'h') === sessionId &&
        tagValue(event, 'tip') === tip &&
        tagValue(event, 't') === CHANGE_REVIEW_MANIFEST_TAG &&
        tagValue(event, 'generation') === CHANGE_REVIEW_GENERATION_TAG,
    );
    if (transactional) {
      const completion = events
        .filter(
          (event) =>
            event.pubkey === mergeInfo.authorPubkey &&
            tagValue(event, 'h') === sessionId &&
            tagValue(event, 'tip') === tip &&
            tagValue(event, 't') === CHANGE_REVIEW_COMPLETE_TAG &&
            tagValue(event, 'generation') === CHANGE_REVIEW_GENERATION_TAG,
        )
        .map((event) => parseChangeReviewGenerationComplete(event.content))
        .find(
          (candidate) =>
            candidate !== null &&
            candidate.tip === tip &&
            manifests.every(
              (manifest) => manifest.tip === candidate.tip && manifest.base === candidate.base,
            ),
        );
      if (!completion) {
        throw new Error(`Missing review completion marker for ${tip.slice(0, 12)}`);
      }
      const chunks = events
        .filter(
          (event) =>
            event.pubkey === mergeInfo.authorPubkey &&
            tagValue(event, 'h') === sessionId &&
            tagValue(event, 'tip') === tip &&
            tagValue(event, 't') === CHANGE_REVIEW_MANIFEST_TAG,
        )
        .map((event) => Number(tagValue(event, 'chunk') ?? 0));
      const completeChunks =
        chunks.length === completion.manifestChunks &&
        [...chunks].sort((a, b) => a - b).every((chunk, index) => chunk === index);
      if (!completeChunks || uniqueFiles.length !== completion.fileCount) {
        throw new Error(
          `Incomplete review manifest for ${tip.slice(0, 12)}: received ${chunks.length} of ${completion.manifestChunks} manifest chunks and ${uniqueFiles.length} of ${completion.fileCount} files`,
        );
      }
    }
    return uniqueFiles;
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
   *
   * A corner that finished but has nothing reviewable (uncommitted work, or
   * no committed change at all) returns `{ reason }` instead of `null` —
   * `null` alone can't distinguish "nothing has happened yet" from "the
   * agent tried and explicitly declined," and the corner-lifecycle event
   * carrying that explanation is deliberately excluded from the transcript
   * (DESIGN.md: corner status is never inscribed there), so this is the only
   * place the human can learn why the review panel is empty.
   */
  async getSubchannelMergeTarget(subchannelId: string): Promise<
    | {
        target: MergeTarget;
        channelId: string;
        authorPubkey: string;
      }
    | { reason: string }
    | null
  > {
    const client = await this.getClient();
    // Activity frames can push merge-ready outside the short transcript
    // backfill window. Fetch body controls directly so review and approval
    // always bind to the current exact merge target.
    const events = await client.query([
      { kinds: [9], '#h': [subchannelId], '#t': ['body-control'], limit: 100 },
    ]);
    for (const event of [...events]
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .reverse()) {
      if ((event.tags ?? []).some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready')) {
        return event.content ? { reason: event.content } : null;
      }
      const repo = tagValue(event, 'repo');
      const branch = tagValue(event, 'branch');
      const tip = tagValue(event, 'tip');
      const parent = tagValue(event, 'parent');
      if (repo && branch && tip) {
        return {
          target: { repo, branch, tip },
          channelId: parent ?? '',
          authorPubkey: event.pubkey,
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
      const existing = await client.query([
        {
          kinds: [9],
          authors: [this.identity.publicKey],
          '#h': [subchannelId],
          '#t': [APPROVAL_MARKER],
          limit: 10,
        },
      ]);
      if (
        existing.some(
          (event) =>
            tagValue(event, 'repo') === target.repo &&
            tagValue(event, 'branch') === target.branch &&
            tagValue(event, 'tip') === target.tip,
        )
      ) {
        return { success: true, message: 'Approval already sent for this change' };
      }
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

  /**
   * Person-facing corner projection used by navigation and the full browse
   * view. Cached for a few seconds per parent Room across all 3 call sites;
   * see `invalidateCornerLifecycleCache`.
   */
  async listSubchannelLifecycle(parentChannelId: string): Promise<CornerSummary[]> {
    const cached = getCachedCornerLifecycle(parentChannelId);
    if (cached) return cached;
    const promise = this.fetchOneRoomLifecycle(parentChannelId);
    setCachedCornerLifecycle(parentChannelId, promise);
    return promise;
  }

  private async fetchOneRoomLifecycle(parentChannelId: string): Promise<CornerSummary[]> {
    const client = await this.getClient();
    const ids = await client.listSubchannels(parentChannelId);
    const parentMetadata = await client.getChannelMetadata(parentChannelId);
    const parentRoomLive = parentMetadata !== null && parentMetadata.archived !== true;
    const cornerIds = ids;
    const stateRecordsByCorner = await fetchCornerStateRecords(client, cornerIds);
    return Promise.all(
      ids.map(async (id) => {
        const [creates, metadata, events] = await Promise.all([
          client.query([{ kinds: [9007], '#h': [id], limit: 5 }]),
          client.getChannelMetadata(id),
          client.sessionEventsBackfill(id, { limit: 50 }),
        ]);
        return cornerSummaryFromEvents(
          id,
          creates,
          metadata,
          events,
          parentRoomLive,
          stateRecordsByCorner.get(id),
        );
      }),
    );
  }

  /**
   * Cross-Room batched corner lifecycle projection: one multi-`#h` round trip
   * for every corner's create event and one multi-`#h` round trip for
   * merge-summary events, regardless of how many parent Rooms are requested —
   * instead of one call graph per Room. Reads and populates the same cache as
   * `listSubchannelLifecycle`, so a Room already warmed by an earlier call
   * (either direction) is a cache hit here too.
   */
  async listSubchannelLifecycleForRooms(
    parentChannelIds: string[],
  ): Promise<Map<string, CornerSummary[]>> {
    const result = new Map<string, CornerSummary[]>();
    const toFetch: string[] = [];
    for (const parentChannelId of parentChannelIds) {
      const cached = getCachedCornerLifecycle(parentChannelId);
      if (cached) {
        result.set(parentChannelId, await cached);
      } else {
        toFetch.push(parentChannelId);
      }
    }
    if (toFetch.length > 0) {
      const fetchPromise = this.fetchManyRoomsLifecycle(toFetch);
      for (const parentChannelId of toFetch) {
        setCachedCornerLifecycle(
          parentChannelId,
          fetchPromise.then((byRoom) => byRoom.get(parentChannelId) ?? []),
        );
      }
      const fetched = await fetchPromise;
      for (const [parentChannelId, corners] of fetched) result.set(parentChannelId, corners);
    }
    return result;
  }

  private async fetchManyRoomsLifecycle(
    parentChannelIds: string[],
  ): Promise<Map<string, CornerSummary[]>> {
    const result = new Map<string, CornerSummary[]>();
    if (parentChannelIds.length === 0) return result;
    const client = await this.getClient();

    const idsByRoom = await Promise.all(
      parentChannelIds.map(async (parentChannelId) => ({
        parentChannelId,
        ids: await client.listSubchannels(parentChannelId),
      })),
    );
    const allCornerIds = [...new Set(idsByRoom.flatMap((entry) => entry.ids))];

    // One multi-`#d` read for the daemon-authoritative corner state records.
    const stateRecordsByCorner = await fetchCornerStateRecords(client, allCornerIds);

    const [createEvents, parentMetadataEntries] = await Promise.all([
      allCornerIds.length > 0
        ? client.query([
            { kinds: [9007], '#h': allCornerIds, limit: Math.max(500, allCornerIds.length * 5) },
          ])
        : Promise.resolve([]),
      Promise.all(
        parentChannelIds.map(async (id) => [id, await client.getChannelMetadata(id)] as const),
      ),
    ]);
    const parentMetadataById = new Map(parentMetadataEntries);

    const createsById = new Map<string, NostrEvent[]>();
    for (const event of createEvents) {
      const id = tagValue(event, 'h');
      if (!id) continue;
      const list = createsById.get(id) ?? [];
      list.push(event);
      createsById.set(id, list);
    }

    await Promise.all(
      idsByRoom.map(async ({ parentChannelId, ids }) => {
        const parentMetadata = parentMetadataById.get(parentChannelId);
        const parentRoomLive = parentMetadata !== null && parentMetadata?.archived !== true;
        const corners = await Promise.all(
          ids.map(async (id) => {
            const [metadata, events] = await Promise.all([
              client.getChannelMetadata(id),
              client.sessionEventsBackfill(id, { limit: 50 }),
            ]);
            return cornerSummaryFromEvents(
              id,
              createsById.get(id) ?? [],
              metadata,
              events,
              parentRoomLive,
              stateRecordsByCorner.get(id),
            );
          }),
        );
        result.set(parentChannelId, corners);
      }),
    );
    return result;
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
   * What a corner inherited from the Room it was opened out of: the objective
   * the daemon recorded on the corner's create event, and the bounded window
   * of Room conversation that immediately preceded the corner opening.
   *
   * Both come from the corner's own kind:9007 create event and the parent
   * Room's history, so this works for every corner — including ones opened
   * before this shipped, which simply have no `task` tag and fall back to the
   * corner's name. The create-event read is the same filter
   * `getParentChannelId` already issues, so on the enter-corner path it is a
   * cache hit rather than a second round trip.
   */
  async cornerBriefing(
    cornerChannelId: string,
    parentChannelId: string,
    limit: number = ROOM_CONTEXT_LIMIT,
  ): Promise<{ task?: string; context: RoomContextEntry[] }> {
    const client = await this.getClient();
    const creates = await client.query([
      { kinds: [KIND_CREATE_GROUP], '#h': [cornerChannelId], limit: 5 },
    ]);
    const create = creates
      .slice()
      .sort((a, b) => a.created_at - b.created_at)
      .find((event) => tagValue(event, TAG_PARENT));
    // No create event means no reliable "before the corner opened" boundary,
    // and a window taken from the wrong side of it would be worse than none.
    if (!create) return { context: [] };
    const task = tagValue(create, 'task');
    const events = await client.sessionEventsBackfill(parentChannelId, {
      until: create.created_at,
      limit: ROOM_CONTEXT_SCAN_LIMIT,
    });
    const viewer = this.identity.publicKey;
    const messages = events
      .map((event) => projectChatEvent(toRigEvent(event), viewer).message)
      .filter((message): message is ChatDisplayMessage => Boolean(message));
    return { ...(task ? { task } : {}), context: selectRoomContext(messages, limit) };
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
      if (mergeInfo && 'target' in mergeInfo) {
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
