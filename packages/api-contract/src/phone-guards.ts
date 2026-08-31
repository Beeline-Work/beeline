import {
  ROOM_VIEW_AGENT_LIMIT,
  ROOM_VIEW_BRIEFING_LIMIT,
  ROOM_VIEW_CHAT_LIMIT,
  ROOM_VIEW_MEMBER_LIMIT,
  ROOM_VIEW_MESSAGE_LIMIT,
  ROOM_VIEW_WORKSPACE_LIMIT,
  type AgentDetailView,
  type AgentPairingAbandonView,
  type AgentPairingClaimView,
  type AgentPairingClaimWireView,
  type ChatListItem,
  type ChatListView,
  type ChatListWorkspace,
  type CornerListItem,
  type CornerListView,
  type InviteView,
  type RoomHistoryView,
  type RoomView,
  type RoomViewAgentTurn,
  type RoomViewHeader,
  type RoomViewIdentity,
  type RoomViewMember,
  type RoomViewMessage,
  type WorkspaceListView,
  type WorkspaceView,
} from './phone-types.js';

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function stringArray(value: unknown, itemGuard: (item: string) => boolean = () => true): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && itemGuard(item));
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function attachment(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    httpUrl(item.url) &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    typeof item.mimeType === 'string' &&
    /^[^/\s]+\/[^/\s]+$/.test(item.mimeType) &&
    integer(item.size) &&
    (item.previewUrl === undefined || httpUrl(item.previewUrl)) &&
    (item.thumbnailUrl === undefined || httpUrl(item.thumbnailUrl)) &&
    (item.sha256 === undefined || (typeof item.sha256 === 'string' && HEX.test(item.sha256))) &&
    (item.width === undefined || (integer(item.width) && item.width > 0)) &&
    (item.height === undefined || (integer(item.height) && item.height > 0)),
  );
}

function activity(value: unknown): boolean {
  const item = record(value);
  const rollup = item?.rollup === undefined ? undefined : record(item.rollup);
  const plan = item?.plan === undefined ? undefined : record(item.plan);
  return Boolean(
    item &&
    (item.kind === 'thinking' ||
      item.kind === 'tool' ||
      item.kind === 'output' ||
      item.kind === 'summary') &&
    typeof item.title === 'string' &&
    optionalString(item.operation) &&
    optionalString(item.status) &&
    (item.thoughtMs === undefined || integer(item.thoughtMs)) &&
    (rollup === undefined || (rollup !== null && Object.values(rollup).every(integer))) &&
    (item.observed === undefined ||
      (Array.isArray(item.observed) &&
        item.observed.every((candidate) => {
          const observed = record(candidate);
          return Boolean(
            observed &&
            typeof observed.verb === 'string' &&
            optionalString(observed.target) &&
            optionalString(observed.result),
          );
        }))) &&
    (item.files === undefined ||
      (Array.isArray(item.files) &&
        item.files.every((candidate) => {
          const file = record(candidate);
          return Boolean(file && typeof file.path === 'string' && optionalString(file.status));
        }))) &&
    (plan === undefined ||
      (plan !== null &&
        optionalString(plan.objective) &&
        Array.isArray(plan.items) &&
        plan.items.every((candidate) => {
          const planItem = record(candidate);
          return Boolean(
            planItem &&
            typeof planItem.step === 'string' &&
            (planItem.status === 'pending' ||
              planItem.status === 'in_progress' ||
              planItem.status === 'completed'),
          );
        }))),
  );
}

function identity(value: unknown): value is RoomViewIdentity {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.pubkey === 'string' &&
    HEX.test(item.pubkey) &&
    (item.kind === 'human' || item.kind === 'agent') &&
    typeof item.name === 'string' &&
    optionalString(item.handle) &&
    optionalString(item.avatar),
  );
}

