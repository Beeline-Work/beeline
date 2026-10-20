/** Buzz / NIP kind constants used by the channel transport. */

/** Stream / channel message (human chat + activity markers). */
export const KIND_STREAM_MESSAGE = 9;

/** NIP-29: create group/channel. */
export const KIND_CREATE_GROUP = 9007;

/** Channel admins list replaceable (`d` = channel UUID). */
export const KIND_CHANNEL_ADMINS = 39001;

/** Channel members list replaceable (`d` = channel UUID). */
export const KIND_CHANNEL_MEMBERS = 39002;

/** NIP-33 parameterized replaceable application data (live in-flight agent reply draft). */
export const KIND_AGENT_DRAFT = 30078;
/** Paired-owner-authored per-agent access policy. */
export const KIND_AGENT_ACCESS_CONFIG = 30078;

/** NIP-33 parameterized replaceable application data (admin-authored Room→repository binding). */
export const KIND_ROOM_REPOSITORY = 30078;

/** Marker tag value for a Room-scoped durable agent availability record. */
export const TAG_AGENT_PRESENCE = 'agent-presence';

/** Marker tag value for a Room-scoped live in-flight agent reply draft (streaming text). */
export const TAG_AGENT_DRAFT = 'agent-draft';

/** Marker tag value for a Room-scoped live rolling agent thought. */
export const TAG_AGENT_THOUGHT = 'agent-thought';

/** Marker for an admin-authored, mutable Room→repository binding (room owns the repo). */
export const TAG_ROOM_REPOSITORY = 'buzz-room-repository';

/** P1 factory permission ledger command and receipt families. */
export const TAG_PERMISSION_REQUEST = 'buzz-permission-request';
export const TAG_PERMISSION_DECISION = 'buzz-permission-decision';
export const TAG_PERMISSION_REVOCATION = 'buzz-permission-revocation';
export const TAG_PERMISSION_EXECUTION = 'buzz-permission-execution';

export const TAG_AGENT_ACCESS_CONFIG = 'buzz-agent-access-config';

/** App-convention parent-channel linkage tag on child (sub)channels. */
export const TAG_PARENT = 'parent';

/** App-convention community linkage tag on channels and invite events. */
export const TAG_COMMUNITY = 'community';
