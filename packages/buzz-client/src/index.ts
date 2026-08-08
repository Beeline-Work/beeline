/**
 * @buzzy/buzz-client — channel-scoped Buzz transport for the mobile RigTransport adapter.
 *
 * Speaks only to real Buzz (WS + HTTP bridge). No UI, no mock relay.
 */

export type {
  Identity,
  WebSocketLike,
  WebSocketConstructor,
  PublishResult,
  ChannelMember,
  ChannelMetadata,
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
  createIdentity,
  loadIdentityFromNsec,
  loadIdentityFromSecret,
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
  KIND_CHANNEL_MEMBERS,
  KIND_AUTH,
  TAG_AGENT_ACTIVITY,
  TAG_MERGE_APPROVAL,
  TAG_PARENT,
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
  sendMessage,
  backfillMessages,
  eventIsAgentActivity,
} from './channel.js';
export type { ChannelOpsContext } from './channel.js';

export {
  buildMergeApproval,
  verifyMergeApproval,
  APPROVAL_MARKER,
} from './approval.js';

export { BuzzClient, createBuzzClient } from './client.js';