function header(value: unknown): value is RoomViewHeader {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    UUID.test(item.id) &&
    typeof item.workspaceId === 'string' &&
    UUID.test(item.workspaceId) &&
    (item.parentId === undefined ||
      (typeof item.parentId === 'string' && UUID.test(item.parentId))) &&
    typeof item.name === 'string' &&
    optionalString(item.about) &&
    optionalString(item.avatar) &&
    (item.visibility === undefined ||
      item.visibility === 'public' ||
      item.visibility === 'invite-only') &&
    typeof item.archived === 'boolean' &&
    integer(item.createdAt) &&
    integer(item.updatedAt),
  );
}

function member(value: unknown): value is RoomViewMember {
  const item = record(value);
  const presence = item?.presence === undefined ? undefined : record(item.presence);
  return Boolean(
    item &&
    identity(item.identity) &&
    (item.role === 'owner' || item.role === 'admin' || item.role === 'member') &&
    (presence === undefined ||
      (presence &&
        (presence.status === 'online' || presence.status === 'offline') &&
        integer(presence.observedAt) &&
        (presence.roomId === undefined ||
          (typeof presence.roomId === 'string' && UUID.test(presence.roomId))))),
  );
}

function messageCorner(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    UUID.test(item.id) &&
    (item.status === 'open' ||
      item.status === 'working' ||
      item.status === 'waiting' ||
      item.status === 'idle' ||
      item.status === 'concluded' ||
      item.status === 'closed'),
  );
}

function messagePermission(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.permissionId === 'string' &&
    item.permissionId.length > 0 &&
    typeof item.requestId === 'string' &&
    item.requestId.length > 0 &&
    identity(item.agent) &&
    item.agent.kind === 'agent' &&
    identity(item.requester) &&
    item.requester.kind === 'human' &&
    (item.decider === undefined || (identity(item.decider) && item.decider.kind === 'human')) &&
    typeof item.tool === 'string' &&
    item.tool.length > 0 &&
    optionalString(item.repository) &&
    (item.purpose === undefined || item.purpose === 'squire-spending') &&
    (item.status === 'pending' ||
      item.status === 'allowed' ||
      item.status === 'denied' ||
      item.status === 'expired' ||
      item.status === 'failed') &&
    (item.cornerId === undefined ||
      (typeof item.cornerId === 'string' && UUID.test(item.cornerId))),
  );
}

function targetBranch(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.proposalId === 'string' &&
    item.proposalId.length > 0 &&
    typeof item.from === 'string' &&
    typeof item.to === 'string' &&
    item.to.length > 0 &&
    optionalString(item.repository) &&
    (item.agent === undefined || identity(item.agent)) &&
    (item.requester === undefined || identity(item.requester)),
  );
}

function githubUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function githubEvent(value: unknown): boolean {
  const item = record(value);
  if (
    !item ||
    (item.type !== 'pull-request' && item.type !== 'issue') ||
    typeof item.actor !== 'string' ||
    typeof item.title !== 'string' ||
    !githubUrl(item.url)
  ) {
    return false;
  }
  return (
    (item.type === 'pull-request' &&
      (item.action === 'opened' || item.action === 'closed' || item.action === 'merged')) ||
    (item.type === 'issue' && (item.action === 'opened' || item.action === 'closed'))
  );
}

function daemonFact(value: unknown): boolean {
  const item = record(value);
  const pullRequest = item?.pullRequest === undefined ? undefined : record(item.pullRequest);
  if (
    !item ||
    (item.type !== 'corner-complete' &&
      item.type !== 'checks-failing' &&
      item.type !== 'worktree-cleaned' &&
      item.type !== 'corner-open') ||
    typeof item.cornerId !== 'string' ||
    !UUID.test(item.cornerId) ||
    typeof item.objective !== 'string' ||
    !item.objective.trim() ||
    (item.outcome !== undefined && item.outcome !== 'landed' && item.outcome !== 'abandoned') ||
    !optionalString(item.name) ||
    (item.type === 'corner-open' && (typeof item.name !== 'string' || !item.name.trim())) ||
    (pullRequest !== undefined &&
      (!pullRequest ||
        (pullRequest.number !== undefined &&
          (!Number.isSafeInteger(pullRequest.number) || Number(pullRequest.number) <= 0)) ||
        !optionalString(pullRequest.title) ||
        !githubUrl(pullRequest.url) ||
        !optionalString(pullRequest.targetBranch))) ||
    (item.subgoals !== undefined &&
      (!Array.isArray(item.subgoals) ||
        !item.subgoals.every((subgoal) => {
          const entry = record(subgoal);
          return Boolean(
            entry &&
            typeof entry.step === 'string' &&
            entry.step.trim() &&
            (entry.status === 'pending' ||
              entry.status === 'in_progress' ||
              entry.status === 'completed'),
          );
        })))
  ) {
    return false;
  }
  return (
    item.type !== 'corner-complete' || item.outcome === 'landed' || item.outcome === 'abandoned'
  );
}

