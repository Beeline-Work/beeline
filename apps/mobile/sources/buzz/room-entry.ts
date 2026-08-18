/**
 * Enter-room hydration: every relay read the chat screen needs, fanned out
 * concurrently, each applying its own slice of UI state the moment that one
 * read lands.
 *
 * This module exists because the foreground must never wait on a network
 * round-trip before showing UI. The chat screen previously hydrated through a
 * single serial `await` chain: installing the live WebSocket subscription (a
 * connect + NIP-42 AUTH handshake with a 15s timeout) came first, then a
 * workspace listing, then a metadata/members batch, then a fixed 750ms sleep,
 * then two more WebSocket subscribe round-trips and two backfills — and only
 * after all of that did the single `setState` block that publishes the Room
 * name, roster and presence run. The roster had resolved many barriers
 * earlier; it was simply held hostage by unrelated calls, which is what the
 * "LOADING MEMBERS" header that never resolves actually was.
 *
 * The contract enforced here, and asserted by `room-entry.test.ts`:
 *
 * 1. Nothing is awaited before the fan-out. Callers paint from local cache.
 * 2. Every handler fires off its *own* read. One slow or hanging read can
 *    never delay a slice it does not feed.
 * 3. Live-subscription installs are started but never awaited by any UI step.
 *    Because a subscription that lands after the history read would miss
 *    anything published in between, readiness triggers one cheap delta
 *    revalidation instead of gating the first read.
 * 4. Processing a response (project/dedupe/sort/store-write) is handed to
 *    `afterInteractions` so it lands after the navigation transition, not in
 *    the middle of it.
 *
 * Deliberately dependency-free (type-only imports) so its test needs no
 * React Native mocks and cannot drift behind the real screen.
 */
import type {
  Agent,
  ChannelMember,
  ChannelRole,
  Community,
  CommunityMember,
  DirectMessage,
  MergeTarget,
  PersonProfile,
} from '@beeline/buzz-client';
import type { CornerStatus, CornerSummary } from '@/buzz/corners';
import { agentRosterCommunityIds, mergeAgentRosters } from '@/buzz/agent-display';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';

/** Relay reads the chat screen needs, narrowed to exactly what it calls. */
export type RoomEntryClient = {
  getChannelMetadata(channelId: string): Promise<{ name?: string } | null>;
  listMembers(channelId: string): Promise<ChannelMember[]>;
  listCommunities(): Promise<Community[]>;
  getChannelCommunityId(channelId: string): Promise<string | null>;
  getDirectMessage(channelId: string): Promise<DirectMessage | null>;
  getChannelRole(channelId: string): Promise<ChannelRole | null>;
  isAgentIdentity(pubkey: string): Promise<boolean>;
  listAgents(communityId: string): Promise<Agent[]>;
  communityMembers(communityId: string): Promise<CommunityMember[]>;
  listPersonProfiles(communityId: string, pubkeys: string[]): Promise<PersonProfile[]>;
};

export type RoomEntryTransport = {
  getParentChannelId(channelId: string): Promise<string | null>;
  isChannelArchived(channelId: string): Promise<boolean>;
  getSubchannelMergeTarget(channelId: string): Promise<{ target: MergeTarget } | null>;
  listSubchannelLifecycle(parentId: string): Promise<CornerSummary[]>;
};

export type RoomTranscriptSync = {
  entry: { messages?: unknown[]; mergeTarget?: MergeTarget | null; archived?: boolean };
  mergeTarget?: MergeTarget | null;
  archiveChannel: boolean;
};

export type RoomEntryDeps = {
  channelId: string;
  viewerPubkey: string;
  client: RoomEntryClient;
  transport: RoomEntryTransport;
  /**
   * Install live delivery for this Room. Started immediately and never awaited
   * by a UI step; its resolution only triggers the gap-closing delta read.
   */
  installLiveDelivery(input: { parentChannelId: string | null }): Promise<void>;
  /** Re-read the transcript into the shared cache. */
  revalidateTranscript(): Promise<RoomTranscriptSync>;
  /** True once the screen has unmounted or the channel changed. */
  isCancelled(): boolean;
  /**
   * Defer response processing past the current interaction. Defaults to
   * running inline, which is what the tests want and what a non-interactive
   * caller (a refresh, a retry) wants.
   */
  afterInteractions?: (run: () => void) => void;
  /** Retry delay for a Room whose very first history read comes back empty. */
  emptyTranscriptRetryMs?: number;
  /**
   * The viewer's own selected Workspace, for the agent-roster union below.
   * Optional: absent simply narrows the union, it never blocks it.
   */
  viewerActiveCommunityId?: () => Promise<string | null>;
};

