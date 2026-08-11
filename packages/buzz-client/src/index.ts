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
  WebSocketLike,
  WebSocketConstructor,
  PublishResult,
  ChannelMember,
  ChannelMetadata,
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
  KIND_CREATE_GROUP,
  KIND_CHANNEL_METADATA,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_AGENT_SOUL,
  KIND_AUTH,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_MERGE_APPROVAL,
  TAG_PARENT,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
} from './kinds.js';

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

export { publishEvent, queryEvents, relayReachable } from './http.js';
export type { HttpBridgeOptions } from './http.js';

export { RelayWs, wsUrlFromHttp } from './ws.js';
export type { Filter, RelayWsOptions } from './ws.js';

export {
  createChannel,
  createSubchannel,
  setMemberRole,
  listMembers,
  isMember,
  waitUntilMember,
  listChannelsForPubkey,
  getChannelMetadata,
  listSubchannels,
  getParentChannelId,
  getChannelCommunityId,
  getChannelRepositoryBinding,
  sendMessage,
  backfillMessages,
  eventIsAgentActivity,
} from './channel.js';
export type { ChannelOpsContext } from './channel.js';

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
  listCommunities,
  communityChannels,
  communityMembers,
  createInvite,
  redeemInvite,
  inviteTokenHash,
  parseCommunityInvite,
} from './community.js';

export {
  attachAgentToChannel,
  createAgent,
  createAgentPairingCode,
  redeemAgentPairingCode,
  setAgentSoul,
  parseAgentSoul,
  listAgents,
  isAgentIdentity,
  hasAgentIdentityMarker,
  isAgentIdentityEvent,
  parseAgent,
} from './agent.js';

export { buildMergeApproval, verifyMergeApproval, APPROVAL_MARKER } from './approval.js';

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