export function isRoomViewMessage(value: unknown): value is RoomViewMessage {
  const item = record(value);
  const reference = item?.reference === undefined ? undefined : record(item.reference);
  const reply = item?.reply === undefined ? undefined : record(item.reply);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    HEX.test(item.id) &&
    typeof item.text === 'string' &&
    integer(item.createdAt) &&
    identity(item.author) &&
    (item.presentation === 'message' ||
      item.presentation === 'system' ||
      item.presentation === 'activity' ||
      item.presentation === 'card') &&
    (reference === undefined ||
      (reference &&
        typeof reference.channelId === 'string' &&
        UUID.test(reference.channelId) &&
        reference.eventId === item.id &&
        typeof reference.rootId === 'string' &&
        HEX.test(reference.rootId))) &&
    (reply === undefined ||
      (reply &&
        typeof reply.channelId === 'string' &&
        UUID.test(reply.channelId) &&
        typeof reply.eventId === 'string' &&
        HEX.test(reply.eventId) &&
        typeof reply.rootId === 'string' &&
        HEX.test(reply.rootId))) &&
    optionalString(item.liveTurnId) &&
    optionalString(item.requestId) &&
    (item.attachments === undefined ||
      (Array.isArray(item.attachments) && item.attachments.every(attachment))) &&
    (item.mentionPubkeys === undefined ||
      (Array.isArray(item.mentionPubkeys) &&
        item.mentionPubkeys.every((pubkey) => typeof pubkey === 'string' && HEX.test(pubkey)))) &&
    (item.activity === undefined ||
      (Array.isArray(item.activity) && item.activity.every(activity))) &&
    (item.durableFact === undefined ||
      item.durableFact === 'failure' ||
      item.durableFact === 'merge' ||
      item.durableFact === 'action') &&
    (item.corner === undefined || messageCorner(item.corner)) &&
    (item.permission === undefined || messagePermission(item.permission)) &&
    (item.targetBranch === undefined || targetBranch(item.targetBranch)) &&
    (item.githubEvent === undefined || githubEvent(item.githubEvent)) &&
    (item.daemonFact === undefined || daemonFact(item.daemonFact)),
  );
}

function scopedMessage(value: unknown, roomId: unknown): value is RoomViewMessage {
  return (
    typeof roomId === 'string' &&
    isRoomViewMessage(value) &&
    (value.reference === undefined || value.reference.channelId === roomId) &&
    (value.reply === undefined || value.reply.channelId === roomId)
  );
}

function watchFilters(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((candidate) => {
      const filter = record(candidate);
      if (!filter) return false;
      return Object.entries(filter).every(([key, entry]) => {
        if (key === 'kinds') return Array.isArray(entry) && entry.every(integer);
        if (key === 'authors' || key === '#h' || key === '#d' || key === '#p' || key === '#t') {
          return Array.isArray(entry) && entry.every((item) => typeof item === 'string');
        }
        return false;
      });
    })
  );
}

function viewer(value: unknown): boolean {
  const item = record(value);
  const permissions = record(item?.permissions);
  return Boolean(
    item &&
    identity(item.identity) &&
    (item.role === 'owner' || item.role === 'admin' || item.role === 'member') &&
    permissions &&
    typeof permissions.send === 'boolean' &&
    typeof permissions.manage === 'boolean',
  );
}

