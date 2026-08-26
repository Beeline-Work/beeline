/**
 * @beeline/buzz-client — channel-scoped Buzz transport for the mobile RigTransport adapter.
 *
 * Speaks only to real Buzz (WS + HTTP bridge). No UI, no mock relay.
 */

export type {
  Identity,
  AgentIdentity,
  Agent,
  CreateAgentOptions,
  AgentPairingCode,
  RedeemAgentPairingResult,
  RepositoryBinding,
  RoomRepository,
  RoomRepositoryInput,
  AgentSoulInput,
  AgentSoulProfile,
  AgentModelConfigOption,
  AgentModelCatalog,
  AgentModelConfigInput,
  AgentModelConfig,
  AgentCommandInfo,
  AgentCommandList,
  PersonProfile,
  PersonProfileInput,
  MediaBlob,
  AttachmentReference,
  WebSocketLike,
  WebSocketConstructor,
  PublishResult,
  ChannelMember,
  ChannelMetadata,
  DirectMessage,
  Community,
  CommunityRole,
  CommunityMember,
  CommunityInvite,
  CommunityInviteRecord,
  CreateInviteOptions,
  RedeemInviteResult,
  SessionEvent,
  SessionEventHandler,
  Unsubscribe,
  ChannelFilterOpts,
  MessageSubmitOpts,
  MergeTarget,
  BuzzClientConfig,
} from './types.js';

export * from './read-model/index.js';

export {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_SCHEME,
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_RELAY_WS_URL,
  LEGACY_RELAY_HOST,
  PRODUCTION_RELAY_HOSTS,
  isProductionRelayHost,
} from './relay-config.js';

export {
  createIdentity,
  createAgentIdentity,
  loadIdentityFromNsec,
  loadAgentIdentityFromNsec,
  loadIdentityFromSecret,
  loadAgentIdentityFromSecret,
  identityNpub,
  identityNsec,
  encodeNpub,
  encodeNsec,
  decodeNpub,
  decodeNsec,
  getPublicKey,
} from './identity.js';

export {
  KIND_STREAM_MESSAGE,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_EDIT_METADATA,
  KIND_CREATE_GROUP,
  KIND_DELETE_GROUP,
  KIND_CHANNEL_METADATA,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_COMMUNITY_INVITE,
  KIND_AGENT_SOUL,
  KIND_PERSON_PROFILE,
  KIND_AGENT_PRESENCE,
  KIND_AGENT_DRAFT,
  KIND_AGENT_MODEL_CATALOG,
  KIND_AGENT_MODEL_CONFIG,
  KIND_AGENT_ACCESS_CONFIG,
  KIND_AUTH,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_PRESENCE,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_AGENT_MODEL_CATALOG,
  TAG_AGENT_MODEL_CONFIG,
  TAG_PERSON_PROFILE,
  TAG_MERGE_APPROVAL,
  TAG_PERMISSION_REQUEST,
  TAG_PERMISSION_DECISION,
  TAG_PERMISSION_REVOCATION,
  TAG_PERMISSION_EXECUTION,
  TAG_DELEGATION_TURN,
  TAG_DELEGATION_RECEIPT,
  TAG_AGENT_ACCESS_CONFIG,
  TAG_PARENT,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
  TAG_DIRECT_MESSAGE,
  TAG_ROOM_LIFECYCLE,
  TAG_CORNER_STATE,
} from './kinds.js';

export * from './permission-request.js';
export * from './delegation-turn.js';
export * from './agent-access-config.js';
export * from './scheduled-turn.js';

export {
  AGENT_PRESENCE_HEARTBEAT_MS,
  AGENT_PRESENCE_STALE_MS,
  AGENT_PRESENCE_DORMANT_MS,
  isAgentPresenceOnline,
  resolveAgentPresenceTier,
  resolveAgentRosterStanding,
  newerAgentPresence,
  agentPresenceKey,
} from './agent-presence.js';
export type {
  AgentPresence,
  AgentPresenceStatus,
  AgentPresenceTier,
  AgentRosterStanding,
  RoomMembershipStanding,
} from './agent-presence.js';

export {
  CORNER_ASK_FRESH_WINDOW_MS,
  CORNER_NEEDS_YOU_STATUSES,
  CORNER_WORK_LIVENESS_WINDOW_MS,
  CORNER_WORK_SIGNAL_TAGS,
  cornerLifecycleFact,
  cornerStatusPrecedence,
  isCornerNeedsYou,
  mapRawCornerStatusTag,
  mergeCornerStatuses,
  resolveCornerLifecycle,
  resolveCornerState,
  resolveCornerStatusAgainstArchive,
  type CornerLifecycleFact,
  type CornerLifecycleStatus,
  type CornerSuperState,
  type CornerVerdict,
} from './corner-lifecycle.js';