export type RoomEntryHandlers = {
  onCommunities(communities: Community[]): void;
  onViewerIsAgent(isAgent: boolean): void;
  onChannelRole(role: ChannelRole | null): void;
  onRoomName(name: string): void;
  /** `null` is a real answer — "this is a Room" — not the absence of one. */
  onParentChannelId(parentChannelId: string | null): void;
  onDirectMessage(dm: DirectMessage | null): void;
  onWorkspaceId(communityId: string | null): void;
  onMembers(members: ChannelMember[]): void;
  onRoster(roster: {
    agents: Agent[];
    people: CommunityMember[];
    profiles: PersonProfile[];
    canManageWorkspace: boolean;
    communityId: string;
  }): void;
  onTranscriptSynced(sync: RoomTranscriptSync): void;
  onArchived(): void;
  onMergeTarget(target: MergeTarget): void;
  onCornerStatus(status: CornerStatus | null): void;
  /**
   * Every corner this transcript can name: a Corner reads its siblings, a Room
   * reads its own. Optional — a caller that only needs its own status can skip
   * it.
   */
  onCornerLifecycle?(corners: CornerSummary[]): void;
  /**
   * The agent roster, committed on its own rather than behind `onRoster`'s
   * person-profile read. Called first with the channel's own Workspace, then
   * again with the union across every Workspace the viewer belongs to.
   */
  onAgents?(agents: Agent[]): void;
  onStepFailed(step: string, error: unknown): void;
};

/** Room title fallback; the screen owns the human-facing label constant. */
export const DEFAULT_ROOM_ENTRY_NAME = 'ROOM';
const DEFAULT_EMPTY_TRANSCRIPT_RETRY_MS = 750;

