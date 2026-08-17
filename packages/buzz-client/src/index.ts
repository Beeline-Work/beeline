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
  AgentSoulInput,
  AgentSoulProfile,
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
  SessionEventKind,
  SessionEventHandler,
  Unsubscribe,
  ChannelFilterOpts,
  MessageSubmitOpts,
  MergeTarget,
  BuzzClientConfig,
} from './types.js';

export {
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_SCHEME,
  DEFAULT_RELAY_BASE_URL,
  DEFAULT_RELAY_WS_URL,
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
  KIND_CHANNEL_METADATA,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_COMMUNITY_INVITE,
  KIND_AGENT_SOUL,
  KIND_PERSON_PROFILE,
  KIND_AGENT_PRESENCE,
  KIND_AGENT_DRAFT,
  KIND_AUTH,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_PRESENCE,
  TAG_AGENT_DRAFT,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_PERSON_PROFILE,
  TAG_MERGE_APPROVAL,
  TAG_PARENT,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
  TAG_DIRECT_MESSAGE,
  TAG_ROOM_LIFECYCLE,
} from './kinds.js';

export {
  AGENT_PRESENCE_HEARTBEAT_MS,
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  newerAgentPresence,
} from './agent-presence.js';
export type { AgentPresence, AgentPresenceStatus } from './agent-presence.js';

export {
  tagValue,
  tagValues,
  channelIdOf,
  isAgentActivity,
  classifySessionEvent,
  toSessionEvent,
  parseMembersEvent,
  parseMetadataEvent,
  sortEventsChronological,
} from './parse.js';

export { publishEvent, queryEvents, requestQueryEvents, relayReachable } from './http.js';
export type { AuthenticatedHttpBridgeOptions, HttpBridgeOptions } from './http.js';

export {
  OIDC_BIND_PROTOCOL,
  OIDC_BIND_KIND,
  OIDC_BIND_MARKER,
  OidcBindError,
  startOidcBind,
  parseOidcBindCallback,
  buildOidcBindEvent,
  finishOidcBind,
  lookupRecovery,
} from './oidc-bind.js';
export type {
  OidcBindChallenge,
  OidcBindStart,
  OidcBindResult,
  OidcIdentityLink,
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
  archiveRoom,
  renameChannel,
  setChannelVisibility,
  listChannelsForPubkey,
  getChannelMetadata,
  listSubchannels,
  getParentChannelId,
  getChannelCommunityId,
  getChannelRepositoryBinding,
  sendMessage,
  backfillMessages,
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
  communityChannels,
  communityMembers,
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
  fallbackAgentName,
  fallbackPersonName,
  isSingleWordAgentName,
  normalizePersonName,
  normalizePersonHandle,
  PERSON_NAME_MAX_LENGTH,
  PERSON_HANDLE_MAX_LENGTH,
  resolveAgentName,
  agentHandle,
  personHandle,
} from './display-name.js';

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
  verifyNip05,
} from './nip05.js';
export type { ParsedNip05, Nip05VerificationStatus, Nip05VerificationResult } from './nip05.js';

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
  CHANGE_REVIEW_VERSION,
  parseChangeReviewManifest,
  type ChangeReviewFile,
  type ChangeReviewManifest,
  type ChangeReviewStatus,
} from './change-review.js';

export { BuzzClient, createBuzzClient } from './client.js';