export {
  KIND_CORNER_STATE,
  CORNER_ACTIVITY_FRESHNESS_MS,
  agentDraftKey,
  agentThoughtKey,
  assertCornerStateTransition,
  canTransitionCornerState,
  cornerStateKey,
  isCornerStateRecordCurrent,
  isCornerStateRecordFresh,
  isCornerTerminalState,
  parseCornerStateRecord,
  type CornerMachineReason,
  type CornerMachineState,
  type CornerStateRecord,
} from './corner-state.js';

export {
  tagValue,
  tagValues,
  channelIdOf,
  parseMembersEvent,
  parseMetadataEvent,
  sortEventsChronological,
} from './parse.js';

export { publishEvent, queryEvents, requestQueryEvents, relayReachable } from './http.js';
export type { AuthenticatedHttpBridgeOptions, HttpBridgeOptions } from './http.js';
export {
  RelayPublishError,
  asRelayPublishError,
  isRetryableRelayPublishError,
  relayPublishErrorFromResponse,
} from './relay-error.js';
export type { RelayPublishErrorKind } from './relay-error.js';
export { buildReplyCommand } from './reply-command.js';
export type { ReplyCommandOptions } from './reply-command.js';
export { isArchivedChannelError } from './archived-channel.js';

export {
  OIDC_BIND_PROTOCOL,
  OIDC_BIND_KIND,
  OIDC_BIND_MARKER,
  MOBILE_APP_SCHEMES,
  OidcBindError,
  startOidcBind,
  startGitHubBind,
  startGitHubInstallation,
  listGitHubRepositories,
  createGitHubRepository,
  getGitHubRepositoryAccess,
  getGitHubRoomInstallationToken,
  getGitHubRoomEvents,
  getAuthCapabilities,
  parseOidcBindCallback,
  buildOidcBindEvent,
  finishOidcBind,
  recoverOidcBind,
  lookupRecovery,
  lookupManagedIdentity,
  adoptGitHubHandle,
  fetchIdentityPredecessors,
  resolveCurrentIdentityPubkey,
} from './oidc-bind.js';
export type {
  OidcBindChallenge,
  OidcBindStart,
  OidcBindResult,
  OidcRecoveryResult,
  OidcIdentityLink,
  GitHubRepositoryAccess,
  GitHubInstallationAccess,
  GitHubRepositoryAccessResult,
  GitHubRoomInstallationToken,
  GitHubRoomEvent,
  GitHubRoomEventsResult,
  AuthCapabilities,
} from './oidc-bind.js';

export { RelayWs, wsUrlFromHttp, wsQueryEvents } from './ws.js';
export type { Filter, RelayWsOptions } from './ws.js';

export { query } from './query.js';
export type { QueryFunnelContext } from './query.js';

export {
  createChannel,
  createSubchannel,
  setMemberRole,
  removeMember,
  removeRoomMember,
  leaveRoom,
  listMembers,
  isMember,
  getChannelRole,
  waitUntilMember,
  waitUntilMemberRole,
  waitUntilNotMember,
  waitUntilRoomArchived,
  waitUntilRoomDeleted,
  archiveRoom,
  deleteRoom,
  renameChannel,
  setChannelVisibility,
  listChannelsForPubkey,
  getChannelMetadata,
  listSubchannels,
  getParentChannelId,
  getChannelCreator,
  getChannelCommunityId,
  getChannelRepositoryBinding,
  sendMessage,
  backfillMessages,
  isMembershipProjectionTimeout,
  MembershipProjectionTimeoutError,
} from './channel.js';
export type { ChannelOpsContext, ChannelRole } from './channel.js';

export {
  directMessageChannelId,
  parseDirectMessage,
  getDirectMessage,
  listDirectMessages,
  resolveDirectMessage,
} from './direct-message.js';

export {
  repositoryRoomId,
  findRepositoryRoom,
  resolveRepositoryRoom,
  resolveRepositoryRoomForHuman,
  ensureRepositoryRoomAdmin,
  type RepositoryRoomResult,
} from './repo-room.js';

export {
  createCommunity,
  getCommunity,
  setCommunityAvatar,
  renameCommunity,
  setCommunityVisibility,
  listCommunities,
  migrateSuccessorMemberships,
  communityChannels,
  communityMembers,
  inheritRolesThroughSuccession,
  attachCommunityMemberToChannel,
  createInvite,
  listCommunityInvites,
  revokeCommunityInvite,
  redeemInvite,
  inviteTokenHash,
  parseCommunityInvite,
  findCommunityInvite,
  DEFAULT_INVITE_TTL_SECONDS,
} from './community.js';