function directMessage(
  value: unknown,
): value is { readonly participants: readonly [string, string] } {
  const item = record(value);
  return Boolean(
    item &&
    Array.isArray(item.participants) &&
    item.participants.length === 2 &&
    item.participants.every((pubkey) => typeof pubkey === 'string' && HEX.test(pubkey)) &&
    item.participants[0] < item.participants[1],
  );
}

function directMessageForViewer(value: unknown, viewerValue: unknown): boolean {
  const viewerItem = record(viewerValue);
  const viewerIdentity = record(viewerItem?.identity);
  return (
    directMessage(value) &&
    typeof viewerIdentity?.pubkey === 'string' &&
    value.participants.includes(viewerIdentity.pubkey)
  );
}

function agentTurn(value: unknown): value is RoomViewAgentTurn {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.requestId === 'string' &&
    HEX.test(item.requestId) &&
    typeof item.agentPubkey === 'string' &&
    HEX.test(item.agentPubkey) &&
    (item.status === 'working' || item.status === 'complete' || item.status === 'failed') &&
    integer(item.createdAt) &&
    optionalString(item.generationId),
  );
}

function workspace(value: unknown): value is ChatListWorkspace {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    UUID.test(item.id) &&
    typeof item.name === 'string' &&
    optionalString(item.avatar) &&
    (item.visibility === 'public' || item.visibility === 'invite-only') &&
    (item.role === 'owner' || item.role === 'admin' || item.role === 'member') &&
    integer(item.updatedAt),
  );
}

function latest(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    HEX.test(item.id) &&
    typeof item.text === 'string' &&
    integer(item.createdAt) &&
    identity(item.author),
  );
}

function chat(value: unknown): value is ChatListItem {
  const item = record(value);
  return Boolean(
    item &&
    header(item.room) &&
    (item.latestMessage === undefined || latest(item.latestMessage)) &&
    integer(item.memberCount) &&
    integer(item.cornerCount) &&
    typeof item.unread === 'boolean' &&
    optionalString(item.repositoryName) &&
    (item.agentState === undefined ||
      item.agentState === 'needs-you' ||
      item.agentState === 'working'),
  );
}

function corner(value: unknown): value is CornerListItem {
  const item = record(value);
  return Boolean(
    item &&
    header(item.corner) &&
    cornerLifecycle(item.lifecycle) &&
    (item.status === 'open' ||
      item.status === 'working' ||
      item.status === 'waiting' ||
      item.status === 'idle' ||
      item.status === 'concluded' ||
      item.status === 'closed') &&
    (item.statusAt === undefined || integer(item.statusAt)) &&
    (item.reason === undefined ||
      item.reason === 'review' ||
      item.reason === 'question' ||
      item.reason === 'failure') &&
    (item.agent === undefined || identity(item.agent)) &&
    (item.latestMessage === undefined || latest(item.latestMessage)),
  );
}

function cornerLifecycle(value: unknown): boolean {
  const item = record(value);
  const pr = item?.pr === undefined ? undefined : record(item.pr);
  return Boolean(
    item &&
    (item.lifecycle === 'working' ||
      item.lifecycle === 'in-review' ||
      item.lifecycle === 'unknown' ||
      item.lifecycle === 'done') &&
    (item.checks === 'passing' ||
      item.checks === 'failing' ||
      item.checks === 'pending' ||
      item.checks === 'unknown') &&
    optionalString(item.branch) &&
    (item.outcome === undefined || item.outcome === 'landed' || item.outcome === 'abandoned') &&
    optionalString(item.reason) &&
    (pr === undefined ||
      (pr &&
        integer(pr.number) &&
        pr.number > 0 &&
        githubUrl(pr.url) &&
        typeof pr.title === 'string' &&
        pr.title.length > 0 &&
        typeof pr.targetBranch === 'string' &&
        pr.targetBranch.length > 0 &&
        typeof pr.headSha === 'string' &&
        /^[0-9a-f]{40}$/i.test(pr.headSha) &&
        optionalString(pr.mergedAt) &&
        optionalString(pr.mergedBy))),
  );
}