function runInline(run: () => void): void {
  run();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fan out every enter-room read at once and publish each slice as it lands.
 *
 * The returned promise settles when every step has settled; it is only for
 * cleanup and tests. Nothing a person can see waits on it.
 */
export function hydrateRoomEntry(
  deps: RoomEntryDeps,
  handlers: RoomEntryHandlers,
  roomNameFallback: string = DEFAULT_ROOM_ENTRY_NAME,
): Promise<void> {
  const { channelId, client, transport, viewerPubkey } = deps;
  const defer = deps.afterInteractions ?? runInline;
  const live = (run: () => void) => {
    if (deps.isCancelled()) return;
    defer(() => {
      if (deps.isCancelled()) return;
      run();
    });
  };
  /** Attach a handler to one read without ever letting it block another. */
  const step = <T>(name: string, read: Promise<T>, apply: (value: T) => void): Promise<void> =>
    read.then(
      (value) => live(() => apply(value)),
      (error) => {
        if (!deps.isCancelled()) handlers.onStepFailed(name, error);
      },
    );

  // ── Independent reads: started together, applied individually ──────────────
  const parentIdRead = transport.getParentChannelId(channelId);
  const directWorkspaceRead = client.getChannelCommunityId(channelId);
  const metadataRead = client.getChannelMetadata(channelId);

  const communitiesRead = client.listCommunities();
  const steps: Promise<void>[] = [
    step('members', client.listMembers(channelId), handlers.onMembers),
    step('communities', communitiesRead, handlers.onCommunities),
    step('viewerIsAgent', client.isAgentIdentity(viewerPubkey), handlers.onViewerIsAgent),
    step('channelRole', client.getChannelRole(channelId), handlers.onChannelRole),
    step('directMessage', client.getDirectMessage(channelId), handlers.onDirectMessage),
    step('archived', transport.isChannelArchived(channelId), (archived) => {
      if (archived) handlers.onArchived();
    }),
    step('roomName', metadataRead, (metadata) =>
      handlers.onRoomName(metadata?.name?.trim() || roomNameFallback),
    ),
    step('parentChannelId', parentIdRead, (parentId) => {
      handlers.onParentChannelId(parentId);
    }),
  ];

  // ── Live delivery: started now, awaited by nothing a person can see ────────
  // A subscription that lands after the history read would miss whatever was
  // published in between, so readiness closes that window with one cheap
  // delta read rather than by holding the first read back behind a handshake.
  const liveDelivery = parentIdRead
    .catch(() => null)
    .then((parentChannelId) =>
      deps.installLiveDelivery({ parentChannelId }).then(
        () => true,
        (error) => {
          if (!deps.isCancelled()) handlers.onStepFailed('installLiveDelivery', error);
          return false;
        },
      ),
    );

  // ── Transcript: read immediately, projected off the interaction ────────────
  const transcript = (async () => {
    try {
      const sync = await deps.revalidateTranscript();
      if (deps.isCancelled()) return;
      live(() => handlers.onTranscriptSynced(sync));
      // A freshly invited member can get a successful but empty first snapshot
      // while the direct-membership projection converges. Retry once, off the
      // critical path — nothing else waits on this.
      if ((sync.entry.messages?.length ?? 0) === 0) {
        await delay(deps.emptyTranscriptRetryMs ?? DEFAULT_EMPTY_TRANSCRIPT_RETRY_MS);
        if (deps.isCancelled()) return;
        const retried = await deps.revalidateTranscript();
        if (deps.isCancelled()) return;
        live(() => handlers.onTranscriptSynced(retried));
      }
    } catch (error) {
      if (!deps.isCancelled()) handlers.onStepFailed('transcript', error);
    }
  })();

  // Close the push-visible gap once live delivery is genuinely established.
  const transcriptGapClose = Promise.all([liveDelivery, transcript]).then(async ([installed]) => {
    if (!installed || deps.isCancelled()) return;
    try {
      const sync = await deps.revalidateTranscript();
      if (deps.isCancelled()) return;
      live(() => handlers.onTranscriptSynced(sync));
    } catch (error) {
      if (!deps.isCancelled()) handlers.onStepFailed('transcriptGapClose', error);
    }
  });

  // ── Corner-only reads, gated on the parent link alone ──────────────────────
  const cornerReads = parentIdRead.then(
    (parentId) => {
      if (deps.isCancelled()) return;
      return Promise.all([
        // A merge target only exists for a corner.
        parentId
          ? step('mergeTarget', transport.getSubchannelMergeTarget(channelId), (mergeInfo) => {
              if (mergeInfo) handlers.onMergeTarget(mergeInfo.target);
            })
          : Promise.resolve(),
        // A Corner reads its siblings, a Room its own corners — one shared
        // short-TTL read serving both the header badge and the corner names.
        step('cornerStatus', transport.listSubchannelLifecycle(parentId ?? channelId), (corners) => {
          handlers.onCornerLifecycle?.(corners);
          handlers.onCornerStatus(corners.find((corner) => corner.id === channelId)?.status ?? null);
        }),
      ]).then(() => undefined);
    },
    () => undefined,
  );

  // ── Workspace roster: the one genuinely dependent chain ────────────────────
  // A corner's create event predates the redundant community tag, so its
  // Workspace resolves through the parent. This is the only place a second
  // barrier is unavoidable, and it feeds the roster alone.
  const workspaceRead = Promise.all([
    directWorkspaceRead.catch(() => null),
    parentIdRead.catch(() => null),
  ]).then(async ([directWorkspaceId, parentId]) => {
    if (directWorkspaceId) return directWorkspaceId;
    if (!parentId) return null;
    return client.getChannelCommunityId(parentId).catch(() => null);
  });

  /** One unreachable Workspace must never cost the transcript the others. */
  const readAgents = (communityId: string): Promise<Agent[]> =>
    client.listAgents(communityId).catch((error) => {
      handlers.onStepFailed(`agents:${communityId}`, error);
      return [] as Agent[];
    });

  // Agent names come from soul overlays, and both halves of an agent's
  // registration are community-scoped — so a transcript resolving the wrong
  // Workspace, or none, names every agent with a confident seed placeholder.
  // Read the channel's own Workspace first and commit it immediately, then
  // fold in every other Workspace the viewer belongs to as a gap-filler. The
  // second pass is deliberately not awaited by the first: a slow or hanging
  // `listCommunities` must not hold back the names the channel already knows.
  const primaryAgentsRead = workspaceRead.then((communityId) =>
    communityId ? readAgents(communityId) : [],
  );
  const agentUnion = (async () => {
    const primary = await primaryAgentsRead;
    if (deps.isCancelled()) return primary;
    live(() => handlers.onAgents?.(primary));
    const [channelCommunityId, activeCommunityId, communities] = await Promise.all([
      workspaceRead.catch(() => null),
      deps.viewerActiveCommunityId?.().catch(() => null) ?? Promise.resolve(null),
      communitiesRead.catch(() => [] as Community[]),
    ]);
    if (deps.isCancelled()) return primary;
    const gapFillers = agentRosterCommunityIds(
      channelCommunityId,
      activeCommunityId,
      communities.map((community) => community.communityId),
    ).filter((communityId) => communityId !== channelCommunityId);
    if (gapFillers.length === 0) return primary;
    const rosters = await Promise.all(gapFillers.map(readAgents));
    if (deps.isCancelled()) return primary;
    const merged = [...mergeAgentRosters([primary, ...rosters]).values()];
    live(() => handlers.onAgents?.(merged));
    return merged;
  })();

  const roster = workspaceRead.then(async (communityId) => {
    if (deps.isCancelled()) return;
    live(() => handlers.onWorkspaceId(communityId));
    if (!communityId) return;
    let agents: Agent[] = [];
    let members: CommunityMember[] = [];
    try {
      [agents, members] = await Promise.all([primaryAgentsRead, client.communityMembers(communityId)]);
    } catch (error) {
      if (!deps.isCancelled()) handlers.onStepFailed('roster', error);
      return;
    }
    if (deps.isCancelled()) return;
    const agentPubkeys = new Set(agents.map((agent) => agent.pubkey));
    const people = members.filter((member) => !agentPubkeys.has(member.pubkey));
    let profiles: PersonProfile[] = [];
    try {
      profiles = await client.listPersonProfiles(
        communityId,
        people.map((member) => member.pubkey),
      );
    } catch (error) {
      if (!deps.isCancelled()) handlers.onStepFailed('personProfiles', error);
    }
    if (deps.isCancelled()) return;
    const viewerRole = members.find((member) => member.pubkey === viewerPubkey)?.role;
    live(() =>
      handlers.onRoster({
        agents,
        people,
        profiles,
        canManageWorkspace: isWorkspaceManagerRole(viewerRole),
        communityId,
      }),
    );
  });

  return Promise.all([
    ...steps,
    liveDelivery,
    transcript,
    transcriptGapClose,
    cornerReads,
    roster,
    agentUnion,
  ]).then(() => undefined);
}