export {
  isRoomUnmigratable,
  markRoomUnmigratable,
  seedUnmigratableRooms,
  unmigratableRooms,
  resetUnmigratableRooms,
  unmigratableRoomKey,
  type UnmigratableRoom,
} from './unmigratable-rooms.js';

export {
  abandonAgentPairing,
  attachAgentToChannel,
  createAgent,
  createAgentPairingCode,
  redeemAgentPairingCode,
  setAgentSoul,
  parseAgentSoul,
  listAgents,
  removeAgent,
  isAgentIdentity,
  hasAgentIdentityMarker,
  isAgentIdentityEvent,
  parseAgent,
} from './agent.js';

export {
  ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES,
  isAllowedAgentModelConfigCategory,
  parseAgentModelCatalog,
  publishAgentModelCatalog,
  getAgentModelCatalog,
  parseAgentModelConfig,
  setAgentModelConfig,
  getAgentModelConfig,
} from './agent-model-config.js';

export {
  MAX_AGENT_COMMANDS,
  agentCommandsKey,
  parseAgentCommandEntries,
  parseAgentCommands,
  publishAgentCommands,
  getAgentCommands,
} from './agent-commands.js';

export {
  parseRoomRepository,
  setRoomRepository,
  getRoomRepository,
  readRoomRepositoryConfig,
  resolveRoomRepository,
  resolveRoomRepositoryState,
  setRoomTargetBranch,
  setRoomGitHubEvents,
  normalizeTargetBranchName,
  type RoomRepositoryAuthorResolution,
  type RoomRepositoryResolution,
} from './room-repository.js';

export {
  canonicalizeGitRemote,
  repositoryKeyForRemote,
  repositoryNameFromCanonicalRemote,
  parseGitRemoteInput,
} from './git-url.js';

export {
  AGENT_NAME_MAX_LENGTH,
  DEFAULT_AGENT_IDENTITY_NAME,
  DEFAULT_BODY_IDENTITY_NAME,
  deriveAgentDisplayName,
  fallbackAgentName,
  fallbackPersonName,
  isReasonableAgentName,
  isSingleWordAgentName,
  normalizePersonName,
  normalizePersonHandle,
  PERSON_NAME_MAX_LENGTH,
  PERSON_HANDLE_MAX_LENGTH,
  resolveAgentName,
  agentHandle,
  personHandle,
} from './display-name.js';

export { summarizeGitFailure } from './git-failure.js';

export {
  BEELINE_SLASH_COMMANDS,
  beelineSlashCommandList,
  isBeelineSlashCommand,
  matchSlashCommand,
} from './slash-command.js';
export type { BeelineSlashCommand, SlashCommandInput } from './slash-command.js';

export {
  parsePersonProfile,
  parseGlobalPersonProfile,
  KIND_NOSTR_PROFILE,
  getGlobalPersonProfile,
  getPersonProfile,
  listPersonProfiles,
  setGlobalPersonProfile,
  setPersonProfile,
} from './person-profile.js';

export {
  parseNip05Identifier,
  normalizeNip05Identifier,
  normalizeManagedHandle,
  parseManagedIdentity,
  verifyNip05,
  claimNip05Handle,
  Nip05ClaimError,
} from './nip05.js';
export type {
  ParsedNip05,
  Nip05VerificationStatus,
  Nip05VerificationResult,
  Nip05ClaimResult,
  ManagedIdentity,
} from './nip05.js';

export { buildMediaUploadAuthorization, uploadMedia } from './media.js';

export {
  ATTACHMENT_MARKER,
  ATTACHMENT_METADATA_TAG,
  ATTACHMENT_FILENAME_TAG,
  normalizeAttachmentReference,
  buildAttachmentTag,
  buildAttachmentTags,
  parseAttachmentTags,
} from './attachment.js';

export { buildMergeApproval, verifyMergeApproval, APPROVAL_MARKER } from './approval.js';

export {
  WRITE_PERMISSION_REQUEST_TAG,
  WRITE_PERMISSION_RESPONSE_TAG,
  type WritePermissionDecision,
} from './write-permission.js';

export {
  CHANGE_REVIEW_EVENT_KIND,
  CHANGE_REVIEW_MANIFEST_TAG,
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_COMPLETE_TAG,
  CHANGE_REVIEW_GENERATION_TAG,
  CHANGE_REVIEW_VERSION,
  parseChangeReviewManifest,
  parseChangeReviewGenerationComplete,
  type ChangeReviewFile,
  type ChangeReviewGenerationComplete,
  type ChangeReviewManifest,
  type ChangeReviewStatus,
} from './change-review.js';

export { BuzzClient, createBuzzClient } from './client.js';