function repository(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.key === 'string' &&
    item.key.length > 0 &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    typeof item.remote === 'string' &&
    item.remote.length > 0 &&
    typeof item.targetBranch === 'string' &&
    item.targetBranch.length > 0 &&
    integer(item.updatedAt) &&
    (item.githubInstallationId === undefined || integer(item.githubInstallationId)) &&
    typeof item.githubEventsEnabled === 'boolean',
  );
}

function repositoryResolution(value: unknown): boolean {
  return value === 'repository' || value === 'none' || value === 'unverified';
}

function modelSelection(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && optionalString(item.model) && optionalString(item.effort));
}

function modelOption(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.category === 'string' &&
    item.category.length > 0 &&
    optionalString(item.currentValue) &&
    Array.isArray(item.options) &&
    item.options.every((candidate) => {
      const option = record(candidate);
      return Boolean(
        option &&
        typeof option.id === 'string' &&
        option.id.length > 0 &&
        optionalString(option.name),
      );
    }),
  );
}

export function isRoomView(value: unknown): value is RoomView {
  const item = record(value);
  return Boolean(
    item &&
    header(item.room) &&
    Array.isArray(item.messages) &&
    item.messages.length <= ROOM_VIEW_MESSAGE_LIMIT &&
    item.messages.every((candidate) => scopedMessage(candidate, record(item.room)?.id)) &&
    Array.isArray(item.latestAgentTurns) &&
    item.latestAgentTurns.length <= ROOM_VIEW_AGENT_LIMIT &&
    item.latestAgentTurns.every(agentTurn) &&
    Array.isArray(item.members) &&
    item.members.length <= ROOM_VIEW_MEMBER_LIMIT &&
    item.members.every(member) &&
    viewer(item.viewer) &&
    (item.directMessage === undefined || directMessageForViewer(item.directMessage, item.viewer)) &&
    (item.parent === undefined || header(item.parent)) &&
    (item.briefing === undefined ||
      (Array.isArray(item.briefing) &&
        item.briefing.length <= ROOM_VIEW_BRIEFING_LIMIT &&
        item.briefing.every(isRoomViewMessage))) &&
    (item.cornerPlan === undefined ||
      activity({ kind: 'output', title: 'Plan', plan: item.cornerPlan })) &&
    Array.isArray(item.corners) &&
    item.corners.every(corner) &&
    (item.repository === undefined || repository(item.repository)) &&
    repositoryResolution(item.repositoryResolution) &&
    (item.cornerLifecycle === undefined || cornerLifecycle(item.cornerLifecycle)) &&
    watchFilters(item.watchFilters),
  );
}

export function isRoomHistoryView(value: unknown): value is RoomHistoryView {
  const item = record(value);
  const before = item?.nextBefore === undefined ? undefined : record(item.nextBefore);
  return Boolean(
    item &&
    typeof item.roomId === 'string' &&
    UUID.test(item.roomId) &&
    Array.isArray(item.messages) &&
    item.messages.length <= ROOM_VIEW_MESSAGE_LIMIT &&
    item.messages.every((candidate) => scopedMessage(candidate, item.roomId)) &&
    (before === undefined ||
      (before &&
        integer(before.createdAt) &&
        typeof before.id === 'string' &&
        HEX.test(before.id))),
  );
}

export function isWorkspaceListView(value: unknown): value is WorkspaceListView {
  const item = record(value);
  return Boolean(
    item &&
    Array.isArray(item.workspaces) &&
    item.workspaces.length <= ROOM_VIEW_WORKSPACE_LIMIT &&
    item.workspaces.every(workspace) &&
    typeof item.truncated === 'boolean' &&
    identity(item.viewer) &&
    watchFilters(item.watchFilters),
  );
}

