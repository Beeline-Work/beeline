/** Signing, shared contracts, and server-backed mobile client utilities. */
export type {
  Identity,
  Agent,
  RepositoryBinding,
  RoomRepository,
  RoomRepositoryInput,
  AgentModelConfigOption,
  AgentModelConfigInput,
  PersonProfile,
  AttachmentReference,
  ChannelMember,
  DirectMessage,
  Community,
  CommunityMember,
} from './types.js';
export { createIdentity, loadIdentityFromNsec, identityNpub, identityNsec } from './identity.js';
export { KIND_AGENT_DRAFT } from './kinds.js';
export {
  type ParsedPermissionRequest,
  type PermissionGrantEnvelopeV1,
  type PermissionScope,
  buildPermissionDecision,
  buildPermissionExecution,
  buildPermissionRevocation,
  defaultPermissionGrantEnvelope,
  parsePermissionDecision,
  parsePermissionExecution,
  parsePermissionRequest,
  parsePermissionRevocation,
  foldPermissionLedger,
  permissionActionId,
  verifyPermissionAction,
  type PermissionConcreteAction,
  type PermissionFreshReader,
} from './permission-request.js';
export { buildAgentAccessConfig, type AgentAccessPolicyV1 } from './agent-access-config.js';
export {
  AGENT_PRESENCE_STALE_MS,
  AGENT_PRESENCE_DORMANT_MS,
  resolveAgentPresenceTier,
  newerAgentPresence,
} from './agent-presence.js';
export type { AgentPresence, AgentPresenceTier } from './agent-presence.js';
export { asRelayPublishError } from './relay-error.js';
export {
  OidcBindError,
  startGitHubBind,
  parseOidcBindCallback,
  buildOidcBindEvent,
  finishOidcBind,
  recoverOidcBind,
  lookupRecovery,
  lookupManagedIdentity,
} from './oidc-bind.js';
export type { OidcBindChallenge, OidcBindStart } from './oidc-bind.js';
export type { GitHubInstallationAccess } from './github-auth.js';
export { fetchIdentityPredecessors } from './identity-succession.js';
export { isMember, getChannelCreator } from './channel.js';
export type { ChannelOpsContext, ChannelRole } from './channel.js';
export {
  seedUnmigratableRooms,
  unmigratableRooms,
  type UnmigratableRoom,
} from './unmigratable-rooms.js';
export { isAllowedAgentModelConfigCategory } from './agent-model-config.js';
export { resolveRoomRepository, type RoomRepositoryAuthorResolution } from './room-repository.js';
export {
  AGENT_NAME_MAX_LENGTH,
  fallbackAgentName,
  fallbackPersonName,
  isReasonableAgentName,
  normalizePersonName,
  resolveAgentName,
  agentHandle,
  personHandle,
} from './display-name.js';
export { normalizeManagedHandle } from './nip05.js';
export type { Nip05VerificationStatus, ManagedIdentity } from './nip05.js';
export { type WritePermissionDecision } from './write-permission.js';
export { MESSAGE_REACTION_EMOJIS, RoomViewClient, RoomViewHttpError } from './room-view.js';
export type {
  AgentDetailView,
  ChatListItem,
  ChatListView,
  ChatListWorkspace,
  CornerListItem,
  CornerListView,
  RoomHistoryView,
  RoomView,
  RoomViewAgentTurn,
  RoomViewClientOptions,
  RoomViewIdentity,
  RoomViewMember,
  RoomViewMessage,
  MessageReactionEmoji,
  MessageReactionView,
  WorkspaceListView,
  WorkspaceMemberListView,
  WorkspaceView,
} from './room-view.js';
export type { KnownMessageReference } from './reply-proof.js';
export { SurfaceRefreshScheduler } from './surface-refresh.js';
export { LiveOverlayDecoder, applyLiveOverlay, visibleLiveOverlays } from './live-overlay.js';
export type { LiveOverlay } from './live-overlay.js';
export { addRoomPage } from './room-response-partitions.js';
export { SurfaceResponseCache, surfaceCacheKey } from './surface-cache.js';
export type { SurfaceCacheAddress } from './surface-cache.js';
export { isRetiredAgentNotice } from './retired-agent-notices.js';
export { SignedEventOutbox } from './signed-event-outbox.js';
export type { SignedOutboxRecord } from './signed-event-outbox.js';
export {
  isRoomView,
  isWorkspaceListView,
  isWorkspaceMemberListView,
  isWorkspaceView,
  isChatListView,
  isCornerListView,
  isAgentDetailView,
} from './surface-guards.js';
export type { BuzzClient } from './client.js';
export { isRoomHistoryView } from './surface-guards.js';

export * from './identity.js';
export * from './permission-request.js';
export * from './agent-access-config.js';

export { RelayPublishError } from './relay-error.js';
export { BEELINE_SLASH_COMMANDS } from './slash-command.js';
export { buildReplyCommand } from './reply-command.js';