export function isWorkspaceView(value: unknown): value is WorkspaceView {
  const item = record(value);
  const managerSettings =
    item?.managerSettings === undefined ? undefined : record(item.managerSettings);
  return Boolean(
    item &&
    workspace(item.workspace) &&
    integer(record(item.workspace)?.createdAt) &&
    optionalString(record(item.workspace)?.about) &&
    (managerSettings === undefined ||
      (managerSettings &&
        (managerSettings.visibility === 'public' ||
          managerSettings.visibility === 'invite-only'))) &&
    Array.isArray(item.members) &&
    item.members.length <= ROOM_VIEW_MEMBER_LIMIT &&
    item.members.every(member) &&
    Array.isArray(item.agents) &&
    item.agents.length <= ROOM_VIEW_AGENT_LIMIT &&
    item.agents.every(member) &&
    typeof item.membersTruncated === 'boolean' &&
    typeof item.agentsTruncated === 'boolean' &&
    viewer(item.viewer) &&
    watchFilters(item.watchFilters),
  );
}

export function isChatListView(value: unknown): value is ChatListView {
  const item = record(value);
  return Boolean(
    item &&
    workspace(item.workspace) &&
    Array.isArray(item.chats) &&
    item.chats.length <= ROOM_VIEW_CHAT_LIMIT &&
    item.chats.every(chat) &&
    typeof item.truncated === 'boolean' &&
    identity(item.viewer) &&
    watchFilters(item.watchFilters),
  );
}

export function isCornerListView(value: unknown): value is CornerListView {
  const item = record(value);
  return Boolean(
    item &&
    header(item.room) &&
    Array.isArray(item.corners) &&
    item.corners.every(corner) &&
    viewer(item.viewer) &&
    watchFilters(item.watchFilters),
  );
}

export function isAgentDetailView(value: unknown): value is AgentDetailView {
  const item = record(value);
  const soul = item?.soul === undefined ? undefined : record(item.soul);
  return Boolean(
    item &&
    typeof item.workspaceId === 'string' &&
    UUID.test(item.workspaceId) &&
    member(item.agent) &&
    item.agent.identity.kind === 'agent' &&
    Array.isArray(item.catalog) &&
    item.catalog.length <= 100 &&
    item.catalog.every(modelOption) &&
    (soul === undefined ||
      (soul !== null &&
        typeof soul.name === 'string' &&
        soul.name.length > 0 &&
        typeof soul.instructions === 'string' &&
        soul.instructions.length > 0 &&
        typeof soul.avatarSeed === 'string' &&
        soul.avatarSeed.length > 0 &&
        (soul.avatar === undefined || httpUrl(soul.avatar)))) &&
    (item.runtimeSelection === undefined || modelSelection(item.runtimeSelection)) &&
    (item.selected === undefined || modelSelection(item.selected)) &&
    watchFilters(item.watchFilters),
  );
}

export function isInviteView(value: unknown): value is InviteView {
  const item = record(value);
  if (
    !item ||
    typeof item.name !== 'string' ||
    !integer(item.expiresAt) ||
    !optionalString(item.avatar)
  )
    return false;
  return Object.keys(item).every(
    (key) => key === 'name' || key === 'avatar' || key === 'expiresAt',
  );
}

export function isAgentPairingClaimWireView(value: unknown): value is AgentPairingClaimWireView {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentPairingClaimWireView>;
  return (
    typeof candidate.workspaceId === 'string' &&
    UUID.test(candidate.workspaceId) &&
    typeof candidate.pairedBy === 'string' &&
    HEX.test(candidate.pairedBy) &&
    typeof candidate.joined === 'boolean' &&
    (candidate.attachedRoomIds === undefined ||
      (Array.isArray(candidate.attachedRoomIds) &&
        candidate.attachedRoomIds.every(
          (roomId) => typeof roomId === 'string' && UUID.test(roomId),
        )))
  );
}

export function isAgentPairingClaimView(value: unknown): value is AgentPairingClaimView {
  return (
    isAgentPairingClaimWireView(value) &&
    Array.isArray(value.attachedRoomIds) &&
    value.attachedRoomIds.every((roomId) => UUID.test(roomId))
  );
}

export function isAgentPairingAbandonView(value: unknown): value is AgentPairingAbandonView {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as Partial<AgentPairingAbandonView>).abandoned === 'boolean'
  );
}
